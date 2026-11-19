import type { FileContent } from '../util/file-content';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratchDir } from '../prompt/system';
import { SessionGoneError, type Runtime } from '../runtime';
import type { AgentEvent, Effort, ImagePart, Message, Mode, PermissionDecision, ToolResultPart } from '../types';
import { DEFAULTS, globalConfigPath, updateGlobalConfig, type ApiKind, type FavillaConfig, type Pricing } from '../config/config';
import { DEFAULT_THEME } from '../config/theme';
import { checkSettings, settingAt, settingBasis, SettingsConflict, SettingsError, type SettingBasis, type SettingPath } from '../config/document';
import { editSetting, settingChanges } from '../config/edit';
import { addressView, keepProxyPassword, keepSavedAddress, redactSecrets } from '../net/address';
import { rulesView, writeRule, type RuleKind } from '../config/rules';
import { folderGit } from '../prompt/env';
import { deletePersona, importPersona, personaAvatar, personasView, setFolderChoice as setPersonaFolderChoice, setGlobalChoice as setPersonaGlobalChoice, writePersona } from '../prompt/persona';
import { copyPreset, deletePreset, importPreset, moveToLibrary, presetsView, setGlobalChoice, setWorkspaceChoice, updatePreset, type PresetScope, type WorkspaceChoice } from '../prompt/preset';
import { readUiState, writeUiState } from '../config/ui-state';
import { changeMailAccount, checkMailAccount, usableMailAccounts, presetFor, PRESETS, type MailAccountSettings, type MailServer, type MailSettings } from '../mail/accounts';
import { envProxy } from '../net/http';
import { isBuiltinProvider } from '../catalog/catalog';
import { authPath, readAuthFile, updateAuthFile } from '../auth/store';
import { makeDiff } from '../tools/diffutil';
import { runRipgrep } from '../tools/ripgrep';
import { detectShell } from '../tools/shell';
import { randomToken } from '../util/id';
import { appPath, dirExists, isInside, isWindows, toForward } from '../util/paths';
import { findBrowser, openFavillaBrowser } from '../tools/browser';
import { servedIn } from '../tools/jobs';
import { previewOf } from './preview';
import { mcpConfigFrom, mcpConfigsIn, type McpServerConfig } from '../mcp/hub';
import { cleanStorage, sealView, storageView } from '../store/usage';
import { tokenStats } from '../store/token-stats';
import { importRecoveryKey, preloadDataKeys, recoveryKey } from '../store/seal';
import { RemoteLink } from '../remote/link';
import { BUILT_IN_FEED, installKind, Updater } from '../update/updater';
import { LanDoor, LAN_PORT, lanAddresses } from '../remote/lan';
import { devices as remoteDevices, forgetDevice, keepLanPort, lastLanPort, newPairingCode, pcKeys } from '../remote/store';
import { b64 } from '../remote/e2e';
import { addPush, pushDevices, pushKey, removePush, sendPush, type PushKind, type PushSubscriptionJSON } from '../remote/push';

/**
 * The relay remote control goes through unless the settings name another. A build fixes it (core/scripts/
 * build-defines.mjs); a build that names none has none, and remote control waits for the user's own relay.
 */
const DEFAULT_RELAY = process.env.FAVILLA_DEFAULT_RELAY ?? '';
/** Touched within two minutes, the computer has its user at it: no phone is notified. */
const AT_COMPUTER_S = 120;
/** A connected phone that said this recently that it has Favilla in view needs no notification. */
const LOOKING_MS = 45_000;
import { debug } from '../util/log';
import { fullContent, fullDisplay, lighten, lightResult } from '../store/pack';
import { extensionInfo, extensionSettingKeys, extensionSettingValue, loadExtensions } from '../extensions/registry';
import { listenForBrowser } from '../net/browser-port';
import { timedSync } from '../util/slow';
import { findInSession } from './find';
import { EventJournal } from './event-journal';
import { followedSessions } from './follow';
import { SessionHeldError } from '../store/locks';
import pkg from '../../package.json';

export interface ServerOptions {
  runtime: Runtime;
  host?: string;
  port?: number;
  token?: string;
  /** Built web UI to serve; API only when absent. */
  webDir?: string;
  allowHosts?: string[];
  /** Native folder picker (desktop app). */
  pickFolder?: () => Promise<string | null>;
  openExternal?: (url: string) => void;
  version?: string;
  /** Seconds since the user last touched this computer (the desktop app): phones are not notified while they are at it. */
  idleSeconds?: () => number;
}

export interface ServerHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readMode(mode: unknown): Mode | undefined {
  if (mode === undefined || mode === 'build' || mode === 'plan') return mode;
  throw new HttpError(400, 'A mode is build or plan.');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

// A preview frames the page a session serves, through its proxy on this computer (preview.ts).
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self'; frame-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function readBody(req: http.IncomingMessage, limit = 40 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Folders no one works in on purpose: the temp folder (benchmarks, tests) and eval runs. */
function scratch(dir: string): boolean {
  const p = path.resolve(dir).toLowerCase();
  return p.startsWith(path.resolve(os.tmpdir()).toLowerCase()) || /[\\/](?:favilla-eval|evals[\\/]runs)(?:[\\/]|$)/.test(p);
}

/** Context windows set in the settings, as "provider/model" refs. */
function windowOverrides(cfg: FavillaConfig): { ref: string; contextWindow: number }[] {
  const out: { ref: string; contextWindow: number }[] = [];
  for (const [pid, p] of Object.entries(cfg.providers ?? {})) {
    for (const [mid, m] of Object.entries(p?.models ?? {})) if (m?.contextWindow) out.push({ ref: `${pid}/${mid}`, contextWindow: m.contextWindow });
  }
  return out;
}

/** Models whose reading of pictures was set by hand. */
function visionOverrides(cfg: FavillaConfig): { ref: string; vision: boolean }[] {
  const out: { ref: string; vision: boolean }[] = [];
  for (const [pid, p] of Object.entries(cfg.providers ?? {})) {
    for (const [mid, m] of Object.entries(p?.models ?? {})) if (typeof m?.vision === 'boolean') out.push({ ref: `${pid}/${mid}`, vision: m.vision });
  }
  return out;
}

/**
 * The change list's diffs, by file and both contents: the app asks every turn's changes again after each turn, and one
 * large file's diff took 0.26 s of the engine's thread. Kept under 32 MB of patch text, oldest out first.
 */
const diffs = new Map<string, ReturnType<typeof makeDiff>>();
let diffChars = 0;
const changeOp = (before: FileContent, after: FileContent) => (before === null ? 'add' : after === null ? 'delete' : 'update');

function cachedDiff(file: string, before: FileContent, after: FileContent): ReturnType<typeof makeDiff> {
  const op = changeOp(before, after);
  if ((before !== null && typeof before === 'object') || (after !== null && typeof after === 'object')) return makeDiff(file, before, after, op);
  const hash = (s: string | null) => (s === null ? '-' : crypto.createHash('sha1').update(s).digest('hex'));
  const key = `${file}\0${op}\0${hash(before)}\0${hash(after)}`;
  const known = diffs.get(key);
  if (known) return known;
  const d = makeDiff(file, before, after, op);
  diffs.set(key, d);
  diffChars += d.patch.length;
  for (const [k, v] of diffs) {
    if (diffChars <= 32_000_000) break;
    diffs.delete(k);
    diffChars -= v.patch.length;
  }
  return d;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Media type from a blob's first bytes (images, or text for tool output). */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function sniffType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'text/plain; charset=utf-8';
}

function fuzzyScore(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  const base = c.slice(c.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 1000 - c.length;
  if (c.includes(q)) return 500 - c.length;
  let i = 0;
  let gaps = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 200 - gaps - c.length / 10;
  }
  return -1;
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const rt = opts.runtime;
  let keysLoading = preloadDataKeys();
  void keysLoading?.then(() => { keysLoading = undefined; });
  const token = opts.token ?? randomToken(24);
  const host = opts.host ?? '127.0.0.1';
  const opening = new Set<Promise<unknown>>();
  let closed = false;
  type WindowScope = { id: string; version: number; active?: string };
  type EventFeed = { res: http.ServerResponse; session?: string; window?: WindowScope; detach(): void };
  const sse = new Set<EventFeed>();
  const windows = new Map<string, EventFeed>();
  let journal: EventJournal | undefined;
  const fileCache = new Map<string, { at: number; files: string[] }>();
  let port = 0;

  function writeEvent(client: EventFeed, chunk: string): boolean {
    const { res } = client;
    if (!res.destroyed && !res.writableEnded) {
      try {
        res.write(chunk);
        return true;
      } catch { /* This connection can no longer receive events. */ }
    }
    client.detach();
    res.destroy();
    return false;
  }

  const broadcast = (event: unknown, session?: string, scoped = false, replay = event) => {
    if (!sse.size && !journal) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    const frame = journal?.append(replay === event ? line : `data: ${JSON.stringify(replay)}\n\n`, scoped ? session : undefined);
    for (const c of sse) {
      if (c.window) {
        if (!scoped || session === c.window.active) writeEvent(c, replay === event ? frame!.wire : `id: ${frame!.id}\n${line}`);
      } else if (!c.session || !session || c.session === session) writeEvent(c, line);
    }
  };

  // The UI gets images as links and long outputs as previews: a long session stays light in the window.
  const blobUrl = (id: string) => `/api/blob/${id}`;
  const lightEvent = (e: AgentEvent): AgentEvent => {
    switch (e.type) {
      case 'message.added':
      case 'message.updated':
        return { ...e, message: lighten(e.message, rt.store.blobs, blobUrl) };
      case 'tool.end':
        return { ...e, result: lightResult(e.result, rt.store.blobs, blobUrl) };
      case 'subagent':
        return { ...e, event: lightEvent(e.event) };
      default:
        return e;
    }
  };
  const unsubscribe = rt.subscribe((e) => {
    if (sse.size || journal) {
      const event = lightEvent(e);
      // Returned input is replayed from the session's unread queue, including after the ring wraps.
      const replay = event.type === 'queue' && event.returned ? { ...event, returned: undefined } : event;
      broadcast(event, e.sessionId, e.type === 'stream.text' || e.type === 'stream.reasoning', replay);
    }
    notifyPhones(e);
  });

  const unsubscribeSettings = rt.subscribeSettings((notice) => broadcast({ type: 'server.settings', notice }));

  // Newer versions, from the feed this build names (none in a build from source): the page shows an update button.
  const updater = new Updater({
    version: opts.version ?? pkg.version,
    feed: BUILT_IN_FEED,
    install: installKind(),
    cacheFile: appPath('update.json'),
    enabled: () => rt.config.updates?.check !== false,
    proxy: () => rt.config.proxy || envProxy() || false,
  });
  // Each change carries the whole view (a few hundred bytes, once a second at most while downloading): no request back.
  const unsubscribeUpdate = updater.onChange(() => broadcast({ type: 'server.update', update: updater.view() }));
  updater.start();

  const allowedHost = (h: string | undefined) => {
    if (!h) return false;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(opts.allowHosts ?? [])];
    return allowed.includes(h);
  };

