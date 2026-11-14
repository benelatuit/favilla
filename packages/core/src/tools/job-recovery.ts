import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../auth/store';
import { debug } from '../util/log';
import { appPath, ensureDir, isWindows } from '../util/paths';
import { agentEnv, spawnShell, type ShellInfo } from './shell';

const recordDir = () => appPath('running-jobs');

export function spawnJob(shell: ShellInfo, command: string, cwd: string) {
  const spawn = (jobMark?: string) => spawnShell(shell, command, cwd, agentEnv(), { stdin: true, jobMark });
  if (!isWindows) return spawn();

  // libuv's Windows job closes the shell when the engine dies, but its descendants can break away.
  // Keep a marked shell as the tree's root so recovery can prove ownership even after a PID is reused.
  const mark = 'favilla-job-' + randomUUID().replaceAll('-', '');
  const file = path.join(ensureDir(recordDir()), mark + '.json');
  const record = { engine: process.pid, engineStarted: Math.floor(performance.timeOrigin), started: Date.now(), pid: 0 };
  const remove = () => {
    try { fs.rmSync(file, { force: true }); } catch (e) { debug('jobs', 'job record not removed', String(e)); }
  };
  // A crash before we can record the PID can still recover the shell by its mark.
  writeFileAtomic(file, JSON.stringify(record));
  try {
    const child = spawn(mark);
    child.once('close', remove);
    if (child.pid) {
      try { writeFileAtomic(file, JSON.stringify({ ...record, pid: child.pid })); }
      catch (e) { debug('jobs', 'job PID not recorded', String(e)); }
    }
    return child;
  } catch (e) {
    remove();
    throw e;
  }
}

// Inspect the process table once on recovery. Open each candidate before checking its creation time,
// and keep its handle until after the kill, so its PID cannot be reused between the check and the kill.
const REAP = String.raw`
$ErrorActionPreference = 'Stop'
$records = @(Get-ChildItem -LiteralPath $env:FAVILLA_JOB_RECORDS -Filter '*.json' -File)
$byId = @{}
$children = @{}
foreach ($row in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) {
  $byId[$row.ProcessId] = $row
  if (!$children.ContainsKey($row.ParentProcessId)) { $children[$row.ParentProcessId] = [Collections.Generic.List[object]]::new() }
  $children[$row.ParentProcessId].Add($row)
}
function Stop-Tree($row, [string]$mark) {
  $proc = $null
  try {
    $proc = [Diagnostics.Process]::GetProcessById($row.ProcessId)
    $null = $proc.Handle
    $born = $proc.StartTime.ToUniversalTime().Ticks
    if (!$row.CreationDate -or ($born - ($born % 10)) -ne $row.CreationDate.ToUniversalTime().Ticks) { return }
    if ($mark -and !(Get-CimInstance Win32_Process -Filter "ProcessId = $($row.ProcessId) AND CommandLine LIKE '%$mark%'" -Property ProcessId)) { return }
    foreach ($child in $children[$row.ProcessId]) {
      if ($child.CreationDate -and $child.CreationDate -ge $row.CreationDate) { Stop-Tree $child }
    }
    if (!$proc.HasExited) {
      $proc.Kill()
      if (!$proc.WaitForExit(1500)) { throw 'A job process did not exit.' }
    }
  } catch [ArgumentException] {
    # The process exited after the snapshot.
  } finally { if ($proc) { $proc.Dispose() } }
}
foreach ($file in $records) {
  $mark = $file.BaseName
  if ($mark -notmatch '^favilla-job-[0-9a-f]{32}$') { continue }
  try {
    $r = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    if (!$r.engine -or !$r.engineStarted -or !$r.started) { continue }
    $owner = $byId[[uint32]$r.engine]
    if ($owner -and (!$owner.CreationDate -or ([DateTimeOffset]$owner.CreationDate).ToUnixTimeMilliseconds() -le $r.engineStarted)) { continue }
    $roots = if ($r.pid) { $byId[[uint32]$r.pid] } else {
      Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$mark%'" -Property ProcessId,CreationDate
    }
    foreach ($root in $roots) {
      if ($root.CreationDate -and ([DateTimeOffset]$root.CreationDate).ToUnixTimeMilliseconds() -ge $r.started) { Stop-Tree $root $mark }
    }
    Remove-Item -LiteralPath $file.FullName -Force
  } catch {
    # Leave a record that could not be reaped for the next start.
  }
}
`;

export async function reapJobs(): Promise<void> {
  if (!isWindows) return;
  const dir = recordDir();
  try {
    if (!fs.readdirSync(dir).some((name) => name.endsWith('.json'))) return;
    // A stuck CIM query must not need another CIM query to stop it.
    await new Promise<void>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REAP], {
        env: { ...process.env, FAVILLA_JOB_RECORDS: dir }, timeout: 10_000, windowsHide: true,
      }, (error, _out, stderr) => {
        if (error) debug('jobs', 'recovery failed', stderr || error.code);
        resolve();
      });
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') debug('jobs', 'job records not read', String(e));
  }
}
