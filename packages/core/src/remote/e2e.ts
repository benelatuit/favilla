/**
 * End-to-end encryption between a phone and the computer it controls, the same code in Node and in the browser.
 * The relay between them sees ciphertext and routing ids, never a word.
 *
 * Keys are P-256. The computer has a signing key (its id at the relay is the hash of the public half, so no relay
 * can stand in for it) and a key-agreement key, which the phone learns from the pairing QR. Each connection runs one
 * handshake in which both static keys and both sides' fresh ephemeral keys take part:
 *
 *   keys = HKDF(ECDH(pc static, phone eph) | ECDH(pc eph, phone static) | ECDH(pc eph, phone eph))
 *
 * so only the paired phone and that computer arrive at the keys, and a key stolen later opens no earlier traffic.
 * Messages are AES-256-GCM with a counter for the nonce, one key each way; a replayed or reordered message fails.
 *
 * A phone page opened from the computer over the local network (a plain http:// address) is not a secure context, and
 * browsers give such a page no WebCrypto. The phone's side of the handshake and the channel therefore reach their
 * few primitives through `Primitives`: WebCrypto wherever it exists, and on such a page the same algorithms in
 * script (e2e-script.ts), which the page loads only then. The computer's side always uses WebCrypto.
 */

const subtle = globalThis.crypto.subtle;
/** WebCrypto's types as each side's library names them (Node's webcrypto, the browser's DOM). */
export type Key = Awaited<ReturnType<typeof subtle.importKey>>;
export type KeyPair = { privateKey: Key; publicKey: Key };
export type Jwk = Record<string, unknown>;
/** A key-agreement key held as bytes by the script primitives: the private scalar, or the uncompressed public point. */
export interface RawKey {
  readonly raw: Uint8Array;
}
export type AgreeKey = Key | RawKey;
export type AgreePair = { privateKey: AgreeKey; publicKey: AgreeKey };
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** AES-256-GCM under one key. The sealed bytes end with the 16-byte tag, as WebCrypto writes them. */
export interface Aead {
  seal(iv: Uint8Array, aad: Uint8Array, plain: Uint8Array): Promise<Uint8Array>;
  open(iv: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
}

/** What the phone's handshake and the channel need: P-256 agreement, SHA-256, HMAC, HKDF and AES-GCM. */
export interface Primitives {
  newAgreementKey(): Promise<AgreePair>;
  /** The public key as the uncompressed point, 65 bytes, the form WebCrypto exports as 'raw'. */
  rawPublic(key: AgreeKey): Promise<Uint8Array<ArrayBuffer>>;
  /** ECDH: the shared point's x coordinate, 32 bytes, as WebCrypto's deriveBits gives it. */
  dh(priv: AgreeKey, pub: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array<ArrayBuffer>>;
  aesGcm(raw: Uint8Array): Promise<Aead>;
}

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

const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

/** The primitives in WebCrypto, Node's and a secure page's alike. */
export const webPrimitives: Primitives = {
  newAgreementKey: () => newAgreementKey(),
  rawPublic: (key) => rawPublic(key as Key),
  async dh(priv, pub) {
    return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importAgreementPublic(pub) }, priv as Key, 256));
  },
  sha256: (data) => sha256(data),
  async hmac(key, data) {
    const k = await subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, buf(data)));
  },
  async hkdf(ikm, salt, info, bytes) {
    const base = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, base, bytes * 8));
  },
  async aesGcm(raw) {
    const key = await subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return {
      seal: async (iv, aad, plain) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(plain))),
      open: async (iv, aad, sealed) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) }, key, buf(sealed))),
    };
  },
};

/** Whether this page has WebCrypto, or must load the script primitives before it can pair or connect. */
export const hasWebCrypto = !!subtle;
let active: Primitives | null = hasWebCrypto ? webPrimitives : null;

/** The primitives the phone's side uses from now on: a page without WebCrypto sets the script ones first. */
export function usePrimitives(p: Primitives): void {
  active = p;
}

function prims(): Primitives {
  if (!active) throw new Error('This page has no WebCrypto and the script primitives are not loaded.');
  return active;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest('SHA-256', buf(data)));
}

/** The computer's id at the relay: from its signing key, so it cannot be claimed by anyone without that key. */
export async function pcIdOf(signPublic: Uint8Array): Promise<string> {
  return b64(await sha256(signPublic)).slice(0, 22);
}

