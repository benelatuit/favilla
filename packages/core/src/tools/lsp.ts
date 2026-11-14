import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { abortError, sleep } from '../util/async';
import { which } from '../util/proc';

/**
 * Language servers for what an editor knows and a model otherwise guesses: the type errors a change made,
 * where something is defined, and every place that uses it. One server per language and project root,
 * started on first use: TypeScript 7's own (`tsc --lsp`) from the project's node_modules, and pyright,
 * gopls or rust-analyzer when they are installed.
 */

/**
 * Every server this process started. Windows does not stop a child when its parent ends, and TypeScript's
 * server does not watch the client's process id, so one left behind by an exit that skipped the clean shutdown
 * went on checking a whole repository on three cores. Whatever way Favilla ends, its servers end with it.
 */
const running = new Set<ChildProcessWithoutNullStreams>();
process.once('exit', () => {
  for (const p of running) {
    try {
      p.kill();
    } catch {
      // Already gone.
    }
  }
});

interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  languageId: (file: string) => string;
}

const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;

/** The project's TypeScript 7 native compiler, which serves LSP; older TypeScript has no LSP of its own. */
function typescriptServer(root: string): ServerSpec | null {
  // Script files in a project of another language (a Go engine's JavaScript test data) are not a TypeScript project.
  if (!['tsconfig.json', 'jsconfig.json', 'package.json'].some((m) => fs.existsSync(path.join(root, m)))) return null;
  let dir = root;
  for (;;) {
    const pkg = path.join(dir, 'node_modules', 'typescript', 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version as string;
        if (Number(version.split('.')[0]) >= 7) {
          const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`;
          const candidates = [
            path.join(dir, 'node_modules', platformPkg, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'),
            // pnpm keeps the platform package beside the real typescript folder.
            path.join(fs.realpathSync(path.join(dir, 'node_modules', 'typescript')), '..', platformPkg, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'),
          ];
          const exe = candidates.find((c) => fs.existsSync(c));
          if (exe) return { name: 'TypeScript', command: exe, args: ['--lsp', '--stdio'], languageId: (f) => (/\.[cm]?tsx?$/i.test(f) ? (/x$/i.test(f) ? 'typescriptreact' : 'typescript') : /x$/i.test(f) ? 'javascriptreact' : 'javascript') };
        }
      } catch {
        // An unreadable package: no server from it.
      }
      return null;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function serverFor(file: string, root: string): ServerSpec | null {
  if (TS_EXT.test(file)) return typescriptServer(root);
  if (/\.pyi?$/i.test(file)) {
    for (const [cmd, name] of [['pyright-langserver', 'pyright'], ['basedpyright-langserver', 'basedpyright']] as const) {
      const exe = which(cmd);
      if (exe) return { name, command: exe, args: ['--stdio'], languageId: () => 'python' };
    }
    return null;
  }
  if (/\.go$/i.test(file)) {
    const exe = which('gopls');
    return exe ? { name: 'gopls', command: exe, args: [], languageId: () => 'go' } : null;
  }
  if (/\.rs$/i.test(file)) {
    const exe = which('rust-analyzer');
    return exe ? { name: 'rust-analyzer', command: exe, args: [], languageId: () => 'rust' } : null;
  }
  return null;
}

export interface Diagnostic {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
  code?: string | number;
}

export interface Location {
  file: string;
  line: number;
  column: number;
}

/** One running language server: JSON-RPC over stdio with Content-Length framing. */
class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private next = 1;
  private waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private header: Buffer = Buffer.alloc(0);
  private pending: { remaining: number; chunks: Buffer[] } | null = null;
  private documents = new Map<string, { uri: string; version: number }>();
  private pushed = new Map<string, Diagnostic[]>();
  private pushWaiters = new Map<string, Set<() => void>>();
  private capabilities: any = {};
  ready: Promise<void>;
  dead = false;
  retired = false;
  lastUsed = Date.now();

  constructor(
    readonly spec: ServerSpec,
    readonly root: string,
  ) {
    this.proc = spawn(spec.command, spec.args, { cwd: root, windowsHide: true });
    running.add(this.proc);
    this.proc.stdout.on('data', (d: Buffer) => this.receive(d));
    this.proc.stderr.resume();
    this.proc.stdin.on('error', () => { this.dead = true; });
    this.proc.on('exit', () => {
      running.delete(this.proc);
      this.dead = true;
      this.retire();
      for (const w of this.waits.values()) w.reject(new Error(`${spec.name} stopped`));
      this.waits.clear();
    });
    this.proc.on('error', () => (this.dead = true));
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          diagnostic: { dynamicRegistration: false },
          definition: { linkSupport: false },
          references: {},
        },
        workspace: { workspaceFolders: true, configuration: false },
      },
    }).then((r) => {
      this.capabilities = r?.capabilities ?? {};
      this.notify('initialized', {});
    });
  }

  private send(msg: unknown): void {
    const body = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const finish = () => {
        clearTimeout(timer);
        this.waits.delete(id);
        signal?.removeEventListener('abort', abort);
      };
      const fail = (e: Error) => { finish(); reject(e); };
      const abort = () => fail(abortError());
      const timer = setTimeout(() => fail(new Error(`${this.spec.name} did not answer ${method} in time`)), timeoutMs);
      this.waits.set(id, { resolve: (v) => { finish(); resolve(v); }, reject: fail });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private receive(chunk: Buffer): void {
    while (chunk.length) {
      if (!this.pending) {
        if (this.header.length) chunk = Buffer.concat([this.header, chunk]);
        const end = chunk.indexOf('\r\n\r\n');
        if (end < 0) {
          this.header = chunk;
          return;
        }
        this.header = Buffer.alloc(0);
        const length = /Content-Length:\s*(\d+)/i.exec(chunk.subarray(0, end).toString('ascii'));
        chunk = chunk.subarray(end + 4);
        if (!length) continue;
        this.pending = { remaining: Number(length[1]), chunks: [] };
      }
      const { remaining, chunks } = this.pending;
      if (remaining > chunk.length) {
        // An incomplete body can span hundreds of chunks. Join it only once the frame is complete.
        if (chunk.length) chunks.push(chunk);
        this.pending.remaining -= chunk.length;
        return;
      }
      const tail = chunk.subarray(0, remaining);
      chunk = chunk.subarray(remaining);
      this.pending = null;
      if (chunks.length) chunks.push(tail);
      this.dispatch(chunks.length ? Buffer.concat(chunks) : tail);
    }
  }

  private dispatch(body: Buffer): void {
    let msg: any;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const w = this.waits.get(msg.id);
      this.waits.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message ?? 'LSP error'));
      else w?.resolve(msg.result);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, version, diagnostics } = msg.params;
      if (typeof uri !== 'string' || !uri.startsWith('file:')) return;
      const file = fileURLToPath(uri);
      const direct = norm(file);
      const key = this.documents.has(direct) ? direct : documentKey(file);
      const document = this.documents.get(key);
      if (!document || (version !== undefined && version !== document.version)) return;
      this.pushed.set(key, (diagnostics ?? []).map(toDiagnostic).filter(Boolean) as Diagnostic[]);
      for (const done of this.pushWaiters.get(key) ?? []) done();
    } else if (msg.id !== undefined && msg.method) {
      // Requests from the server (configuration, capability registration): answer so it is not left waiting.
      this.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => null) : null });
    }
  }

  /** Tell the server the file's text as it is on disk now. */
  sync(file: string, key = documentKey(file)): boolean {
    if (this.retired || this.dead) return false;
    const opened = this.documents.get(key);
    const uri = opened?.uri ?? pathToFileURL(file).href;
    const text = fs.readFileSync(file, 'utf8');
    const version = (opened?.version ?? 0) + 1;
    this.documents.set(key, { uri, version });
    this.pushed.delete(key);
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.languageId(file), version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return true;
  }

  async diagnostics(file: string, timeoutMs: number, signal: AbortSignal): Promise<Diagnostic[] | null> {
    await this.ready;
    if (signal.aborted) return null;
    this.lastUsed = Date.now();
    const key = documentKey(file);
    if (!this.sync(file, key)) return null;
    if (this.capabilities.diagnosticProvider) {
      const uri = this.documents.get(key)!.uri;
      const r = await this.request('textDocument/diagnostic', { textDocument: { uri } }, timeoutMs, signal).catch(() => null);
      if (signal.aborted) return null;
      if (r?.items) return r.items.map(toDiagnostic).filter(Boolean) as Diagnostic[];
    }
    if (this.documents.has(key) && !this.pushed.has(key)) {
      await new Promise<void>((resolve) => {
        const waiters = this.pushWaiters.get(key) ?? new Set();
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          waiters.delete(done);
          if (!waiters.size) this.pushWaiters.delete(key);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        waiters.add(done);
        this.pushWaiters.set(key, waiters);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return signal.aborted ? null : (this.pushed.get(key) ?? null);
  }

  async locations(method: 'textDocument/definition' | 'textDocument/references', file: string, line: number, column: number): Promise<Location[]> {
    await this.ready;
    this.lastUsed = Date.now();
    const key = documentKey(file);
    if (!this.documents.has(key) && !this.sync(file, key)) return [];
    const uri = this.documents.get(key)!.uri;
    const r = await this.request(method, { textDocument: { uri }, position: { line: line - 1, character: column - 1 }, ...(method === 'textDocument/references' ? { context: { includeDeclaration: true } } : {}) });
    const list = Array.isArray(r) ? r : r ? [r] : [];
    return list
      .map((l: any) => {
        const uri = l.uri ?? l.targetUri;
        const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
        if (!uri || !range || !uri.startsWith('file:')) return null;
        return { file: fileURLToPath(uri), line: range.start.line + 1, column: range.start.character + 1 };
      })
      .filter(Boolean) as Location[];
  }

  /**
   * The connection is ending: close what is open and let the waiting checks go. Documents stay open while the
   * server is kept for the next session, because a late push without a version could not be told from the
   * answer to a new open of the same file.
   */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    const documents = [...this.documents.values()];
    this.documents.clear();
    this.pushed.clear();
    for (const waiters of this.pushWaiters.values()) for (const done of waiters) done();
    if (!this.dead) for (const { uri } of documents) this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  close(): void {
    this.retire();
    try {
      this.proc.kill();
    } catch {
      // Gone already.
    }
  }
}

function norm(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** A peer can publish the real path of a file Favilla opened through a link. */
function documentKey(file: string): string {
  try {
    return norm(fs.realpathSync.native(file));
  } catch {
    // A document may have been deleted since it was opened.
    return norm(file);
  }
}

function toDiagnostic(d: any): Diagnostic | null {
  if (!d?.range) return null;
  const severity = d.severity === 1 || d.severity === undefined ? 'error' : d.severity === 2 ? 'warning' : null;
  if (!severity) return null;
  return { line: d.range.start.line + 1, column: d.range.start.character + 1, message: String(d.message ?? '').split('\n')[0], severity, code: d.code };
}

/**
 * The servers of every session in this process, one per kind and project root. Each session used to start its
 * own: four threads open on one project ran four TypeScript servers (1.3 GB), and an edit's check waited on
 * whichever was busy. A server stays while a session uses it, closes after 15 minutes unused, and a minute after
 * the last session using it has closed.
 */
const pool = new Map<string, { client: LspClient; users: Set<LanguageServers> }>();
let reaper: NodeJS.Timeout | null = null;

function reap(): void {
  for (const [k, e] of pool) {
    const idle = Date.now() - e.client.lastUsed;
    if (e.client.dead || idle > 15 * 60_000 || (!e.users.size && idle > 60_000)) (e.client.close(), pool.delete(k));
  }
  if (!pool.size && reaper) clearInterval(reaper), (reaper = null);
}

/** How many servers the process runs now (for tests and the diagnostics view). */
export function runningServers(): number {
  return pool.size;
}

/** Closes the servers no session uses now, without waiting out the minute. */
export function closeUnusedServers(): void {
  for (const [k, e] of pool) if (!e.users.size) (e.client.close(), pool.delete(k));
}

/** The language servers a session uses: shared with the other sessions on the same project. */
export class LanguageServers {
  private used = new Set<string>();
  private closed = new AbortController();

  constructor(private readonly cwd: string) {}

  private client(file: string): LspClient | null {
    if (this.closed.signal.aborted) return null;
    const root = projectRoot(file, this.cwd);
    const spec = serverFor(file, root);
    if (!spec) return null;
    const key = `${spec.name}:${norm(root)}`;
    let e = pool.get(key);
    if (e && e.client.dead) {
      e.client.close();
      pool.delete(key);
      e = undefined;
    }
    if (!e) {
      e = { client: new LspClient(spec, root), users: new Set() };
      pool.set(key, e);
      if (!reaper) (reaper = setInterval(reap, 30_000)).unref();
    }
    e.users.add(this);
    this.used.add(key);
    return e.client;
  }

  /**
   * The errors the language server reports for a file as it is on disk, or null when no server covers it or
   * it did not answer in time (the first check of a project waits for the project to load).
   */
  async errors(file: string, timeoutMs = 4000): Promise<{ server: string; diagnostics: Diagnostic[] } | null> {
    const c = this.client(file);
    if (!c) return null;
    const check = new AbortController();
    const signal = AbortSignal.any([this.closed.signal, check.signal]);
    try {
      const d = await Promise.race([c.diagnostics(file, timeoutMs, signal), sleep(timeoutMs + 500, signal).then(() => null)]);
      return d ? { server: c.spec.name, diagnostics: d.filter((x) => x.severity === 'error') } : null;
    } catch {
      return null;
    } finally {
      check.abort();
    }
  }

  async definition(file: string, line: number, column: number): Promise<Location[] | null> {
    const c = this.client(file);
    return c ? c.locations('textDocument/definition', file, line, column) : null;
  }

  async references(file: string, line: number, column: number): Promise<Location[] | null> {
    const c = this.client(file);
    return c ? c.locations('textDocument/references', file, line, column) : null;
  }

  /** Start the server for a file and open it, so the first check after an edit does not wait for the project to load. */
  warm(file: string): void {
    const c = this.client(file);
    if (c) void c.ready.then(() => { if (!this.closed.signal.aborted) c.sync(file); }).catch(() => {});
  }

  /** Whether some server covers this file. */
  covers(file: string): boolean {
    return !!serverFor(file, projectRoot(file, this.cwd));
  }

  /** This session is done with its servers; another session on the project keeps them, otherwise they close soon. */
  close(): void {
    this.closed.abort();
    for (const k of this.used) {
      pool.get(k)?.users.delete(this);
    }
    this.used.clear();
  }
}

/** The nearest folder above the file with a project marker, within the working folder when it is inside. */
function projectRoot(file: string, cwd: string): string {
  const markers = ['tsconfig.json', 'jsconfig.json', 'package.json', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml'];
  for (let dir = path.dirname(path.resolve(file)); ; ) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir || norm(dir) === norm(path.dirname(cwd))) return cwd;
    dir = up;
  }
}
