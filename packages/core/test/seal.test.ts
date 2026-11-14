import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, SessionMeta } from '../src/types';

// A fixed key for the tests, so no DPAPI call is made; the real key never comes near a test.
const A = Buffer.alloc(32, 7).toString('base64');
const B = Buffer.alloc(32, 9).toString('base64');
process.env.FAVILLA_TEST_DATA_KEY = A;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-seal-'));
process.env.FAVILLA_HOME = path.join(root, 'home');
const { FORMER_NAME } = await import('../src/former-name');
const { dataKey, fakeKeyStores, importRecoveryKey, isSealed, keyPlace, openLines, recoveryKey, resetSealKey, seal, SealError, sealingFor, sealLine, setSealing, unseal } = await import('../src/store/seal');
const { SessionStore } = await import('../src/store/sessions');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const meta = (id: string, cwd: string): SessionMeta => ({ id, title: id, cwd, created: 1, updated: 1, provider: 'openai', model: 'gpt-6-luna', effort: 'medium', mode: 'build', profile: 'codex' });
const user = (id: string, text: string): Message => ({ id, role: 'user', origin: 'user', time: 1, parts: [{ type: 'text', text }] }) as Message;

describe('sealing data at rest', () => {
  beforeEach(() => {
    process.env.FAVILLA_TEST_DATA_KEY = A;
    resetSealKey();
    setSealing(true);
  });

  it('seals and opens, passes plain data through, and names the trouble with a key it does not have', () => {
    const plain = Buffer.from('the conversation');
    const sealed = seal(plain);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.includes(plain)).toBe(false);
    expect(unseal(sealed).toString()).toBe('the conversation');
    // Two seals of one text differ (a fresh nonce each time).
    expect(seal(plain).equals(sealed)).toBe(false);
    // Written before sealing: read as it is.
    expect(unseal(plain).toString()).toBe('the conversation');
    // Another account's key cannot open it, and says how to fix that.
    process.env.FAVILLA_TEST_DATA_KEY = B;
    resetSealKey();
    expect(() => unseal(sealed)).toThrow(SealError);
    // With the old key back among the keys (a recovery key taken in), it opens again.
    process.env.FAVILLA_TEST_DATA_KEY = `${B},${A}`;
    resetSealKey();
    expect(unseal(sealed).toString()).toBe('the conversation');
    expect(recoveryKey()).toMatch(/^favilla-key-[A-Za-z0-9_-]{43}$/);
  });

  it('leaves new data plain with sealing off, and reads sealed data all the same', () => {
    const sealed = seal(Buffer.from('x'));
    setSealing(false);
    expect(isSealed(seal(Buffer.from('y')))).toBe(false);
    expect(unseal(sealed).toString()).toBe('x');
  });

  it('keeps a session sealed once it is put away, and its pictures and outputs too, and reads both back', async () => {
    const store = new SessionStore(path.join(root, 'sessions'));
    const m = meta('s1', path.join(root, 'project'));
    store.create(m, 'system words');
    store.saveMessage(m, user('u1', 'a secret plan'));
    store.flushIndex();
    expect(await store.freeze('s1')).toBe(true);
    const cold = path.join(store.root, path.basename(path.dirname(store.dataDir(m))), 's1.jsonl.br');
    const raw = fs.readFileSync(cold);
    expect(isSealed(raw)).toBe(true);
    expect(raw.includes(Buffer.from('secret'))).toBe(false);
    const back = store.load('s1');
    expect(back?.messages.at(-1)?.parts[0]).toMatchObject({ text: 'a secret plan' });
    // Blobs: sealed on disk, the same content kept once, read back whole.
    const id = store.blobs.put('a long tool output '.repeat(200));
    expect(store.blobs.put('a long tool output '.repeat(200))).toBe(id);
    const onDisk = fs.readFileSync(path.join(store.blobs.root, id.slice(0, 2), id));
    expect(isSealed(onDisk)).toBe(true);
    expect(store.blobs.text(id)).toBe('a long tool output '.repeat(200));
    // Written to again, it opens and goes on.
    store.saveMessage(m, user('u2', 'more'));
    expect(store.load('s1')?.messages.length).toBe(2);
  });

  it('seals the session being written line by line, and the list of sessions', async () => {
    const store = new SessionStore(path.join(root, 'lines'));
    const m = meta('s2', path.join(root, 'project'));
    store.create(m, 'system words');
    store.saveMessage(m, user('u1', 'a secret plan'));
    store.flushIndex();
    const hot = path.join(store.root, path.basename(path.dirname(store.dataDir(m))), 's2.jsonl');
    const text = fs.readFileSync(hot, 'utf8');
    expect(text).not.toContain('secret');
    expect(text.split('\n').filter(Boolean).every((l) => l.startsWith('~'))).toBe(true);
    const index = fs.readFileSync(path.join(store.root, 'index.json'));
    expect(isSealed(index)).toBe(true);
    expect(index.includes(Buffer.from('project'))).toBe(false);
    // Another process reads both back.
    const other = new SessionStore(store.root);
    expect(other.list().map((x) => x.id)).toEqual(['s2']);
    expect(other.load('s2')?.messages[0].parts[0]).toMatchObject({ text: 'a secret plan' });
    // Put away and written to again: the lines come back sealed one by one.
    expect(await other.freeze('s2')).toBe(true);
    other.saveMessage(m, user('u2', 'more'));
    expect(fs.readFileSync(hot, 'utf8')).not.toContain('secret');
    expect(other.load('s2')?.messages.map((x) => x.id)).toEqual(['u1', 'u2']);
  });

  it('drops a line a crash cut short, and keeps what the next process writes after it', () => {
    const store = new SessionStore(path.join(root, 'torn'));
    const m = meta('s3', path.join(root, 'project'));
    store.create(m, 'system words');
    store.saveMessage(m, user('u1', 'first'));
    store.flushIndex();
    const hot = path.join(store.root, path.basename(path.dirname(store.dataDir(m))), 's3.jsonl');
    // Half of a line, with no end.
    fs.appendFileSync(hot, sealLine(JSON.stringify({ t: 'msg', m: user('lost', 'half written') })).slice(0, 60));
    const next = new SessionStore(store.root);
    next.saveMessage(m, user('u2', 'after the crash'));
    expect(next.load('s3')?.messages.map((x) => x.id)).toEqual(['u1', 'u2']);
  });

  it('keeps a session sealed under a key that is not here whole until the key comes, and its blobs with it', async () => {
    const store = new SessionStore(path.join(root, 'elsewhere'));
    const m = meta('s4', path.join(root, 'project'));
    store.create(m, 'system words');
    const id = store.blobs.put('an output only this session keeps '.repeat(100));
    store.saveReleased(m, [id]);
    store.flushIndex();
    const blob = path.join(store.blobs.root, id.slice(0, 2), id);
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    fs.utimesSync(blob, old, old);
    // A blob only a sealed line names stays through housekeeping.
    await store.collectGarbage(true);
    expect(fs.existsSync(blob)).toBe(true);
    // On another account: the session does not open half, the list is not taken for empty, and nothing is deleted.
    process.env.FAVILLA_TEST_DATA_KEY = B;
    resetSealKey();
    const there = new SessionStore(store.root);
    expect(there.load('s4')).toBeNull();
    expect(() => openLines(fs.readFileSync(path.join(store.root, path.basename(path.dirname(store.dataDir(m))), 's4.jsonl'), 'utf8'))).toThrow(SealError);
    there.create(meta('s5', path.join(root, 'project')), 'new here');
    there.flushIndex();
    expect(await there.collectGarbage(true)).toEqual({ removed: 0, freed: 0 });
    expect(fs.existsSync(blob)).toBe(true);
    // The recovery key taken in: everything opens again, the session written there included.
    process.env.FAVILLA_TEST_DATA_KEY = `${B},${A}`;
    resetSealKey();
    there.flushIndex();
    const back = new SessionStore(store.root);
    await back.recoverOrphans();
    expect(back.load('s4')?.system).toBe('system words');
    expect(back.list().map((x) => x.id).sort()).toEqual(['s4', 's5']);
  });

  it('seals by default only in Favilla’s own folder, and never with FAVILLA_SEAL=0', () => {
    const home = process.env.FAVILLA_HOME;
    try {
      delete process.env.FAVILLA_HOME;
      expect(sealingFor(undefined)).toBe(true);
      process.env.FAVILLA_HOME = path.join(os.homedir(), '.favilla');
      expect(sealingFor(undefined)).toBe(true);
      process.env.FAVILLA_HOME = path.join(root, 'stick');
      expect(sealingFor(undefined)).toBe(false);
      expect(sealingFor(true)).toBe(true);
      process.env.FAVILLA_SEAL = '0';
      expect(sealingFor(true)).toBe(false);
    } finally {
      delete process.env.FAVILLA_SEAL;
      process.env.FAVILLA_HOME = home;
    }
  });
});