export async function newAgreementKey(extractable = false): Promise<KeyPair> {
  return (await subtle.generateKey(P256, extractable, ['deriveBits'])) as unknown as KeyPair;
}

/** A phone's own key-agreement key, made with the primitives this page uses. */
export async function newPhoneKey(p: Primitives = prims()): Promise<AgreePair> {
  return p.newAgreementKey();
}

export async function newSigningKey(): Promise<KeyPair> {
  return (await subtle.generateKey(SIGN, true, ['sign', 'verify'])) as unknown as KeyPair;
}

export async function rawPublic(key: Key): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export async function importAgreementPublic(raw: Uint8Array): Promise<Key> {
  return subtle.importKey('raw', buf(raw), P256, true, []);
}

export async function importSigningPublic(raw: Uint8Array): Promise<Key> {
  return subtle.importKey('raw', buf(raw), SIGN, true, ['verify']);
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

/** The proof a phone sends with its first hello: it saw the one-time pairing code on the computer's screen. */
export async function pairProof(code: Uint8Array, phone: Uint8Array, eph: Uint8Array, p: Primitives = webPrimitives): Promise<string> {
  return b64(await p.hmac(code, cat(enc.encode('favilla-pair'), phone, eph)));
}

/** One direction of an established connection: AES-GCM, the nonce a counter that must only go up. */
class Lane {
  private n = 0;
  private seen = -1;
  constructor(
    private readonly key: Aead,
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
      const d = await this.key.seal(this.nonce(n), this.label, enc.encode(text));
      return { n, d: b64(d) };
    });
  }

  open(n: number, d: string): Promise<string> {
    return this.inTurn(async () => {
      if (!Number.isSafeInteger(n) || n <= this.seen) throw new Error('a message out of order or sent twice');
      const plain = await this.key.open(this.nonce(n), this.label, unb64(d));
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

async function channel(ikm: Uint8Array, transcript: Uint8Array, mine: 'pc' | 'phone', p: Primitives): Promise<Channel> {
  const bits = await p.hkdf(ikm, await p.sha256(transcript), enc.encode('favilla-remote v1'), 64);
  const toPc = new Lane(await p.aesGcm(bits.subarray(0, 32)), enc.encode('to-pc'));
  const toPhone = new Lane(await p.aesGcm(bits.subarray(32, 64)), enc.encode('to-phone'));
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
export async function phoneHello(o: { phone: AgreePair; pc: Uint8Array; code?: Uint8Array; name?: string; primitives?: Primitives }): Promise<{ hello: string; finish: (welcome: string) => Promise<Channel> }> {
  const p = o.primitives ?? prims();
  const eph = await p.newAgreementKey();
  const phonePub = await p.rawPublic(o.phone.publicKey);
  const ephPub = await p.rawPublic(eph.publicKey);
  const hello = JSON.stringify({ t: 'hello', v: 1, phone: b64(phonePub), eph: b64(ephPub), ...(o.code ? { pair: await pairProof(o.code, phonePub, ephPub, p) } : {}), ...(o.name ? { name: o.name } : {}) });
  return {
    hello,
    async finish(welcome) {
      const w = JSON.parse(welcome) as { t?: string; eph?: string; ok?: string; error?: string };
      if (w.t !== 'welcome' || !w.eph || !w.ok) throw new Error(w.error ?? 'the computer did not answer the handshake');
      const pcEph = unb64(w.eph);
      const ikm = cat(await p.dh(eph.privateKey, o.pc), await p.dh(o.phone.privateKey, pcEph), await p.dh(eph.privateKey, pcEph));
      const ch = await channel(ikm, cat(phonePub, ephPub, o.pc, pcEph), 'phone', p);
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
  const p = webPrimitives;
  const eph = await newAgreementKey();
  const pcPub = await rawPublic(o.pc.publicKey);
  const ephPub = await rawPublic(eph.publicKey);
  const ikm = cat(await p.dh(o.pc.privateKey, o.hello.eph), await p.dh(eph.privateKey, o.hello.phone), await p.dh(eph.privateKey, o.hello.eph));
  const ch = await channel(ikm, cat(o.hello.phone, o.hello.eph, pcPub, ephPub), 'pc', p);
  return { welcome: JSON.stringify({ t: 'welcome', eph: b64(ephPub), ok: await ch.seal('favilla:ok') }), channel: ch };
}
