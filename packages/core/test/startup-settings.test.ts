import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { settingText, settingsWords, type SettingsNotice } from '../src/i18n';
import { DEFAULT_THEME } from '../src/config/theme';

/*
 * Startup reads, in order of use:
 * - User and project config.json: providers, themes, MCP, tools, shell, guard and extensions' settings.
 * - auth.json and provider dotenv files, then cache/models-*.json,
 *   models-dev.json, efforts-learned.json and windows-learned.json.
 * - sessions/index.json and the selected session's JSONL or archive, locks, keys/ and running-jobs/.
 * - Global and project AGENTS.md and alternate rule files, their includes, memory.md, and SKILL.md
 *   in the user's and the project's skill directories. Presets, personas and their *.choice files.
 * - ui-state.json, bundled themes and per-window browser storage. Desktop also reads window.json
 *   and the Electron user-data server-port.json and last-version.txt.
 * - Optional services have their own files (remote.json and push subscriptions) when enabled.
 */
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'favilla-startup-settings-'));
const repo = path.resolve(import.meta.dirname, '../../..');
const credential = 'invented-credential-never-echo';
const expectedAnswer = 'Startup fixture answered.';
vi.stubEnv('HOME', root);
vi.stubEnv('USERPROFILE', root);
vi.stubEnv('FAVILLA_HOME', undefined);
vi.stubEnv('FAVILLA_HOME', root);
vi.stubEnv('FAVILLA_SEAL', undefined);
vi.stubEnv('FAVILLA_SEAL', '0');
vi.stubEnv('FAVILLA_SKILLS', undefined);
vi.stubEnv('FAVILLA_WEB_SEARCH', undefined);
vi.stubEnv('FAVILLA_WEB_SEARCH', 'off');
vi.stubEnv('FAVILLA_DEBUG', undefined);
vi.stubEnv('FAVILLA_MODEL', undefined);
vi.stubEnv('FAVILLA_PROXY', undefined);
const builtins: Record<string, { env?: string[] }> = JSON.parse(fs.readFileSync(path.join(repo, 'packages/core/src/catalog/providers.json'), 'utf8'));
for (const provider of Object.values(builtins)) for (const name of provider.env ?? []) vi.stubEnv(name, undefined);
for (const name of Object.keys(process.env)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/i.test(name)) vi.stubEnv(name, undefined);

const transport = await import('../src/net/http');
const { REGISTRY_URL } = await import('../src/catalog/registry');
const { MailClient } = await import('../src/mail/client');
const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');
const { loadConfig, loadGlobalConfigRaw, updateGlobalConfig } = await import('../src/config/config');
const { writeUiState } = await import('../src/config/ui-state');
const { readAuthFile, updateAuthFile } = await import('../src/auth/store');
const { SessionStore } = await import('../src/store/sessions');
const { projectSlug } = await import('../src/util/paths');
type Runtime = ReturnType<typeof createRuntime>;

const fake = http.createServer((req, res) => {
  req.resume();
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    return void res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
  }
  if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  for (const data of [
    { choices: [{ index: 0, delta: { content: expectedAnswer } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5 } },
  ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
  res.end('data: [DONE]\n\n');
});
let endpoint = '';
let fixtureNumber = 0;
const children = new Set<ChildProcess>();
const connect = Socket.prototype.connect;
const loopback = (host: unknown) => typeof host !== 'string' || /^(?:127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(host);

beforeAll(async () => {
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const address = first as { host?: string; port?: number } | undefined;
    const host = typeof first === 'number' ? args[1] : address?.host;
    if (!loopback(host) || [8080, 11434].includes(Number(typeof first === 'number' ? first : address?.port))) throw new Error('Non-fixture connection refused');
    return Reflect.apply(connect, this, args);
  } as typeof connect);
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.kill();
  })));
  await new Promise<void>((resolve) => {
    fake.close(() => resolve());
    fake.closeAllConnections();
  });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('favilla-startup-settings-')) throw new Error('Unexpected fixture folder');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function fixture() {
  const dir = path.join(root, String(++fixtureNumber));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  process.env.FAVILLA_HOME = home;
  const put = (name: string, bytes: string | Buffer) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  const config = {
    model: 'relay/fixture', effort: 'low', modelRegistry: false, languageServers: false, checkpoints: false, skills: false,
    providers: { relay: { name: 'Fixture relay', api: 'openai-chat', baseUrl: endpoint, auth: 'none', local: true, models: { fixture: { contextWindow: 48_000 } } } },
  };
  const settings = put('home/config.json', JSON.stringify(config));
  const auth = put('home/auth.json', JSON.stringify({ keys: { kept: credential }, unknown: 'kept' }));
  return { dir, home, project, put, config, settings, auth };
}
type Fixture = ReturnType<typeof fixture>;

const checks = ['starts', 'diagnoses', 'preserves', 'agrees', 'private'] as const;
type Check = typeof checks[number];
type Outcome = Record<Check, boolean>;
const healthy = (): Outcome => ({ starts: true, diagnoses: true, preserves: true, agrees: true, private: true });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const settingTextPlain = (note: SettingsNotice) => settingText(note);
const noSecret = (messages: string[]) => messages.every((s) => !s.includes(credential));
const digest = (file: string) => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (e) { return (e as NodeJS.ErrnoException).code; }
};
const totals = { held: 0, proposals: 0 };
const assertChecks = (o: Outcome, proposals: Check[], detail?: string) => {
  expect(checks.filter((k) => !o[k]), detail).toEqual(proposals);
  if (proposals.length) totals.proposals++;
  else totals.held++;
};
afterAll(() => console.log(`Startup/settings matrix: ${totals.held} held, ${totals.proposals} proposal cases.`));
const encode = (text: string, encoding: 'utf8' | 'bom' | 'le' | 'be') =>
  encoding === 'utf8' ? Buffer.from(text) : encoding === 'bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
    : Buffer.concat([Buffer.from(encoding === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === 'le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf16le').swap16()]);

