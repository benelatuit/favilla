import { execFile, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FORMER_NAME } from '../former-name';
import { appPath, isWindows } from '../util/paths';
import { debug } from '../util/log';

/**
 * Sessions at rest, the list of them, and the pictures, outputs and snapshots they keep are sealed with AES-256-GCM,
 * under a key only this account on this computer can open: on Windows protected by DPAPI, on a Mac in the login
 * keychain, on Linux in the Secret Service (GNOME Keyring, KWallet). Where the system has none of those, the key is
 * in a file only the user can read, which a copy of the whole folder takes along. A copy of Favilla's folder on
 * another computer or account cannot be read without the recovery key from Settings > Storage. Data written before
 * sealing, or with sealing off, stays readable as it is.
 *
 * A session being written is sealed line by line (see sealLine); put away, it is sealed whole. Not sealed: command
 * logs (deleted after a week), the names of the files a restore point holds, and folder snapshots, which copy the
 * project's own files, plain where they came from.
 *
 * Keys are never thrown away: a recovery key taken in becomes the key new data is sealed with, and the key before
 * it still opens what it sealed.
 */
const MAGIC = Buffer.from('LTS1');
const IV = 12;
const TAG = 16;
/** Starts a sealed line of a JSONL file: no JSON line starts with it and base64url never holds it. */
const LINE = '~';
/** A sealed line: LINE, the key's id (KID characters), then the sealed bytes in base64url. */
const KID = 4;
const SERVICE = 'favilla-data-key';

let on = true;
/** The key new data is sealed with first, then the older ones; undefined until read. */
let ring: Buffer[] | undefined;
let warming: Promise<void> | undefined;
/** When an incomplete read of the keys is tried again; 0 while the keys held are all there are. */
let retryAt = 0;
const RETRY_MS = 30_000;

const keysDir = () => appPath('keys');

/** Whether new data is sealed. Reading never depends on it. */
export function setSealing(enabled: boolean): void {
  on = enabled;
}

export function sealing(): boolean {
  return on;
}

/**
 * Whether data is sealed when the config does not say (storage.encrypt): yes in Favilla's own folder, no in one set
 * with FAVILLA_HOME (tests, evals, a copy carried on a stick to other computers, which a key bound to this one would
 * lock out). FAVILLA_SEAL=0 turns it off whatever the config says.
 */
export function sealingFor(encrypt: boolean | undefined): boolean {
  if (process.env.FAVILLA_SEAL === '0') return false;
  if (encrypt !== undefined) return encrypt;
  const home = process.env.FAVILLA_HOME;
  const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
  return !home || same(path.resolve(home), path.join(os.homedir(), '.favilla'));
}

type Run = (cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }) => string | null;

const keyCommandOptions = (env?: Record<string, string>) => ({
  env: { ...process.env, ...env }, encoding: 'utf8' as const, windowsHide: true, timeout: 20_000,
});

const system: Run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { ...keyCommandOptions(opts.env), input: opts.input });
  if (r.status !== 0) {
    debug('seal', `${cmd} failed`, (r.stderr || r.error?.message || '').slice(0, 300));
    return null;
  }
  return r.stdout.trim();
};
let run = system;
let platform: NodeJS.Platform = process.platform;

const DPAPI = (fn: 'Protect' | 'Unprotect') =>
  `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}([Convert]::FromBase64String($env:FAVILLA_SEAL_IN), $null, 'CurrentUser'))`;
const dpapiArgs = (fn: 'Protect' | 'Unprotect') => ['-NoProfile', '-NonInteractive', '-Command', DPAPI(fn)];
const dpapi = (fn: 'Protect' | 'Unprotect', input: string) => run('powershell.exe', dpapiArgs(fn), { env: { FAVILLA_SEAL_IN: input } });
const itemName = () => `favilla-${randomBytes(6).toString('hex')}`;

/** Where a key is kept, named by the key file's extension; the file holds what `get` needs to give the key back. */
interface KeyStore {
  put(key: string): string | null;
  get(held: string): string | null;
}

