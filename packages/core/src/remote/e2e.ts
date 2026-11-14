/**
 * End-to-end encryption between a phone and the computer it controls, the same code in Node and in the browser
 * (WebCrypto only, nothing else imported). The relay between them sees ciphertext and routing ids, never a word.
 *
 * Keys are P-256. The computer has a signing key (its id at the relay is the hash of the public half, so no relay
 * can stand in for it) and a key-agreement key, which the phone learns from the pairing QR. Each connection runs one
 * handshake in which both static keys and both sides' fresh ephemeral keys take part:
 *
 *   keys = HKDF(ECDH(pc static, phone eph) | ECDH(pc eph, phone static) | ECDH(pc eph, phone eph))
 *
 * so only the paired phone and that computer arrive at the keys, and a key stolen later opens no earlier traffic.
 * Messages are AES-256-GCM with a counter for the nonce, one key each way; a replayed or reordered message fails.
 */

const subtle = globalThis.crypto.subtle;
/** WebCrypto's types as each side's library names them (Node's webcrypto, the browser's DOM). */
export type Key = Awaited<ReturnType<typeof subtle.importKey>>;
export type KeyPair = { privateKey: Key; publicKey: Key };
export type Jwk = Record<string, unknown>;
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
}

/** The computer's id at the relay: from its signing key, so it cannot be claimed by anyone without that key. */
export async function pcIdOf(signPublic: Uint8Array): Promise<string> {
  return b64(await sha256(signPublic)).slice(0, 22);
}

export async function newAgreementKey(extractable = false): Promise<KeyPair> {
  return (await subtle.generateKey(P256, extractable, ['deriveBits'])) as unknown as KeyPair;
}

export async function newSigningKey(): Promise<KeyPair> {
  return (await subtle.generateKey(SIGN, true, ['sign', 'verify'])) as unknown as KeyPair;
}

export async function rawPublic(key: Key): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export async function importAgreementPublic(raw: Uint8Array): Promise<Key> {
  return subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, P256, true, []);
}

export async function importSigningPublic(raw: Uint8Array): Promise<Key> {
  return subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, SIGN, true, ['verify']);
}

/** A private key to keep (sealed) and read back: JWK, the one form both sides import. */
export async function exportPrivate(key: Key): Promise<Jwk> {
  return (await subtle.exportKey('jwk', key)) as unknown as Jwk;
}

export async function importAgreementPrivate(jwk: Jwk): Promise<Key> {
  return subtle.importKey('jwk', jwk as never, P256, false, ['deriveBits']);
}

export async function importSigningPrivate(jwk: Jwk): Promise<Key> {
  return subtle.importKey('jwk', jwk as never, SIGN, false, ['sign']);
}

export async function sign(key: Key, text: string): Promise<string> {
  return b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(text)));
}

export async function verify(publicRaw: Uint8Array, text: string, signature: string): Promise<boolean> {
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importSigningPublic(publicRaw), unb64(signature), enc.encode(text));
}

async function dh(priv: Key, pub: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importAgreementPublic(pub) }, priv, 256));
}

/** The proof a phone sends with its first hello: it saw the one-time pairing code on the computer's screen. */
export async function pairProof(code: Uint8Array, phone: Uint8Array, eph: Uint8Array): Promise<string> {
  const k = await subtle.importKey('raw', code as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await subtle.sign('HMAC', k, cat(enc.encode('favilla-pair'), phone, eph)));
}

/** One direction of an established connection: AES-GCM, the nonce a counter that must only go up. */
class Lane {
  private n = 0;
  private seen = -1;
  constructor(
    private readonly key: Key,
    private readonly label: Uint8Array,
  ) {}

  private nonce(n: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(new ArrayBuffer(12));
    new DataView(iv.buffer).setBigUint64(4, BigInt(n));
    return iv;
  }

  // One at a time, in the order they were asked for. Encrypting is asynchronous: a small message sealed after a big one
  // could finish first and go first, and the other end, which takes counters only upward, threw the big one away as a
  // replay. Opened two at a time, one frame sent twice passed the check twice, both before the counter moved.
  private queue: Promise<unknown> = Promise.resolve();
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  seal(text: string): Promise<{ n: number; d: string }> {
    return this.inTurn(async () => {
      const n = this.n++;
      const d = await subtle.encrypt({ name: 'AES-GCM', iv: this.nonce(n), additionalData: this.label as Uint8Array<ArrayBuffer> }, this.key, enc.encode(text));
      return { n, d: b64(d) };
    });
  }