async function web(rt: Runtime, run: (request: (route: string, method?: string, body?: unknown) => Promise<{ ok: boolean; status: number; text: string; value: any }>) => Promise<void>) {
  const server = await startServer({ runtime: rt, host: '127.0.0.1', token: 'fixture' });
  try {
    await run(async (route, method = 'GET', body) => {
      const res = await fetch(new URL(`api/${route}`, server.url), {
        method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, value: JSON.parse(text) };
    });
  } finally { await server.close(); }
}

type Startup = {
  name: string;
  arrange(f: Fixture): string | void;
  route?: string;
  inspect?(value: any): boolean;
  open?: Check[];
  issue?: string;
  expected?: string;
  session?: boolean;
  repaired?: boolean;
  defaultGone?: boolean;
  cache?: 'discover' | 'efforts' | 'windows' | 'registry';
  library?: 'presets' | 'personas';
};

const brokenJson = [
  '{', '{"model', '{"model":', '{"model":"rel', '{"maxSteps":4',
  '{"model":tru', '{"model":null, /*', '{"model":"relay/fixture",',
];
const startup: Startup[] = [
  { name: 'no optional files', arrange() {} },
  { name: 'JSONC, unknown key and CRLF', arrange: (f) => f.put('home/config.json', '{\r\n // kept\r\n' + JSON.stringify(f.config).slice(1, -1) + ', "unknown": true,\r\n}\r\n') },
  ...(['bom', 'le', 'be'] as const).map((enc) => ({
    name: `${enc} settings at startup`, arrange: (f: Fixture) => f.put('home/config.json', encode(JSON.stringify(f.config), enc)),
  })),
  ...brokenJson.map((text, i): Startup => ({
    name: `global config cut class ${i + 1}`, arrange: (f) => f.put('home/config.json', text),
    issue: 'config.json', expected: settingsWords.start,
  })),
  { name: 'torn UTF-16 config', arrange: (f) => f.put('home/config.json', encode('{"theme":"晨"}', 'le').subarray(0, -1)), issue: 'config.json', expected: settingsWords.start },
  { name: 'torn UTF-8 config', arrange: (f) => f.put('home/config.json', Buffer.from('{"theme":"晨"}').subarray(0, -3)), issue: 'config.json', expected: settingsWords.start },
  { name: 'missing global config', arrange(f) { fs.unlinkSync(f.settings); } },
  { name: 'empty global config', arrange: (f) => f.put('home/config.json', ''), issue: 'config.json', expected: settingsWords.start },
  { name: 'directory in place of global config', arrange(f) { fs.unlinkSync(f.settings); fs.mkdirSync(f.settings); return f.settings; }, issue: 'config.json', expected: settingsWords.unreadable },
  { name: 'read-only global config at start', arrange(f) { fs.chmodSync(f.settings, 0o444); return f.settings; } },
  { name: 'torn project config', arrange: (f) => f.put('project/.favilla/config.json', '{"effort":'), issue: 'config.json', expected: settingsWords.start },
  { name: 'removed default provider', arrange: (f) => f.put('home/config.json', JSON.stringify({ ...f.config, model: 'removed/fixture' })), issue: 'config.json', expected: settingsWords.model, defaultGone: true },
  { name: 'new model on a named relay', arrange: (f) => f.put('home/config.json', JSON.stringify({ ...f.config, model: 'relay/new-model' })), session: true },
  { name: 'providers of the same display name', arrange(f) {
    return f.put('home/config.json', JSON.stringify({ ...f.config, providers: { ...f.config.providers, another: f.config.providers.relay } }));
  }, route: 'providers', inspect: (v) => v.filter((p: { name: string }) => p.name === 'Fixture relay').length === 2 },
  { name: 'relay with trailing slash', arrange(f) {
    f.config.providers.relay.baseUrl += '/';
    return f.put('home/config.json', JSON.stringify(f.config));
  }, route: 'providers', inspect: (v) => v.find((p: { id: string }) => p.id === 'relay')?.baseUrl === endpoint },
  ...(['', 'C:/not/an/http/address'] as const).map((baseUrl): Startup => ({
    name: baseUrl ? 'relay with a Windows path for its address' : 'relay without an address',
    arrange(f) {
      const relay: Partial<typeof f.config.providers.relay> = f.config.providers.relay;
      if (baseUrl) relay.baseUrl = baseUrl;
      else delete relay.baseUrl;
      return f.put('home/config.json', JSON.stringify(f.config));
    },
    route: 'providers', inspect: (v) => v.find((p: { id: string }) => p.id === 'relay')?.configured === false,
    issue: 'config.json', expected: settingsWords.value,
  })),
  ...([['providers', null], ['providers', { broken: null }], ['model', {}], ['mcpServers', { broken: null }], ['browserPath', 9], ['instructions', 9]] as const)
    .map(([key, value]): Startup => ({
      name: `wrong type in ${key} ${JSON.stringify(value)}`,
      arrange: (f) => f.put('home/config.json', JSON.stringify({ ...f.config, [key]: value })),
      ...(key === 'providers' ? { route: 'providers' } : key === 'model' ? { session: true } : key === 'instructions' ? { route: 'rules' } : {}),
      issue: 'config.json', expected: settingsWords.value,
    })),
  ...([['baseUrl', 7], ['apiKey', []], ['env', {}], ['models', { fixture: { efforts: {} } }]] as const)
    .map(([key, value]): Startup => ({
      name: `wrong provider type at providers.relay.${key}`,
      arrange: (f) => f.put('home/config.json', JSON.stringify({
        ...f.config, providers: { relay: { ...f.config.providers.relay, ...(key === 'apiKey' || key === 'env' ? { auth: 'key' } : {}), [key]: value } },
      })),
      route: 'providers', issue: 'config.json', expected: settingsWords.value,
    })),
  { name: 'broken auth syntax leaves the provider list usable', arrange: (f) => f.put('home/auth.json', `{"keys":{"kept":"${credential}"},`), route: 'providers', issue: 'auth.json', expected: settingsWords.start },
  { name: 'null auth document leaves the provider list usable', arrange: (f) => f.put('home/auth.json', 'null'), route: 'providers', issue: 'auth.json', expected: settingsWords.start },
  { name: 'wrong key type preserves other provider credentials', arrange: (f) => f.put('home/auth.json', JSON.stringify({ keys: { openai: [], kept: credential } })), route: 'providers', issue: 'auth.json', expected: settingsWords.value },
  ...['{"models":[', '{"models":{}}'].map((text, i): Startup => ({
    name: i ? 'discovery cache with non-array models' : 'torn model discovery cache',
    arrange(f) {
      f.put('home/config.json', JSON.stringify({ ...f.config, providers: { relay: { ...f.config.providers.relay, discover: 'openai' } } }));
      return f.put('home/cache/models-relay.json', text);
    },
    route: 'providers', cache: 'discover',
  })),
  { name: 'learned effort cache of the wrong type', arrange: (f) => f.put('home/cache/efforts-learned.json', 'null'), route: 'providers', cache: 'efforts' },
  { name: 'learned window cache of the wrong type', arrange: (f) => f.put('home/cache/windows-learned.json', 'null'), route: 'providers', cache: 'windows' },
  { name: 'registry with an invalid provider entry', arrange(f) {
    f.put('home/config.json', JSON.stringify({ ...f.config, modelRegistry: true }));
    return f.put('home/cache/models-dev.json', JSON.stringify({ v: 2, fetched: Date.now(), providers: { relay: { api: endpoint, models: null } } }));
  }, route: 'providers', cache: 'registry' },
  { name: 'settings report with an authenticated proxy keeps its password private', arrange(f) {
    return f.put('home/config.json', JSON.stringify({ ...f.config, proxy: 'http://fixture:' + credential + '@127.0.0.1:9' }));
  }, inspect: (v) => v.config.proxy === 'http://fixture@127.0.0.1:9' && v.config.proxyPasswordSaved === true },
  { name: 'torn session index', arrange: (f) => f.put('home/sessions/index.json', '{"old":'), route: 'sessions', repaired: true },
  { name: 'null session index', arrange: (f) => f.put('home/sessions/index.json', 'null'), route: 'sessions', repaired: true },
  ...([
    ['null preset entry', 'presets', 'null'],
    ['null persona entry', 'personas', 'null'],
    ['preset with a name and malformed entries', 'presets', '{\n  "name": "broken",\n  "entries": null\n}'],
  ] as const).map(([name, library, text]): Startup => ({
    name, library,
    arrange(f) {
      const good = library === 'presets' ? { name: 'kept', format: 'sillytavern', entries: [], imported: 1 } : { name: 'kept', description: '', personality: '', created: 1 };
      f.put(`home/${library}/kept.json`, JSON.stringify(good));
      return f.put(`home/${library}/broken.json`, text);
    },
    route: library, issue: 'broken.json', expected: settingsWords.libraryValue,
    inspect: (view) => (library === 'presets' ? view.global.items : view.items).map((p: { name: string }) => p.name).join(',') === 'kept',
  })),
  { name: 'corrupt window state', arrange: (f) => f.put('home/ui-state.json', '{"folder":'), route: 'ui-state' },
  { name: 'project instructions include themselves', arrange: (f) => f.put('project/AGENTS.md', '@AGENTS.md\nThe instruction is bounded.\n'), session: true },
  { name: 'skill without usable frontmatter', arrange(f) {
    f.put('home/config.json', JSON.stringify({ ...f.config, skills: true }));
    return f.put('project/.favilla/skills/broken/SKILL.md', '---\nnull\n---\nBody.\n');
  }, session: true },
  { name: '50 MiB config with an unknown key', arrange: (f) => f.put('home/config.json', JSON.stringify({ ...f.config, unknown: ' '.repeat(50 * 1024 * 1024) })) },
];

async function probeStartup(row: Startup, failures: string[] = []): Promise<Outcome> {
  const f = fixture();
  const file = row.arrange(f) ?? f.settings;
  const before = digest(file);
  const authBefore = digest(f.auth);
  const result = healthy();
  const notices: string[] = [];
  const visible: string[] = [];
  let issues: SettingsNotice[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => notices.push(args.map(String).join(' ')));
  let rt: Runtime | undefined;
  try {
    rt = createRuntime(f.project);
    rt.subscribe((e) => { if (e.type === 'notice') notices.push(e.text); });
    // Startup probes own their reads. Optional background requests must not run into the next fixture's home.
    const refresh = rt.catalog.refreshRegistry.bind(rt.catalog);
    const registry = vi.spyOn(rt.catalog, 'refreshRegistry').mockResolvedValue(false);
    const discovery = vi.spyOn(rt.catalog, 'discoverAll').mockResolvedValue(undefined);
    try { await web(rt, async (request) => {
      const info = await request('info');
      visible.push(info.text);
      issues = info.value?.settingsNotices ?? [];
      const first = row.route ? await request(row.route) : info;
      const again = await request(row.route ?? 'info');
      for (const response of [first, again]) {
        visible.push(response.text);
        if (!response.ok) notices.push(String(response.value.error));
      }
      result.starts = info.ok && first.ok && again.ok;
      if (first.ok && again.ok) result.agrees = first.text === again.text && (row.inspect?.(first.value) ?? true);
      if (row.cache) {
        result.preserves = digest(file) === before;
        if (row.cache === 'discover') {
          await rt!.catalog.discover('relay');
          result.agrees &&= rt!.catalog.models('relay').some((m) => m.id === 'fixture' && m.discovered);
        } else if (row.cache === 'registry') {
          const request = transport.http;
          const registry = vi.spyOn(transport, 'http').mockImplementation((url, opts) => String(url) === REGISTRY_URL
            ? Promise.resolve(Response.json(Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['fixture-' + i, { models: { fixture: { limit: { context: 48_000 } } } }]))))
            : request(url, opts));
          try { result.agrees &&= await refresh(); } finally { registry.mockRestore(); }
        } else {
          const ref = 'relay/fixture';
          if (row.cache === 'efforts') rt!.catalog.learnEfforts(ref, ['low']);
          else rt!.catalog.learnWindow(ref, 32_000);
        }
        result.agrees &&= digest(file) !== before && !!JSON.parse(fs.readFileSync(file, 'utf8'));
      }
      if (row.library) {
        const issue = issues.find((n) => n.key === settingsWords.libraryValue);
        result.diagnoses &&= issue?.vars.line === (row.name.includes('malformed') ? 3 : 1) && issues.length === 1;
        const put = row.library === 'presets'
          ? await request('presets/update', 'POST', { name: 'broken', patch: { user: 'fixture' } })
          : await request('personas/write', 'POST', { old: 'broken', patch: { description: 'fixture' } });
        visible.push(put.text);
        result.preserves &&= !put.ok && put.value.problem?.key === settingsWords.libraryValue;
        const after = await request('info');
        result.diagnoses &&= after.value.settingsNotices.filter((n: SettingsNotice) => n.id === issue?.id).length === 1;
      }
      if (row.defaultGone) {
        await expect(rt!.start({ cwd: f.project })).rejects.toThrow(settingText({ key: settingsWords.model, vars: { file: f.settings } }));
        const chosen = await rt!.start({ cwd: f.project, model: 'relay/fixture' });
        result.agrees &&= chosen.modelInfo.ref === 'relay/fixture';
      }
      if (row.session) {
        const session = await rt!.start({ cwd: f.project });
        if (row.name.includes('include themselves')) {
          const system = rt!.store.load(session.id)?.system ?? '';
          result.starts &&= system.includes('The instruction is bounded.') && system.length < 100_000;
        }
      }
    }); } finally { registry.mockRestore(); discovery.mockRestore(); }
  } catch (error) {
    result.starts = false;
    notices.push(message(error));
    failures.push(message(error), ...(error instanceof Error && error.cause ? [message(error.cause)] : []));
  } finally {
    rt?.dispose();
    warn.mockRestore();
  }
  const unique = new Set(issues.map((n) => n.id));
  result.diagnoses &&= !notices.length && unique.size === issues.length && (row.issue
    ? issues.some((n) => String(n.vars.file).endsWith(row.issue!) && (!row.expected || n.key === row.expected))
    : !issues.length);
  const saved = digest(file) === before || !!row.repaired && digest(file + '.broken') === before;
  result.preserves &&= (saved || !!row.cache) && digest(f.auth) === authBefore;
  result.private = noSecret([...visible, ...notices]);
  return result;
}