const STORES: Record<string, KeyStore> = {
  // Windows: the key protected by DPAPI for this account, the protected bytes in the file.
  dpapi: { put: (k) => dpapi('Protect', k), get: (held) => dpapi('Unprotect', held) },
  // A Mac: in the login keychain, the item's name in the file. The key goes in on standard input, never in a process list.
  keychain: {
    put: (k) => {
      const id = itemName();
      return run('security', ['-i'], { input: `add-generic-password -U -a ${id} -s ${SERVICE} -w ${k}\n` }) === null ? null : id;
    },
    get: (id) => run('security', ['find-generic-password', '-a', id, '-s', SERVICE, '-w']),
  },
  // Linux desktops: in the Secret Service, the item's name in the file.
  secret: {
    put: (k) => {
      const id = itemName();
      return run('secret-tool', ['store', '--label', 'Favilla data key', 'service', SERVICE, 'item', id], { input: k }) === null ? null : id;
    },
    get: (id) => run('secret-tool', ['lookup', 'service', SERVICE, 'item', id]),
  },
  // No store on this system: the key itself, in a file only this user can read.
  file: { put: (k) => k, get: (held) => held },
};

/** The stores a new key goes to, best first. Every Windows has DPAPI; a key beside the data there would only mislead. */
const storesHere = () => (platform === 'win32' ? ['dpapi'] : platform === 'darwin' ? ['keychain', 'file'] : ['secret', 'file']);

const KEY_FILE = /^data(?:\.(\d+))?\.key(?:\.(dpapi|keychain|secret))?$/;
const fileName = (n: number, store: string) => `data${n ? `.${n}` : ''}.key${store === 'file' ? '' : `.${store}`}`;

interface KeyFile {
  name: string;
  n: number;
  store: string;
}

/** The key files, the current one (0) first. */
function keyFiles(dir = keysDir()): KeyFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no keys yet */
  }
  return names
    .flatMap((name) => {
      const m = KEY_FILE.exec(name);
      return m ? [{ name, n: Number(m[1] ?? 0), store: m[2] ?? 'file' }] : [];
    })
    .sort((a, b) => a.n - b.n);
}

/** Keep a key in the best store that takes it, in the file `name` gives for that store; that file, or null. */
function writeKey(name: (store: string) => string, k: Buffer): string | null {
  fs.mkdirSync(keysDir(), { recursive: true });
  for (const store of storesHere()) {
    // DPAPI's side reads standard base64; the keychain and secret-tool lines are safest without + / =.
    const text = k.toString(store === 'dpapi' || store === 'file' ? 'base64' : 'base64url');
    const held = STORES[store].put(text);
    // Read back before anything is sealed with it: a store that took the key and cannot give it back loses the data.
    if (!held || STORES[store].get(held) !== text) continue;
    const file = path.join(keysDir(), name(store));
    fs.writeFileSync(file, held, { mode: 0o600 });
    return file;
  }
  return null;
}

function readKeyFile(dir: string, f: KeyFile): string | null {
  try {
    return fs.readFileSync(path.join(dir, f.name), 'utf8').trim();
  } catch {
    return null;
  }
}

function sameKeyFiles(dir: string, files: KeyFile[], held: (string | null)[]): boolean {
  if (dir !== keysDir()) return false;
  const current = keyFiles();
  return current.length === files.length && current.every((f, i) => f.name === files[i].name && readKeyFile(dir, f) === held[i]);
}

function keyBytes(text: string | null): Buffer | null {
  // base64 reads base64url too.
  const k = text ? Buffer.from(text, 'base64') : null;
  return k?.length === 32 ? k : null;
}

function readKey(f: KeyFile, held: string | null): Buffer | null {
  try {
    return held === null ? null : keyBytes(STORES[f.store].get(held));
  } catch {
    return null;
  }
}