  // Named by port: cookies are shared by every port of a host, and two Favilla servers must not sign each other out.
  const cookieName = () => `favilla_token_${port}`;

  // Remote control while the settings have it on (global config only, never a project's): one link out to the relay,
  // and a door for phones on the same network (lan.ts), each when it is set.
  let link: RemoteLink | null = null;
  let door: LanDoor | null = null;
  let doorAsked: number | undefined;
  const relayOf = () => (rt.config.remote?.relay || DEFAULT_RELAY).replace(/\/+$/, '');
  const lanOn = () => !!rt.config.remote?.enabled && rt.config.remote?.lan !== false && port > 0;
  // A port set in the settings, or none: then the one the door last opened on, so paired phones find it again.
  const lanPortSet = () => {
    const p = rt.config.remote?.lanPort;
    return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : undefined;
  };
  const syncRemote = () => {
    const want = !!rt.config.remote?.enabled && port > 0 && (!!relayOf() || lanOn());
    if (link && (!want || link.relay !== relayOf())) {
      link.stop();
      link = null;
    }
    if (want && !link) {
      link = new RemoteLink({ relay: relayOf(), port, token, proxy: rt.config.proxy || envProxy() || false, onState: () => broadcast({ type: 'server.remote' }) });
      link.start();
    }
    if (door && (!lanOn() || doorAsked !== lanPortSet())) {
      door.stop();
      door = null;
    }
    if (lanOn() && !door) {
      doorAsked = lanPortSet();
      const opened = (door = new LanDoor({
        webDir: opts.webDir,
        port: doorAsked ?? lastLanPort() ?? LAN_PORT,
        host: process.env.FAVILLA_LAN_HOST || undefined,
        pcId: async () => (await pcKeys()).id,
        link: () => link,
        onState: () => {
          if (opened.state === 'open') void pcKeys().then(() => keepLanPort(opened.port), () => {});
          broadcast({ type: 'server.remote' });
        },
      }));
      void opened.start();
    }
  };
  const remoteView = async () => {
    if (keysLoading) await keysLoading;
    const k = await pcKeys();
    const online = new Set(link?.connected() ?? []);
    const notified = new Set(pushDevices());
    const relay = addressView(relayOf(), true);
    return { basis: settingBasis(rt.globalSettings, ['enabled', 'relay', 'awake', 'lan'].map((k) => ['remote', k])), enabled: !!rt.config.remote?.enabled, awake: !!rt.config.remote?.awake, lan: rt.config.remote?.lan !== false, lanState: door?.state ?? 'off', lanError: door?.error, lanPort: door?.port ?? 0, lanAddresses: door?.state === 'open' ? lanAddresses() : [], relay: relay.address, relaySet: addressView(rt.config.remote?.relay ?? '', true).address, relayDefault: DEFAULT_RELAY, state: link?.state ?? 'off', error: redactSecrets(link?.error, [...relay.hidden, ...addressView(rt.config.proxy ?? '', true).hidden]), pc: k.id, devices: remoteDevices().map(({ pub: _pub, ...d }) => ({ ...d, online: online.has(d.id), notify: notified.has(d.id) })) };
  };

  // Phones that asked for notifications hear when work ends or waits for an answer: not while the user is at this
  // computer (it shows its own), not on a phone that has Favilla open, and once a session and kind in 15 seconds.
  const viewing = new Map<string, number>();
  const lastPush = new Map<string, number>();
  const notifyPhones = (e: AgentEvent) => {
    if (!rt.config.remote?.enabled) return;
    const kind: PushKind | null =
      e.type === 'turn.end'
        ? e.reason === 'done'
          ? 'done'
          : e.reason === 'max_steps'
            ? 'limit'
            : e.reason === 'aborted'
              ? null
              : 'failed'
        : e.type === 'permission.request' || e.type === 'question.request' || e.type === 'plan.request'
          ? 'ask'
          : null;
    if (!kind) return;
    const meta = rt.live.get(e.sessionId)?.meta ?? rt.store.metaOf(e.sessionId);
    if (!meta || meta.parentId || (opts.idleSeconds && opts.idleSeconds() < AT_COMPUTER_S)) return;
    const key = `${e.sessionId}:${kind}`;
    if (Date.now() - (lastPush.get(key) ?? 0) < 15_000) return;
    lastPush.set(key, Date.now());
    const online = new Set(link?.connected() ?? []);
    const looking = (d: string) => online.has(d) && Date.now() - (viewing.get(d) ?? 0) < LOOKING_MS;
    void sendPush(kind, e.sessionId, meta.title ?? '', { proxy: rt.config.proxy || envProxy() || false, contact: relayOf(), skip: looking }).catch((err) => debug('push', 'not sent', String(err)));
  };

  const authed = (req: http.IncomingMessage) => {
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    const cookie = req.headers.cookie ?? '';
    return cookie.split(/;\s*/).some((c) => c === `${cookieName()}=${token}`);
  };

  /**
   * The window's state as it was left; with nothing saved yet (a first start, or an update from a version that
   * kept it only in the page), the folders of the most recent sessions stand in for the recent folders, so the
   * sessions show up again where they were.
   */
  const uiState = async () => {
    const ui = readUiState();
    if (ui.recent?.length) return ui;
    if (keysLoading) await keysLoading;
    const recent: string[] = [];
    for (const m of rt.store.list({ limit: 300 })) {
      if (m.parentId || !m.cwd || recent.some((r) => r.toLowerCase() === m.cwd.toLowerCase()) || !dirExists(m.cwd) || scratch(m.cwd)) continue;
      recent.push(m.cwd);
      if (recent.length >= 8) break;
    }
    return recent.length ? { ...ui, folder: ui.folder ?? recent[0], recent } : ui;
  };