it.each(startup)('$name', async (row) => {
  const failures: string[] = [];
  assertChecks(await probeStartup(row, failures), row.open ?? [], failures.join('\n'));
});

type SaveCase = {
  name: string;
  arrange(f: Fixture): string;
  run(f: Fixture): boolean | Promise<boolean>;
  unchanged?: boolean;
  issue?: string;
  open?: Check[];
};

const editable = (f: Fixture, newline = '\r\n') => [
  '{', '  // keep this comment', ...Object.entries(f.config).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
  '  "unknown": { "keep": true },', '}',
].join(newline) + newline;
const saveLanguage = () => updateGlobalConfig({ language: 'zh-CN' });
const saveKey = () => updateAuthFile((old) => ({ ...old, keys: { ...old.keys, added: 'fixture' } }));
const savePlace = () => writeUiState({ folder: 'new place' });
const encodingCases = (['utf8', 'bom', 'le', 'be'] as const).map((enc): SaveCase => ({
  name: `edit ${enc} settings without rewriting their encoding, comments or unknown keys`,
  arrange: (f) => f.put('home/config.json', encode(editable(f), enc)),
  run(f) {
    saveLanguage();
    const before = encode(editable(f), enc);
    const now = fs.readFileSync(f.settings);
    const header = enc === 'utf8' ? 0 : enc === 'bom' ? 3 : 2;
    const config = loadGlobalConfigRaw();
    const text = enc === 'le' || enc === 'be'
      ? (enc === 'be' ? Buffer.from(now.subarray(2)).swap16() : now.subarray(2)).toString('utf16le')
      : now.subarray(header).toString('utf8');
    return now.subarray(0, header).equals(before.subarray(0, header))
      && !/(?<!\r)\n/.test(text) && text.includes('// keep this comment')
      && text.includes('"unknown": { "keep": true }') && config.language === 'zh-CN';
  },
}));

function corrupt(name: string, file: string, text: string, save: () => unknown): SaveCase {
  return { name, arrange: (f) => f.put(file, text), run: () => { save(); return false; }, unchanged: true, issue: path.basename(file) };
}

const saves: SaveCase[] = [
  ...encodingCases,
  {
    name: 'clearing one setting keeps the previous setting comment',
    arrange: (f) => f.put('home/config.json', '{\r\n  "effort": "low", // about effort\r\n  "language": "auto",\r\n  "unknown": true,\r\n}\r\n'),
    run(f) {
      updateGlobalConfig({ language: undefined });
      const text = fs.readFileSync(f.settings, 'utf8');
      return text.includes('"effort": "low", // about effort') && text.includes('"unknown": true') && loadConfig().language === undefined;
    },
  },
  ...brokenJson.map((text, i) => corrupt(`config save after a cut of class ${i + 1}`, 'home/config.json', text, saveLanguage)),
  corrupt('config save against a scalar', 'home/config.json', 'true', saveLanguage),
  corrupt('config save against an array', 'home/config.json', '[]', saveLanguage),
  corrupt('auth save against an interrupted write', 'home/auth.json', `{"keys":{"kept":"${credential}"},`, saveKey),
  corrupt('auth save against a damaged keys map', 'home/auth.json', '{"keys":[1]}', saveKey),
  corrupt('auth save against a directory', 'home/auth.json', '', saveKey),
  ...['{"folder":"previous",', 'true'].map((text): SaveCase => ({
    name: 'window state recovers from ' + text,
    arrange: (f) => f.put('home/ui-state.json', text),
    run(f) {
      savePlace();
      writeUiState({ last: { model: 'relay/fixture' } });
      const prior = fs.readFileSync(path.join(f.home, 'ui-state.json.broken'), 'utf8');
      const copies = fs.readdirSync(f.home).filter((name) => name.startsWith('ui-state.json.broken'));
      const state = JSON.parse(fs.readFileSync(path.join(f.home, 'ui-state.json'), 'utf8'));
      return prior === text && copies.length === 1 && state.folder === 'new place' && state.last.model === 'relay/fixture';
    },
  })),
  {
    name: 'save with a reader holding the config file',
    arrange: (f) => f.settings,
    unchanged: true, issue: 'config.json',
    run(f) {
      // Windows sharing modes can deny a read, unlike a Node descriptor. Inject that OS result at the read.
      const read = fs.readFileSync;
      const mock = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (file === f.settings) throw Object.assign(new Error('EPERM: config.json'), { code: 'EPERM' });
        return Reflect.apply(read, fs, [file, ...args]);
      }) as typeof read);
      try { saveLanguage(); return false; }
      finally { mock.mockRestore(); }
    },
  },
  {
    name: 'save against a damaged session index rebuilds and keeps the original bytes',
    arrange: (f) => f.put('home/sessions/index.json', '{"old":'),
    async run(f) {
      const rt = createRuntime(f.project);
      const slug = projectSlug(f.project);
      const metadata = (id: string) => ({ id, title: 'fixture', cwd: f.project, created: 1, updated: 1, provider: 'relay', model: 'fixture', effort: 'low' as const, mode: 'build' as const, profile: 'favilla' as const });
      const text = (id: string) => JSON.stringify({ t: 'session', meta: metadata(id), system: '' }) + '\n';
      const { brotliCompressSync } = await import('node:zlib');
      f.put('home/sessions/' + slug + '/hot.jsonl', text('hot') + JSON.stringify({ t: 'meta', meta: { ...metadata('hot'), title: 'later' } }) + '\n');
      f.put('home/sessions/' + slug + '/cold.jsonl.br', brotliCompressSync(text('cold')));
      const unreadable = f.put('home/sessions/' + slug + '/unreadable.jsonl.br', 'not an archive');
      const reads = fs.readdirSync;
      const root = rt.store.root;
      let scans = 0;
      const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...args: unknown[]) => {
        if (dir === root) scans++;
        return Reflect.apply(reads, fs, [dir, ...args]);
      }) as typeof reads);
      try {
        const listed = rt.store.list().map((m) => [m.id, m.title]).sort();
        expect(listed).toEqual([['cold', 'fixture'], ['hot', 'later']]);
        rt.store.create(metadata('fresh'), '');
        rt.store.flushIndex();
        expect(new SessionStore(root).list().map((m) => m.id).sort()).toEqual(['cold', 'fresh', 'hot']);
        return scans === 1 && fs.readFileSync(path.join(root, 'index.json.broken'), 'utf8') === '{"old":'
          && fs.readFileSync(unreadable, 'utf8') === 'not an archive';
      } finally { spy.mockRestore(); rt.dispose(); }
    },
  },
  {
    name: 'second duplicate setting is the effective one after save',
    arrange: (f) => f.put('home/config.json', '{"language":"en","language":"auto",' + JSON.stringify(f.config).slice(1)),
    run: () => { saveLanguage(); return false; },
    unchanged: true, issue: 'config.json',
  },
  {
    name: 'PUT on a provider id containing a dot edits only that provider',
    arrange: (f) => f.put('home/config.json', JSON.stringify({ ...f.config, providers: { ...f.config.providers, 'relay.test': f.config.providers.relay } })),
    async run(f) {
      const rt = createRuntime(f.project);
      let ok = false;
      try {
        await web(rt, async (request) => {
          const res = await request('config', 'PUT', { providers: { 'relay.test': { enabled: false } } });
          ok = res.ok && loadConfig().providers?.['relay.test']?.enabled === false && rt.catalog.provider('relay.test').enabled === false;
        });
        return ok;
      } finally { rt.dispose(); }
    },
  },
  {
    name: 'two windows saving different settings agree with the CLI',
    arrange: (f) => f.put('home/config.json', editable(f)),
    async run(f) {
      const rt = createRuntime(f.project);
      let ok = false;
      try {
        await web(rt, async (request) => {
          const { value: { basis } } = await request('info');
          const saves = await Promise.all([request('config', 'PUT', { language: 'zh-CN', basis }), request('config', 'PUT', { theme: 'nightshift', basis })]);
          const [one, two] = await Promise.all([request('info'), request('info')]);
          const onDisk = loadConfig();
          ok = saves.every((r) => r.ok) && one.text === two.text && one.value.config.language === onDisk.language
            && one.value.config.theme === onDisk.theme && onDisk.language === 'zh-CN' && onDisk.theme === 'nightshift'
            && fs.readFileSync(f.settings, 'utf8').includes('// keep this comment');
        });
        return ok;
      } finally { rt.dispose(); }
    },
  },
  {
    name: 'two engines pick up a hand edit while already running',
    arrange: (f) => f.settings,
    async run(f) {
      const rt = createRuntime(f.project);
      const second = createRuntime(f.project);
      let ok = false;
      try {
        await web(rt, async (one) => web(second, async (two) => {
          saveLanguage();
          const [a, b] = await Promise.all([one('info'), two('info')]);
          ok = a.ok && b.ok && a.value.config.language === loadConfig().language && b.value.config.language === loadConfig().language;
        }));
        return ok;
      } finally { rt.dispose(); second.dispose(); }
    },
  },
  {
    name: 'provider deletion does not publish when auth cannot be read',
    arrange: (f) => f.put('home/auth.json', '{"keys":'),
    async run(f) {
      const cfg = digest(f.settings);
      const rt = createRuntime(f.project);
      try {
        let ok = false;
        await web(rt, async (request) => {
          const res = await request('providers/relay', 'DELETE');
          ok = !res.ok && digest(f.settings) === cfg && noSecret([res.text]);
        });
        return ok;
      } finally { rt.dispose(); }
    },
    unchanged: true,
  },
  {
    name: 'failed reload leaves all already loaded folders on the same settings',
    arrange: (f) => f.settings,
    async run(f) {
      const rt = createRuntime(f.project);
      const other = path.join(f.dir, 'other');
      fs.mkdirSync(other);
      try {
        await rt.start({ cwd: other });
        f.put('other/.favilla/config.json', '{"effort":');
        saveLanguage();
        const found: SettingsNotice[] = [];
        const off = rt.subscribeSettings((notice) => found.push(notice));
        try {
          expect(rt.reload()).toBe(false);
          expect(rt.reload()).toBe(false);
          expect(found.map(settingTextPlain)).toEqual([
            settingText({ key: settingsWords.reload, vars: { file: path.join(other, '.favilla', 'config.json'), line: 1 } }),
          ]);
          return rt.config.language === undefined;
        } finally { off(); }
      } finally { rt.dispose(); }
    },
  },
];
saves.find((row) => row.name === 'auth save against a directory')!.arrange = (f) => {
  fs.unlinkSync(f.auth);
  fs.mkdirSync(f.auth);
  return f.auth;
};

