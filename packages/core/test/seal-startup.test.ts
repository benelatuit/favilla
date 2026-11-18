import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';
import { dataKey, preloadDataKeys, resetSealKey, seal, unseal } from '../src/store/seal';

const proc = vi.hoisted(() => ({ execFile: vi.fn(), spawnSync: vi.fn() }));
const onInput = vi.fn();
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), ...proc }));

let home: string;
const current = Buffer.alloc(32, 7);
const previous = Buffer.alloc(32, 9);
const keyFile = (n?: number) => path.join(home, 'keys', `data${n ? '.' + n : ''}.key.dpapi`);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-startup-key-'));
  fs.mkdirSync(path.join(home, 'keys'));
  vi.stubEnv('FAVILLA_HOME', home);
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', undefined);
  onInput.mockReset();
  proc.execFile.mockReset().mockImplementation((_exe, _args, _opts, done) => {
    const stdin = { on: () => stdin, end: (input: string) => onInput(input, done) };
    return { stdin };
  });
  proc.spawnSync.mockReset();
  resetSealKey();
});

afterEach(() => {
  resetSealKey();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it.skipIf(process.platform !== 'win32')('preloads current and previous DPAPI keys in the same order', async () => {
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', previous.toString('base64'));
  const history = seal(Buffer.from('Older encrypted bytes'));
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', undefined);
  resetSealKey();

  fs.writeFileSync(keyFile(), 'protected current');
  fs.writeFileSync(keyFile(1), 'protected previous');
  onInput.mockImplementation((input, done) => {
    const key = input === 'protected current' ? current : previous;
    queueMicrotask(() => done(null, key.toString('base64') + '\r\n', ''));
  });
  const warming = preloadDataKeys();
  expect(warming).toBeDefined();
  expect(preloadDataKeys()).toBe(warming);
  await warming;
  expect(dataKey(false)).toEqual(current);
  expect(unseal(history).toString()).toBe('Older encrypted bytes');
  expect(proc.spawnSync).not.toHaveBeenCalled();
  expect(onInput.mock.calls.map(([input]) => input)).toEqual(['protected current', 'protected previous']);
  for (const [name, args, opts] of proc.execFile.mock.calls) {
    expect(path.isAbsolute(name)).toBe(true);
    expect(args.join(' ')).toContain('Unprotect');
    expect(opts).toMatchObject({ windowsHide: true, timeout: 20_000 });
  }
});

it.skipIf(process.platform !== 'win32').each([true, false])('opens keys without a console on both read paths, helper present: %s', async (present) => {
  const exists = fs.existsSync;
  const probe = vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).endsWith('dpapi.exe') ? present : exists(p));
  try {
    fs.writeFileSync(keyFile(), 'protected current');
    onInput.mockImplementation((_input, done) => done(null, current.toString('base64'), ''));
    proc.spawnSync.mockReturnValue({ status: 0, stdout: current.toString('base64') });
    await preloadDataKeys();
    resetSealKey();
    expect(dataKey(false)).toEqual(current);
    for (const call of [proc.execFile, proc.spawnSync]) {
      expect(call).toHaveBeenCalledTimes(1);
      const [exe, , options] = call.mock.calls[0];
      expect(path.basename(exe)).toBe(present ? 'dpapi.exe' : 'powershell.exe');
      expect(options.windowsHide).toBe(true);
    }
  } finally {
    probe.mockRestore();
  }
});

it.skipIf(process.platform !== 'win32')('does not install a preloaded key whose file was replaced during unseal', async () => {
  fs.writeFileSync(keyFile(), 'protected previous');
  let finish: (error: null, text: string, stderr: string) => void = () => {};
  onInput.mockImplementation((_input, done) => { finish = done; });
  const warming = preloadDataKeys();
  expect(warming).toBeDefined();
  fs.writeFileSync(keyFile(), 'protected current');
  finish(null, previous.toString('base64'), '');
  await warming;

  proc.spawnSync.mockReturnValue({ status: 0, stdout: current.toString('base64') });
  expect(dataKey(false)).toEqual(current);
  expect(proc.spawnSync.mock.calls[0][2].input).toBe('protected current');
  expect(fs.readFileSync(keyFile(), 'utf8')).toBe('protected current');
});

