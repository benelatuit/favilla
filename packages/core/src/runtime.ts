import type { AgentEvent, ImagePart, TextPart } from './types';
import { Catalog } from './catalog/catalog';
import { globalConfigPath, loadConfig, type ConfigRead, type FavillaConfig } from './config/config';
import { settingFileVersion, settingNotice, SettingsError, SettingsFileError, type SettingSource } from './config/document';
import { settingsWords, type SettingsNotice } from './i18n';
import { authPath, readAuthFile } from './auth/store';
import { SessionHeldError } from './store/locks';
import { SessionStore } from './store/sessions';
import { Session, type StartOptions } from './agent/session';
import { McpHub } from './mcp/hub';
import { withImages } from './store/pack';
import { sealingFor, setSealing } from './store/seal';
import { forgetIdleCodeIndexes } from './tools/codesearch';
import { closeUnusedServers } from './tools/lsp';
import { imageWorker } from './tools/image';
import { reapJobs } from './tools/job-recovery';
import { debug } from './util/log';
import { normalizeForCompare } from './util/paths';
import { ATTACHED, attachedPart } from './prompt/attached';
import { listPresets } from './prompt/preset';
import { listPersonas } from './prompt/persona';
import type { LibraryReport } from './prompt/library';
import { tokenLogSince } from './store/token-log';

export class SessionGoneError extends Error {
  constructor(readonly replacementId?: string) {
    super(replacementId ? 'This session was replaced.' : 'This session was removed.');
  }
}

/** Everything a front end needs: config, model catalog, session store and the live sessions. */
export interface Runtime {
  cwd: string;
  config: FavillaConfig;
  catalog: Catalog;
  store: SessionStore;
  live: Map<string, Session>;
  /** MCP servers from the config, shared by all sessions. */
  mcp: McpHub;
  start(opts: StartOptions): Promise<Session>;
  get(id: string, opts?: Omit<StartOptions, 'cwd'>): Promise<Session>;
  /** Check before opening a session for work: a hidden source is kept only for its history. */
  assertWritable(id: string): void;
  /** A new session branched from `src` at a message (see Session.fork). */
  fork(src: Session, messageId: string, where: 'before' | 'after'): Promise<Session>;
  /**
   * Branch at a message, as a front end does it: stop the source, put back the files it changed from that point
   * on when `undo` is set, fork, and send an edited message (`text`) in the new branch. Without `images` the
   * edited message keeps the original's images and the files attached to it. With `replace` the conversation after
   * that point goes instead: the new session takes the source's place in every list and the source is deleted.
   */
  branch(src: Session, messageId: string, where: 'before' | 'after', opts?: { undo?: boolean; text?: string; images?: ImagePart[]; replace?: boolean }): Promise<{ session: Session; restored: string[] }>;
  close(id: string): void;
  /** Compress a session's file and its sub-agents' files (a session that is done for now). */
  freeze(id: string): Promise<void>;
  /**
   * Keep a long-running process light. Session files left plain by crashes or other processes are
   * compressed and unused blobs deleted; with `evictAfterMs`, sessions nobody has used for that long leave
   * memory and are compressed too (only for front ends that reach sessions through `get`, never holding one).
   */
  housekeeping(opts?: { evictAfterMs?: number }): void;
  reload(): boolean;
  refreshSettings(): void;
  readonly globalSettings: Record<string, unknown>;
  readonly credentials: Record<string, unknown>;
  readonly settingsNotices: SettingsNotice[];
  subscribeSettings(listener: (notice: SettingsNotice) => void): () => void;
  reportLibrary: LibraryReport;
  /** Events from every live session, and replacements. */
  subscribe(listener: (e: AgentEvent) => void): () => void;
  dispose(): void;
  /** Dispose, then compress every session this process used, so nothing it wrote stays plain on disk. */
  shutdown(): Promise<void>;
}