describe('where the key is kept', () => {
  const home = process.env.FAVILLA_HOME!;
  const keys = path.join(home, 'keys');
  let undo = () => {};
  beforeEach(() => {
    delete process.env.FAVILLA_TEST_DATA_KEY;
    fs.rmSync(keys, { recursive: true, force: true });
    setSealing(true);
  });
  afterEach(() => {
    undo();
    process.env.FAVILLA_TEST_DATA_KEY = A;
    resetSealKey();
  });

  /** A keychain or Secret Service played in memory; `refuse` makes it fail as a locked or missing one does. */
  function store(refuse = false) {
    const items = new Map<string, string>();
    const calls: string[] = [];
    const run = (cmd: string, args: string[], opts: { input?: string } = {}) => {
      calls.push(`${cmd} ${args[0]}`);
      if (refuse) return null;
      if (cmd === 'security' && args[0] === '-i') {
        const m = /-a (\S+) -s (\S+) -w (\S+)/.exec(opts.input ?? '')!;
        items.set(m[1], m[3]);
        return '';
      }
      if (cmd === 'security') return items.get(args[args.indexOf('-a') + 1]) ?? null;
      if (cmd === 'secret-tool' && args[0] === 'store') return items.set(args.at(-1)!, opts.input!), '';
      if (cmd === 'secret-tool') return items.get(args.at(-1)!) ?? null;
      return null;
    };
    return { items, calls, run };
  }

  it('keeps a Mac’s key in the keychain, the file holding only its name, and reads it back after a restart', () => {
    const s = store();
    undo = fakeKeyStores('darwin', s.run);
    const sealed = seal(Buffer.from('a conversation'));
    expect(isSealed(sealed)).toBe(true);
    expect(fs.readdirSync(keys)).toEqual(['data.key.keychain']);
    const held = fs.readFileSync(path.join(keys, 'data.key.keychain'), 'utf8');
    expect(held).toMatch(/^favilla-[0-9a-f]{12}$/);
    expect(s.items.get(held)).toBe(dataKey()!.toString('base64url'));
    // The key went in on standard input, never as an argument.
    expect(s.calls).toContain('security -i');
    resetSealKey();
    expect(unseal(sealed).toString()).toBe('a conversation');
    expect(keyPlace()).toBe('keychain');
  });

  it('keeps a Linux key in the Secret Service, and in a file only when there is none', () => {
    undo = fakeKeyStores('linux', store().run);
    seal(Buffer.from('x'));
    expect(fs.readdirSync(keys)).toEqual(['data.key.secret']);
    undo();
    fs.rmSync(keys, { recursive: true, force: true });
    undo = fakeKeyStores('linux', store(true).run);
    const sealed = seal(Buffer.from('y'));
    expect(fs.readdirSync(keys)).toEqual(['data.key']);
    expect(fs.readFileSync(path.join(keys, 'data.key'), 'utf8')).toBe(dataKey()!.toString('base64'));
    expect(keyPlace()).toBe('file');
    resetSealKey();
    expect(unseal(sealed).toString()).toBe('y');
  });

  it('never makes a new key over one that will not open, and takes a recovery key in beside the old', () => {
    const s = store();
    undo = fakeKeyStores('darwin', s.run);
    const before = seal(Buffer.from('sealed before'));
    // The keychain item gone (another Mac, say): no key, and the old key file stays for the recovery key.
    s.items.clear();
    resetSealKey();
    expect(dataKey()).toBeNull();
    expect(isSealed(seal(Buffer.from('z')))).toBe(false);
    expect(fs.readdirSync(keys)).toEqual(['data.key.keychain']);
    const other = `favilla-key-${Buffer.alloc(32, 5).toString('base64url')}`;
    importRecoveryKey(other);
    resetSealKey();
    expect(recoveryKey()).toBe(other);
    expect(fs.readdirSync(keys).sort()).toEqual(['data.1.key.keychain', 'data.key.keychain']);
    expect(() => unseal(before)).toThrow(SealError);
    expect(unseal(seal(Buffer.from('sealed after'))).toString()).toBe('sealed after');
    const old = Buffer.alloc(32, 7).toString('base64url');
    expect(() => importRecoveryKey(`other-key-${old}`)).toThrow(/starts with favilla-key- and/);
    if (!FORMER_NAME) return;
    // A key shown under the former name starts with it; written down then, it still opens.
    importRecoveryKey(`${FORMER_NAME}-key-${old}`);
    resetSealKey();
    expect(recoveryKey()).toBe(`favilla-key-${old}`);
  });
});
