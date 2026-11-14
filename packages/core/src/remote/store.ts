import fs from 'node:fs';
import path from 'node:path';
import { appPath } from '../util/paths';
import { writeFileAtomic } from '../auth/store';
import { seal, unseal } from '../store/seal';
import { b64, exportPrivate, importAgreementPrivate, importSigningPrivate, newAgreementKey, newSigningKey, pairProof, pcIdOf, rawPublic, sha256, unb64, type Hello, type Jwk, type Key, type KeyPair } from './e2e';

/** A phone this computer has paired with: its key-agreement key, what it calls itself, when it was last here. */
export interface Device {
  id: string;
  pub: string;
  name: string;
  added: number;
  seen?: number;
}

interface Saved {
  v: 1;
  signPub: string;
  kxPub: string;
  /** The two private keys, sealed with this account's data key (store/seal.ts). */
  secret: string;
  devices: Device[];
}

export interface PcKeys {
  id: string;
  signPub: Uint8Array;
  sign: Key;
  kx: KeyPair;
  kxPub: Uint8Array;
}

const file = () => appPath('remote.json');

function read(): Saved | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8')) as Saved;
    return s.v === 1 && s.signPub && s.kxPub && s.secret ? s : null;
  } catch {
    return null;
  }
}

function write(s: Saved): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(s, null, 2));
}

let keys: Promise<PcKeys> | null = null;

/** This computer's keys for remote control, made on first use and kept sealed. */
export function pcKeys(): Promise<PcKeys> {
  keys ??= (async () => {
    let s = read();
    if (!s) {
      const signing = await newSigningKey();
      const kx = await newAgreementKey(true);
      const secret = JSON.stringify({ sign: await exportPrivate(signing.privateKey), kx: await exportPrivate(kx.privateKey) });
      s = { v: 1, signPub: b64(await rawPublic(signing.publicKey)), kxPub: b64(await rawPublic(kx.publicKey)), secret: seal(Buffer.from(secret)).toString('base64'), devices: [] };
      write(s);
    }
    const secret = JSON.parse(unseal(Buffer.from(s.secret, 'base64')).toString('utf8')) as { sign: Jwk; kx: Jwk };
    const signPub = unb64(s.signPub);
    const kxPub = unb64(s.kxPub);
    const kxPrivate = await importAgreementPrivate(secret.kx);
    const kxPublic = await globalThis.crypto.subtle.importKey('raw', kxPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return { id: await pcIdOf(signPub), signPub, sign: await importSigningPrivate(secret.sign), kx: { privateKey: kxPrivate, publicKey: kxPublic }, kxPub };
  })();
  keys.catch(() => (keys = null));
  return keys;
}

export function devices(): Device[] {
  return read()?.devices ?? [];
}

export function forgetDevice(id: string): void {
  const s = read();
  if (!s) return;
  write({ ...s, devices: s.devices.filter((d) => d.id !== id) });
}

function saveDevice(d: Device): void {
  const s = read();
  if (!s) return;
  write({ ...s, devices: [...s.devices.filter((x) => x.id !== d.id), d] });
}

/** Pairing codes shown on this computer's screen: one use each, ten minutes. In memory only. */
const codes = new Map<string, number>();
const CODE_MS = 10 * 60_000;

export function newPairingCode(): { code: Uint8Array; expires: number } {
  const code = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const expires = Date.now() + CODE_MS;
  codes.set(b64(code), expires);
  return { code, expires };
}

/**
 * Whether a hello may go on to a handshake: from a paired phone, or one that proves it saw a code shown here (it is
 * paired then, and the code is spent). Null when neither.
 */
export async function admit(hello: Hello): Promise<Device | null> {
  const pub = b64(hello.phone);
  const id = b64(await sha256(hello.phone)).slice(0, 16);
  const known = devices().find((d) => d.pub === pub);
  if (known) {
    const seen = { ...known, seen: Date.now() };
    saveDevice(seen);
    return seen;
  }
  if (!hello.pair) return null;
  const now = Date.now();
  for (const [code, expires] of codes) {
    if (expires < now) {
      codes.delete(code);
      continue;
    }
    if ((await pairProof(unb64(code), hello.phone, hello.eph)) !== hello.pair) continue;
    codes.delete(code);
    const d: Device = { id, pub, name: hello.name || 'Phone', added: now, seen: now };
    saveDevice(d);
    return d;
  }
  return null;
}
