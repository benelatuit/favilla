import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<object>()), ...mocks }));

import { runRipgrep } from '../src/tools/ripgrep';

it('stops a capped ripgrep directly without querying process trees', async () => {
  vi.stubEnv('FAVILLA_RG', process.execPath);
  const signal = new AbortController();
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: 9999999, exitCode: null, signalCode: null, killed: false, stdout, stderr: new EventEmitter(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    }),
  }) as unknown as ChildProcess;
  mocks.spawn.mockImplementation((file: string) => {
    if (file === process.execPath) return child;
    const helper = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    queueMicrotask(() => helper.emit('close', 1));
    return helper;
  });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const natural = setTimeout(() => child.emit('close', 0), 20);
  try {
    const listing = runRipgrep(['--files'], process.cwd(), signal.signal, 1);
    stdout.emit('data', Buffer.from('one.txt\ntwo.txt\n'));
    expect(await listing).toMatchObject({ truncated: true, code: 0 });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls.map(([file]) => file)).toEqual([process.execPath]);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  } finally {
    clearTimeout(natural);
    kill.mockRestore();
    vi.unstubAllEnvs();
  }
});
