import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import type { Runtime } from '../src/runtime';
import { SessionStore } from '../src/store/sessions';
import { setSealing } from '../src/store/seal';
import { BrowserSession, findBrowser } from '../src/tools/browser';
import { DesktopSession } from '../src/tools/desktop';
import { JobManager } from '../src/tools/jobs';
import { closeUnusedServers, runningServers } from '../src/tools/lsp';
import { detectShell, runShell } from '../src/tools/shell';
import { jobTool } from '../src/tools/shell-tools';
import type { ToolContext } from '../src/tools/types';
import { cleanTerminal, truncateMiddle } from '../src/util/text';
import type { AgentEvent, Message, SessionMeta } from '../src/types';

// Check ownership before cleanup; the outer Windows job then kills and counts even detached fixtures.
const windows = process.platform === 'win32' && process.env.FAVILLA_OWNERSHIP_JOB === '1';
const native = it.runIf(windows && process.env.FAVILLA_TURN_FULL === '1');
const regression = it.runIf(windows);
const exec = promisify(execFile);
const MiB = 1024 * 1024;
const shell = detectShell('cmd');

async function until(predicate: () => boolean | Promise<boolean>, ms = 3500): Promise<boolean> {
  const deadline = performance.now() + ms;
  do {
    if (await predicate()) return true;
    await wait(25);
  } while (performance.now() < deadline);
  return false;
}

async function owned(root: string, clean = false): Promise<number> {
  const script = `$m=$env:FAVILLA_FIXTURE_PATH; $rows=@(Get-CimInstance Win32_Process -Property ProcessId,CommandLine | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($m,[StringComparison]::OrdinalIgnoreCase) -ge 0
  }); ${clean ? '$rows | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ' : ''}$rows.Count`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FAVILLA_FIXTURE_PATH: root }, windowsHide: true, timeout: 5000,
  });
  return Number(stdout.trim());
}

