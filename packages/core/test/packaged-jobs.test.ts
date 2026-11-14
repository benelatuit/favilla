import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appBuilderRequire, electronExecutable, jobBundle, nodeCommand, packagedPath, requireRunAsNode, runJobEngine, shells, type JobShell } from './fixtures/electron-jobs';

const owned = process.platform === 'win32' && process.env.FAVILLA_OWNERSHIP_JOB === '1' && process.env.FAVILLA_PACKAGED_JOBS === '1';
const packaged = it.runIf(owned);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-packaged-jobs-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));

const reason = /background jobs require Electron to honor ELECTRON_RUN_AS_NODE/;

it('rejects packaging that disables Electron run-as-node', async () => {
  const { SENTINEL, FuseState } = appBuilderRequire('@electron/fuses/dist/constants.js');
  const exe = path.join(root, 'fixture.exe');
  fs.writeFileSync(exe, Buffer.concat([Buffer.from(SENTINEL), Buffer.of(1, 1, FuseState.ENABLE)]));
  await expect(requireRunAsNode(exe)).resolves.toBeUndefined();
  await expect(requireRunAsNode(exe, false)).rejects.toThrow(reason);
  fs.writeFileSync(exe, Buffer.concat([Buffer.from(SENTINEL), Buffer.of(1, 1, FuseState.DISABLE)]));
  await expect(requireRunAsNode(exe, true)).rejects.toThrow(reason);
});

const variants = ['plain', 'asar'] as const;
type Variant = (typeof variants)[number];
const engines = new Map<Variant, { exe: string; entry: string }>();

beforeAll(async () => {
  if (!owned) return;
  const exe = await electronExecutable();
  const bundle = await jobBundle(path.join(root, 'bundle'));
  engines.set('plain', { exe, entry: bundle });
  engines.set('asar', await packagedPath(exe, bundle, root));
}, 25_000);

async function until(check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + 12_000; Date.now() < end; ) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
}

function marked(pid: number, mark: string): boolean {
  const script = '$p=Get-CimInstance Win32_Process -Filter "ProcessId = $env:FAVILLA_JOB_PID" -Property CommandLine; if ($p.CommandLine -and $p.CommandLine.Contains($env:FAVILLA_JOB_MARK)) { "marked" }';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FAVILLA_JOB_PID: String(pid), FAVILLA_JOB_MARK: mark }, windowsHide: true, timeout: 5000, encoding: 'utf8',
  }).trim() === 'marked';
}

function shortJob(shell: JobShell, output: string): string {
  if (shell === 'cmd') return 'echo ' + output + '& exit /b 23';
  if (shell === 'powershell') return "[Console]::WriteLine('" + output + "'); exit 23";
  return "printf '%s\\n' '" + output + "'; exit 23";
}

for (const variant of variants) for (const shell of shells) {
  packaged(shell + ' jobs survive the ' + variant + ' Electron launch and are stopped or reaped', async () => {
    const { exe, entry } = engines.get(variant)!;
    const dir = path.join(root, variant === 'asar' ? '项目 ' + shell : shell);
    const out = path.join(dir, 'output');
    // cmd's parser has a smaller command-line limit than PowerShell or the Bash environment path.
    const length = shell === 'cmd' ? 7500 : 30_000;
    const value = variant === 'asar' ? 'long-' + 'x'.repeat(length) : 'short job output';
    const short = runJobEngine(exe, entry, out, shell, 'run', shortJob(shell, value));
    expect(await short.closed, short.log()).toBe(0);
    const result = JSON.parse(fs.readFileSync(path.join(out, 'result'), 'utf8'));
    expect(result).toMatchObject({ exe, entry, code: 23, bridges: shell === 'bash' ? 0 : 1 });
    expect(result.electron).toBeTruthy();
    expect(result.output.replaceAll('\r\n', '\n')).toBe(value + '\n');
    expect(fs.readdirSync(path.join(short.home, 'running-jobs'))).toEqual([]);

    for (const stop of [true, false]) {
      const cwd = path.join(dir, stop ? 'stop' : 'crash');
      fs.mkdirSync(cwd, { recursive: true });
      const childFile = path.join(cwd, 'child.cjs');
      fs.copyFileSync(new URL('./fixtures/owned-child.cjs', import.meta.url), childFile);
      const args = [childFile, 'root', cwd, 'detaches'];
      const plain = nodeCommand(shell, ...args);
      const command = variant === 'asar' ? nodeCommand(shell, ...args, 'x'.repeat(length - plain.length - 3)) : plain;
      const engine = runJobEngine(exe, entry, cwd, shell, 'tree', command);
      try {
        const ready = path.join(cwd, 'ready');
        expect(await until(() => fs.existsSync(ready) || engine.child.exitCode !== null), engine.log()).toBe(true);
        expect(fs.existsSync(ready), engine.log()).toBe(true);
        const tree = JSON.parse(fs.readFileSync(ready, 'utf8')) as { engine: number; root: number; pids: number[] };
        const recordDir = path.join(engine.home, 'running-jobs');
        const names = fs.readdirSync(recordDir);
        expect(names).toHaveLength(1);
        const mark = path.basename(names[0], '.json');
        expect(mark).toMatch(/^favilla-job-[0-9a-f]{32}$/);
        const record = JSON.parse(fs.readFileSync(path.join(recordDir, names[0]), 'utf8'));
        expect(record).toMatchObject({ engine: tree.engine, pid: tree.root });
        expect(marked(tree.root, mark)).toBe(true);
        expect(tree.pids.every(alive)).toBe(true);
        if (stop) {
          fs.writeFileSync(path.join(cwd, 'stop'), '');
          expect(await engine.closed, engine.log()).toBe(0);
        } else {
          engine.child.kill();
          await engine.closed;
          expect([tree.root, ...tree.pids].every(alive)).toBe(true);
          const restart = runJobEngine(exe, entry, cwd, shell, 'reap');
          expect(await restart.closed, restart.log()).toBe(0);
        }
        expect(await until(() => [tree.root, ...tree.pids].every((pid) => !alive(pid)))).toBe(true);
        expect(fs.readdirSync(recordDir)).toEqual([]);
      } finally {
        if (engine.child.exitCode === null && engine.child.signalCode === null) engine.child.kill();
        await engine.closed;
      }
    }
  }, 55_000);
}
