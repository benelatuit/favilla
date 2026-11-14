import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-push-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const { encryptPush, pushKey, resetPush, vapidAuth } = await import('../src/remote/push');

const u = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** What the phone's browser does with a push message (RFC 8291 from the receiving side). */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const prkKey = hmac(authSecret, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const sealed = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

describe('web push', () => {
  it('encrypts as RFC 8291 section 5 shows', () => {
    const body = encryptPush(Buffer.from('When I grow up, I want to be a watermelon'), u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), u('BTBZMqHH6r4Tts7J_aSIgg'), {
      salt: u('DGv6ra1nlYgDCS1FRnbzlw'),
      asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    });
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs for the push service with a key it can check, and keeps the key across restarts', () => {
    const auth = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', 'https://relay.example');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(JSON.parse(u(m[2]).toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://relay.example' });
    const raw = u(m[4]);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, u(m[3]))).toBe(true);
    const before = pushKey();
    resetPush();
    expect(pushKey()).toBe(before);
    // The file holds the private key: sealed, never plain.
    expect(fs.readFileSync(path.join(home, 'push.json')).subarray(0, 4).toString()).toBe('LTS1');
  });
});

describe('notifications on the phone from the server', () => {
  // A stand-in model that answers every request with a line, and a stand-in push service that keeps what it gets.
  const model = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }] }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'All done.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const got: { headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const service = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = Buffer.from('0123456789abcdef');
  let idle = 999;
  let server: Awaited<ReturnType<typeof import('../src/server/server').startServer>>;
  let rt: ReturnType<typeof import('../src/runtime').createRuntime>;
  const call = (p: string, body?: unknown, device?: string) =>
    fetch(`${server.url.replace(/\/$/, '')}/api${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', ...(device ? { 'X-Favilla-Device': device } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  beforeAll(async () => {
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
    const port = (model.address() as AddressInfo).port;
    // Remote control on, with a relay nobody answers at: notifications do not go through it.
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'fake/m1', remote: { enabled: true, relay: 'http://127.0.0.1:9' }, providers: { fake: { api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 32000 } } } } }));
    const { createRuntime } = await import('../src/runtime');
    const { startServer } = await import('../src/server/server');
    rt = createRuntime(project, { interactive: true });
    server = await startServer({ runtime: rt, token: 't', idleSeconds: () => idle });
  });

  afterAll(async () => {
    await server.close();
    rt.dispose();
    model.close();
    service.close();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const turn = async (text: string) => {
    const { meta } = (await (await call('/sessions', { cwd: project })).json()) as { meta: { id: string } };
    await call(`/sessions/${meta.id}/send`, { text });
    for (let i = 0; i < 100; i++) {
      const v = (await (await call(`/sessions/${meta.id}`)).json()) as { status: string; messages: unknown[] };
      if (v.status === 'idle' && v.messages.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    return meta.id;
  };

  it('tells a subscribed phone that work is done, sealed for it, and not while someone is at the computer', async () => {
    // Only a phone subscribes: the window here has no device of its own.
    expect((await call('/notify/subscribe', { sub: {}, words: {} })).status).toBe(400);
    const sub = { endpoint: `http://127.0.0.1:${(service.address() as AddressInfo).port}/push/one`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
    const words = { done: 'Finished', limit: 'Stopped at the step limit', failed: 'Went wrong', ask: 'Waiting for you' };
    expect((await call('/notify/subscribe', { sub, words }, 'phone1')).status).toBe(200);
    expect(await (await call('/notify', undefined, 'phone1')).json()).toMatchObject({ on: true, key: pushKey() });
    const id = await turn('Say something.');
    expect(got).toHaveLength(1);
    expect(got[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400', urgency: 'normal', topic: id.slice(0, 32) });
    expect(String(got[0].headers.authorization)).toMatch(/^vapid t=.+, k=/);
    expect(got[0].body.includes(Buffer.from('Finished'))).toBe(false);
    expect(JSON.parse(decrypt(got[0].body, ua.getPrivateKey(), authSecret))).toMatchObject({ b: 'Finished', s: id });
    // At the computer a minute ago: no phone is told.
    idle = 60;
    await turn('Again.');
    expect(got).toHaveLength(1);
    // Turned off on the phone: nothing more is sent to it.
    idle = 999;
    await call('/notify/unsubscribe', {}, 'phone1');
    await turn('Once more.');
    expect(got).toHaveLength(1);
  }, 30_000);
});