const send = (res: http.ServerResponse, delta: object, reason = 'stop') => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
};
type Reply = (res: http.ServerResponse) => void;
const answer = (text = 'Done.'): Reply => (res) => send(res, { content: text });
const tool = (name: string, input: object): Reply => (res) => send(res, {
  tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }],
}, 'tool_calls');
const foreground = (command: string) => tool('shell', { command, description: 'Run the local fixture' });
const background = (command: string) => tool('shell', { command, description: 'Start the local fixture', background: true });
const delegate = tool('agent', { description: 'Inspect the fixture', prompt: 'Check the local fixture.', type: 'general' });
const text = (messages: Message[]) => JSON.stringify(messages);
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface Fixture {
  root: string;
  command(mode: string, kind?: string, size?: number): string;
  file(name: string): string;
  seen(name: string): Promise<boolean>;
  gone(): Promise<boolean>;
  runtime(extra?: Record<string, unknown>): Promise<Runtime>;
  reply(...steps: Reply[]): void;
  requests: string[];
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-owner-case-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('FAVILLA_HOME', home);
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', undefined);
  vi.stubEnv('FAVILLA_PREFETCH', '0');
  const file = (name: string) => path.join(root, name);
  fs.copyFileSync(new URL('./fixtures/owned-child.cjs', import.meta.url), file('child.cjs'));
  const command = (mode: string, kind = '', size = 0) => `"${process.execPath}" "${file('child.cjs')}" ${mode} "${root}" "${kind}" ${size}`;
  let plan: Reply[] = [];
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
    let body = '';
    req.setEncoding('utf8').on('data', (s) => { body += s; });
    req.on('end', () => {
      requests.push(body);
      (plan.shift() ?? answer())(res);
    });
  });
  const runtimes = new Set<Runtime>();
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1';
    const runtime = async (extra = {}) => {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        model: 'fixture/m1', effort: 'off', shell: 'cmd', tools: 'favilla', skills: false, memoryGuard: false,
        languageServers: false, folderSnapshots: false, modelRegistry: false, autoCompact: false, guard: { mode: 'off' },
        storage: { encrypt: false },
        providers: { fixture: { api: 'openai-chat', local: true, auth: 'none', discover: false, baseUrl, models: { m1: { family: 'gpt', contextWindow: 64000 } } } },
        ...extra,
      }));
      const { createRuntime } = await import('../src/runtime');
      const rt = createRuntime(root, { interactive: true });
      runtimes.add(rt);
      return rt;
    };
    await run({ root, command, file, runtime, requests, reply: (...steps) => { plan = steps; },
      seen: (name) => until(() => fs.existsSync(file(name))), gone: () => until(async () => (await owned(root)) === 0) });
  } finally {
    fs.writeFileSync(file('finish'), '');
    await Promise.allSettled([...runtimes].map((rt) => rt.shutdown()));
    closeUnusedServers();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    if (await owned(root, true)) expect(await until(async () => (await owned(root)) === 0)).toBe(true);
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

const strict = process.env.FAVILLA_TURN_STRICT === '1';
for (const kind of ['ignores', 'detaches', 'orphan']) native(`stop reaps the three-deep tree when the grandchild ${kind}`, async () => fixture(async (f) => {
  const controller = new AbortController();
  const run = runShell(shell, f.command('root', kind), { cwd: f.root, timeoutMs: 8000, signal: controller.signal, logFile: f.file('out.log'), memoryGuard: false });
  expect(await f.seen('leaf')).toBe(true);
  if (kind === 'orphan') await wait(150);
  controller.abort();
  expect((await run).aborted).toBe(true);
  const gone = await f.gone();
  expect(gone).toBe(kind !== 'orphan' || strict);
}), 18_000);

native('stop before a background spawn starts nothing; an announced job belongs to the session', async () => fixture(async (f) => {
  const rt = await f.runtime();
  const s = await rt.start({ cwd: f.root });
  const off = s.on((e) => { if (e.type === 'tool.start') s.abort(); });
  f.reply(background(f.command('gate', 'too-late')));
  await s.send('Start the first fixture.');
  off();
  expect(s.jobs.list()).toEqual([]);
  expect(fs.existsSync(f.file('too-late'))).toBe(false);

  f.reply(background(f.command('gate', 'announced')), answer());
  await s.send('Start another fixture.');
  expect(await f.seen('announced')).toBe(true);
  s.abort();
  expect(s.jobs.list()).toHaveLength(1);
  rt.close(s.id);
  expect(await f.gone()).toBe(true);
}), 18_000);

native('shutdown while a foreground tool is running reaps it and saves its result', async () => fixture(async (f) => {
  const rt = await f.runtime();
  const s = await rt.start({ cwd: f.root });
  f.reply(foreground(f.command('root', 'detaches')));
  const turn = s.send('Run the fixture.');
  expect(await f.seen('leaf')).toBe(true);
  await rt.shutdown();
  await turn;
  expect(await f.gone()).toBe(true);
  expect(text(rt.store.load(s.id)!.messages)).toContain('tool_result');
}), 18_000);

for (const commandShell of ['cmd', 'bash']) native(`a restarted engine reaps jobs left by a hard kill in ${commandShell}`, async () => fixture(async (f) => {
  await f.runtime({ shell: commandShell });
  f.reply(background(f.command('gate')), answer());
  const engine = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/owned-engine.ts', import.meta.url)), f.root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  engine.stderr!.on('data', (d) => { diagnostic += d; });
  const exited = once(engine, 'exit');
  await until(() => fs.existsSync(f.file('session')) || engine.exitCode !== null, 8000);
  expect(fs.existsSync(f.file('session')), diagnostic).toBe(true);
  expect(await f.seen('job')).toBe(true);
  engine.kill();
  await exited;
  const records = f.file('home/running-jobs');
  const names = fs.existsSync(records) ? fs.readdirSync(records) : [];
  if (commandShell === 'bash' && names.length === 1) {
    // The engine might die after spawning the shell and before updating the record with its PID.
    const recordFile = path.join(records, names[0]);
    fs.writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(recordFile, 'utf8')), pid: 0 }));
  }
  const restarted = await f.runtime({ shell: commandShell });
  const reopened = await restarted.get(fs.readFileSync(f.file('session'), 'utf8'));
  expect(await f.gone()).toBe(true);
  expect(names).toHaveLength(1);
  expect(fs.readdirSync(records)).toEqual([]);
  await reopened.send('Report the fixture outcome.');
  expect(count(f.requests.at(-1)!, 'ended with exit code')).toBe(0);
}), 18_000);

