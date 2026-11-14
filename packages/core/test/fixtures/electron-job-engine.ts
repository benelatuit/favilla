import assert from 'node:assert/strict';
import cp, { type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { writeFileAtomic } from '../../src/auth/store';
import { reapJobs } from '../../src/tools/job-recovery';
import { JobManager } from '../../src/tools/jobs';
import { detectShell } from '../../src/tools/shell';

async function until(check: () => boolean): Promise<void> {
  for (const end = Date.now() + 16_000; Date.now() < end; ) {
    if (check()) return;
    await wait(20);
  }
  throw new Error('The job fixture timed out.');
}

async function run(): Promise<void> {
  const [kind, action] = process.argv.slice(2);
  const shell = detectShell(kind);
  assert.equal(shell.kind, kind);
  const electron = process.versions.electron;
  let bridges = 0;
  if (electron) {
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    // The desktop engine does not inherit this flag. Refuse an accidental app launch even if the bridge regresses.
    delete process.env.ELECTRON_RUN_AS_NODE;
    const spawn = cp.spawn;
    cp.spawn = ((file: string, ...args: unknown[]) => {
      if (path.resolve(file).toLowerCase() === process.execPath.toLowerCase()) {
        const opts = (Array.isArray(args[0]) ? args[1] : args[0]) as SpawnOptions | undefined;
        assert.equal(opts?.env?.ELECTRON_RUN_AS_NODE, '1', 'The shell bridge would launch Electron as an app.');
        bridges++;
      }
      return Reflect.apply(spawn, cp, [file, ...args]);
    }) as typeof cp.spawn;
    syncBuiltinESMExports();
  }
  await reapJobs();
  if (action === 'reap') return;

  const jobs = new JobManager(shell, path.resolve('logs'));
  const job = jobs.start(process.env.FAVILLA_JOB_TEST_COMMAND!, process.cwd());
  const closed = once(job.child, 'close');
  if (action === 'tree') {
    const files = ['root', 'middle', 'leaf'];
    const pids = () => files.map((file) => fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0);
    await until(() => pids().every((pid) => pid > 0));
    writeFileAtomic(path.resolve('ready'), JSON.stringify({ engine: process.pid, root: job.child.pid, pids: pids() }));
    await until(() => fs.existsSync('stop'));
    jobs.kill(job.id);
  }
  await closed;
  const { output } = jobs.read(job.id);
  writeFileAtomic(path.resolve('result'), JSON.stringify({ output, code: job.exitCode, electron, bridges, exe: process.execPath, entry: process.argv[1] }));
}

void run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