it.skipIf(process.platform !== 'win32')('uses the new key for a write during preload even after an early read', async () => {
  fs.writeFileSync(keyFile(), 'protected previous');
  const opening = new Deferred<string>();
  onInput.mockImplementation((_input, done) => {
    void opening.promise.then((text) => done(null, text, ''));
  });
  proc.spawnSync.mockImplementation((_name, _args, opts) => ({
    status: 0, stdout: (opts.input === 'protected previous' ? previous : current).toString('base64'),
  }));

  const warming = preloadDataKeys();
  try {
    expect(dataKey(false)).toEqual(previous);
    fs.writeFileSync(keyFile(), 'protected current');
    // A sealed write before the preload ends must already use the current file.
    const record = seal(Buffer.from('Saved during startup'));
    opening.resolve(previous.toString('base64'));
    await warming;
    resetSealKey();
    expect(unseal(record).toString()).toBe('Saved during startup');
  } finally {
    opening.resolve(previous.toString('base64'));
    await warming;
  }
});

it.skipIf(process.platform !== 'win32')('checks the current key again when DPAPI was opening a replaced file', async () => {
  fs.writeFileSync(keyFile(), 'protected previous');
  const opening = new Deferred<string>();
  onInput.mockImplementation((_input, done) => {
    void opening.promise.then((text) => done(null, text, ''));
  });
  const warming = preloadDataKeys();
  proc.spawnSync.mockImplementation((_name, _args, opts) => {
    if (opts.input === 'protected previous') {
      fs.writeFileSync(keyFile(), 'protected current');
      return { status: 0, stdout: previous.toString('base64') };
    }
    return { status: 0, stdout: current.toString('base64') };
  });

  try {
    const record = seal(Buffer.from('Saved after rotation'));
    opening.resolve(previous.toString('base64'));
    await warming;
    resetSealKey();
    expect(unseal(record).toString()).toBe('Saved after rotation');
  } finally {
    opening.resolve(previous.toString('base64'));
    await warming;
  }
});

it.skipIf(process.platform !== 'win32')('tries the keys again after DPAPI becomes available', async () => {
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', current.toString('base64'));
  const saved = seal(Buffer.from('Previously saved'));
  vi.stubEnv('FAVILLA_TEST_DATA_KEY', undefined);
  resetSealKey();
  fs.writeFileSync(keyFile(), 'protected current');
  onInput.mockImplementation((_input, done) => done(new Error('timed out'), '', ''));
  await preloadDataKeys();
  proc.spawnSync.mockReturnValueOnce({ status: null, error: new Error('timed out'), stdout: '' })
    .mockReturnValue({ status: 0, stdout: current.toString('base64') });

  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    expect(dataKey(false)).toBeNull();
    // A key that does not open is not asked for again on every line.
    expect(dataKey(false)).toBeNull();
    expect(proc.spawnSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(unseal(saved).toString()).toBe('Previously saved');
    expect(proc.spawnSync).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.skipIf(process.platform !== 'win32')('leaves the keys to the waiting reader when one did not open during the preload', async () => {
  fs.writeFileSync(keyFile(), 'protected current');
  fs.writeFileSync(keyFile(1), 'protected previous');
  onInput.mockImplementation((input, done) => {
    if (input === 'protected previous') queueMicrotask(() => done(new Error('timed out'), '', ''));
    else queueMicrotask(() => done(null, current.toString('base64'), ''));
  });
  await preloadDataKeys();

  proc.spawnSync.mockImplementation((_name, _args, opts) => ({ status: 0, stdout: (opts.input === 'protected current' ? current : previous).toString('base64') }));
  expect(dataKey(false)).toEqual(current);
  expect(proc.spawnSync).toHaveBeenCalledTimes(2);
});