regression('recovery leaves a process with a reused job PID alone', async () => fixture(async (f) => {
  const started = Date.now();
  const child = spawn(process.execPath, [f.file('child.cjs'), 'gate', f.root, 'bystander'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    expect(await f.seen('bystander')).toBe(true);
    const records = f.file('home/running-jobs');
    fs.mkdirSync(records);
    const record = path.join(records, 'favilla-job-0123456789abcdef0123456789abcdef.json');
    fs.writeFileSync(record, JSON.stringify({ engine: process.pid, engineStarted: 1, started, pid: child.pid }));
    const rt = await f.runtime();
    await rt.start({ cwd: f.root });
    expect(fs.existsSync(record)).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    child.kill();
    await exited;
  }
}), 12_000);

native('deleting one session reaps its watcher and leaves another session’s job running', async () => fixture(async (f) => {
  const rt = await f.runtime();
  const a = await rt.start({ cwd: f.root }), b = await rt.start({ cwd: f.root });
  fs.mkdirSync(f.file('many'));
  for (let i = 0; i < 1200; i++) fs.closeSync(fs.openSync(path.join(f.file('many'), String(i)), 'w'));
  const watcher = a.jobs.start(f.command('watch'), f.root);
  const other = b.jobs.start(f.command('gate', 'other'), f.root);
  expect(await f.seen('watch')).toBe(true);
  expect(await f.seen('other')).toBe(true);
  rt.close(a.id);
  rt.store.delete(a.id);
  expect(await until(() => watcher.done)).toBe(true);
  expect(other.done).toBe(false);
  await rt.shutdown();
  expect(await f.gone()).toBe(true);
}), 18_000);

native('a job delivers its report once when there is no window, including across compaction', async () => fixture(async (f) => {
  const rt = await f.runtime();
  const s = await rt.start({ cwd: f.root });
  const other = await rt.start({ cwd: f.root });
  await s.send('Seed the conversation.');
  let release!: Reply;
  let response: http.ServerResponse | undefined;
  f.reply((res) => { response = res; release = answer('<summary>A hand-off.</summary>'); });
  const compact = s.compact();
  expect(await until(() => !!response)).toBe(true);
  const job = s.jobs.start(f.command('gate'), f.root);
  expect(await f.seen('job')).toBe(true);
  fs.writeFileSync(f.file('finish'), '');
  expect(await until(() => job.done)).toBe(true);
  release(response!);
  expect(await compact).toBe(true);
  await s.settled();
  await other.send('Another session.');
  const report = 'ended with exit code 0';
  expect(count(text(s.messages), report)).toBe(1);
  expect(count(text(other.messages), report)).toBe(0);
  rt.close(s.id);
  const reopened = await rt.get(s.id);
  expect(count(text(reopened.messages), report)).toBe(1);
}), 18_000);

regression('a job respects the log buffer and rotation limits with a slow disk', async () => fixture(async (f) => {
  const jobs = new JobManager(shell, f.file('logs'));
  const streams: fs.WriteStream[] = [];
  let slowWrites = 8;
  const create = fs.createWriteStream;
  const lag = (write: () => void) => slowWrites-- > 0 ? void setTimeout(write, 30) : write();
  const spy = vi.spyOn(fs, 'createWriteStream').mockImplementation((name, options) => {
    const out = create(name, { ...(typeof options === 'object' ? options : {}), fs: {
      open: fs.open, close: fs.close,
      write: (fd, data, offset, length, position, done) => lag(() => fs.write(fd, data, offset, length, position, done)),
      writev: (fd, data, position, done) => lag(() => fs.writev(fd, data, position, done)),
    } });
    streams.push(out);
    return out;
  });
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, streams.reduce((n, s) => n + s.writableLength, 0)); }, 2);
  try {
    const size = (process.env.FAVILLA_TURN_FULL === '1' ? 1024 : 64) * MiB;
    const job = jobs.start(f.command('flood', '', size), f.root);
    expect(await until(() => job.done && streams.every((s) => s.closed), 24_000)).toBe(true);
    const bytes = fs.readdirSync(f.file('logs')).reduce((n, name) => n + fs.statSync(path.join(f.file('logs'), name)).size, 0);
    console.log(`Job output ${size} B, peak queued ${peak} B, retained ${bytes} B.`);
    expect(peak).toBeLessThan(MiB);
    expect(bytes).toBeLessThanOrEqual(16 * MiB);
    expect(job.buffer.length).toBeLessThanOrEqual(2_000_000);
    expect(job.buffer).toContain('Output complete.');
  } finally {
    clearInterval(timer);
    spy.mockRestore();
    await jobs.disposeAll();
  }
}), 31_000);

