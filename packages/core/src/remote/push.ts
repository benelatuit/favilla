import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type JsonWebKey } from 'node:crypto';
import fs from 'node:fs';
import { writeFileAtomic } from '../auth/store';
import { proxiedFetch } from '../net/http';
import { seal, unseal } from '../store/seal';
import { debug } from '../util/log';
import { appPath } from '../util/paths';

/**
 * Notifications on paired phones by Web Push (RFC 8030). They go from this computer straight to the push service of
 * the phone's browser, encrypted for that browser alone (RFC 8291) and signed with this computer's VAPID key (RFC 8292),
 * so the push service takes them only from here and sees nothing but ciphertext. The relay plays no part.
 */

/** What a notification is about. */
export type PushKind = 'done' | 'limit' | 'failed' | 'ask';

/** A browser's subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A phone's subscription and the words for each kind of notification, in the phone's own language. */
interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
  words: Record<PushKind, string>;
  added: number;
}

interface State {
  v: 1;
  vapid: { jwk: JsonWebKey; pub: string };
  subs: Record<string, Sub>;
}

const file = () => appPath('push.json');
let state: State | null = null;

const rawPublic = (jwk: JsonWebKey) => Buffer.concat([Buffer.from([4]), Buffer.from(String(jwk.x), 'base64url'), Buffer.from(String(jwk.y), 'base64url')]).toString('base64url');

/** The keys and the subscriptions, sealed as one file; the VAPID key is made on first use. */
function load(): State {
  if (state) return state;
  try {
    state = JSON.parse(unseal(fs.readFileSync(file())).toString('utf8')) as State;
  } catch (e) {
    // A file this account cannot open waits for its key: new keys over it would cut every phone off for good.
    if (fs.existsSync(file())) throw e;
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    state = { v: 1, vapid: { jwk, pub: rawPublic(jwk) }, subs: {} };
    save();
  }
  return state;
}

function save(): void {
  fs.mkdirSync(appPath(), { recursive: true });
  writeFileAtomic(file(), seal(Buffer.from(JSON.stringify(state), 'utf8')));
}

/** This computer's VAPID public key, which a phone subscribes with. */
export function pushKey(): string {
  return load().vapid.pub;
}

export function pushDevices(): string[] {
  return Object.keys(load().subs);
}

export function addPush(device: string, sub: PushSubscriptionJSON, words: Record<PushKind, string>): void {
  // Push services are HTTPS; plain HTTP only to this computer itself (a stand-in service in tests).
  const endpoint = String(sub?.endpoint ?? '');
  if (!(/^https:\/\//.test(endpoint) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(endpoint)) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Not a push subscription.');
  load().subs[device] = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, words, added: Date.now() };
  save();
}

export function removePush(device: string): void {
  if (!load().subs[device]) return;
  delete load().subs[device];
  save();
}

/** Forget what was read (tests, and a key file that changed). */
export function resetPush(): void {
  state = null;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/**
 * One push message encrypted for one browser (RFC 8291, aes128gcm in a single record). The salt and this side's
 * key are random; tests give them to reproduce the RFC's example.
 */
export function encryptPush(plain: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed?: { salt: Buffer; asPrivate: Buffer }): Buffer {
  const ecdh = createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const prkKey = hmac(authSecret, ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  // The 0x02 ends the last (and only) record.
  const body = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/** The VAPID authorization for a push service: a token for its origin, valid twelve hours, signed with this computer's key. */
export function vapidAuth(endpoint: string, contact: string): string {
  const s = load();
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key: s.vapid.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${sig.toString('base64url')}, k=${s.vapid.pub}`;
}

/**
 * A notification to every subscribed phone that `skip` lets through: the session's title and the phone's words for
 * the kind. A phone whose push service says the subscription is gone is forgotten.
 */
export async function sendPush(kind: PushKind, session: string, title: string, o: { proxy: string | false; contact: string; skip: (device: string) => boolean }): Promise<number> {
  const s = load();
  let sent = 0;
  for (const [device, sub] of Object.entries(s.subs)) {
    if (o.skip(device)) continue;
    const body = encryptPush(Buffer.from(JSON.stringify({ t: title.slice(0, 120) || 'Favilla', b: sub.words[kind] ?? '', s: session })), Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url'));
    try {
      const res = await proxiedFetch(o.proxy)(sub.endpoint, {
        method: 'POST',
        // Topic: a newer notification of the same session replaces one the phone has not received yet.
        headers: { Authorization: vapidAuth(sub.endpoint, o.contact), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: kind === 'ask' ? 'high' : 'normal', Topic: session.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) },
        body: new Uint8Array(body),
      });
      if (res.status === 404 || res.status === 410) removePush(device);
      else if (!res.ok) debug('push', `push service answered ${res.status}`, (await res.text()).slice(0, 200));
      else sent++;
    } catch (e) {
      debug('push', 'push not sent', String(e));
    }
  }
  return sent;
}
