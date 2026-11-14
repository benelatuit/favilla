import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const shells = ['cmd', 'powershell', 'bash'] as const;
export type JobShell = (typeof shells)[number];

export const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
export const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
export const requireRunAsNode: (exe: string, configured?: boolean) => Promise<void> = desktopRequire('./electron-fuses.mjs').requireRunAsNode;

export async function electronExecutable(): Promise<string> {
  const pkg = desktopRequire.resolve('electron/package.json');
  const exe = process.env.FAVILLA_TEST_ELECTRON ?? path.join(path.dirname(pkg), 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) throw new Error('Electron is not installed. Set FAVILLA_TEST_ELECTRON to the installed test binary.');
  await requireRunAsNode(exe);
  return path.resolve(exe);
}

export async function jobBundle(dir: string): Promise<string> {
  const outfile = path.join(dir, 'engine.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./electron-job-engine.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  });
  return outfile;
}

export async function packagedPath(exe: string, bundle: string, root: string): Promise<{ exe: string; entry: string }> {
  const install = path.join(root, 'Favilla 安装');
  await fsp.cp(path.dirname(exe), install, { recursive: true });
  const copied = path.join(install, path.basename(exe));
  const renamed = path.join(install, 'Favilla.exe');
  if (copied.toLowerCase() !== renamed.toLowerCase()) fs.renameSync(copied, renamed);
  await requireRunAsNode(renamed);
  const archive = path.join(install, 'resources', 'app.asar');
  await appBuilderRequire('@electron/asar').createPackage(path.dirname(bundle), archive);
  return { exe: renamed, entry: path.join(archive, path.basename(bundle)) };
}

export function nodeCommand(shell: JobShell, ...args: string[]): string {
  const node = process.execPath;
  if (shell === 'cmd') return [node, ...args].map((s) => '"' + s + '"').join(' ');
  if (shell === 'powershell') return '& ' + [node, ...args].map((s) => "'" + s.replaceAll("'", "''") + "'").join(' ') + '; exit $LASTEXITCODE';
  return [node.replaceAll('\\', '/'), ...args].map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(' ');
}

export function runJobEngine(exe: string, entry: string, cwd: string, kind: JobShell, action: 'run' | 'tree' | 'reap', command = '') {
  const electron = exe !== process.execPath;
  const home = path.join(cwd, 'home');
  fs.mkdirSync(home, { recursive: true });
  const child = spawn(exe, [entry, kind, action], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAVILLA_HOME: home, FAVILLA_JOB_TEST_COMMAND: command, ELECTRON_RUN_AS_NODE: electron ? '1' : undefined, NODE_OPTIONS: undefined },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('error', (e) => { log += String(e); });
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  return { child, home, closed, log: () => log };
}