for (const commandShell of ['cmd', 'powershell']) regression(`the job tool returns identical unread output from a finished job in ${commandShell}`, async () => fixture(async (f) => {
  const jobs = new JobManager(detectShell(commandShell), f.file('logs'));
  try {
    const command = f.command('flood', 'hold', 2 * MiB + 300_000);
    const job = jobs.start(commandShell === 'powershell' ? '& ' + command : command, f.root);
    expect(await until(() => jobs.peek(job.id)?.text.includes('Output complete.') ?? false)).toBe(true);
    expect(jobs.write(job.id, 'stderr\n')).toBeNull();
    expect(await until(() => jobs.peek(job.id)?.text.includes('stderr: 通过') ?? false)).toBe(true);
    const before = jobs.peek(job.id)!.text;
    expect(before.length).toBeGreaterThan(MiB);
    fs.writeFileSync(f.file('finish'), '');
    expect(await until(() => job.done)).toBe(true);
    expect(jobs.peek(job.id)).toEqual({ text: before, done: true });
    const reduced = await until(() => job.buffer.length <= 4000, 1500);
    expect(jobs.peek(job.id)).toEqual({ text: before, done: true });
    const ctx = { cwd: f.root, jobs, outputChars: 4000 } as ToolContext;
    const filter = 'x{10}|Output complete\\.|stderr:';
    const matching = before.split('\n').filter((line) => new RegExp(filter).test(line)).join('\n');
    const result = await jobTool.execute({ id: job.id, action: 'output', filter }, ctx);
    expect(result.content).toBe(job.id + ' exited with code 0.\nNew output:\n' + truncateMiddle(cleanTerminal(matching), 4000).text.trim());
    expect(result.display).toMatchObject({ output: matching.slice(-200_000) });
    expect((await jobTool.execute({ id: job.id, action: 'output' }, ctx)).content).toBe(job.id + ' exited with code 0.\nNo new output since the last check.');
    expect(reduced).toBe(true);
  } finally { await jobs.disposeAll(); }
}), 12_000);

native('fifty short jobs notify their owner once each', async () => fixture(async (f) => {
  const jobs = new JobManager(shell, f.file('logs'));
  fs.writeFileSync(f.file('small.txt'), 'x'.repeat(128 * 1024));
  const ended: string[] = [];
  jobs.onEnd((job) => ended.push(job.id));
  try {
    const jobsStarted = Array.from({ length: 50 }, () => jobs.start(`type "${f.file('small.txt')}"`, f.root));
    expect(await until(() => ended.length === 50, 8000)).toBe(true);
    expect(new Set(ended).size).toBe(50);
    expect(jobs.list()).toEqual([]);
    expect(await until(() => jobsStarted.every((j) => j.buffer.length <= 4000))).toBe(true);
    const retained = jobsStarted.reduce((n, j) => n + j.buffer.length, 0);
    console.log(`Finished jobs retain ${retained} characters.`);
    expect(jobsStarted.every((j) => jobs.read(j.id).output.length === 128 * 1024)).toBe(true);
  } finally { await jobs.disposeAll(); }
}), 18_000);

for (const fault of ['stop', 'cut', 'budget']) native(`a sub-agent returns control to its parent after ${fault}`, async () => fixture(async (f) => {
  const rt = await f.runtime({ maxSteps: 4 });
  const s = await rt.start({ cwd: f.root });
  const events: AgentEvent[] = [];
  s.on((e) => events.push(e));
  fs.writeFileSync(f.file('tiny.txt'), 'fixture');
  const read = tool('read', { path: 'tiny.txt' });
  f.reply(delegate, ...(fault === 'stop' ? [foreground(f.command('root', 'detaches'))] : fault === 'cut'
    ? [(res: http.ServerResponse) => res.destroy(), answer('Child recovered.')] : [read, read, read, read]));
  const turn = s.send('Use a sub-agent to check this.');
  if (fault === 'stop') {
    expect(await f.seen('leaf')).toBe(true);
    s.abort();
  }
  await turn;
  expect(s.liveState().children).toEqual([]);
  expect(s.status).toBe('idle');
  expect(events.some((e) => e.type === 'tool.end' && e.result.name === 'agent')).toBe(true);
  if (fault === 'stop') expect(await f.gone()).toBe(true);
  if (fault === 'cut') expect(text(s.messages)).toContain('Child recovered.');
  if (fault === 'budget') expect(text(s.messages)).toContain('after 4 steps without a report');
}), 18_000);