it.each(saves)('$name', async (row) => {
  const f = fixture();
  const file = row.arrange(f);
  const before = digest(file);
  const authBefore = digest(f.auth);
  const outcome = healthy();
  const notices: string[] = [];
  try {
    outcome.agrees = await row.run(f);
  } catch (error) {
    outcome.agrees = !!row.issue;
    notices.push(message(error));
  }
  outcome.diagnoses = row.issue ? notices.length === 1 && notices[0].includes(row.issue) && /invalid JSON on line \d+\. Fix it before saving\.|appears twice|has an invalid value for|Could not read/.test(notices[0]) : !notices.length;
  outcome.preserves = (!row.unchanged || digest(file) === before) && (file === f.auth || digest(f.auth) === authBefore);
  outcome.private = noSecret(notices);
  assertChecks(outcome, row.open ?? []);
});

const socketFence = `
  import { Socket } from 'node:net';
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof first === 'number' ? args[1] : first?.host;
    const port = Number(typeof first === 'number' ? first : first?.port);
    if (host && !/^(127\\.0\\.0\\.1|localhost|::1|\\[::1\\])$/i.test(host)) throw new Error('Non-loopback fixture connection refused');
    if (port === 8080 || port === 11434) {
      const local = Number(process.env.FAVILLA_FIXTURE_PORT);
      if (!local || port !== 8080) throw new Error('Non-fixture model port refused');
      if (Array.isArray(args[0])) args[0][0] = { ...first, port: local };
      else args[0] = typeof first === 'number' ? local : { ...first, port: local };
    }
    return Reflect.apply(connect, this, args);
  };
`;

function readLog(f: Fixture): string {
  const log = path.join(f.home, 'logs', 'desktop.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

function childIn(f: Fixture, file: string, args: string[], preload = '') {
  const data = `data:text/javascript;base64,${Buffer.from(socketFence + preload).toString('base64')}`;
  const child = fork(file, args, {
    cwd: f.project, silent: true, windowsHide: true, execArgv: ['--import', import.meta.resolve('tsx'), '--import', data],
    env: { ...process.env, FAVILLA_HOME: f.home, FAVILLA_PORT: '0', FAVILLA_TOKEN: 'fixture', FAVILLA_FIXTURE_PORT: new URL(endpoint).port, TERM: 'xterm', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', CI: undefined },
  });
  children.add(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => child.kill(), 9_000);
  const closed = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.once('error', (error) => { output += message(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, output });
    });
  });
  return { child, closed };
}

const cli = path.join(repo, 'packages/cli/src/main.ts');
const desktop = path.join(repo, 'packages/desktop/src/engine.ts');
const surfaceSetup = {
  tui: `
    Object.defineProperties(process.stdout, { isTTY: { value: true }, columns: { value: 100 }, rows: { value: 30 } });
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    process.stdin.setRawMode = () => process.stdin;
  `,
  web: `process.on('message', () => process.emit('SIGTERM', 'SIGTERM'));`,
  desktop: `
    process.parentPort = {
      postMessage: (data) => process.send(data),
      on: (event, handler) => process.on(event, (data) => handler({ data })),
    };
  `,
};

async function surface(f: Fixture, mode: 'print' | 'models' | 'tui' | 'web' | 'desktop', broken: boolean) {
  const model = broken ? ['--model', 'local/fixture'] : [];
  const args = mode === 'print' ? ['-p', 'Reply.', '--quiet', '-C', f.project, ...model] : mode === 'tui' ? ['-C', f.project, ...model]
    : mode === 'web' ? ['web', '--no-open', '--token', 'fixture'] : ['models', broken ? 'local' : 'relay'];
  const { child, closed } = childIn(f, mode === 'desktop' ? desktop : cli, args, mode in surfaceSetup ? surfaceSetup[mode as keyof typeof surfaceSetup] : '');
  let ping: Promise<boolean> | undefined;
  let windowNotices: SettingsNotice[] = [];
  const serve = (url: string, stop: string | object) => {
    ping ??= fetch(new URL('/api/info', url), { headers: { authorization: 'Bearer fixture' }, signal: AbortSignal.timeout(4000) })
      .then(async (r) => {
        if (!r.ok) return false;
        const info = await r.json() as { config: { model?: string }; settingsNotices: SettingsNotice[] };
        windowNotices = info.settingsNotices;
        return info.config.model === (broken ? undefined : 'relay/fixture');
      }, () => false)
      .finally(() => { if (child.connected) child.send(stop); });
  };
  if (mode === 'desktop') child.on('message', (m: { type?: string; url?: string }) => { if (m.type === 'ready' && m.url) serve(m.url, { type: 'shutdown' }); });
  if (mode === 'web') child.stdout?.on('data', (chunk) => {
    const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
    if (url) serve(url, 'stop');
  });
  if (mode === 'tui') {
    let shown = '';
    let typed = false;
    let submitted = false;
    child.stdout?.on('data', (chunk) => {
      shown = (shown + String(chunk)).slice(-4096);
      if (!typed && shown.includes('/help')) {
        typed = true;
        child.stdin?.write('/quit');
      }
      // Ink has to render the edit before Enter can submit it. A timer can fire before that render under load.
      if (typed && !submitted && shown.includes('/quit')) {
        submitted = true;
        child.stdin?.write('\r');
      }
    });
  }
  if (mode !== 'tui') child.stdin?.end();
  const r = await closed;
  const text = r.output + (mode === 'desktop' ? readLog(f) : '');
  const observed = mode === 'print' ? r.output.includes(expectedAnswer) : mode === 'tui' ? r.output.includes('/help')
    : mode === 'models' ? r.output.includes(broken ? 'local/fixture' : 'relay/fixture') : !!(await ping);
  return { starts: r.code === 0 && observed, text, windowNotices };
}

const surfaces = (['print', 'models', 'tui', 'web', 'desktop'] as const)
  .flatMap((mode) => [false, true].map((broken) => ({ name: `${mode} ${broken ? 'with torn global config' : 'with valid config'}`, mode, broken })));
