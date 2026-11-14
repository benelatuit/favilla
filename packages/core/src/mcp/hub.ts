import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { ImagePart } from '../types';
import type { ToolBinding, ToolDef } from '../tools/types';
import { proxiedFetch } from '../net/http';
import { addressView, redactSecrets } from '../net/address';
import { truncateEnd } from '../util/text';
import { debug } from '../util/log';
import pkg from '../../package.json';

/** A server started as a local command (stdio) or reached over HTTP (streamable HTTP, falling back to SSE). */
export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean; timeoutMs?: number }
  | { url: string; headers?: Record<string, string>; enabled?: boolean; timeoutMs?: number };

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; title?: string };
}

export interface McpServerStatus {
  name: string;
  state: 'connecting' | 'ready' | 'failed' | 'off';
  tools: string[];
  error?: string;
}

interface Server {
  name: string;
  config: McpServerConfig;
  state: McpServerStatus['state'];
  client?: Client;
  tools: McpTool[];
  error?: string;
}

const CONNECT_MS = 15_000;

/** Words of a command line, quotes kept together: `-y "@scope/pkg" --dir 'C:\My Files'`. */
export function splitArgs(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)])) : {};

/** One server's settings as a config file or a README writes them, reduced to what Favilla reads. */
function normalize(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === false || r.disabled === true ? { enabled: false } : {};
  const url = typeof r.url === 'string' ? r.url : typeof r.serverUrl === 'string' ? r.serverUrl : '';
  if (url) {
    if (!/^https?:\/\//i.test(url)) return null;
    const headers = strings(r.headers);
    return { url, ...(Object.keys(headers).length ? { headers } : {}), ...enabled };
  }
  if (typeof r.command !== 'string' || !r.command.trim()) return null;
  // A whole command line in "command" (some READMEs write it so) is split into the program and its arguments.
  const words = Array.isArray(r.args) ? null : splitArgs(r.command.trim());
  const command = words ? words[0] : r.command.trim();
  const args = words ? words.slice(1) : (r.args as unknown[]).map(String);
  const env = strings(r.env);
  return { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(typeof r.cwd === 'string' && r.cwd ? { cwd: r.cwd } : {}), ...enabled };
}

/**
 * The servers in pasted text: a config's "mcpServers" (Claude Desktop, Cursor) or "servers" (VS Code) block, a
 * map of names to servers, or one server alone (its name left empty).
 */
export function mcpConfigsIn(text: string): [string, McpServerConfig][] {
  const errors: ParseError[] = [];
  const raw = parseJsonc(text.trim(), errors, { allowTrailingComma: true });
  if (!raw || typeof raw !== 'object') return [];
  const one = normalize(raw);
  if (one) return [['', one]];
  const r = raw as Record<string, unknown>;
  const map = (r.mcpServers ?? r.servers ?? (r.mcp as Record<string, unknown> | undefined)?.servers ?? r) as Record<string, unknown>;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([name, cfg]): [string, McpServerConfig | null] => [name.trim().replace(/[^\w.-]+/g, '-').slice(0, 40), normalize(cfg)])
    .filter((e): e is [string, McpServerConfig] => !!e[0] && !!e[1]);
}

/**
 * A server's settings from the settings page. Env vars and headers come as names with new values; a name sent
 * without a value keeps the value saved before, which the page never receives.
 */