  open(n: number, d: string): Promise<string> {
    return this.inTurn(async () => {
      if (!Number.isSafeInteger(n) || n <= this.seen) throw new Error('a message out of order or sent twice');
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: this.nonce(n), additionalData: this.label as Uint8Array<ArrayBuffer> }, this.key, unb64(d));
      this.seen = n;
      return dec.decode(plain);
    });
  }
}

export interface Channel {
  /** Sealed text to send as it is. */
  seal(text: string): Promise<string>;
  /** A sealed frame back to its text; throws on anything forged, replayed or out of order. */
  open(frame: string): Promise<string>;
}

async function channel(ikm: Uint8Array, transcript: Uint8Array, mine: 'pc' | 'phone'): Promise<Channel> {
  const base = await subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: await sha256(transcript), info: enc.encode('favilla-remote v1') }, base, 512));
  const key = (raw: Uint8Array) => subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const toPc = new Lane(await key(bits.subarray(0, 32)), enc.encode('to-pc'));
  const toPhone = new Lane(await key(bits.subarray(32, 64)), enc.encode('to-phone'));
  const out = mine === 'pc' ? toPhone : toPc;
  const inn = mine === 'pc' ? toPc : toPhone;
  return {
    async seal(text) {
      const { n, d } = await out.seal(text);
      return JSON.stringify({ t: 'm', n, d });
    },
    async open(frame) {
      const f = JSON.parse(frame) as { t?: string; n?: number; d?: string };
      if (f.t !== 'm' || typeof f.n !== 'number' || typeof f.d !== 'string') throw new Error('not a sealed message');
      return inn.open(f.n, f.d);
    },
  };
}

/** The phone's side of the handshake: its hello, then the channel once the computer's welcome is in. */
export async function phoneHello(o: { phone: KeyPair; pc: Uint8Array; code?: Uint8Array; name?: string }): Promise<{ hello: string; finish: (welcome: string) => Promise<Channel> }> {
  const eph = await newAgreementKey();
  const phonePub = await rawPublic(o.phone.publicKey);
  const ephPub = await rawPublic(eph.publicKey);
  const hello = JSON.stringify({ t: 'hello', v: 1, phone: b64(phonePub), eph: b64(ephPub), ...(o.code ? { pair: await pairProof(o.code, phonePub, ephPub) } : {}), ...(o.name ? { name: o.name } : {}) });
  return {
    hello,
    async finish(welcome) {
      const w = JSON.parse(welcome) as { t?: string; eph?: string; ok?: string; error?: string };
      if (w.t !== 'welcome' || !w.eph || !w.ok) throw new Error(w.error ?? 'the computer did not answer the handshake');
      const pcEph = unb64(w.eph);
      const ikm = cat(await dh(eph.privateKey, o.pc), await dh(o.phone.privateKey, pcEph), await dh(eph.privateKey, pcEph));
      const ch = await channel(ikm, cat(phonePub, ephPub, o.pc, pcEph), 'phone');
      // The computer proves it holds its key: only it could seal this with the keys just made.
      if ((await ch.open(w.ok)) !== 'favilla:ok') throw new Error('the computer could not prove who it is');
      return ch;
    },
  };
}

export interface Hello {
  phone: Uint8Array;
  eph: Uint8Array;
  pair?: string;
  name?: string;
}

export function readHello(text: string): Hello | null {
  try {
    const h = JSON.parse(text) as { t?: string; v?: number; phone?: string; eph?: string; pair?: string; name?: string };
    if (h.t !== 'hello' || h.v !== 1 || !h.phone || !h.eph) return null;
    return { phone: unb64(h.phone), eph: unb64(h.eph), pair: h.pair, name: typeof h.name === 'string' ? h.name.slice(0, 60) : undefined };
  } catch {
    return null;
  }
}

/** The computer's side: given a hello it has decided to accept, the welcome to send and the channel. */
export async function pcWelcome(o: { pc: KeyPair; hello: Hello }): Promise<{ welcome: string; channel: Channel }> {
  const eph = await newAgreementKey();
  const pcPub = await rawPublic(o.pc.publicKey);
  const ephPub = await rawPublic(eph.publicKey);
  const ikm = cat(await dh(o.pc.privateKey, o.hello.eph), await dh(eph.privateKey, o.hello.phone), await dh(eph.privateKey, o.hello.eph));
  const ch = await channel(ikm, cat(o.hello.phone, o.hello.eph, pcPub, ephPub), 'pc');
  return { welcome: JSON.stringify({ t: 'welcome', eph: b64(ephPub), ok: await ch.seal('favilla:ok') }), channel: ch };
}