it.each(surfaces)('$name', async ({ mode, broken }) => {
  const f = fixture();
  if (broken) {
    f.put('home/config.json', '{\n  "model":');
    f.put('home/cache/models-local.json', JSON.stringify({ fetched: Date.now(), models: [{ id: 'fixture' }] }));
  }
  const before = digest(f.settings);
  const beforeAuth = digest(f.auth);
  const r = await surface(f, mode, broken);
  expect(r.starts, r.text).toBe(true);
  const o = healthy();
  o.starts = r.starts;
  const expected = settingText({ key: settingsWords.start, vars: { file: f.settings, line: 2 } });
  const errors = r.text.split(/\r?\n/).filter((line) => /config\.json|^\s+at\s/.test(line));
  const terminal = mode === 'desktop' || (broken ? errors.length === 1 && errors[0].includes(expected) : !errors.length);
  const window = mode !== 'web' && mode !== 'desktop' || (broken ? r.windowNotices.length === 1 && settingText(r.windowNotices[0]) === expected : !r.windowNotices.length);
  o.diagnoses = terminal && window;
  o.preserves = digest(f.settings) === before && digest(f.auth) === beforeAuth;
  o.private = noSecret([r.text, JSON.stringify(r.windowNotices)]);
  assertChecks(o, []);
}, 12_000);

const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
async function concurrentSaves(f: Fixture, type: 'config' | 'auth' | 'ui') {
  const writer = f.put('writer.mjs', `
    import fs from 'node:fs';
    import { updateGlobalConfig } from ${JSON.stringify(moduleUrl('../src/config/config.ts'))};
    import { updateAuthFile } from ${JSON.stringify(moduleUrl('../src/auth/store.ts'))};
    import { writeUiState } from ${JSON.stringify(moduleUrl('../src/config/ui-state.ts'))};
    const [type, file, role, mark] = process.argv.slice(2);
    const write = fs.writeFileSync;
    process.on('message', () => {
      try {
        if (role === 'first') fs.writeFileSync = (name, ...args) => {
          if (typeof name === 'string' && name.startsWith(file + '.') && name.endsWith('.tmp')) {
            process.send('read');
            const sleep = new Int32Array(new SharedArrayBuffer(4));
            const until = Date.now() + 800;
            while (!fs.existsSync(mark) && Date.now() < until) Atomics.wait(sleep, 0, 0, 10);
          }
          return write(name, ...args);
        };
        const first = role === 'first';
        if (type === 'config') updateGlobalConfig(first ? { theme: 'nightshift' } : { language: 'zh-CN' });
        if (type === 'auth') updateAuthFile((old) => ({ ...old, keys: { ...old.keys, [role]: 'fixture' } }));
        if (type === 'ui') writeUiState(first ? { folder: 'first' } : { session: 'second' });
        process.exit(0);
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    });
    process.send('ready');
  `);
  const file = path.join(f.home, type === 'ui' ? 'ui-state.json' : `${type}.json`);
  if (type === 'ui') f.put('home/ui-state.json', '{"recent":["old"]}');
  const mark = path.join(f.dir, 'writer-finished');
  const [first, second] = ['first', 'second'].map((role) => childIn(f, writer, [type, file, role, mark]));
  const wait = (c: typeof first, value: string) => Promise.race([
    c.closed.then(() => false), new Promise<boolean>((resolve) => c.child.on('message', (msg) => { if (msg === value) resolve(true); })),
  ]);
  const ready = await Promise.all([wait(first, 'ready'), wait(second, 'ready')]);
  if (ready.every(Boolean)) {
    const read = wait(first, 'read');
    first.child.send('start');
    if (await read) second.child.send('start');
    await second.closed.then(() => fs.writeFileSync(mark, ''));
  }
  const results = await Promise.all([first.closed, second.closed]);
  return { saved: results.every((r) => r.code === 0), output: results.map((r) => r.output), file };
}

it.each(['config', 'auth', 'ui'] as const)('independent %s saves from two processes both survive', async (type) => {
  const f = fixture();
  const r = await concurrentSaves(f, type);
  const o = healthy();
  o.starts = r.saved;
  o.diagnoses = r.output.every((s) => !s.trim());
  o.private = noSecret(r.output);
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  o.preserves = type === 'auth' ? saved.keys?.kept === credential && saved.unknown === 'kept' : type === 'ui' ? saved.recent?.[0] === 'old' : saved.model === 'relay/fixture';
  o.agrees = type === 'config' ? saved.theme === 'nightshift' && saved.language === 'zh-CN'
    : type === 'auth' ? saved.keys?.first === 'fixture' && saved.keys?.second === 'fixture' : saved.folder === 'first' && saved.session === 'second';
  assertChecks(o, []);
}, 12_000);

const dataModule = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const desktopMain = path.join(repo, 'packages/desktop/src/main.ts');
const electronStub = dataModule(`
  import { EventEmitter } from 'node:events';
  const nothing = () => {};
  export const app = Object.assign(new EventEmitter(), {
    getVersion: () => 'fixture', requestSingleInstanceLock: () => true, isPackaged: true, setAppUserModelId: nothing,
    whenReady: async () => {}, getPath: () => process.env.FAVILLA_HOME, quit: () => process.exit(1),
    disableHardwareAcceleration: () => process.send({ type: 'low-memory' }),
  });
  export const dialog = { showErrorBox: (_title, error) => process.send({ type: 'error', error }) };
  export const ipcMain = { handle: nothing, on: nothing };
  export const Menu = { setApplicationMenu: nothing };
  export const nativeTheme = { shouldUseDarkColors: false };
  export const powerMonitor = { getSystemIdleTime: () => 0 };
  export const powerSaveBlocker = {};
  export const shell = {};
  export const utilityProcess = {
    fork(_file, _args, { env }) {
      const child = Object.assign(new EventEmitter(), { postMessage: nothing, kill: nothing });
      const preferred = Number(env.FAVILLA_PORT);
      const port = preferred === 12345 ? 12346 : 12345;
      process.send({ type: 'engine', preferred, port });
      queueMicrotask(() => child.emit('message', { type: 'ready', port, url: 'http://127.0.0.1:' + port + '/', token: env.FAVILLA_TOKEN }));
      return child;
    },
  };
  export class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: nothing, session: { clearCache: async () => {} } });
      process.send({ type: 'bounds', width: options.width, color: options.backgroundColor });
    }
    async loadURL(url) { process.send({ type: 'loaded', port: Number(new URL(url).port) }, () => process.exit(0)); }
    show() { throw new Error('Fixture must not show a window'); }
  }
`);
const desktopLoader = dataModule(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: ${JSON.stringify(electronStub)}, shortCircuit: true };
    return next(specifier, context);
  }
