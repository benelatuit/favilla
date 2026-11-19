import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { closeUnusedServers, LanguageServers, typescriptServer } from '../src/tools/lsp';
import * as proc from '../src/util/proc';

it('uses the bundled compiler only as a last resort for a project without TypeScript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-bundled-lsp-'));
  const root = path.join(dir, 'workspace', 'project');
  const resources = path.join(dir, 'resources');
  const bin = path.join(`@typescript/typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
  const put = (file: string, text = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const previous = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const which = vi.spyOn(proc, 'which').mockReturnValue(null);
  try {
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
    const bundled = put(path.join(resources, 'app.asar.unpacked/node_modules', bin));
    put(path.join(root, 'tsconfig.json'), '{}');
    const ts = path.join(root, 'node_modules/typescript/package.json');
    for (const version of ['5.8.0', '6.0.0']) {
      put(ts, JSON.stringify({ version }));
      expect(typescriptServer(root)).toBeNull();
    }
    fs.unlinkSync(ts);
    expect(typescriptServer(root)?.command).toBe(bundled);
    const global = path.join(dir, 'bin', 'vtsls');
    which.mockImplementation((name) => name === 'vtsls' ? global : null);
    expect(typescriptServer(root)?.command).toBe(global);
    const local = path.join(root, 'node_modules/typescript-language-server');
    put(path.join(local, 'package.json'), '{"bin":"./cli.mjs"}');
    const cli = put(path.join(local, 'cli.mjs'));
    expect(typescriptServer(root)?.args[0]).toBe(cli);
    const modules = path.join(path.dirname(root), 'node_modules');
    put(path.join(modules, 'typescript/package.json'), '{"version":"7.0.0"}');
    const native = put(path.join(modules, bin));
    expect(typescriptServer(root)?.command).toBe(native);
  } finally {
    if (previous) Object.defineProperty(process, 'resourcesPath', previous);
    else Reflect.deleteProperty(process, 'resourcesPath');
    which.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('finds project language servers when the compiler has no native LSP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-ts-lsp-'));
  try {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    for (const [name, version] of [['typescript', '5.8'], ['@vtsls/language-server', '1'], ['typescript-language-server', '1']]) {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version, bin: './cli.mjs' }));
      fs.writeFileSync(path.join(dir, 'cli.mjs'), '');
      if (name !== 'typescript') expect(typescriptServer(root)?.args).toEqual([path.join(dir, 'cli.mjs'), '--stdio']);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const fixture = vi.hoisted(() => ({ children: [] as ChildProcess[], script: '', log: '' }));

vi.mock('../src/util/proc', async (original) => {
  const proc = await original<typeof import('../src/util/proc')>();
  return { ...proc, which: (command: string) => command === 'pyright-langserver' ? process.execPath : proc.which(command) };
});
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>();
  return {
    ...cp,
    spawn(command: string, args: string[], options: SpawnOptions) {
      if (command !== process.execPath || args[0] !== '--stdio') return cp.spawn(command, args, options);
      const child = cp.spawn(command, [fixture.script, fixture.log], options);
      fixture.children.push(child);
      return child;
    },
  };
});

function peer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-lsp-notices-'));
  fixture.script = fileURLToPath(new URL('./fixtures/lsp-peer.cjs', import.meta.url));
  fixture.log = path.join(dir, 'peer.log');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
  fixture.children.length = 0;
  const calls = (name: string) => fs.readFileSync(fixture.log, 'utf8').split('\n').filter((line) => line === name).length;
  const clean = async (...owners: LanguageServers[]) => {
    const ended = fixture.children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => once(child, 'close'));
    for (const owner of owners) owner.close();
    closeUnusedServers();
    await Promise.all(ended);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  };
  return { dir, calls, clean };
}

const check = { server: 'pyright', diagnostics: [{ line: 1, column: 1, message: 'Fixture error', severity: 'error', code: undefined }] };

it('ignores diagnostics for old versions and keeps the server and its open documents for the next session', async () => {
  const { dir, calls, clean } = peer();
  const versioned = path.join(dir, 'versioned.py');
  const legacy = path.join(dir, 'legacy.py');
  for (const file of [versioned, legacy]) fs.writeFileSync(file, 'wrong\n');
  const [first, shared, resumed] = Array.from({ length: 3 }, () => new LanguageServers(dir));
  try {
    expect(await first.errors(versioned, 1000)).toEqual(check);
    expect(await shared.errors(versioned, 1000)).toEqual(check);
    expect(await shared.errors(legacy, 1000)).toEqual(check);
    first.close();
    expect(calls('textDocument/didClose')).toBe(0);
    expect(fixture.children).toHaveLength(1);
    shared.close();
    expect(await resumed.errors(legacy, 1000)).toEqual(check);
    expect(calls('textDocument/didOpen')).toBe(2);
    expect(calls('textDocument/didClose')).toBe(0);
    expect(fixture.children).toHaveLength(1);
    fs.writeFileSync(versioned, 'clean\n');
    expect(await resumed.errors(versioned, 1000)).toEqual({ server: 'pyright', diagnostics: [] });
  } finally {
    await clean(first, shared, resumed);
  }
});

it('uses diagnostics published under the real path for a file opened through a link', async () => {
  const { dir, calls, clean } = peer();
  const owner = new LanguageServers(dir);
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'linked');
  try {
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'alias.py'), 'wrong\n');
    fs.symlinkSync(real, link, 'junction');
    expect(await owner.errors(path.join(link, 'alias.py'), 1000)).toEqual(check);
    expect(await owner.errors(path.join(real, 'alias.py'), 1000)).toEqual(check);
    expect(calls('textDocument/didOpen')).toBe(1);
    expect(calls('textDocument/didChange')).toBe(1);
  } finally {
    await clean(owner);
  }
});

it('releases a diagnostic wait when a session is disposed and leaves the shared server usable', async () => {
  const { dir, calls, clean } = peer();
  const first = new LanguageServers(dir), second = new LanguageServers(dir);
  const silent = path.join(dir, 'never.py'), checked = path.join(dir, 'checked.py');
  let result: Awaited<ReturnType<LanguageServers['errors']>> | undefined;
  try {
    fs.writeFileSync(silent, 'wrong\n');
    fs.writeFileSync(checked, 'wrong\n');
    const waiting = first.errors(silent, 4000).then((answer) => { result = answer; });
    await vi.waitFor(() => expect(calls('textDocument/didOpen')).toBe(1), 1500);
    first.close();
    await vi.waitFor(() => expect(result).toBeNull(), 300);
    await waiting;
    expect(await second.errors(checked, 1000)).toEqual(check);
    expect(fixture.children).toHaveLength(1);
  } finally {
    await clean(first, second);
  }
});