  const configFields = ['model', 'effort', 'language', 'theme', 'proxy', 'smallModel', 'subagentModel', 'shadowTests.model', 'guard.mode', 'answerFormat', 'maxSteps', 'bashTimeoutMs', 'webSearch', 'skills', 'browserPath', 'shell', 'tools', 'context.compactAt', 'computer', 'browser.visible', 'browser.keepLogins', 'browser.use', 'desktop.hardwareAcceleration', 'storage.encrypt', 'updates.check'];
  const providerFields = ['baseUrl', 'proxy', 'enabled', 'keyFile', 'slots'];
  const providerBasis = (id: string, models: string[], credentials: unknown) => {
    const p = ['providers', id];
    return {
      ...settingBasis(rt.globalSettings, [p, ...providerFields.map((k) => [...p, k]), ...models.flatMap((m) => {
        const at = [...p, 'models', m];
        return [at, [...at, 'contextWindow'], [...at, 'vision']];
      })]),
      ...settingBasis(credentials, [['keys', id]]),
    };
  };
  const mcpBasis = (name: string) => {
    const p = ['mcpServers', name];
    const raw = settingAt(rt.globalSettings, p);
    return settingBasis(rt.globalSettings, [p, ...['url', 'command', 'args', 'cwd', 'enabled'].map((k) => [...p, k]), ...['headers', 'env'].flatMap((k) => Object.keys(settingAt(raw, [k]) ?? {}).map((name) => [...p, k, name]))]);
  };
  const providersView = () => {
    const own = rt.config.providers ?? {};
    let credentials = rt.credentials;
    const auth = readAuthFile(undefined, 'reload', (raw) => { credentials = raw; });
    return rt.catalog.providers(auth).map((p) => {
      const { configured, models, error } = rt.catalog.providerListing(p);
      const mine = own[p.id]?.models ?? {};
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        api: p.api,
        auth: p.auth,
        local: p.local,
        serial: p.serial,
        baseUrl: addressView(p.baseUrl, true).address,
        basis: providerBasis(p.id, Object.keys(mine), credentials),
        configured,
        custom: !isBuiltinProvider(p.id),
        keys: p.keys.length,
        error,
        models: configured ? models : [],
        // Added by hand in the settings: in the user's own file and not among what the server lists.
        added: models
          .filter((m) => !m.discovered && Object.prototype.hasOwnProperty.call(mine, m.id))
          .map((m) => ({ id: m.id, contextWindow: m.contextWindow })),
      };
    });
  };

  // Sessions this process only reads: another process holds them, or they are in another Favilla folder.
  const followed = followedSessions(rt);

  const sessionView = async (id: string) => {
    const home = followed.homeOf(id);
    if (home) {
      const view = followed.view(id, home);
      if (!view) throw new HttpError(404, 'No such session');
      return view;
    }
    let s: Awaited<ReturnType<typeof rt.get>>;
    try {
      s = await rt.get(id, { interactive: true });
    } catch (e) {
      // Held by another process: shown as it is on disk, and followed while a page has it open.
      const view = e instanceof SessionHeldError ? followed.view(id) : null;
      if (view) return view;
      throw e;
    }
    return {
      meta: s.meta,
      messages: timedSync('view built', () => s.messages.map((m) => lighten(m, rt.store.blobs, blobUrl))),
      activeStart: s.activeStart,
      todos: s.todos,
      usage: { ...s.usage, contextTokens: s.contextTokens },
      status: s.status,
      pending: s.pendingRequests(),
      queued: s.queued,
      held: s.held,
      model: s.modelInfo,
      turns: s.checkpoints.turns(),
      live: s.liveState(),
      returned: s.unreadInputs(),
    };
  };

  /** A path as an answer writes it, on this computer: a file: URL, a Git Bash /c/… path, or relative to `cwd`. */
  function askedPath(raw: string, cwd: string): string {
    try {
      return /^file:/i.test(raw) ? fileURLToPath(raw) : path.resolve(cwd, raw.replace(/^\/([a-z])\//i, '$1:/'));
    } catch {
      throw new HttpError(400, 'Not a path');
    }
  }

  async function listFiles(cwd: string): Promise<string[]> {
    const now = Date.now();
    const hit = fileCache.get(cwd);
    if (hit && now - hit.at < 30_000) return hit.files;
    // A folder may never be opened again. Drop its listing once it can no longer be served from cache.
    for (const [dir, cached] of fileCache) if (now - cached.at >= 30_000) fileCache.delete(dir);
    const r = await runRipgrep(['--files', '--hidden', '--glob', '!.git', '--glob', '!node_modules'], cwd, AbortSignal.timeout(8000), 8_000_000);
    const files = r.stdout.split(/\r?\n/).filter(Boolean).map((f) => toForward(f));
    fileCache.set(cwd, { at: Date.now(), files });
    return files;
  }

  function listDirs(dir: string): { path: string; parent: string | null; dirs: { name: string; path: string }[]; roots: { name: string; path: string }[] } {
    const roots: { name: string; path: string }[] = [{ name: 'Home', path: os.homedir() }];
    if (isWindows) for (const letter of 'CDEFGHIJ') if (dirExists(`${letter}:\\`)) roots.push({ name: `${letter}:`, path: `${letter}:\\` });
    const target = dir && dirExists(dir) ? path.resolve(dir) : os.homedir();
    let dirs: { name: string; path: string }[] = [];
    try {
      dirs = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) || a.name.localeCompare(b.name));
    } catch {
      /* unreadable folder */
    }
    const parent = path.dirname(target) === target ? null : path.dirname(target);
    return { path: target, parent, dirs, roots };
  }

  function findResult(messages: Message[], callId: string | undefined): ToolResultPart | null {
    if (!callId) return null;
    for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result' && p.callId === callId) return p;
    return null;
  }

  function childResult(sessionId: string, callId: string | undefined): ToolResultPart | null {
    for (const child of rt.store.list({ children: true }).filter((m) => m.parentId === sessionId)) {
      // A sub-agent still at work lives in its parent, not in rt.live; its file lags behind its latest results.
      const running = [...rt.live.values()].map((s) => s.descendant(child.id)).find(Boolean);
      const rec = running ?? rt.live.get(child.id) ?? rt.store.load(child.id);
      const hit = rec && (findResult(rec.messages, callId) ?? childResult(child.id, callId));
      if (hit) return hit;
    }
    return null;
  }

  /** Blobs are named by their content, so the browser may keep them for good. */
  function sendBlob(res: http.ServerResponse, id: string): void {
    const data = rt.store.blobs.get(id);
    if (!data) throw new HttpError(404, 'No such blob');
    res.writeHead(200, { 'Content-Type': sniffType(data), 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }

  const projectOf = async (id: string, remote: boolean) => {
    const live = rt.live.get(id);
    if (live) return live.meta.cwd;
    if (keysLoading) await keysLoading;
    const meta = rt.store.metaOf(id);
    if (!meta && remote) throw new HttpError(403, 'A session is required');
    return meta?.cwd ?? rt.cwd;
  };

  async function remoteFile(file: string, cwd: string, id: string): Promise<string> {
    const real = await fs.promises.realpath(file).catch(() => null);
    if (!real) throw new HttpError(404, 'No such file');
    for (const dir of [cwd, scratchDir(cwd)]) {
      const root = await fs.promises.realpath(dir).catch(() => null);
      if (root && isInside(root, real)) return real;
    }
    const forms = [real, toForward(real), pathToFileURL(real).href, toForward(path.relative(cwd, real))];
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mention = new RegExp(`(?:^|[\\s"'\\x60(<])(?:${forms.filter(Boolean).map(escape).join('|')})(?=$|[\\s"'\u0060)>]|:\\d+\\b|#L\\d+\\b|[.,!?](?:\\s|$))`, isWindows ? 'i' : '');
    const session = rt.live.get(id) ?? rt.store.load(id);
    if (session?.messages.some((m) => m.parts.some((p) =>
      p.type === 'text' ? mention.test(p.text) : p.type === 'tool_result' ? mention.test(p.content) :
      p.type === 'image' && !!p.sourcePath && mention.test(p.sourcePath)))) return real;
    throw new HttpError(403, 'File is outside this session');
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const method = req.method ?? 'GET';
    const [a, b, c, d] = parts;

    if (a === 'events' && b && method === 'PUT') {
      const body = await readBody(req);
      const client = windows.get(b);
      const scope = client?.window;
      if (!client || !scope || !Number.isSafeInteger(body.version) || body.version < 0) {
        res.writeHead(404).end();
        return;
      }
      if (body.version > scope.version) {
        scope.version = body.version;
        scope.active = typeof body.session === 'string' ? body.session : undefined;
        const draft = scope.active ? rt.live.get(scope.active)?.liveState().draft : null;
        // The snapshot and all following pieces are ordered on the same connection.
        writeEvent(client, `event: draft\ndata: ${JSON.stringify({ version: scope.version, session: scope.active, draft: draft ?? null })}\n\n`);
      }
      res.writeHead(204).end();
      return;
    }

    if (a === 'events' && !b && method === 'GET') {
      const id = url.searchParams.get('window');
      const version = Number(url.searchParams.get('scope'));
      const window: WindowScope | undefined = id && /^[a-f0-9]{32}$/.test(id) && Number.isSafeInteger(version) && version >= 0
        ? { id, version, active: url.searchParams.get('active') || undefined }
        : undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(window ? { 'X-Favilla-Event-Replay': '1' } : {}) });
      const ping = setInterval(() => writeEvent(client, ': ping\n\n'), 15_000);
      const client: EventFeed = {
        res, session: url.searchParams.get('session') ?? undefined, window,
        detach() {
          clearInterval(ping);
          sse.delete(client);
          if (window && windows.get(window.id) === client) windows.delete(window.id);
        },
      };
      res.once('close', client.detach);
      res.once('error', () => { client.detach(); res.destroy(); });
      if (!writeEvent(client, 'retry: 1500\n\n')) return;
      if (window) {
        journal ??= new EventJournal(randomToken(8));
        const active = window.active ? rt.live.get(window.active) : undefined;
        const missed = !window.active || active ? journal.since(url.searchParams.get('after'), window.active) : undefined;
        if (!writeEvent(client, 'event: replay\ndata: {}\n\n')) return;
        for (const f of missed ?? []) if (!writeEvent(client, f.wire)) return;
        const returned = active?.unreadInputs();
        if (returned?.length && !writeEvent(client, `data: ${JSON.stringify({ type: 'queue', sessionId: active!.id, items: active!.queued, returned })}\n\n`)) return;
        if (!writeEvent(client, `id: ${journal.cursor}\nevent: ready\ndata: ${JSON.stringify({ resumed: missed !== undefined })}\n\n`)) return;
        const previous = windows.get(window.id);
        if (previous) {
          previous.detach();
          previous.res.end();
        }
        windows.set(window.id, client);
      }
      sse.add(client);
      return;
    }

    if (method === 'GET' && ['info', 'mcp', 'providers', 'mail', 'remote', 'storage'].includes(a)) rt.refreshSettings();

    if (a === 'mcp') {
      // MCP servers for the settings page: their state and settings, with the names of env vars and headers but
      // never their values, which stay in the global config file.
      const view = () => {
        const configs = rt.mcp.configs();
        return rt.mcp.status().map((s) => {
          const c = configs[s.name];
          const config = !c ? null : 'url' in c ? { url: addressView(c.url, true).address, headers: Object.keys(c.headers ?? {}), enabled: c.enabled !== false } : { command: c.command, args: c.args ?? [], env: Object.keys(c.env ?? {}), cwd: c.cwd ?? '', enabled: c.enabled !== false };
          return { ...s, config, basis: mcpBasis(s.name) };
        });
      };
      if (!b && method === 'GET') return send(res, 200, view());
      if (method === 'POST') {
        const body = await readBody(req);
        const name = String(body.name ?? '').trim();
        const write = (prepare: (current: FavillaConfig) => [SettingPath, unknown][], basis?: SettingBasis) => {
          const paths: [SettingPath, unknown][] = [];
          updateGlobalConfig((current) => { paths.push(...prepare(current)); return {}; }, paths, basis);
          rt.reload();
          broadcast({ type: 'server.config' });
        };
        if (b === 'save') {
          const from = String(body.from ?? name);
          const p = ['mcpServers', from];
          const to = ['mcpServers', name];
          if (!/^[\w.-]{1,40}$/.test(name)) throw new HttpError(400, 'A server name is letters, digits, dots, dashes or underscores, at most 40.');
          const opened = rt.mcp.configs()[from];
          // Blank saved values identify fields the form kept. Compare the form's two versions independently of the disk.
          const masked = (input: Record<string, unknown>, before?: McpServerConfig) => mcpConfigFrom({
            ...input, ...Object.fromEntries(['headers', 'env'].flatMap((key) => Array.isArray(input[key])
              ? [[key, input[key].map(({ name, value }) => ({ name, value: value ?? (!before || settingAt(before, [key, name]) !== undefined ? '' : undefined) }))]] : [])),
          });
          const shown = (c: McpServerConfig) => 'url' in c
            ? { ...c, url: addressView(c.url, true).address, kind: 'url', headers: Object.keys(c.headers ?? {}).map((name) => ({ name })) }
            : { ...c, kind: 'command', env: Object.keys(c.env ?? {}).map((name) => ({ name })) };
          const before = body.before === undefined ? opened && masked(shown(opened)) : body.before && masked(body.before);
          const after = before ? masked(body.config, before) : mcpConfigFrom(body.config);
          const basis = body.basis ?? mcpBasis(from);
          write((current) => {
            const old = settingAt(current, p) as McpServerConfig | undefined;
            if (!before || !old) {
              checkSettings(globalConfigPath(), basis, current, [p, to]);
              if (body.from || before || settingAt(current, to) !== undefined) throw new SettingsConflict(globalConfigPath());
              return [[to, after]];
            }
            const edits = settingChanges(before, after, p);
            checkSettings(globalConfigPath(), basis, current, edits.map(([at]) => at));
            if (from === name) return edits;
            if (settingAt(current, to) !== undefined) throw new SettingsConflict(globalConfigPath());
            let moved = JSON.stringify(old);
            for (const [at, value] of edits) moved = editSetting(moved, at.slice(p.length), value);
            return [[p, undefined], [to, JSON.parse(moved)]];
          });
          return send(res, 200, view());
        }
        if (b === 'import') {
          const found = mcpConfigsIn(String(body.text ?? ''));
          if (!found.length) throw new HttpError(400, 'No MCP server found in that text: paste the "mcpServers" block of a README, or one server with a command or a url.');
          write((current) => found.flatMap(([n, cfg]) => {
            const p = ['mcpServers', n || name || 'server'];
            const old = settingAt(current, p);
            if (old === undefined) return [[p, cfg]];
            const other = 'url' in cfg ? 'command' : 'url';
            const fields = settingChanges(undefined, cfg, p);
            if (settingAt(old, [other]) !== undefined) fields.push([[...p, other], undefined]);
            return fields;
          }), body.basis);
          return send(res, 200, view());
        }
        if (b === 'delete') {
          write(() => [[['mcpServers', name], undefined]], body.basis);
          return send(res, 200, view());
        }
        if (b === 'restart') {
          await rt.mcp.restart(name);
          return send(res, 200, view());
        }
      }
    }
    if (a === 'blob' && b && method === 'GET') {
      if (keysLoading) await keysLoading;
      const home = url.searchParams.get('home');
      if (home !== null) {
        const data = followed.home(Number(home))?.store.blobs.get(b);
        if (!data) throw new HttpError(404, 'No such blob');
        res.writeHead(200, { 'Content-Type': sniffType(data), 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        return void res.end(data);
      }
      return sendBlob(res, b);
    }
    if (a === 'image' && method === 'GET') {
      // A picture an answer shows by its path on this computer (![icon](design/icon.png)): a relative path is the
      // session's project's. Pictures only, read without holding up the thread.
      const id = url.searchParams.get('session') ?? '';
      const raw = (url.searchParams.get('path') ?? '').trim();
      // A picture a tool showed the model, by the short name its result gave it (![the page](pic:3f9a2c1b7d4e)): kept
      // in the blob store, and served only when it is a picture.
      const pic = /^pic:([0-9a-f]{12,40})$/i.exec(raw);
      if (pic) {
        const blob = rt.store.blobs.find(pic[1].toLowerCase());
        if (blob && keysLoading) await keysLoading;
        const data = blob ? rt.store.blobs.get(blob) : null;
        if (!blob || !data) throw new HttpError(404, 'No such picture');
        if (!sniffType(data).startsWith('image/')) throw new HttpError(415, 'Not a picture');
        return sendBlob(res, blob);
      }
      const remote = req.headers['x-favilla-device'] !== undefined;
      const cwd = await projectOf(id, remote);
      const asked = askedPath(raw, cwd);
      const file = remote ? await remoteFile(asked, cwd, id) : asked;
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (!type) throw new HttpError(415, 'Not a picture');
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, 'No such picture');
      if (st.size > 30 * 1024 * 1024) throw new HttpError(413, 'Picture too large');
      const data = await fs.promises.readFile(file);
      // A picture opened on its own must not run as part of the app (an SVG can hold scripts).
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      res.end(data);
      return;
    }
    if (a === 'file' && method === 'GET') {
      // A file an answer names (`src/store.ts:42`, a path in full, or its name alone), for the app's file view: a
      // relative path is the session's project's. Text only, up to 2 MB; with `stat`, where it is and nothing more.
      const id = url.searchParams.get('session') ?? '';
      const raw = (url.searchParams.get('path') ?? '').trim();
      const remote = req.headers['x-favilla-device'] !== undefined;
      const cwd = await projectOf(id, remote);
      let file = askedPath(raw, cwd);
      let st = await fs.promises.stat(file).catch(() => null);
      let others = 0;
      if (!st) {
        // Not where it says: the project's file whose path ends the most like it (a path from another checkout or
        // machine, `store/sessions.ts`, the name alone); the nearest the root when more end so.
        const parts = toForward(raw.replace(/^file:\/*/i, '')).replace(/^[a-z]:/i, '').split('/').filter((p) => p && p !== '.');
        const files = parts.length ? await listFiles(cwd).catch(() => [] as string[]) : [];
        for (let k = 0; k < parts.length && !st; k++) {
          const tail = `/${parts.slice(k).join('/')}`.toLowerCase();
          const found = files.filter((f) => `/${f}`.toLowerCase().endsWith(tail)).sort((x, y) => x.length - y.length);
          if (!found.length) continue;
          file = path.join(cwd, found[0]);
          st = await fs.promises.stat(file).catch(() => null);
          others = found.length - 1;
        }
      }
      if (!st?.isFile()) throw new HttpError(404, 'No such file');
      if (remote) file = await remoteFile(file, cwd, id);
      const where = { path: file, relative: toForward(path.relative(cwd, file)), cwd, others };
      if (url.searchParams.has('stat')) return send(res, 200, where);
      if (st.size > 2 * 1024 * 1024) throw new HttpError(413, 'Too large to show here');
      const data = await fs.promises.readFile(file);
      if (data.subarray(0, 8000).includes(0)) throw new HttpError(415, 'Not a text file');
      return send(res, 200, { ...where, content: data.toString('utf8') });
    }
    if (a === 'info' && method === 'GET') {
      const cfg = rt.config;
      const proxy = addressView(cfg.proxy ?? '', true);
      await loadExtensions();
      return send(res, 200, {
        version: opts.version ?? pkg.version,
        cwd: rt.cwd,
        home: os.homedir(),
        platform: process.platform,
        desktop: !!opts.pickFolder,
        config: { model: cfg.model, effort: cfg.effort, language: cfg.language ?? 'auto', theme: cfg.theme ?? DEFAULT_THEME, proxy: proxy.address, proxyPasswordSaved: proxy.passwordSaved, smallModel: cfg.smallModel ?? '', subagentModel: cfg.subagentModel ?? '', shadowModel: cfg.shadowTests?.model ?? '', guard: cfg.guard?.mode ?? 'confirm', webSearch: cfg.webSearch ?? true, skills: cfg.skills !== false, shell: cfg.shell ?? 'bash', answerFormat: cfg.answerFormat === 'plain' ? 'plain' : 'structured', tools: cfg.tools ?? DEFAULTS.tools, globalConfig: globalConfigPath(), compactAt: cfg.context?.compactAt ?? DEFAULTS.context.compactAt, windows: windowOverrides(cfg), visions: visionOverrides(cfg), computer: !!cfg.computer, lowMemory: cfg.desktop?.hardwareAcceleration === false, browser: cfg.browser?.use === 'edge' || cfg.browser?.use === 'chrome' ? cfg.browser.use : cfg.browser?.visible ? 'visible' : cfg.browser?.keepLogins ? 'keep' : 'fresh', browserPath: cfg.browserPath ?? '', browserFound: !!findBrowser(cfg.browserPath) },
        shell: (({ name, path, fallback }) => ({ name, path, fallback }))(detectShell(cfg.shell)),
        ui: await uiState(),
        settingsNotices: rt.settingsNotices,
        basis: settingBasis(rt.globalSettings, [...configFields, ...extensionSettingKeys()].map((k) => k.split('.'))),
        // What the installed extensions bring: their settings with the values set, and their words for the cards.
        extensions: extensionInfo(cfg),
      });
    }

    if (a === 'browser' && b === 'open' && method === 'POST') {
      // Favilla's browser for the user to sign in to sites; the agent's sessions attach to it. Signing in there is
      // only of use when sessions keep that profile, so a fresh-profile setting moves to keeping logins.
      const exe = findBrowser(rt.config.browserPath);
      if (!exe) throw new HttpError(404, 'No Chrome, Chromium or Edge was found (Settings > Tools sets its path).');
      if (!rt.config.browser?.visible && !rt.config.browser?.keepLogins) {
        updateGlobalConfig({ 'browser.keepLogins': true }, []);
        rt.reload();
        broadcast({ type: 'server.config' });
      }
      const how = await openFavillaBrowser(exe, appPath('browser-profile'));
      return send(res, 200, { ok: how === 'opened' || how === 'started', how });
    }

    if (a === 'config' && method === 'PUT') {
      const body = await readBody(req);
      const changes: Record<string, unknown> = {};
      for (const k of configFields) if (k in body) changes[k] = body[k] === '' ? undefined : body[k];
      await loadExtensions();
      for (const k of extensionSettingKeys()) if (k in body) changes[k] = extensionSettingValue(k, body[k]);
      const paths: [string[], unknown][] = [];
      // A model's context window, set or (null) back to what the provider reports: "provider/model-id", where the id may hold dots and slashes.
      for (const w of Array.isArray(body.windows) ? (body.windows as { ref: string; contextWindow: number | null }[]) : []) {
        const cut = String(w.ref).indexOf('/');
        if (cut <= 0) continue;
        const n = Number(w.contextWindow);
        paths.push([['providers', w.ref.slice(0, cut), 'models', w.ref.slice(cut + 1), 'contextWindow'], w.contextWindow === null || !(n >= 4096) ? undefined : Math.round(n)]);
      }
      // Whether a model reads pictures, set by hand where the provider and the catalogue say nothing or are wrong.
      for (const v of Array.isArray(body.visions) ? (body.visions as { ref: string; vision: boolean | null }[]) : []) {
        const cut = String(v.ref).indexOf('/');
        if (cut <= 0) continue;
        paths.push([['providers', v.ref.slice(0, cut), 'models', v.ref.slice(cut + 1), 'vision'], typeof v.vision === 'boolean' ? v.vision : undefined]);
      }
      updateGlobalConfig((current) => {
        if (typeof changes.proxy === 'string') changes.proxy = keepProxyPassword(changes.proxy, current.proxy);
        if (body.providers && typeof body.providers === 'object') {
          for (const [pid, ps] of Object.entries(body.providers as Record<string, Record<string, unknown>>)) {
            for (const [k, v] of Object.entries(ps)) {
              if (!providerFields.includes(k)) continue;
              const prior = current.providers?.[pid];
              const value = k === 'baseUrl' && typeof v === 'string' ? keepSavedAddress(v, prior?.baseUrl) : v;
              paths.push([['providers', pid, k], value === '' ? undefined : value]);
            }
          }
        }
        return changes;
      }, paths, body.basis);
      rt.reload();
      broadcast({ type: 'server.config' });
      return send(res, 200, { ok: true });
    }

    if (a === 'mail') {
      const settings = () => (rt.config as { mail?: MailSettings }).mail ?? {};
      const passwordOf = (address: string) => settingAt(rt.credentials, ['mail', address.toLowerCase()]);
      // Mail accounts for Settings: never their passwords, only whether one is saved.
      const view = () => {
        const s = settings();
        const accounts = usableMailAccounts(s);
        const raw = settingAt(rt.globalSettings, ['mail', 'accounts']);
        const byAddress = { accounts: Object.fromEntries((Array.isArray(raw) ? raw : []).filter((a) => typeof a?.address === 'string').map((a) => [a.address.toLowerCase(), a])) };
        return {
          basis: {
            ...settingBasis(rt.globalSettings, [['mail', 'default'], ['mail', 'sendWithoutAsking']]),
            ...settingBasis(byAddress, Object.keys(byAddress.accounts).flatMap((id) => {
              const p = ['accounts', id];
              return [p, [...p, 'name'], [...p, 'user'], ...['imap', 'smtp'].flatMap((k) => ['host', 'port', 'secure'].map((v) => [...p, k, v]))];
            })),
            ...settingBasis(rt.credentials, accounts.map(({ address }) => ['mail', address.toLowerCase()])),
          },
          accounts: accounts.map(({ address, name, user, provider, imap, smtp }) => ({
            address, name, user, provider, hasPassword: !!passwordOf(address),
            imap: { host: imap.host, port: imap.port, secure: imap.secure },
            smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
          })),
          default: s.default ?? accounts[0]?.address ?? null,
          sendWithoutAsking: !!s.sendWithoutAsking,
          presets: PRESETS.map((p) => ({ provider: p.provider, passwords: p.passwords })),
        };
      };
      if (!b && method === 'GET') return send(res, 200, view());
      if (!b && method === 'PUT') {
        const body = await readBody(req);
        const changes: [string[], unknown][] = [];
        if ('default' in body) changes.push([['mail', 'default'], body.default || undefined]);
        if ('sendWithoutAsking' in body) changes.push([['mail', 'sendWithoutAsking'], body.sendWithoutAsking ? true : undefined]);
        updateGlobalConfig({}, changes, body.basis);
        rt.reload();
        broadcast({ type: 'server.config' });
        return send(res, 200, view());
      }
      if (b === 'accounts' && method === 'POST') {
        // An account added or changed: servers from the provider when not given, then a sign-in to both before it is kept.
        const body = await readBody(req);
        const address = String(body.address ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, 'Give an email address.');
        const id = address.toLowerCase();
        rt.refreshSettings();
        const touched: SettingPath[] = [
          ...['name', 'user'].filter((k) => typeof body[k] === 'string').map((k) => [k]),
          ...['imap', 'smtp'].flatMap((k) => ['host', 'port', 'secure'].filter((v) => body[k]?.host && Object.hasOwn(body[k], v)).map((v) => [k, v])),
        ];
        // Report a stale form before trying a password. Check again under the writer's lock.
        checkMailAccount(id, rt.globalSettings, touched, body.basis);
        const known = usableMailAccounts(settings()).find((x) => x.address.toLowerCase() === id);
        const preset = presetFor(address);
        const server = (v: unknown, fallback?: MailServer): MailServer | undefined => {
          const o = (v ?? {}) as Partial<MailServer>;
          if (!o.host) return fallback;
          const secure = typeof o.secure === 'boolean' ? o.secure : fallback?.secure ?? true;
          return { host: String(o.host).trim(), port: Number(o.port) || fallback?.port || (secure ? 993 : 587), secure };
        };
        const imap = server(body.imap, known?.imap ?? preset?.imap);
        const smtp = server(body.smtp, known?.smtp ?? preset?.smtp);
        if (!imap || !smtp) throw new HttpError(400, 'This provider is not known: give its IMAP and SMTP servers.');
        const user = typeof body.user === 'string' ? body.user : known?.user;
        const account: MailAccountSettings = { address, ...(body.name ? { name: String(body.name) } : known?.name ? { name: known.name } : {}), ...(user ? { user } : {}), provider: preset?.provider ?? known?.provider ?? 'imap', imap, smtp };
        const fields: [SettingPath, unknown][] = touched.map((at) => [at, at.length === 1 && body[at[0]] === '' ? undefined : settingAt(account, at)]);
        const typedPassword = typeof body.password === 'string' && body.password ? body.password.replace(/\s+/g, '') : undefined;
        if (typedPassword !== undefined) checkSettings(authPath(), body.basis, rt.credentials, [['mail', id]]);
        const password = typedPassword ?? passwordOf(address);
        if (typeof password !== 'string' || !password) throw new HttpError(400, 'Give the app password for this account.');
        try {
          const { MailClient } = await import('../mail/client');
          await new MailClient(account, password, rt.config.proxy ?? envProxy() ?? false).test();
        } catch (e) {
          throw new HttpError(400, `Could not sign in: ${redactSecrets((e as Error & { responseText?: string }).responseText ?? (e as Error).message, [password])}`);
        }
        changeMailAccount(id, account, fields, typedPassword, body.basis);
        rt.reload();
        broadcast({ type: 'server.config' });
        return send(res, 200, view());
      }
      if (b === 'accounts' && c && method === 'DELETE') {
        const { basis } = await readBody(req);
        changeMailAccount(decodeURIComponent(c).toLowerCase(), undefined, [], undefined, basis);
        rt.reload();
        broadcast({ type: 'server.config' });
        return send(res, 200, view());
      }
    }

    if (a === 'providers') {
      if (!b && method === 'GET') return send(res, 200, providersView());
      if (!b && method === 'POST') {
        // A provider of the user's own: a name, the request format it speaks, its address, a key, and model ids when it lists none.
        const body = await readBody(req);
        const name = String(body.name ?? '').trim();
        const kind = String(body.api ?? '') as ApiKind;
        const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '');
        if (!name) throw new HttpError(400, 'Give the provider a name.');
        if (!['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(kind)) throw new HttpError(400, `Unknown request format "${kind}".`);
        if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new HttpError(400, 'The base URL must start with http:// or https://.');
        const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
        let id = stem;
        const key = String(body.key ?? '').trim();
        const local = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(baseUrl);
        const models = Array.isArray(body.models) ? Object.fromEntries((body.models as unknown[]).map((m) => [String(m).trim(), {}]).filter(([m]) => m)) : {};
        const settings = {
          name,
          api: kind,
          baseUrl,
          discover: kind === 'anthropic' ? 'anthropic' : kind === 'gemini' ? 'gemini' : 'openai',
          ...(local ? { local: true } : {}),
          ...(local && !key ? { auth: 'none' } : {}),
          ...(Object.keys(models).length ? { models } : {}),
        };
        const write = (keys?: Record<string, string>) => {
          const paths: [SettingPath, unknown][] = [];
          updateGlobalConfig((current) => {
            for (let n = 2; isBuiltinProvider(id) || Object.hasOwn(current.providers ?? {}, id) || Object.hasOwn(keys ?? {}, id); n++) id = `${stem}-${n}`;
            paths.push([['providers', id], settings]);
            return {};
          }, paths);
        };
        if (key) updateAuthFile((f) => {
          write(f.keys);
          return { ...f, keys: { ...f.keys, [id]: key } };
        });
        else write();
        rt.reload();
        await rt.catalog.discover(id, true).catch(() => {});
        broadcast({ type: 'server.config' });
        return send(res, 200, providersView().find((p) => p.id === id));
      }
      if (b && !c && method === 'DELETE') {
        if (isBuiltinProvider(b)) throw new HttpError(400, 'Built-in providers can be turned off, not removed.');
        const { basis } = await readBody(req);
        updateAuthFile((f) => {
          checkSettings(authPath(), basis, f, [['keys', b]]);
          updateGlobalConfig({}, [[['providers', b], undefined]], basis);
          const keys = { ...f.keys };
          delete keys[b];
          return { ...f, keys };
        });
        rt.reload();
        broadcast({ type: 'server.config' });
        return send(res, 200, { ok: true });
      }
      if (b && c === 'discover' && method === 'POST') {
        await rt.catalog.discover(b, true);
        return send(res, 200, providersView().find((p) => p.id === b));
      }
      if (b && c === 'key' && method === 'POST') {
        const { key, basis } = await readBody(req);
        updateAuthFile((f) => {
          checkSettings(authPath(), basis, f, [['keys', b]]);
          rt.refreshSettings();
          if (basis && !isBuiltinProvider(b) && !Object.hasOwn(rt.globalSettings.providers ?? {}, b)) throw new SettingsConflict(globalConfigPath());
          const keys = { ...f.keys };
          if (key) keys[b] = String(key).trim();
          else delete keys[b];
          return { ...f, keys };
        });
        await rt.catalog.discover(b, true).catch(() => {});
        return send(res, 200, providersView().find((p) => p.id === b));
      }
      if (b && c === 'models' && (method === 'POST' || method === 'DELETE')) {
        // A model the server does not list, added or removed by hand. The id goes in the body: it may hold slashes and dots.
        const body = await readBody(req);
        const id = String(body.id ?? '').trim();
        if (!id || /\s/.test(id)) throw new HttpError(400, 'Give the model id as the provider names it, without spaces.');
        if (!rt.catalog.providers().some((p) => p.id === b)) {
          if (body.basis) throw new SettingsConflict(globalConfigPath());
          throw new HttpError(404, `Unknown provider "${b}".`);
        }
        if (method === 'DELETE') updateGlobalConfig({}, [[['providers', b, 'models', id], undefined]], body.basis);
        else {
          const n = Number(body.contextWindow);
          const paths: [string[], unknown][] = [];
          updateGlobalConfig((current) => {
            const kept = current.providers?.[b]?.models?.[id] ?? {};
            paths.push([['providers', b, 'models', id], { ...kept, ...(n >= 4096 ? { contextWindow: Math.round(n) } : {}) }]);
            return {};
          }, paths, body.basis);
        }
        rt.reload();
        broadcast({ type: 'server.config' });
        return send(res, 200, providersView().find((p) => p.id === b));
      }
    }

    if (a === 'ui-state') {
      if (method === 'GET') return send(res, 200, readUiState());
      if (method === 'PUT') return send(res, 200, writeUiState(await readBody(req)));
    }

    if (a === 'rules') {
      // The window of the default model sizes how much of the instruction files a new session takes in.
      const windowOf = () => {
        try {
          return rt.catalog.resolve(rt.config.model).contextWindow;
        } catch {
          return 200_000;
        }
      };
      if (method === 'GET') return send(res, 200, rulesView(url.searchParams.get('cwd') || rt.cwd, rt.config, windowOf()));
      if (method === 'PUT') {
        const body = await readBody(req);
        const kind = String(body.which) as RuleKind;
        if (!['global', 'project', 'memory', 'globalMemory'].includes(kind)) throw new HttpError(400, `Unknown rules "${kind}".`);
        const cwd = body.cwd && dirExists(body.cwd) ? String(body.cwd) : rt.cwd;
        writeRule(kind, cwd, String(body.content ?? ''), rt.config, body.basis);
        return send(res, 200, rulesView(cwd, rt.config, windowOf()));
      }
    }

    if (a === 'presets') {
      if (method === 'GET') return send(res, 200, presetsView(url.searchParams.get('cwd') || rt.cwd, rt.reportLibrary));
      if (method === 'POST') {
        const body = await readBody(req);
        const cwd = body.cwd && dirExists(body.cwd) ? String(body.cwd) : rt.cwd;
        const scope: PresetScope = body.scope === 'workspace' ? 'workspace' : 'global';
        const name = String(body.name ?? '');
        switch (b) {
          case 'import': {
            const { report } = importPreset(scope, cwd, String(body.text ?? ''), name);
            return send(res, 200, { ...presetsView(cwd, rt.reportLibrary), report });
          }
          case 'use':
            if (scope === 'global') setGlobalChoice(name || null, body.basis);
            else setWorkspaceChoice(cwd, body.use === 'own' || body.use === 'library' ? { use: body.use, name } : ({ use: body.use === 'none' ? 'none' : 'global' } as WorkspaceChoice), body.basis);
            return send(res, 200, presetsView(cwd, rt.reportLibrary));
          case 'move':
            moveToLibrary(cwd, name);
            return send(res, 200, presetsView(cwd, rt.reportLibrary));
          case 'update':
            updatePreset(scope, cwd, name, body.patch ?? {}, body.basis);
            return send(res, 200, presetsView(cwd, rt.reportLibrary));
          case 'copy':
            copyPreset(scope, cwd, name);
            return send(res, 200, presetsView(cwd, rt.reportLibrary));
          case 'delete':
            deletePreset(scope, cwd, name, body.basis);
            return send(res, 200, presetsView(cwd, rt.reportLibrary));
        }
      }
    }

    if (a === 'personas') {
      if (method === 'GET' && b === 'avatar') {
        const data = personaAvatar(url.searchParams.get('name') ?? '');
        if (!data) throw new HttpError(404, 'No such picture');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        res.end(data);
        return;
      }
      if (method === 'GET') return send(res, 200, personasView(url.searchParams.get('cwd') || rt.cwd, rt.reportLibrary));
      if (method === 'POST') {
        const body = await readBody(req);
        const cwd = body.cwd && dirExists(body.cwd) ? String(body.cwd) : rt.cwd;
        const name = String(body.name ?? '');
        switch (b) {
          case 'import': {
            // A card is a picture or JSON: it comes as base64, the way a browser reads a file it is given.
            const { persona, report } = importPersona(Buffer.from(String(body.data ?? ''), 'base64'), name);
            return send(res, 200, { ...personasView(cwd, rt.reportLibrary), imported: persona.name, report });
          }
          case 'write': {
            const p = writePersona(body.old ? String(body.old) : null, body.patch ?? {}, body.basis);
            return send(res, 200, { ...personasView(cwd, rt.reportLibrary), written: p.name });
          }
          case 'use':
            if (body.scope === 'folder') setPersonaFolderChoice(cwd, body.use === 'library' && name ? { use: 'library', name } : { use: body.use === 'none' ? 'none' : 'global' }, body.basis);
            else setPersonaGlobalChoice(name || null, body.basis);
            return send(res, 200, personasView(cwd, rt.reportLibrary));
          case 'delete':
            deletePersona(name, body.basis);
            return send(res, 200, personasView(cwd, rt.reportLibrary));
        }
      }
    }

    if (a === 'files' && method === 'GET') {
      const cwd = url.searchParams.get('cwd') || rt.cwd;
      const q = url.searchParams.get('q') ?? '';
      const files = await listFiles(cwd);
      const ranked = files
        .map((f) => ({ f, s: fuzzyScore(f, q) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 40)
        .map((x) => x.f);
      return send(res, 200, ranked);
    }

    // The folder's branch and its uncommitted files, for the welcome page; null outside a repository.
    if (a === 'git' && method === 'GET') {
      const cwd = url.searchParams.get('cwd') || rt.cwd;
      return send(res, 200, dirExists(cwd) ? await folderGit(cwd) : null);
    }

    if (a === 'fs' && method === 'GET') return send(res, 200, listDirs(url.searchParams.get('path') ?? ''));
    if (a === 'pick-folder' && method === 'POST') {
      if (!opts.pickFolder) throw new HttpError(404, 'No native folder picker');
      return send(res, 200, { path: await opts.pickFolder() });
    }
    if (a === 'notify') {
      // A phone's notifications: the key it subscribes with, its subscription, and whether it has Favilla in view. The
      // link names the phone (X-Favilla-Device); the window on this computer has none of its own.
      const device = typeof req.headers['x-favilla-device'] === 'string' ? req.headers['x-favilla-device'] : '';
      if (!b && method === 'GET') {
        if (keysLoading) await keysLoading;
        return send(res, 200, { key: pushKey(), on: !!device && pushDevices().includes(device) });
      }
      if (method === 'POST') {
        if (!device) throw new HttpError(400, 'Notifications are set up on the phone.');
        const body = await readBody(req);
        if (b === 'subscribe') {
          const kinds: PushKind[] = ['done', 'limit', 'failed', 'ask'];
          const words = (body.words ?? {}) as Record<string, unknown>;
          if (!kinds.every((k) => typeof words[k] === 'string')) throw new HttpError(400, 'The words of each notification are missing.');
          if (keysLoading) await keysLoading;
          addPush(device, body.sub as PushSubscriptionJSON, Object.fromEntries(kinds.map((k) => [k, String(words[k]).slice(0, 80)])) as Record<PushKind, string>);
          return send(res, 200, { on: true });
        }
        if (b === 'unsubscribe') {
          if (keysLoading) await keysLoading;
          removePush(device);
          return send(res, 200, { on: false });
        }
        if (b === 'visible') {
          if (body.visible) viewing.set(device, Date.now());
          else viewing.delete(device);
          return send(res, 200, {});
        }
      }
    }
    if (a === 'remote') {
      // Settings > Remote, on this computer only: the link refuses these paths from a phone.
      if (!b && method === 'GET') return send(res, 200, await remoteView());
      if (method === 'POST') {
        const body = await readBody(req);
        if (b === 'enable') {
          const relay = typeof body.relay === 'string' ? body.relay.trim().replace(/\/+$/, '') : undefined;
          if (relay && !/^https:\/\/[^\s/]+$/.test(relay)) throw new HttpError(400, 'The relay is an https:// address, without a path.');
          const lan = typeof body.lan === 'boolean' ? body.lan : rt.config.remote?.lan !== false;
          if (body.on === true && !(relay ?? relayOf()) && !lan) throw new HttpError(400, 'Turn on the same network, or give the address of your relay.');
          updateGlobalConfig((current) => ({
            ...(typeof body.on === 'boolean' ? { 'remote.enabled': body.on } : {}),
            ...(typeof body.lan === 'boolean' ? { 'remote.lan': body.lan } : {}),
            ...(relay !== undefined ? { 'remote.relay': relay ? keepSavedAddress(relay, current.remote?.relay) : undefined } : {}),
            ...(typeof body.awake === 'boolean' ? { 'remote.awake': body.awake } : {}),
          }), [], body.basis);
          rt.reload();
          if (rt.config.remote?.enabled && keysLoading) await keysLoading;
          syncRemote();
          return send(res, 200, await remoteView());
        }
        if (b === 'pair') {
          // Through the relay, or straight to this computer from a phone on the same network.
          const via = body.via === 'lan' || body.via === 'relay' ? body.via : relayOf() ? 'relay' : 'lan';
          let base: string;
          if (via === 'relay') {
            if (!relayOf()) throw new HttpError(400, 'Give the address of your relay first.');
            base = addressView(relayOf(), true).address;
          } else {
            if (door?.state !== 'open') throw new HttpError(400, 'Phones on the same network cannot connect yet: turn it on above.');
            const addresses = lanAddresses().map((a) => a.address);
            const address = typeof body.address === 'string' && addresses.includes(body.address) ? body.address : addresses[0];
            if (!address) throw new HttpError(400, 'This computer is not on a local network right now.');
            base = `http://${address}:${door.port}`;
          }
          // What the phone needs, in the link's fragment: no server on the way sees it.
          if (keysLoading) await keysLoading;
          const k = await pcKeys();
          const { code, expires } = newPairingCode();
          const data = Buffer.from(JSON.stringify({ pc: k.id, kx: b64(k.kxPub), c: b64(code), n: os.hostname().slice(0, 40) })).toString('base64url');
          return send(res, 200, { url: `${base}/#pair=${data}`, expires, via });
        }
        if (b === 'forget') {
          forgetDevice(String(body.id ?? ''));
          if (keysLoading) await keysLoading;
          removePush(String(body.id ?? ''));
          link?.dropDevice(String(body.id ?? ''));
          return send(res, 200, await remoteView());
        }
      }
    }
    // Tokens by day, model and folder for Settings > Usage: counts only, never what was said.
    if (a === 'usage' && !b && method === 'GET') {
      if (keysLoading) await keysLoading;
      const from = Number(url.searchParams.get('from')) || 0;
      // Prices for replies from before the log, which did not keep what they cost: looked up once per model.
      const prices = new Map<string, Pricing | undefined>();
      const price = (provider: string, model: string) => {
        const ref = `${provider}/${model}`;
        if (!prices.has(ref)) {
          try {
            const m = rt.catalog.resolve(ref);
            prices.set(ref, m.provider === provider && m.id === model ? m.pricing : undefined);
          } catch {
            prices.set(ref, undefined);
          }
        }
        return prices.get(ref);
      };
      // A server of the user's own costs nothing per token: its models are free, not of unknown price.
      const free = (provider: string) => {
        try {
          return rt.catalog.provider(provider).local;
        } catch {
          return false;
        }
      };
      return send(res, 200, await tokenStats(rt.store, { from, tz: url.searchParams.get('tz') ?? undefined, price, free }));
    }

    if (a === 'update') {
      if (!b && method === 'GET') return send(res, 200, updater.view());
      // Asked for in the settings: checks now, with checking turned off too.
      if (b === 'check' && method === 'POST') {
        await updater.check(true, true);
        return send(res, 200, updater.view());
      }
      // The installer downloads in the background; progress and the result come as server.update events.
      if (b === 'download' && method === 'POST') {
        void updater.fetchInstaller();
        return send(res, 200, updater.view());
      }
    }
    if (a === 'storage') {
      if (keysLoading) await keysLoading;
      // What Favilla's folder holds, and making room in it (never in a project).
      if (!b && method === 'GET') return send(res, 200, { ...(await storageView(rt.store, url.searchParams.get('fresh') === '1')), seal: sealView() });
      if (b === 'clean' && method === 'POST') {
        const r = await cleanStorage(rt.store, String((await readBody(req)).what ?? ''), new Set(rt.live.keys()));
        return send(res, 200, { ...r, view: { ...(await storageView(rt.store, true)), seal: sealView() } });
      }
      // The recovery key is shown only on request, to be kept somewhere safe; taking one in never drops a key.
      if (b === 'recovery-key' && method === 'POST') return send(res, 200, { key: recoveryKey() });
      if (b === 'import-key' && method === 'POST') {
        importRecoveryKey(String((await readBody(req)).key ?? ''));
        return send(res, 200, { seal: sealView() });
      }
    }
    if (a === 'reveal' && method === 'POST') {
      // A folder shown in the system's file manager, for the page in a browser (the desktop app opens it itself).
      // Folders only: "opening" a file would run it.
      const dir = String((await readBody(req)).path ?? '');
      if (!path.isAbsolute(dir) || !dirExists(dir)) throw new HttpError(400, 'Not a folder on this computer');
      const [cmd, ...args] = isWindows ? ['explorer.exe', dir] : process.platform === 'darwin' ? ['open', dir] : ['xdg-open', dir];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', (e) => debug('reveal', 'failed', String(e))).unref();
      return send(res, 200, { ok: true });
    }

    if (a === 'sessions') {
      if (keysLoading) await keysLoading;
      if (!b && method === 'GET') {
        // A session whose sub-agents work on in the background after its turn counts as working.
        const liveOf = (id: string) => {
          const s = rt.live.get(id);
          return s ? (s.status === 'idle' && s.backgroundRuns().length ? 'running' : s.status) : null;
        };
        // Without a folder: every folder's, for the sidebar that lists them all.
        const cwd = url.searchParams.get('cwd') ?? undefined;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 300, 1), 2000);
        const own = rt.store.list({ cwd, limit }).map((m) => ({ ...m, live: liveOf(m.id) }));
        const others = followed.list(cwd, limit);
        return send(res, 200, others.length ? [...own, ...others].sort((x, y) => y.updated - x.updated).slice(0, limit) : own);
      }
      if (!b && method === 'POST') {
        const body = await readBody(req);
        if (closed) return;
        const cwd = body.cwd && dirExists(body.cwd) ? body.cwd : rt.cwd;
        const start = rt.start({ cwd, model: body.model, effort: body.effort as Effort, mode: readMode(body.mode), interactive: true, deferProjectFacts: true });
        // Closing the server must also finish the reads started for windows that never sent a message.
        const facts = start.then((session) => session.projectFactsReady);
        opening.add(facts);
        const forget = () => { opening.delete(facts); };
        void facts.then(forget, forget);
        const s = await start;
        return send(res, 200, await sessionView(s.id));
      }
      if (b && !c && method === 'GET') return send(res, 200, await sessionView(b));
      if (b && c === 'follow' && method === 'GET') {
        if (followed.stream(req, res, b, Math.max(0, Number(url.searchParams.get('after')) || 0), followed.homeOf(b))) return;
        throw new HttpError(404, 'No such session');
      }
      // Another Favilla folder's sessions are only read here, from its files: nothing else reaches the runtime, which
      // would look for them in this folder.
      if (b && (c || method !== 'GET') && followed.homeOf(b)) throw new HttpError(409, 'This session is in another Favilla folder and opens read-only here.');
      if (b && !c && method === 'DELETE') {
        // A terminal (favilla -c) or another app that has it open goes on writing to it: deleted under it, the session
        // came back as a file of the lines written since, with no start.
        const holder = rt.store.locks.holder(b);
        if (holder) throw new HttpError(409, `Session ${b} is open in another Favilla (process ${holder.pid}). Close it there first, then delete it.`);
        rt.close(b);
        rt.store.delete(b);
        return send(res, 200, { ok: true });
      }
      if (b && c === 'find') {
        // The scan yields to streaming turns, so the page can have moved on before it ends: a find bar drops its
        // request when the words change. Only that ends a scan. Another window's search of the same session does
        // not: two find bars on one session ask at the same moment whenever a message arrives.
        const controller = new AbortController();
        const gone = () => controller.abort();
        res.once('close', gone);
        try {
          const s = await rt.get(b, { interactive: true });
          const result = await findInSession(s.messages, url.searchParams.get('q') ?? '', rt.store.blobs, 5000, controller.signal);
          if (!controller.signal.aborted) return send(res, 200, result);
        } catch (e) {
          if (!controller.signal.aborted) throw e;
        } finally {
          res.off('close', gone);
        }
        return;
      }
      if (b && c) {
        const body = method === 'POST' ? await readBody(req) : {};
        const reads = ['preview', 'context', 'result', 'changes'].includes(c);
        if (!reads) rt.assertWritable(b);
        const s = await rt.get(b, { interactive: true });
        if (!reads) rt.assertWritable(b);
        switch (c) {
          case 'preview': {
            // The pages this session's folder serves (its dev servers), newest first; the one asked for, or the
            // newest, behind the proxy that adds point-and-tell.
            const pages = servedIn(s.meta.cwd);
            const want = url.searchParams.get('url') ?? (typeof body.url === 'string' ? body.url : '');
            const page = pages.find((x) => x.url === want) ?? pages[0];
            return send(res, 200, { pages, ...(page ? { url: page.url, proxied: await previewOf(page.url) } : {}) });
          }
          case 'send': {
            const images: ImagePart[] = (body.images ?? []).map((i: ImagePart) => ({ type: 'image', mediaType: i.mediaType, data: i.data, name: i.name }));
            s.send(String(body.text ?? ''), images).catch((e) => debug('server', 'send failed', String(e)));
            return send(res, 200, { ok: true });
          }
          case 'retry':
            s.retry()?.catch((e) => debug('server', 'retry failed', String(e)));
            return send(res, 200, { ok: true });
          case 'abort':
            s.abort();
            return send(res, 200, { ok: true });
          case 'stop-child':
            // One sub-agent, at any depth; the agent that started it goes on.
            return send(res, 200, { ok: s.stopChild(String(body.child ?? '')) });
          case 'returned':
            s.acknowledgeInputs(Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === 'string') : []);
            return send(res, 200, { ok: true });
          case 'unqueue': {
            // A message sent while the agent works, taken back before it was read: its text and images, to edit.
            const back = s.withdraw(String(body.id ?? ''));
            return send(res, 200, back ? { ok: true, ...back } : { ok: false });
          }
          case 'permission':
            return send(res, 200, { ok: s.respondPermission(body.id, body.decision as PermissionDecision) });
          case 'answer':
            return send(res, 200, { ok: s.answerQuestion(body.id, body.answers ?? null) });
          case 'plan':
            return send(res, 200, { ok: s.respondPlan(body.id, !!body.approved, body.feedback) });
          case 'settings': {
            const mode = readMode(body.mode);
            if (body.model) await s.setModel(body.model);
            if (body.effort) s.setEffort(body.effort);
            if (mode) s.setMode(mode);
            if (typeof body.title === 'string') s.setTitle(body.title);
            if ('goal' in body) {
              const g = body.goal as { objective?: unknown; criteria?: unknown } | null;
              if (g && String(g.objective ?? '').trim()) s.setUserGoal(String(g.objective), Array.isArray(g.criteria) ? g.criteria.map(String) : []);
              else s.setGoal(undefined);
            }
            return send(res, 200, await sessionView(b));
          }
          case 'compact': {
            // During a turn it waits for the turn's next step: the answer comes now, the compaction's events later.
            const queued = s.busy;
            const done = s.compact('manual');
            if (queued) {
              done.catch(() => {});
              return send(res, 200, { ok: true, queued: true });
            }
            await done;
            return send(res, 200, { ok: true });
          }
          case 'context':
            return send(res, 200, s.contextReport());
          case 'fork': {
            // Branch at a message; `undo` first puts back the files this session changed from that point on, `replace`
            // drops the conversation after it instead of keeping it beside the branch.
            const where = body.where === 'after' ? 'after' : 'before';
            const { session: branch, restored } = await rt.branch(s, String(body.message ?? ''), where, { undo: !!body.undo, text: typeof body.text === 'string' ? body.text : undefined, replace: !!body.replace });
            return send(res, 200, { ...(await sessionView(branch.id)), restored });
          }
          case 'reload-rules':
            await s.reloadRules();
            return send(res, 200, { ok: true });
          case 'undo':
            return send(res, 200, { restored: await s.undoFiles(String(body.turn)) });
          case 'result': {
            // The whole output behind a preview, from this session or one of its sub-agents.
            const part = findResult(s.messages, d) ?? childResult(b, d);
            if (!part) throw new HttpError(404, 'No such tool result');
            return send(res, 200, { content: fullContent(part, rt.store.blobs), display: fullDisplay(part, rt.store.blobs) });
          }
          case 'changes': {
            // One file of a turn with every line around its changes, for a view that opens the unchanged runs in
            // place; asked when one is opened, so it is not kept.
            const one = url.searchParams.get('file');
            if (d && one !== null) {
              const ch = (await s.turnChangesAsync(d)).find((x) => x.path === one);
              if (!ch) throw new HttpError(404, 'No such change');
              return send(res, 200, { ...makeDiff(ch.path, ch.before, ch.after, changeOp(ch.before, ch.after), undefined, Infinity), via: ch.via });
            }
            // Asked after every turn and status change: the snapshots are read without holding the engine's thread
            // (a command that changed 300 files held it 17 s, read file by file).
            const turns = d ? [d] : s.checkpoints.turns();
            const out: { turn: string; files: unknown[] }[] = [];
            for (const t of turns) {
              if (res.destroyed) return;
              const files: unknown[] = [];
              for (const ch of await s.turnChangesAsync(t)) {
                if (res.destroyed) return;
                files.push({ ...cachedDiff(ch.path, ch.before, ch.after), via: ch.via });
                // Other requests and the running turn get the thread between diffs.
                if (files.length % 25 === 0) await new Promise((r) => setImmediate(r));
              }
              out.push({ turn: t, files });
            }
            if (!res.destroyed) return send(res, 200, out);
            return;
          }
        }
      }
    }
    throw new HttpError(404, `No route for ${method} ${url.pathname}`);
  }

  function serveStatic(res: http.ServerResponse, url: URL): void {
    const given = url.searchParams.get('token');
    if (given === token) {
      // Kept on disk (Max-Age), so a restart of the browser's network process does not sign the page out.
      res.writeHead(302, { 'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, Location: url.pathname });
      res.end();
      return;
    }
    if (!opts.webDir) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Favilla server is running. The web UI is not built; run `pnpm build`.');
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      throw new HttpError(400, 'Not a path');
    }
    let file = path.resolve(opts.webDir, rel || 'index.html');
    if (!isInside(opts.webDir, file)) throw new HttpError(403, 'Outside the web directory');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(opts.webDir, 'index.html');
    const ext = path.extname(file);
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
    // Only the built files under assets/ carry their content's hash in their names and never change. The others keep
    // their names across versions (icon.png): kept as never changing, a window showed an old version's icon after
    // every update since (2026-11-03), so the browser asks again each time.
    headers['Cache-Control'] = ext === '.html' ? 'no-store' : isInside(path.resolve(opts.webDir, 'assets'), file) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) throw new HttpError(403, 'Host not allowed');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        if (!authed(req)) throw new HttpError(401, 'Missing or invalid token');
        const origin = req.headers.origin;
        if (origin !== undefined && req.method !== 'GET' && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
        await api(req, res, url);
        return;
      }
      serveStatic(res, url);
    } catch (e) {
      const gone = e instanceof SessionGoneError;
      const problem = e instanceof SettingsError ? e.problem : undefined;
      const status = gone ? 410 : e instanceof HttpError ? e.status : e instanceof SettingsConflict || e instanceof SessionHeldError ? 409 : problem ? 400 : 500;
      if (status === 500) debug('server', 'request failed', String((e as Error).stack ?? e));
      if (!res.headersSent) send(res, status, { error: (e as Error).message, ...(problem ? { problem } : {}), ...(gone && e.replacementId ? { replacementId: e.replacementId } : {}) });
      else res.end();
    }
  });

  // A port of its own choosing is one the app's window and a browser will open; one asked for is taken as it is.
  if (opts.port) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, host, () => resolve());
    });
  } else await listenForBrowser(server, host);
  port = (server.address() as AddressInfo).port;
  if (keysLoading && rt.config.remote?.enabled) {
    void keysLoading.then(() => { if (!closed) syncRemote(); });
  } else syncRemote();
  rt.catalog
    .discoverAll()
    .then(() => broadcast({ type: 'server.config' }))
    .catch(() => {});
  // models.dev, fetched again every few days: new thinking levels and windows reach open sessions and the pickers.
  void rt.catalog.refreshRegistry().then((changed) => {
    if (closed || !changed) return;
    rt.reload();
    broadcast({ type: 'server.config' });
  });
  // Start MCP servers now, so the first session does not wait for them and settings can show their state.
  rt.mcp
    .start()
    .then(() => broadcast({ type: 'server.config' }))
    .catch(() => {});
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${shownHost}:${port}/`,
    port,
    token,
    close: async () => {
      await new Promise<void>((resolve) => {
        closed = true;
        followed.close();
        unsubscribe();
        unsubscribeSettings();
        unsubscribeUpdate();
        updater.stop();
        link?.stop();
        door?.stop();
        for (const c of sse) {
          c.detach();
          c.res.end();
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await Promise.allSettled(opening);
    },
  };
}