`);

it.each([
  { name: 'desktop main with usable bounds and port', window: '{"width":900}', port: '{"port":12345}', utf16: false, open: [] },
  { name: 'desktop main with null bounds', window: 'null', port: '{"port":12345}', utf16: false, open: [] },
  { name: 'desktop main with damaged port file', window: '{"width":900}', port: '{"port":', utf16: false, open: [] },
  { name: 'desktop first colour reads UTF-16 settings', window: '{"width":900}', port: '{"port":12345}', utf16: true, open: [] },
] as { name: string; window: string; port: string; utf16: boolean; open: Check[] }[])('$name', async (row) => {
  const f = fixture();
  const config = JSON.stringify({ ...f.config, theme: 'kiln-night', desktop: { hardwareAcceleration: false } });
  f.put('home/config.json', row.utf16 ? encode(config, 'le') : config);
  const bounds = f.put('home/window.json', row.window);
  const port = f.put('home/server-port.json', row.port);
  const watched = [f.settings, f.auth, bounds, port];
  const before = watched.map(digest);
  const { child, closed } = childIn(f, desktopMain, [], `
    import Module, { register } from 'node:module';
    globalThis.__FAVILLA_THEME_BARS__ = (await import(${JSON.stringify(pathToFileURL(path.join(repo, 'packages/desktop/theme-bars.mjs')).href)})).themeBars();
    register(${JSON.stringify(desktopLoader)}, import.meta.url);
    const electron = await import(${JSON.stringify(electronStub)});
    const load = Module._load;
    Module._load = function (specifier, ...args) {
      return specifier === 'electron' ? electron : Reflect.apply(load, this, [specifier, ...args]);
    };
  `);
  const events: { type: string; color?: string; width?: number; error?: string; preferred?: number; port?: number }[] = [];
  child.on('message', (m) => events.push(m as (typeof events)[number]));
  child.stdin?.end();
  const r = await closed;
  const o = healthy();
  o.starts = r.code === 0 && events.some((e) => e.type === 'loaded');
  o.diagnoses = !events.some((e) => e.type === 'error');
  o.preserves = watched.slice(0, 3).every((file, i) => digest(file) === before[i]);
  const b = events.find((e) => e.type === 'bounds');
  const engine = events.find((e) => e.type === 'engine');
  if (o.starts) o.agrees = b?.width === (row.window === 'null' ? 1380 : 900) && b.color === '#24201c'
    && events.some((e) => e.type === 'low-memory')
    && engine?.preferred === (row.port === '{"port":' ? 0 : 12345)
    && events.find((e) => e.type === 'loaded')?.port === engine?.port
    && JSON.parse(fs.readFileSync(port, 'utf8')).port === engine?.port;
  o.private = noSecret([r.output, ...events.map((e) => e.error ?? ''), readLog(f)]);
  assertChecks(o, row.open);
}, 12_000);

it.skipIf(process.platform !== 'win32')('Windows denies access to a settings file held exclusively by another process', async () => {
  const f = fixture();
  const before = [digest(f.settings), digest(f.auth)];
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$file = [IO.File]::Open($env:FAVILLA_FIXTURE_FILE, 'Open', 'Read', 'None')",
    "try { [Console]::WriteLine('held'); [void][Console]::ReadLine() } finally { $file.Dispose() }",
  ].join('\n')], { windowsHide: true, stdio: 'pipe', env: { ...process.env, FAVILLA_FIXTURE_FILE: f.settings } });
  children.add(child);
  let out = '';
  child.on('error', (e) => { out += message(e); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  const timer = setTimeout(() => child.kill(), 8_000);
  const closed = new Promise<void>((resolve) => child.once('close', () => {
    clearTimeout(timer);
    children.delete(child);
    resolve();
  }));
  const held = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((resolve) => child.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(true); })),
  ]);
  const o = healthy();
  try {
    expect(held, out).toBe(true);
    const rt = createRuntime(f.project);
    const notice = settingText({ key: settingsWords.unreadable, vars: { file: f.settings } });
    try {
      const seen = rt.settingsNotices.map(settingTextPlain);
      o.diagnoses = seen.length === 1 && seen[0] === notice;
      try { saveLanguage(); o.agrees = false; }
      catch (e) { o.diagnoses &&= message(e) === notice; }
      o.private = noSecret(seen);
    } finally { rt.dispose(); }
  } finally {
    if (!child.stdin.destroyed) child.stdin.end('\n');
    await closed;
  }
  o.preserves = digest(f.settings) === before[0] && digest(f.auth) === before[1];
  assertChecks(o, []);
}, 12_000);

const layouts: { name: string; before: string; edits: [string[], unknown][]; after: string }[] = [
  {
    name: 'two-space siblings and a nested provider',
    before: '{\n  "providers": {\n    "alpha": { "baseUrl": "http://a" }\n  },\n  "untouched": [ 1, 2 ]\n}\n',
    edits: [[['providers', 'beta'], { baseUrl: 'http://b', models: { fixture: { contextWindow: 48000 } } }], [['theme'], 'kiln']],
    after: '{\n  "providers": {\n    "alpha": { "baseUrl": "http://a" },\n    "beta": {\n      "baseUrl": "http://b",\n      "models": {\n        "fixture": {\n          "contextWindow": 48000\n        }\n      }\n    }\n  },\n  "untouched": [ 1, 2 ],\n  "theme": "kiln"\n}\n',
  },
  {
    name: 'tab indentation with CRLF and a trailing comma',
    before: '{\r\n\t"providers": {\r\n\t\t"alpha": { "baseUrl": "http://a" },\r\n\t},\r\n}\r\n',
    edits: [[['providers', 'beta'], { baseUrl: 'http://b' }]],
    after: '{\r\n\t"providers": {\r\n\t\t"alpha": { "baseUrl": "http://a" },\r\n\t\t"beta": {\r\n\t\t\t"baseUrl": "http://b"\r\n\t\t},\r\n\t},\r\n}\r\n',
  },
  { name: 'empty one-line document', before: '{}', edits: [[['theme'], 'kiln']], after: '{\n  "theme": "kiln"\n}' },
  { name: 'nonempty one-line document', before: '{ "a": 1 }', edits: [[['theme'], 'kiln']], after: '{ "a": 1,\n  "theme": "kiln"\n}' },
  {
    name: 'empty nested parent keeps the file indent unit',
    before: '{\n    "providers": {},\n    "other": 1\n}\n',
    edits: [[['providers', 'beta'], { baseUrl: 'http://b' }]],
    after: '{\n    "providers": {\n        "beta": {\n            "baseUrl": "http://b"\n        }\n    },\n    "other": 1\n}\n',
  },
  {
    name: 'comment after the last key',
    before: '{\n  "a": 1 // stays on this line\n  // keep this too\n}\n',
    edits: [[['theme'], 'kiln']],
    after: '{\n  "a": 1, // stays on this line\n  // keep this too\n  "theme": "kiln"\n}\n',
  },
  {
    name: 'a replacement only touches the value',
    before: '{ "a": 1, "theme" /* chosen */ : "auto", "b": [1,2] }',
    edits: [[['theme'], 'kiln']],
    after: '{ "a": 1, "theme" /* chosen */ : "kiln", "b": [1,2] }',
  },
];

it.each(layouts)('settings layout: $name', ({ before, edits, after }) => {
  const f = fixture();
  f.put('home/config.json', before);
  updateGlobalConfig({}, edits);
  expect(fs.readFileSync(f.settings)).toEqual(Buffer.from(after));
});

it.each([true, false])('a settings lock with a live foreign PID, stale=%s', (stale) => {
  const f = fixture();
  const lock = f.settings + '.edit-lock';
  const held = path.join(lock, process.ppid + '-00000000-0000-0000-0000-000000000000');
  process.kill(process.ppid, 0);
  fs.mkdirSync(lock);
  fs.writeFileSync(held, '');
  const time = new Date(Date.now() - (stale ? 10_000 : 0));
  fs.utimesSync(lock, time, time);
  if (stale) {
    saveLanguage();
    expect(loadConfig().language).toBe('zh-CN');
    expect(fs.existsSync(lock)).toBe(false);
  } else {
    const before = digest(f.settings);
    expect(saveLanguage).toThrow(settingText({ key: settingsWords.busy, vars: { file: f.settings } }));
    expect(digest(f.settings)).toBe(before);
    expect(fs.existsSync(held)).toBe(true);
  }
});

it('a torn config is all defaults at start, deduped, refused on save and cleared when fixed', async () => {
  const f = fixture();
  f.put('home/config.json', '{\n  "theme": "kiln",\n  "model":');
  const before = digest(f.settings);
  const rt = createRuntime(f.project);
  const startup = settingText({ key: settingsWords.start, vars: { file: f.settings, line: 3 } });
  const save = settingText({ key: settingsWords.save, vars: { file: f.settings, line: 3 } });
  try {
    expect(rt.config.theme).toBeUndefined();
    expect(rt.settingsNotices.map(settingTextPlain)).toEqual([startup]);
    const notices: SettingsNotice[] = [];
    rt.subscribeSettings((note) => notices.push(note));
    expect(rt.reload()).toBe(false);
    expect(notices).toEqual([]);
    await web(rt, async (request) => {
      const info = await request('info');
      expect(info.value.settingsNotices.map(settingTextPlain)).toEqual([startup]);
      const result = await request('config', 'PUT', { theme: 'kiln' });
      expect(result.ok).toBe(false);
      expect(result.value.error).toBe(save);
      expect(digest(f.settings)).toBe(before);
      f.put('home/config.json', JSON.stringify({ ...f.config, theme: 'kiln' }));
      expect(rt.reload()).toBe(true);
      expect((await request('info')).value.settingsNotices).toEqual([]);
      expect(rt.config.theme).toBe('kiln');
    });
  } finally { rt.dispose(); }
});

it('a theme never chosen is Gesso following the system, and a saved one, "auto" among them, stays', async () => {
  const f = fixture();
  const rt = createRuntime(f.project);
  try {
    expect(DEFAULT_THEME).toBe('lampblack-auto');
    expect(rt.config.theme).toBeUndefined();
    await web(rt, async (request) => {
      expect((await request('info')).value.config.theme).toBe('lampblack-auto');
      // "auto" was the default up to 1.2.26 but is only ever written by a choice: Drafting following the system.
      for (const saved of ['auto', 'kiln', 'gesso']) {
        f.put('home/config.json', JSON.stringify({ ...f.config, theme: saved }));
        expect(rt.reload()).toBe(true);
        expect((await request('info')).value.config.theme).toBe(saved);
      }
    });
  } finally { rt.dispose(); }
});

it('a torn auth reload keeps the previous credentials and refuses a save without echoing the file', async () => {
  const f = fixture();
  f.put('home/auth.json', JSON.stringify({ keys: { relay: credential, kept: 'still saved' } }));
  const rt = createRuntime(f.project);
  const torn = f.put('home/auth.json', '{\n  "keys": {"relay": "' + credential + '"},\n  "mail":');
  const before = digest(torn);
  try {
    const notices: SettingsNotice[] = [];
    rt.subscribeSettings((notice) => notices.push(notice));
    expect(rt.reload()).toBe(true);
    expect(rt.reload()).toBe(true);
    expect(notices.map(settingTextPlain)).toEqual([settingText({ key: settingsWords.reload, vars: { file: f.auth, line: 3 } })]);
    expect(readAuthFile().keys?.relay).toBe(credential);
    await web(rt, async (request) => {
      const reply = await request('providers/relay/key', 'POST', { key: 'replacement' });
      expect(reply.ok).toBe(false);
      expect(reply.value.error).toBe(settingText({ key: settingsWords.save, vars: { file: f.auth, line: 3 } }));
      expect(noSecret([reply.text, (await request('info')).text])).toBe(true);
      expect(digest(torn)).toBe(before);
    });
  } finally { rt.dispose(); }
});

it('a bad known key falls back on its own and does not erase the rest of the settings', () => {
  const f = fixture();
  const config = { ...f.config, theme: 'kiln', guard: { mode: 4, allow: ['fixture'] }, context: { compactAt: 'wrong', limit: 4096 }, future: true };
  f.put('home/config.json', JSON.stringify(config));
  const rt = createRuntime(f.project);
  try {
    expect(rt.config).toMatchObject({ model: 'relay/fixture', theme: 'kiln', guard: { allow: ['fixture'] }, context: { limit: 4096 }, future: true });
    expect(rt.config.guard?.mode).toBeUndefined();
    expect(rt.config.context?.compactAt).toBeUndefined();
    expect(rt.settingsNotices.map((n) => n.vars.key).sort()).toEqual(['context.compactAt', 'guard.mode']);
    expect(JSON.parse(fs.readFileSync(f.settings, 'utf8'))).toEqual(config);
  } finally { rt.dispose(); }
});

it('the proxy password stays on disk for the same username and never comes back in settings', async () => {
  const f = fixture();
  f.put('home/config.json', JSON.stringify({ ...f.config, proxy: 'http://fixture:' + credential + '@127.0.0.1:9' }));
  const rt = createRuntime(f.project);
  try {
    await web(rt, async (request) => {
      const read = async (address: string, saved: boolean) => {
        const info = await request('info');
        expect(info.value.config).toMatchObject({ proxy: address, proxyPasswordSaved: saved });
        expect(noSecret([info.text])).toBe(true);
      };
      const save = async (value: string, stored: string) => {
        const reply = await request('config', 'PUT', { proxy: value });
        expect(reply.ok).toBe(true);
        expect(noSecret([reply.text])).toBe(true);
        expect(loadGlobalConfigRaw().proxy).toBe(stored);
      };
      await read('http://fixture@127.0.0.1:9', true);
      await save('http://fixture@127.0.0.1:10', 'http://fixture:' + credential + '@127.0.0.1:10');
      await read('http://fixture@127.0.0.1:10', true);
      await save('http://fixture:replacement@127.0.0.1:10', 'http://fixture:replacement@127.0.0.1:10');
      await read('http://fixture@127.0.0.1:10', true);
      await save('http://other@127.0.0.1:11', 'http://other@127.0.0.1:11');
      await read('http://other@127.0.0.1:11', false);
    });
  } finally { rt.dispose(); }
});

it('settings answers project provider, account and MCP secrets out of their views', async () => {
  const f = fixture();
  const url = 'http://fixture:' + credential + '@127.0.0.1:9/mcp?api_key=' + credential + '&mode=sse';
  const server = { host: 'fixture.example', port: 993, secure: true, token: credential };
  const account = { address: 'fixture@example.test', imap: server, smtp: server, password: credential };
  f.put('home/config.json', JSON.stringify({
    ...f.config, providers: { ...f.config.providers, relay: { ...f.config.providers.relay, baseUrl: url, auth: 'key', apiKey: credential, headers: { Authorization: 'Bearer ' + credential } } },
    mcpServers: { remote: { url, headers: { Authorization: 'Bearer ' + credential }, enabled: false }, stdio: { command: 'fixture', env: { TOKEN: credential }, enabled: false } },
    mail: { accounts: [account] },
  }));
  f.put('home/auth.json', JSON.stringify({ keys: { relay: credential }, mail: { [account.address]: credential } }));
  f.put('home/cache/models-relay.json', JSON.stringify({ fetched: Date.now(), models: [], error: 'Rejected ' + credential }));
  const rt = createRuntime(f.project);
  const shown = 'http://fixture@127.0.0.1:9/mcp?mode=sse';
  try {
    await web(rt, async (request) => {
      const routes = await Promise.all(['info', 'providers', 'mcp', 'mail'].map((route) => request(route)));
      expect(routes.every((r) => r.ok) && noSecret(routes.map((r) => r.text))).toBe(true);
      expect(routes[1].value.find((p: { id: string }) => p.id === 'relay')).toMatchObject({ baseUrl: shown, keys: 1 });
      expect(routes[2].value.find((s: { name: string }) => s.name === 'remote').config).toEqual({ url: shown, headers: ['Authorization'], enabled: false });
      expect(routes[2].value.find((s: { name: string }) => s.name === 'stdio').config.env).toEqual(['TOKEN']);
      expect(routes[3].value.accounts[0]).toMatchObject({ address: account.address, hasPassword: true });
      expect((await request('mcp/save', 'POST', { name: 'remote', config: { kind: 'url', url: shown, headers: [{ name: 'Authorization' }], enabled: false } })).ok).toBe(true);
      expect(rt.mcp.configs().remote).toEqual({ url, headers: { Authorization: 'Bearer ' + credential }, enabled: false });
    });
  } finally { rt.dispose(); }
});

it('the MCP form keeps fields added, changed and removed on disk, and refuses a conflicting or deleted entry', async () => {
  const f = fixture();
  const initial = { url: 'http://127.0.0.1:9/mcp', headers: { Accept: 'application/json', Remove: 'one' }, enabled: false };
  const onDisk = (entry?: object) => f.put('home/config.json', JSON.stringify({ ...f.config, mcpServers: entry ? { fixture: entry } : {} }));
  onDisk(initial);
  const rt = createRuntime(f.project);
  try {
    await web(rt, async (request) => {
      const open = async () => {
        const { value: [entry] } = await request('mcp');
        return { name: 'fixture', from: 'fixture', basis: entry.basis, before: {
          ...entry.config, kind: 'url', headers: entry.config.headers.map((name: string) => ({ name })),
        } };
      };
      const opened = await open();
      const headers = { Accept: 'changed by hand', 'X-Added-On-Disk': credential };
      onDisk({ ...initial, headers, timeoutMs: 2400 });
      const saved = await request('mcp/save', 'POST', { ...opened, config: { ...opened.before, url: initial.url + '/new' } });
      expect(saved.ok).toBe(true);
      expect(noSecret([saved.text])).toBe(true);
      expect(loadGlobalConfigRaw().mcpServers?.fixture).toEqual({ ...initial, headers, timeoutMs: 2400, url: initial.url + '/new' });

      const next = await open();
      onDisk({ ...initial, headers });
      const before = digest(f.settings);
      const refused = await request('mcp/save', 'POST', { ...next, config: { ...next.before, url: initial.url + '/other', enabled: true } });
      expect(refused.status).toBe(409);
      expect(refused.value.problem.key).toBe(settingsWords.conflict);
      expect(digest(f.settings)).toBe(before);
      expect((await open()).before.url).toBe(initial.url);

      onDisk();
      const deleted = digest(f.settings);
      const reply = await request('mcp/save', 'POST', { ...next, config: { ...next.before, enabled: true } });
      expect(reply.status).toBe(409);
      expect(digest(f.settings)).toBe(deleted);
      expect((await request('mcp')).value).toEqual([]);
    });
  } finally { rt.dispose(); }
});

it('config and credential forms compare touched fields together, without recreating a provider or model', async () => {
  const f = fixture();
  const initial = { ...f.config, proxy: 'http://user:fixture@127.0.0.1:9', theme: 'kiln' };
  f.put('home/config.json', JSON.stringify(initial));
  f.put('home/auth.json', JSON.stringify({ keys: { relay: credential }, unknown: 'kept' }));
  const rt = createRuntime(f.project);
  try {
    await web(rt, async (request) => {
      const basis = (await request('info')).value.basis;
      const p = (await request('providers')).value.find((p: { id: string }) => p.id === 'relay');
      f.put('home/config.json', JSON.stringify({ ...initial, theme: 'nightshift' }));
      expect((await request('config', 'PUT', { language: 'zh-CN', basis })).ok).toBe(true);
      expect(loadGlobalConfigRaw()).toMatchObject({ theme: 'nightshift', language: 'zh-CN' });
      const before = digest(f.settings);
      const conflict = await request('config', 'PUT', { theme: 'drafting', proxy: 'http://user@127.0.0.1:11', basis });
      expect(conflict.status).toBe(409);
      expect(digest(f.settings)).toBe(before);

      const raw = loadGlobalConfigRaw();
      const relay = raw.providers!.relay;
      f.put('home/config.json', JSON.stringify({ ...raw, providers: { relay: { ...relay, models: {} } } }));
      expect((await request('config', 'PUT', { windows: [{ ref: 'relay/fixture', contextWindow: 64_000 }], basis: p.basis })).status).toBe(409);
      expect(loadGlobalConfigRaw().providers?.relay.models).toEqual({});

      f.put('home/auth.json', JSON.stringify({ keys: { relay: 'new by hand' }, unknown: 'kept' }));
      const auth = digest(f.auth);
      const key = await request('providers/relay/key', 'POST', { key: 'typed in window', basis: p.basis });
      expect(key.status).toBe(409);
      expect(noSecret([key.text])).toBe(true);
      expect(digest(f.auth)).toBe(auth);

      const fresh = (await request('providers')).value.find((p: { id: string }) => p.id === 'relay');
      f.put('home/config.json', JSON.stringify({ ...raw, providers: {} }));
      const gone = digest(f.settings);
      expect((await request('config', 'PUT', { providers: { relay: { baseUrl: endpoint + '/new' } }, basis: fresh.basis })).status).toBe(409);
      expect((await request('providers/relay/key', 'POST', { key: 'typed in window', basis: fresh.basis })).status).toBe(409);
      expect((await request('providers/relay/models', 'POST', { id: 'model', basis: fresh.basis })).status).toBe(409);
      expect([digest(f.settings), digest(f.auth)]).toEqual([gone, auth]);
    });
  } finally { rt.dispose(); }
});

it('the mail form keeps another account and an outside change, and publishes neither file on a password conflict', async () => {
  const f = fixture();
  const old = { address: 'first@example.test', name: 'First', imap: { host: 'localhost', port: 993, secure: true }, smtp: { host: 'localhost', port: 465, secure: true } };
  const other = { ...old, address: 'second@gmail.com' };
  f.put('home/config.json', JSON.stringify({ ...f.config, mail: { accounts: [old] } }));
  f.put('home/auth.json', JSON.stringify({ mail: { [old.address]: credential } }));
  const tested = vi.spyOn(MailClient.prototype, 'test').mockResolvedValue({ folders: 1 });
  const rt = createRuntime(f.project);
  try {
    await web(rt, async (request) => {
      const opened = await request('mail');
      expect(noSecret([opened.text])).toBe(true);
      const keep = { ...old, name: 'Changed by hand', extra: true };
      f.put('home/config.json', JSON.stringify({ ...f.config, mail: { accounts: [other, keep] } }));
      const saved = await request('mail/accounts', 'POST', { address: old.address, password: 'typed', basis: opened.value.basis });
      expect(saved.ok, saved.value.problem?.key).toBe(true);
      expect(JSON.parse(fs.readFileSync(f.settings, 'utf8')).mail.accounts).toEqual([other, keep]);
      f.put('home/auth.json', JSON.stringify({ mail: { [old.address]: 'changed by hand' } }));
      const before = [digest(f.settings), digest(f.auth)];
      const calls = tested.mock.calls.length;
      const refused = await request('mail/accounts', 'POST', { address: old.address, password: 'typed again', name: 'New name', basis: saved.value.basis });
      expect(refused.status).toBe(409);
      expect([digest(f.settings), digest(f.auth)]).toEqual(before);
      expect(noSecret([refused.text])).toBe(true);
      expect(tested).toHaveBeenCalledTimes(calls);

      const fresh = await request('mail');
      expect((await request('mail/accounts', 'POST', { address: old.address, name: 'From the window', basis: fresh.value.basis })).ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(f.settings, 'utf8')).mail.accounts).toEqual([other, { ...keep, name: 'From the window' }]);
      expect(digest(f.auth)).toBe(before[1]);

      const loaded = await request('mail');
      f.put('home/config.json', JSON.stringify({ ...f.config, mail: { accounts: [other] } }));
      const deleted = digest(f.settings);
      expect((await request('mail/accounts', 'POST', { address: old.address, name: 'After deletion', basis: loaded.value.basis })).status).toBe(409);
      expect([digest(f.settings), digest(f.auth)]).toEqual([deleted, before[1]]);
    });
  } finally { rt.dispose(); tested.mockRestore(); }
});

it('a catalogue refresh finishing after shutdown cannot reload the next startup fixture', async () => {
  const f = fixture();
  const rt = createRuntime(f.project);
  let finish!: (changed: boolean) => void;
  const refresh = vi.spyOn(rt.catalog, 'refreshRegistry').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const reload = vi.spyOn(rt, 'reload');
  try {
    await web(rt, async (request) => { expect((await request('info')).ok).toBe(true); });
    const next = fixture();
    next.put('home/config.json', '');
    finish(true);
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    const empty = createRuntime(next.project);
    try { expect(empty.settingsNotices.map((n) => n.key)).toEqual([settingsWords.start]); }
    finally { empty.dispose(); }
  } finally { finish(false); reload.mockRestore(); refresh.mockRestore(); rt.dispose(); }
});

// The ordinary matrix stays quick. This sweep probes each declared key with a value of a different JSON type
// and repeats common file encodings and interruption shapes across the independent readers.
const wide = process.env.FAVILLA_STARTUP_SWEEP === '1';
it.runIf(wide)('sweeps the individual settings and the optional startup files', async () => {
  const configFile = '../src/config/config.ts';
  const reads = (file: string, type: string) => {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const body = new RegExp(`^export interface ${type} \\{\\r?\\n([\\s\\S]*?)^\\}`, 'm').exec(text)?.[1];
    if (!body) throw new Error(`Missing declaration for ${type}`);
    return [...body.matchAll(/^ {2}(\w+)\??: ([^\n]+)/gm)].map(([, key, type]) => [key, type.includes('[]') ? {} : [null]] as const);
  };
  const fields = [
    { file: configFile, type: 'FavillaConfig', path: [] },
    { file: configFile, type: 'ProviderSettings', path: ['providers', 'relay'] },
    { file: configFile, type: 'ModelSettings', path: ['providers', 'relay', 'models', 'fixture'] },
    { file: configFile, type: 'Quirks', path: ['providers', 'relay', 'quirks'] },
    { file: configFile, type: 'Pricing', path: ['providers', 'relay', 'models', 'fixture', 'pricing'] },
  ];
  const shapes = fields.flatMap((spec) => reads(spec.file, spec.type).map(([key, wrong]): Startup => ({
    name: [...spec.path, key].join('.'),
    arrange(f) {
      const config = f.config as Record<string, any>;
      const target = spec.path.reduce<Record<string, any>>((node, part) => (node[part] ??= {}), config);
      target[key] = wrong;
      if (spec.type === 'ProviderSettings' && ['apiKey', 'apiKeys', 'env', 'keyFile'].includes(key)) target.auth = 'key';
      return f.put('home/config.json', JSON.stringify(config));
    },
    route: spec.type === 'FavillaConfig' && key === 'mcpServers' ? 'mcp' : key === 'instructions' ? 'rules' : 'providers',
    session: spec.type === 'FavillaConfig' && ['model', 'effort', 'instructions', 'shell', 'context', 'skills', 'tools'].includes(key),
    issue: 'config.json',
  })));
  const optional = [
    ['auth.json', 'providers', () => ({ keys: { kept: credential } })],
    ['cache/models-relay.json', 'providers', () => ({ fetched: Date.now(), models: [{ id: 'fixture' }] })],
    ['cache/efforts-learned.json', 'providers', () => ({ 'relay/fixture': { efforts: ['low'], at: Date.now() } })],
    ['cache/windows-learned.json', 'providers', () => ({ 'relay/fixture': { window: 32_000, at: Date.now() } })],
    ['cache/models-dev.json', 'providers', () => ({ v: 2, fetched: Date.now(), providers: { relay: { models: { fixture: { c: 48_000 } } } } })],
    ['sessions/index.json', 'sessions', () => ({})],
    ['presets/entry.json', 'presets', () => ({ name: 'fixture', entries: [] })],
    ['personas/entry.json', 'personas', () => ({ name: 'fixture' })],
    ['ui-state.json', 'ui-state', () => ({ folder: 'fixture', recent: ['fixture'] })],
  ] as const;
  const forms = [
    ['missing', (text: string) => text], ['empty', () => ''], ['torn', (text: string) => text.slice(0, -1)],
    ['directory', (text: string) => text], ['read-only', (text: string) => text], ['CRLF', (text: string) => text + '\r\n'],
    ['BOM', (text: string) => encode(text, 'bom')], ['UTF-16', (text: string) => encode(text, 'le')],
    ['comments', (text: string) => '// fixture\n' + text], ['trailing comma', (text: string) => text.length > 2 ? text.slice(0, -1) + ',}' : '{,}'],
    ['wrong root', () => 'true'], ['duplicate key', (text: string) => '{"fixture":1,"fixture":2' + (text.length > 2 ? ',' + text.slice(1) : '}')],
  ] as const;
  const variations = optional.flatMap(([file, route, make]) => forms.map(([form, bytes]): Startup => ({
    name: `${file} ${form}`,
    arrange(f) {
      if (file.endsWith('models-dev.json')) f.put('home/config.json', JSON.stringify({ ...f.config, modelRegistry: true }));
      const target = f.put('home/' + file, bytes(JSON.stringify(make())));
      if (form === 'directory' || form === 'missing') fs.unlinkSync(target);
      if (form === 'directory') fs.mkdirSync(target);
      if (form === 'read-only') fs.chmodSync(target, 0o444);
      return target;
    },
    route, repaired: file === 'sessions/index.json', issue: ['missing', 'read-only', 'CRLF'].includes(form) ? undefined : path.basename(file),
  })));
  const observed = [...shapes, ...variations];
  const faults = Object.fromEntries(checks.map((key) => [key, [] as string[]])) as Record<Check, string[]>;
  for (const row of observed) {
    const result = await probeStartup(row);
    for (const key of checks) if (!result[key]) faults[key].push(row.name);
  }
  console.log('Startup/settings sweep', JSON.stringify({
    cases: observed.length,
    held: observed.length - new Set(Object.values(faults).flat()).size,
    counts: Object.fromEntries(checks.map((key) => [key, faults[key].length])),
    starts: faults.starts, preserves: faults.preserves, private: faults.private,
  }));
  expect(faults.preserves).toEqual([]);
  expect(faults.private).toEqual([]);
}, 120_000);
