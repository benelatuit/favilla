import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { SessionLocks } from '../src/store/locks';

// The gate a writer passes to take a session is held for one write. A process that died inside it leaves the gate
// behind; Windows may hand its PID to another program at once, so a live PID alone must not keep the session shut.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-gate-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function leaveGate(id: string, ageMs: number): void {
  const gate = path.join(root, `${id}.swap`);
  fs.mkdirSync(gate, { recursive: true });
  // This test's own PID stands for the program that got the dead writer's PID: alive, and not the gate's owner.
  fs.writeFileSync(path.join(gate, String(process.pid)), '');
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(gate, at, at);
}

it('waits behind a gate just taken', () => {
  leaveGate('fresh', 0);
  const locks = new SessionLocks(root);
  expect(() => locks.take('fresh')).toThrow(/being archived/);
  expect(locks.owns('fresh')).toBe(false);
});

it('takes a session whose gate was left by a dead writer, though its PID is alive again', () => {
  leaveGate('left', 3 * 60_000);
  const locks = new SessionLocks(root);
  locks.take('left');
  expect(locks.owns('left')).toBe(true);
  expect(fs.existsSync(path.join(root, 'left.swap'))).toBe(false);
  locks.release('left');
});