export function mcpConfigFrom(input: unknown, old?: McpServerConfig): McpServerConfig {
  const i = (input ?? {}) as Record<string, unknown>;
  const pairs = (list: unknown, before: Record<string, string> = {}) => {
    const out: Record<string, string> = {};
    for (const e of Array.isArray(list) ? (list as { name?: unknown; value?: unknown }[]) : []) {
      const k = String(e?.name ?? '').trim();
      if (!k) continue;
      if (typeof e.value === 'string') out[k] = e.value;
      else if (k in before) out[k] = before[k];
    }
    return out;
  };
  const enabled = i.enabled === false ? { enabled: false } : {};
  if (i.kind === 'url') {
    const url = String(i.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('The address must start with http:// or https://.');
    const headers = pairs(i.headers, old && 'url' in old ? old.headers : undefined);
    return { url, ...(Object.keys(headers).length ? { headers } : {}), ...enabled };
  }
  const command = String(i.command ?? '').trim();
  if (!command) throw new Error('A server started on this computer needs a command, such as npx or uvx.');
  const args = Array.isArray(i.args) ? (i.args as unknown[]).map(String) : splitArgs(String(i.args ?? ''));
  const env = pairs(i.env, old && 'command' in old ? old.env : undefined);
  const cwd = String(i.cwd ?? '').trim();
  return { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(cwd ? { cwd } : {}), ...enabled };
}

/** Names the providers accept: letters, digits, _ and -, at most 64 characters. */
function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * The MCP servers of a runtime: started once, shared by every session. A session takes the tools of the
 * servers that are ready when it starts and keeps them for its whole life (the tool list is part of the
 * frozen prompt prefix).
 */
export class McpHub {
  private servers: Server[];
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    configs: Record<string, McpServerConfig> = {},
    private readonly proxy: string | false = false,
  ) {
    this.servers = Object.entries(configs).map(([name, config]) => ({ name, config, state: config.enabled === false ? 'off' : 'connecting', tools: [] }));
  }

  get configured(): boolean {
    return this.servers.some((s) => s.state !== 'off');
  }

  /** Connect every enabled server once; later calls wait for the same attempt. */
  start(): Promise<void> {
    this.starting ??= Promise.all(this.servers.filter((s) => s.state !== 'off').map((s) => this.connect(s))).then(() => {});
    return this.starting;
  }

  /** Wait for the servers, but never longer than `ms`: a slow server joins sessions started after it is ready. */
  async ready(ms = 10_000): Promise<void> {
    if (!this.configured) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.start(), new Promise((r) => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
  }

  private async connect(s: Server): Promise<void> {
    if (this.closing) return;
    const c = s.config;
    const client = new Client({ name: 'favilla', version: pkg.version });
    // Shutdown and reconfiguration also own a transport whose handshake has not finished.
    s.client = client;
    try {
      if ('command' in c) {
        const transport = new StdioClientTransport({ command: c.command, args: c.args ?? [], env: { ...getDefaultEnvironment(), ...(c.env ?? {}) }, cwd: c.cwd, stderr: 'pipe' });
        transport.stderr?.on('data', (d) => debug('mcp', `${s.name} stderr`, String(d).slice(0, 500)));
        await withTimeout(client.connect(transport), c.timeoutMs ?? CONNECT_MS, `Starting ${s.name}`);
      } else {
        const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(c.url);
        const opts = { requestInit: { headers: c.headers ?? {} }, fetch: proxiedFetch(local ? false : this.proxy) as never };
        try {
          await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(c.url), opts)), c.timeoutMs ?? CONNECT_MS, `Connecting to ${s.name}`);
        } catch (e) {
          if (s.client !== client) return;
          // Older servers speak only the SSE transport.
          debug('mcp', `${s.name}: streamable HTTP failed, trying SSE`, String(e));
          await withTimeout(client.connect(new SSEClientTransport(new URL(c.url), opts)), c.timeoutMs ?? CONNECT_MS, `Connecting to ${s.name}`);
        }
      }
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CONNECT_MS, `Listing the tools of ${s.name}`);
        tools.push(...(page.tools as McpTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      if (s.client !== client) return;
      s.tools = tools;
      s.state = 'ready';
    } catch (e) {
      if (s.client !== client) return;
      s.client = undefined;
      s.state = 'failed';
      const c = s.config;
      const secrets = 'url' in c ? [...Object.values(c.headers ?? {}), ...addressView(c.url, true).hidden] : Object.values(c.env ?? {});
      s.error = redactSecrets((e as Error).message, [...secrets, ...addressView(this.proxy || '').hidden]);
      debug('mcp', `${s.name} failed`, s.error);
      client.close().catch(() => {});
    }
  }

  status(): McpServerStatus[] {
    return this.servers.map((s) => ({ name: s.name, state: s.state, tools: s.tools.map((t) => t.name), error: s.error }));
  }

  /** The servers' settings as configured, for the settings page (which never receives the values of env or headers). */
  configs(): Record<string, McpServerConfig> {
    return Object.fromEntries(this.servers.map((s) => [s.name, s.config]));
  }

  /**
   * Take a new set of settings: servers removed or changed are closed, new or changed ones connect, the rest go on
   * untouched. Open sessions keep the tools they started with; new sessions get the new ones.
   */
  update(configs: Record<string, McpServerConfig> = {}): void {
    const same = (a: McpServerConfig, b: McpServerConfig) => JSON.stringify(a) === JSON.stringify(b);
    const next: Server[] = [];
    for (const s of this.servers) {
      const c = configs[s.name];
      if (c && same(c, s.config)) next.push(s);
      else {
        s.client?.close().catch(() => {});
        s.client = undefined;
        s.state = 'off';
      }
    }
    const fresh: Server[] = [];
    for (const [name, config] of Object.entries(configs)) {
      if (next.some((s) => s.name === name)) continue;
      const s: Server = { name, config, state: config.enabled === false ? 'off' : 'connecting', tools: [] };
      next.push(s);
      if (s.state === 'connecting') fresh.push(s);
    }
    this.servers = next;
    // Before the first start, start() connects them all.
    if (!this.starting || !fresh.length) return;
    this.starting = Promise.all([this.starting, ...fresh.map((s) => this.connect(s))]).then(() => {});
  }

  /** Connect one server again (after it failed, or to pick up tools it added). */
  async restart(name: string): Promise<void> {
    const s = this.servers.find((x) => x.name === name);
    if (!s || s.config.enabled === false) return;
    await s.client?.close().catch(() => {});
    s.client = undefined;
    s.tools = [];
    s.error = undefined;
    s.state = 'connecting';
    await this.connect(s);
  }

  /** Tool bindings for the servers that are ready. Read-only tools only, for research sub-agents. */
  bindings(readOnlyOnly = false): ToolBinding[] {
    const out: ToolBinding[] = [];
    for (const s of this.servers) {
      if (s.state !== 'ready' || !s.client) continue;
      for (const t of s.tools) {
        const readOnly = t.annotations?.readOnlyHint === true;
        if (readOnlyOnly && !readOnly) continue;
        const def = this.def(s, t, readOnly);
        out.push({
          def,
          spec: {
            name: toolName(s.name, t.name),
            description: `${t.description?.trim() || t.annotations?.title || t.name} (MCP server "${s.name}")`.slice(0, 1024),
            parameters: { type: 'object', properties: {}, ...t.inputSchema },
          },
          normalize: (a) => a,
        });
      }
    }
    return out;
  }

  private def(s: Server, t: McpTool, readOnly: boolean): ToolDef<Record<string, unknown>> {
    return {
      kind: 'mcp',
      readOnly,
      title: (input) => `${s.name} · ${t.name}${Object.keys(input ?? {}).length ? ` ${JSON.stringify(input).slice(0, 120)}` : ''}`,
      execute: async (input, ctx) => {
        if (!s.client || s.state !== 'ready') return { content: `The MCP server "${s.name}" is not connected.`, isError: true };
        let result: { content?: unknown[]; isError?: boolean; structuredContent?: unknown };
        try {
          result = (await s.client.callTool({ name: t.name, arguments: input }, undefined, { signal: ctx.signal, timeout: 10 * 60_000 })) as typeof result;
        } catch (e) {
          return { content: `${s.name} · ${t.name} failed: ${(e as Error).message}`, isError: true };
        }
        const texts: string[] = [];
        const images: ImagePart[] = [];
        for (const item of (result.content ?? []) as Record<string, any>[]) {
          if (item.type === 'text') texts.push(item.text);
          else if (item.type === 'image' && ctx.model.vision) images.push({ type: 'image', mediaType: item.mimeType, data: item.data, name: `${t.name}.png` });
          else if (item.type === 'image') texts.push('[image omitted: the current model cannot view images]');
          else if (item.type === 'resource') texts.push(item.resource?.text ?? `[resource ${item.resource?.uri ?? ''}]`);
          else if (item.type === 'resource_link') texts.push(`[${item.name ?? 'resource'}] ${item.uri}`);
        }
        if (!texts.length && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent, null, 2));
        const cut = truncateEnd(texts.join('\n\n') || '(no output)', ctx.outputChars);
        return {
          content: cut.truncated ? `${cut.text}\n\n[Output truncated: ${cut.omittedChars} more characters.]` : cut.text,
          images: images.length ? images : undefined,
          isError: !!result.isError,
          display: { kind: 'text', text: cut.text.slice(0, 4000) },
        };
      },
    };
  }

  close(): Promise<void> {
    this.closing ??= Promise.all(this.servers.map((s) => {
      const client = s.client;
      s.client = undefined;
      return client?.close().catch(() => {});
    })).then(() => {});
    return this.closing;
  }
}