regression('engine shutdown closes an MCP server that is still connecting', async () => fixture(async (f) => {
  const rt = await f.runtime({ mcpServers: { waiting: { command: process.execPath, args: [f.file('child.cjs'), 'mcp', f.root], timeoutMs: 15_000 } } });
  const startup = rt.mcp.start();
  expect(await f.seen('mcp')).toBe(true);
  await rt.shutdown();
  expect(await f.gone()).toBe(true);
  await startup;
}), 18_000);

regression('engine shutdown closes its unused language servers', async () => fixture(async (f) => {
  const moduleRoot = fs.realpathSync(path.resolve('node_modules', 'typescript'));
  fs.mkdirSync(f.file('node_modules'));
  fs.symlinkSync(moduleRoot, path.join(f.file('node_modules'), 'typescript'), 'junction');
  const platform = path.join('@typescript', `typescript-win32-${process.arch}`, 'lib');
  fs.mkdirSync(path.join(f.file('node_modules'), platform), { recursive: true });
  fs.copyFileSync(path.join(moduleRoot, '..', platform, 'tsc.exe'), path.join(f.file('node_modules'), platform, 'tsc.exe'));
  fs.writeFileSync(f.file('tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  const rt = await f.runtime({ languageServers: true });
  const s = await rt.start({ cwd: f.root });
  f.reply(tool('write', { path: 'fixture.ts', content: 'export const fixture: number = 1;' }), answer());
  const before = runningServers();
  await s.send('Write the fixture.');
  expect(runningServers()).toBe(before + 1);
  await rt.shutdown();
  expect(runningServers()).toBe(before);
  expect(await f.gone()).toBe(true);
}), 18_000);


regression('an append by another process survives publication of a cold archive', async () => fixture(async (f) => {
  setSealing(false);
  const store = new SessionStore(f.file('archive'));
  const meta: SessionMeta = { id: 'archive', cwd: f.root, title: '', created: 1, updated: 1, provider: 'fixture', model: 'm', effort: 'off', mode: 'build', profile: 'favilla' };
  store.create(meta, 'Fixture.');
  store.saveMessage(meta, { id: 'before', role: 'user', time: 1, parts: [{ type: 'text', text: 'Before publication.' }] });
  store.flushIndex();
  const writer = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/archive-writer.ts', import.meta.url)), f.root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(writer, 'exit');
  let diagnostic = '';
  writer.stderr!.on('data', (d) => { diagnostic += d; });
  await until(() => fs.existsSync(f.file('ready')) || writer.exitCode !== null, 8000);
  expect(fs.existsSync(f.file('ready')), diagnostic).toBe(true);

  const rename = fs.renameSync;
  const timer = new Int32Array(new SharedArrayBuffer(4));
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === store.dataDir(meta) + '.jsonl.br') {
      fs.writeFileSync(f.file('publish'), '');
      // The old writer completes here, between stat and unlink. A writer sharing the gate waits for publication.
      const deadline = performance.now() + 500;
      while (!fs.existsSync(f.file('written')) && performance.now() < deadline) Atomics.wait(timer, 0, 0, 5);
    }
    rename(from, to);
  });
  try {
    expect(await store.freeze(meta.id)).toBe(true);
    expect((await exited)[0], diagnostic).toBe(0);
    expect(store.load(meta.id)?.messages.map((m) => m.id)).toEqual(['before', 'during']);
  } finally { spy.mockRestore(); }
}), 18_000);



const browserExe = windows ? findBrowser() : null;
it.runIf(windows && !!browserExe && process.env.FAVILLA_TURN_FULL === '1')('closing a headless browser reaps its helpers', async () => fixture(async (f) => {
  vi.stubEnv('TEMP', f.root);
  vi.stubEnv('TMP', f.root);
  vi.stubEnv('FAVILLA_WEB_FETCH', 'off');
  const browser = new BrowserSession(browserExe!, false);
  try {
    await browser.start();
    expect(await owned(f.root)).toBeGreaterThan(0);
  } finally {
    browser.close();
  }
  expect(await f.gone()).toBe(true);
}), 18_000);

native('closing a desktop helper reaps it without using a desktop operation', async () => fixture(async (f) => {
  vi.stubEnv('TEMP', f.root);
  vi.stubEnv('TMP', f.root);
  const helper = new DesktopSession();
  try {
    await expect(helper.call('fixture-no-window')).rejects.toThrow(/Unknown operation/);
    expect(await owned(f.root)).toBeGreaterThan(0);
  } finally {
    helper.close();
  }
  expect(await f.gone()).toBe(true);
}), 18_000);