/** Start opening existing Windows keys while the engine starts. Only a caller that needs them joins the wait. */
export function preloadDataKeys(): Promise<void> | undefined {
  if (ring || platform !== 'win32' || run !== system || process.env.FAVILLA_TEST_DATA_KEY) return;
  if (warming) return warming;
  const dir = keysDir();
  const files = keyFiles();
  if (!files.length || files.some((f) => f.store !== 'dpapi')) return;
  const held = files.map((f) => readKeyFile(dir, f));
  if (!held.every((s): s is string => s !== null)) return;
  const pending = (async () => {
    const keys: Buffer[] = [];
    for (const input of held) {
      const k = await new Promise<Buffer | null>((resolve) => {
        execFile('powershell.exe', dpapiArgs('Unprotect'), keyCommandOptions({ FAVILLA_SEAL_IN: input }), (err, stdout, stderr) => {
          if (err) debug('seal', 'powershell.exe failed', (stderr || err.message).slice(0, 300));
          resolve(err ? null : keyBytes(stdout.trim()));
        });
      });
      if (k) keys.push(k);
    }
    return keys;
  })().then((keys) => {
    // A key that did not open here is left to the reader that waits for it: a slow start must not cost the session a key.
    if (warming === pending && !ring && keys.length === files.length && sameKeyFiles(dir, files, held)) ring = keys;
  }).catch(() => {}).finally(() => {
    if (warming === pending) warming = undefined;
  });
  return (warming = pending);
}

/** Every key this account can read, the current one first. */
function keyring(): Buffer[] {
  if (ring && (!retryAt || Date.now() < retryAt)) return ring;
  const test = process.env.FAVILLA_TEST_DATA_KEY;
  if (test) return (ring = test.split(',').map((k) => Buffer.from(k, 'base64')));
  // Opening a key can wait on the system while another process replaces the file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const dir = keysDir();
    const files = keyFiles();
    const held = files.map((f) => readKeyFile(dir, f));
    const keys = files.map((f, i) => readKey(f, held[i])).filter((k): k is Buffer => k !== null);
    if (!sameKeyFiles(dir, files, held)) continue;
    // During preload the files may still change. An incomplete read can be the system failing for a moment, so it
    // is tried again, but not on every line: each try starts the key command and can wait out its timeout.
    if (!warming) {
      ring = keys;
      retryAt = keys.length === files.length ? 0 : Date.now() + RETRY_MS;
    }
    return keys;
  }
  return [];
}

/** The key new data is sealed with, made on first use; null when no key can be had here. */
export function dataKey(create = true): Buffer | null {
  const keys = keyring();
  if (keys.length) return keys[0];
  // A key file that will not open (after a reinstall, say) is never replaced: what it sealed waits for the recovery key.
  if (!create || keyFiles().some((f) => f.n === 0)) return null;
  const k = randomBytes(32);
  if (!writeKey((store) => fileName(0, store), k)) return null;
  if (!warming) ring = [k];
  return k;
}

/** Where the current key is kept: 'dpapi', 'keychain', 'secret' or 'file'; null when there is no key file. */
export function keyPlace(): string | null {
  return keyFiles()[0]?.store ?? null;
}

export function isSealed(buf: Buffer): boolean {
  return buf.length >= MAGIC.length + IV + TAG && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function sealWith(k: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

/** The plain bytes, or a throw when this key did not seal them (or they were cut short). */
function openWith(k: Buffer, buf: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(MAGIC.length, MAGIC.length + IV));
  d.setAuthTag(buf.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG));
  return Buffer.concat([d.update(buf.subarray(MAGIC.length + IV + TAG)), d.final()]);
}

/** Seal data for disk, when sealing is on and a key can be had; otherwise the data as it is. */
export function seal(plain: Buffer): Buffer {
  if (!on) return plain;
  const k = dataKey();
  return k ? sealWith(k, plain) : plain;
}

export class SealError extends Error {}

const keyMissing = () => new SealError('This was saved encrypted on another computer or account, or under a key that is gone. Import its recovery key in Settings > Storage.');

/**
 * Keys of another Favilla folder on this account, by its key folder: a store of sessions viewed from here (one a
 * headless run or an eval keeps). They only open what that folder sealed; nothing here is ever sealed with them.
 */
const visiting = new Map<string, Buffer[]>();

/** Open what the Favilla folder whose keys are in `dir` sealed, from now on. False when none of its keys open here. */
export function openWithKeysAt(dir: string): boolean {
  const known = visiting.get(dir);
  if (known) return known.length > 0;
  const keys = keyFiles(dir)
    .map((f) => readKey(f, readKeyFile(dir, f)))
    .filter((k): k is Buffer => k !== null);
  visiting.set(dir, keys);
  return keys.length > 0;
}

/** Every key that opens data here: this folder's, then those of folders viewed from it. */
const openingKeys = (): Buffer[] => (visiting.size ? [...keyring(), ...[...visiting.values()].flat()] : keyring());