export function createRuntime(cwd = process.cwd(), defaults: Partial<StartOptions> = {}): Runtime {
  // From here on every request is in the token log; the usage page reads older replies from the sessions.
  tokenLogSince(true);
  let notices = new Map<string, SettingsNotice>();
  const settingListeners = new Set<(notice: SettingsNotice) => void>();
  const libraryNotices = new Map<string, SettingsNotice>();
  const reportLibrary: LibraryReport = (file, issue) => {
    if (!issue) { libraryNotices.delete(file); return; }
    if (libraryNotices.get(file)?.id === issue.id) return;
    libraryNotices.set(file, issue);
    for (const listen of settingListeners) listen(issue);
  };
  const publishSettings = (found: SettingsNotice[], all = false) => {
    const prior = notices;
    const files = new Set(found.map((n) => n.vars.file));
    notices = all ? new Map() : new Map([...prior].filter(([, n]) => !files.has(n.vars.file)));
    for (const issue of found) {
      if (notices.has(issue.id)) continue;
      const previous = prior.get(issue.id);
      notices.set(issue.id, previous ?? issue);
      if (!previous) for (const listen of settingListeners) listen(issue);
    }
  };
  const read = (dir: string, found: SettingsNotice[], reload = false) => {
    const options: ConfigRead = { report: (notice) => found.push(notice), reload };
    const config = loadConfig(dir, options);
    return { config, source: options.modelSource, global: options.global };
  };
  const unavailable = (catalog: Catalog, source: SettingSource | undefined, found: SettingsNotice[]) => {
    if (!source || catalog.defaultAvailable()) return undefined;
    const notice = settingNotice(source, settingsWords.model);
    found.push(notice);
    return notice;
  };
  const settingsVersion = () => settingFileVersion(globalConfigPath()) + '/' + settingFileVersion(authPath());
  let version = settingsVersion();
  let credentials = {};
  const initial: SettingsNotice[] = [];
  const first = read(cwd, initial);
  let global = first.global ?? {};
  readAuthFile((notice) => initial.push(notice), 'start', (raw) => { credentials = raw; });
  const catalog = new Catalog(first.config);
  const missingModel = unavailable(catalog, first.source, initial);
  publishSettings(initial);
  listPresets('global', cwd, reportLibrary);
  listPresets('workspace', cwd, reportLibrary);
  listPersonas(reportLibrary);
  setSealing(sealingFor(catalog.config.storage?.encrypt));
  const store = new SessionStore();
  const recovery = reapJobs();
  const exclusiveServers = defaults.exclusiveMcp ? { workspace: { url: defaults.exclusiveMcp } } : undefined;
  const mcp = new McpHub(exclusiveServers ?? catalog.config.mcpServers, catalog.config.proxy ?? false);
  /** Shared by every session, so a config reload reaches all of them. */
  const deps = { catalog, config: catalog.config, store, mcp, missingModel };
  /**
   * The same for sessions in another folder, under that folder's own .favilla/config.json: one engine serves every
   * folder in the app, and a project's settings had applied nowhere there (and `favilla web` had applied its own
   * folder's to all).
   */
  const folders = new Map<string, { dir: string; deps: typeof deps }>();
  const depsFor = (dir: string): typeof deps => {
    const key = normalizeForCompare(dir);
    if (key === normalizeForCompare(cwd)) return deps;
    let f = folders.get(key);
    if (!f) {
      const found: SettingsNotice[] = [];
      const { config, source } = read(dir, found);
      const view = catalog.withConfig(config);
      f = { dir, deps: { catalog: view, config, store, mcp, missingModel: unavailable(view, source, found) } };
      folders.set(key, f);
      listPresets('workspace', dir, reportLibrary);
      if (found.length) publishSettings(found);
    }
    return f.deps;
  };
  const live = new Map<string, Session>();
  const listeners = new Set<(e: AgentEvent) => void>();
  const unsubs = new Map<string, () => void>();
  /** When each live session was last used, by a front end or by its own events. */
  const used = new Map<string, number>();
  /** Sessions being opened, so a second ask while one opens waits for the same one. */
  const opening = new Map<string, Promise<Session>>();
  const timers: NodeJS.Timeout[] = [];
  /** Every session this process opened, compressed on shutdown. */
  const touched = new Set<string>();
  // The locks on the sessions this process has open stay fresh while it lives (see SessionLocks).
  const heartbeat = setInterval(() => store.locks.beat(), 30_000);
  heartbeat.unref();

  const emit = (e: AgentEvent) => {
    for (const l of listeners) l(e);
  };

  const attach = (s: Session) => {
    live.set(s.id, s);
    used.set(s.id, Date.now());
    touched.add(s.id);
    unsubs.set(
      s.id,
      s.on((e) => {
        used.set(s.id, Date.now());
        emit(e);
      }),
    );
    return s;
  };

  const freezeTree = async (id: string): Promise<void> => {
    await store.freeze(id);
    for (const child of store.list({ children: true }).filter((m) => m.parentId === id)) await freezeTree(child.id);
  };

  const rt: Runtime = {
    cwd,
    get config() {
      return deps.config;
    },
    get globalSettings() { return global; },
    get credentials() { return credentials; },
    refreshSettings() {
      if (settingsVersion() !== version) rt.reload();
    },
    get settingsNotices() { return [...notices.values(), ...libraryNotices.values()]; },
    reportLibrary,
    subscribeSettings(listener) {
      settingListeners.add(listener);
      return () => settingListeners.delete(listener);
    },
    catalog,
    store,
    live,
    mcp,
    async start(opts) {
      // A session freezes its tools when it starts, so give MCP servers a moment to come up first.
      const folder = depsFor(opts.cwd);
      const options = { ...defaults, ...opts };
      if (folder.missingModel && !options.model) throw new SettingsError(folder.missingModel);
      await Promise.all([mcp.ready(), recovery]);
      return attach(await Session.start(folder, options));
    },
    async get(id, opts) {
      const existing = live.get(id);
      if (existing) {
        used.set(id, Date.now());
        // Loaded first without anyone there (a branch made by the runtime, say): a front end opening it now is someone.
        if (opts?.interactive) existing.attend();
        return existing;
      }
      // A sub-agent still at work belongs to its parent and is not listed here: return that session itself.
      // Opening its file instead would give a copy frozen at that moment, which never moves again.
      for (const s of live.values()) {
        const child = s.descendant(id);
        if (child) return child;
      }
      // Open in another Favilla: two writers interleave the file and lose each other's turns.
      const holder = store.locks.holder(id);
      if (holder) throw new SessionHeldError(id, holder.pid);
      // Asked twice while it opens (a page's view and its events at once): one session, not two writing one file.
      let pending = opening.get(id);
      if (!pending) {
        pending = (async () => {
          await Promise.all([mcp.ready(), recovery]);
          store.locks.take(id);
          try {
            const dir = store.metaOf(id)?.cwd;
            return attach(await Session.open(dir ? depsFor(dir) : deps, id, { ...defaults, ...opts }));
          } catch (e) {
            store.locks.release(id);
            throw e;
          }
        })().finally(() => opening.delete(id));
        opening.set(id, pending);
      }
      const s = await pending;
      if (opts?.interactive) s.attend();
      return s;
    },
    assertWritable(id) {
      const meta = store.metaOf(id);
      if (meta && !meta.hidden) return;
      const replacement = store.replacementOf(id);
      if (meta?.hidden || replacement) throw new SessionGoneError(replacement?.id);
    },
    async fork(src, messageId, where) {
      rt.assertWritable(src.id);
      return attach(await Session.fork(depsFor(src.meta.cwd), src, messageId, where, defaults));
    },
    async branch(src, messageId, where, opts = {}) {
      rt.assertWritable(src.id);
      await src.stop();
      rt.assertWritable(src.id);
      const from = where === 'before' ? src.messages.find((m) => m.id === messageId)?.turn : src.turnAfter(messageId);
      const restored = opts.undo && from ? await src.undoFiles(from) : [];
      const session = await rt.fork(src, messageId, where);
      if (opts.replace) {
        // The same conversation, cut back: no branch mark (unless the source was a branch), the source's start time.
        // Deleting the source only hides it while the new session reads its history from that file.
        session.meta = { ...session.meta, created: src.meta.created, branchOf: src.meta.branchOf, replaces: [...(src.meta.replaces ?? []), src.id] };
        store.saveMeta(session.meta);
        rt.close(src.id);
        store.delete(src.id);
        emit({ type: 'session.replaced', sessionId: src.id, replacement: session.meta });
      }
      const text = opts.text?.trim() ?? '';
      if (text && where === 'before') {
        let body = text;
        let images = opts.images;
        if (!images) {
          const original = src.messages.find((m) => m.id === messageId);
          const said = original?.parts.find((p) => p.type === 'text' && !p.synthetic) as TextPart | undefined;
          // All of it: a paste may hold the attachment line itself.
          const attached = said ? attachedPart(said.text) : '';
          if (attached) body = `${text}${ATTACHED}${attached}`;
          images = (original ? withImages(structuredClone(original), store.blobs).parts : []).filter((p): p is ImagePart => p.type === 'image' && !!p.data);
        }
        session.send(body, images).catch((e) => debug('runtime', 'send failed', String(e)));
      }
      return { session, restored };
    },
    close(id) {
      const s = live.get(id);
      if (!s) return;
      unsubs.get(id)?.();
      unsubs.delete(id);
      used.delete(id);
      s.dispose();
      live.delete(id);
    },
    freeze: freezeTree,
    housekeeping(opts = {}) {
      if (timers.length) return;
      const quietly = (what: string, p: Promise<unknown>) => p.catch((e) => debug('store', `${what} failed`, String(e)));
      const tidy = () =>
        quietly(
          'housekeeping',
          (async () => {
            const recovered = await store.recoverOrphans();
            const frozen = await store.freezeIdle(new Set(live.keys()));
            const gc = await store.collectGarbage();
            if (recovered || frozen || gc.removed) debug('store', 'housekeeping', { recovered, frozen, removed: gc.removed, freed: gc.freed });
          })(),
        );
      timers.push(setTimeout(tidy, 30_000), setInterval(tidy, 10 * 60_000));
      const after = opts.evictAfterMs;
      if (after) {
        timers.push(
          setInterval(() => {
            const now = Date.now();
            for (const [id, s] of live) {
              if (s.inUse() || now - (used.get(id) ?? 0) < after) continue;
              rt.close(id);
              void quietly('freeze', freezeTree(id));
            }
            // A folder's code index goes the same way: hundreds of megabytes for a big one.
            forgetIdleCodeIndexes(after, now);
          }, 60_000),
        );
      }
      for (const t of timers) t.unref();
    },
    reload() {
      version = settingsVersion();
      // Read every folder before changing any of the live configuration.
      const found: SettingsNotice[] = [];
      const targets = [{ dir: cwd, deps }, ...folders.values()];
      let changes;
      try {
        changes = targets.map((f) => ({ deps: f.deps, ...read(f.dir, found, true) }));
      } catch (e) {
        if (!(e instanceof SettingsFileError)) throw e;
        publishSettings([e.notice('reload')]);
        return false;
      }
      global = changes[0].global ?? {};
      readAuthFile((notice) => found.push(notice), 'reload', (raw) => { credentials = raw; });
      for (const f of changes) {
        f.deps.config = f.deps.catalog.config = f.config;
        f.deps.missingModel = unavailable(f.deps.catalog, f.source, found);
      }
      publishSettings(found, true);
      setSealing(sealingFor(deps.config.storage?.encrypt));
      // MCP servers added, changed or removed in the settings connect or close now, the others go on.
      mcp.update(exclusiveServers ?? deps.config.mcpServers);
      // A new context window or compaction mark applies to open sessions at once.
      for (const s of live.values()) s.applySettings();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      imageWorker.close();
      clearInterval(heartbeat);
      for (const t of timers.splice(0)) clearInterval(t);
      for (const id of [...live.keys()]) rt.close(id);
      store.flushIndex();
      void mcp.close();
    },
    async shutdown() {
      // Running turns end cleanly first (their calls answered) and jobs stop, a few seconds at most.
      await Promise.all([...live.values()].map((s) => s.wind()));
      rt.dispose();
      closeUnusedServers();
      await Promise.all([mcp.close(), recovery]);
      for (const id of touched) await freezeTree(id).catch((e) => debug('store', 'freeze failed', String(e)));
    },
  };
  return rt;
}
