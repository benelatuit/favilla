import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The real key path on Windows: made and kept through DPAPI by PowerShell, as the installed app does it. The suite's
// fixed test key is taken away for this file only.
delete process.env.FAVILLA_TEST_DATA_KEY;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-dpapi-'));
process.env.FAVILLA_HOME = home;
const { dataKey, importRecoveryKey, isSealed, recoveryKey, resetSealKey, seal, unseal } = await import('../src/store/seal');
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe.skipIf(process.platform !== 'win32')('sealing with a key DPAPI keeps', () => {
  it('makes a key only this account can open, seals with it, and opens again after a restart', () => {
    const sealed = seal(Buffer.from('a conversation'));
    expect(isSealed(sealed)).toBe(true);
    const file = path.join(home, 'keys', 'data.key.dpapi');
    const stored = fs.readFileSync(file, 'utf8');
    // What is on disk is DPAPI's wrapping, never the key itself.
    expect(stored).not.toContain(dataKey()!.toString('base64'));
    expect(stored.length).toBeGreaterThan(200);
    // A new process: the key read back through DPAPI opens what the first sealed.
    resetSealKey();
    expect(unseal(sealed).toString()).toBe('a conversation');
  }, 60_000);

  it('takes in a recovery key and still opens what the old key sealed', () => {
    const before = seal(Buffer.from('sealed before'));
    const other = `favilla-key-${Buffer.alloc(32, 5).toString('base64url')}`;
    importRecoveryKey(other);
    resetSealKey();
    expect(recoveryKey()).toBe(other);
    expect(unseal(before).toString()).toBe('sealed before');
    expect(unseal(seal(Buffer.from('sealed after'))).toString()).toBe('sealed after');
    expect(fs.readdirSync(path.join(home, 'keys')).filter((n) => n.startsWith('data')).sort()).toEqual(['data.1.key.dpapi', 'data.key.dpapi']);
  }, 60_000);
});