/** Data from disk as it was written: sealed data opened by whichever key sealed it, anything else passed through. */
export function unseal(buf: Buffer): Buffer {
  if (!isSealed(buf)) return buf;
  for (const k of openingKeys()) {
    try {
      return openWith(k, buf);
    } catch {
      /* another key's */
    }
  }
  throw keyMissing();
}

const kid = (k: Buffer) => createHash('sha256').update(k).digest().subarray(0, 3).toString('base64url');

/** One line of a JSONL file as it goes to disk: sealed when sealing is on, with the id of its key. */
export function sealLine(line: string): string {
  if (!on) return line;
  const k = dataKey();
  return k ? `${LINE}${kid(k)}${sealWith(k, Buffer.from(line, 'utf8')).toString('base64url')}` : line;
}

/** Every line of a JSONL text sealed (see sealLine), for a session thawed to be written again. */
export function sealLines(text: string): string {
  return on ? text.split('\n').map((l) => (l ? sealLine(l) : l)).join('\n') : text;
}

/**
 * The plain text of a JSONL file whose lines may be sealed one by one. A line sealed under a key that is not here
 * makes the whole file wait for that key (SealError), as a sealed file does. Under a key that is here, a line that
 * does not open is half a line from a crash mid-write and is dropped, as the JSON reader drops a torn plain line.
 */
export function openLines(text: string): string {
  if (!text.startsWith(LINE) && !text.includes(`\n${LINE}`)) return text;
  const keys = openingKeys().map((k) => ({ id: kid(k), k }));
  return text
    .split('\n')
    .map((l) => {
      if (!l.startsWith(LINE)) return l;
      if (l.length <= 1 + KID) return '';
      const id = l.slice(1, 1 + KID);
      const mine = keys.filter((x) => x.id === id);
      if (!mine.length) throw keyMissing();
      const buf = Buffer.from(l.slice(1 + KID), 'base64url');
      for (const { k } of mine) {
        try {
          if (isSealed(buf)) return openWith(k, buf).toString('utf8');
        } catch {
          /* torn, or another key with the same id */
        }
      }
      return '';
    })
    .join('\n');
}

/** The current key as text, to keep somewhere safe; null when there is none. */
export function recoveryKey(): string | null {
  const k = dataKey(false);
  return k ? `favilla-key-${k.toString('base64url')}` : null;
}

/** Take in a recovery key (this account's after a reinstall, or another computer's): it seals from now on, the old keys still open. */
/** A key shown under the app's former name starts with that name; one written down then still opens. */
const RECOVERY_KEY = new RegExp(`^(?:favilla${FORMER_NAME ? `|${FORMER_NAME}` : ''})-key-([A-Za-z0-9_-]{43})$`);

export function importRecoveryKey(text: string): void {
  const m = RECOVERY_KEY.exec(text.trim());
  if (!m) throw new Error('That is not a valid recovery key: it starts with favilla-key- and has 43 more characters.');
  const k = Buffer.from(m[1], 'base64url');
  const keys = keyring();
  if (keys[0]?.equals(k)) return;
  // Kept under a passing name first; then the current key moves to the next free number and this one takes its
  // place, each a rename, so no key file is ever lost.
  const incoming = writeKey((store) => `incoming.${process.pid}.${store}`, k);
  if (!incoming) throw new Error('The key could not be stored for this account.');
  const files = keyFiles();
  const current = files.find((f) => f.n === 0);
  if (current) fs.renameSync(path.join(keysDir(), current.name), path.join(keysDir(), fileName(Math.max(...files.map((f) => f.n)) + 1, current.store)));
  fs.renameSync(incoming, path.join(keysDir(), fileName(0, path.extname(incoming).slice(1))));
  if (!warming) ring = [k, ...keys.filter((x) => !x.equals(k))];
}

/** Forget the keys read so far (tests, and after the key files changed). */
export function resetSealKey(): void {
  ring = undefined;
  retryAt = 0;
  warming = undefined;
}

/** Tests: the system's key commands played by `commands`, as on `as`; the keys read so far forgotten. Returns the undo. */
export function fakeKeyStores(as: NodeJS.Platform, commands: Run): () => void {
  run = commands;
  platform = as;
  resetSealKey();
  return () => {
    run = system;
    platform = process.platform;
    resetSealKey();
  };
}
