import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { electronExecutable, jobBundle, nodeCommand, packagedPath, runJobEngine, shells } from './fixtures/electron-jobs';

// A background job's shell is started detached on Windows so that its tree can be found again after the engine is
// killed. A detached process has no console, and a console program started under it gets a new one, which is a
// window on the user's screen unless something hides it. This watches the desktop's visible top-level windows while
// a job runs a console program under each shell, and fails on any new console window. It looks at the real desktop,
// so it runs only when asked for: FAVILLA_WINDOW_CHECK=1.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-window-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));

const WATCH = String.raw`
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class W {
  delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible() {
    var r = new List<string>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { var s = new StringBuilder(256); GetClassName(h, s, 256); r.Add(h.ToInt64() + "|" + s); } return true; }, IntPtr.Zero);
    return r;
  }
}
'@
$before = @{}; foreach ($w in [W]::Visible()) { $before[$w.Split('|')[0]] = 1 }
[Console]::Out.WriteLine('ready')
$new = @{}
$end = (Get-Date).AddMilliseconds([int]$env:FAVILLA_WATCH_MS)
while ((Get-Date) -lt $end) {
  foreach ($w in [W]::Visible()) { $p = $w.Split('|'); if (!$before.ContainsKey($p[0])) { $new[$p[0]] = $p[1] } }
  Start-Sleep -Milliseconds 30
}
foreach ($c in $new.Values) { [Console]::Out.WriteLine('new ' + $c) }
`;

it.runIf(process.platform === 'win32' && process.env.FAVILLA_WINDOW_CHECK === '1')('a background job opens no console window under Node or packaged Electron', async () => {
  const bundle = await jobBundle(path.join(root, 'bundle'));
  const electron = await packagedPath(await electronExecutable(), bundle, root);
  const engines = [{ exe: process.execPath, entry: bundle, name: 'node' }, { ...electron, name: 'electron' }];
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WATCH], {
    windowsHide: true, env: { ...process.env, FAVILLA_WATCH_MS: String(1500 + engines.length * shells.length * 2500) },
  });
  const closed = once(watcher, 'close');
  let out = '';
  watcher.stdout.on('data', (d) => (out += d));
  const ran: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        if (!out.includes('ready')) return;
        clearTimeout(timer);
        watcher.stdout.off('data', ready);
        resolve();
      };
      const timer = setTimeout(() => reject(new Error('the watcher did not start')), 20_000);
      watcher.stdout.on('data', ready);
      ready();
    });
    for (const engine of engines) for (const shell of shells) {
      // A console program two levels down: the shell starts node, node starts ping.
      const cwd = path.join(root, engine.name + ' ' + shell);
      const ping = "process.exitCode=require('node:child_process').spawnSync('ping',['-n','2','127.0.0.1'],{stdio:'inherit'}).status";
      const run = runJobEngine(engine.exe, engine.entry, cwd, shell, 'run', nodeCommand(shell, '-e', ping));
      expect(await run.closed, run.log()).toBe(0);
      const result = JSON.parse(fs.readFileSync(path.join(cwd, 'result'), 'utf8'));
      expect(result.code).toBe(0);
      expect(result.output).toContain('127.0.0.1');
      expect(watcher.exitCode).toBeNull();
      ran.push(engine.name + ':' + shell);
    }
    expect((await closed)[0]).toBe(0);
    const fresh = out.split(/\r?\n/).filter((l) => l.startsWith('new ')).map((l) => l.slice(4));
    console.log('shells', ran.join(' '), '| new windows', JSON.stringify(fresh));
    expect(fresh.filter((c) => /Console|CASCADIA/i.test(c))).toEqual([]);
  } finally {
    if (watcher.exitCode === null) watcher.kill();
    await closed;
  }
}, 60_000);
