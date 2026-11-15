import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-remote-lan-'));
process.env.FAVILLA_HOME = home;
// The door listens on this computer alone in tests: no network a firewall would ask about.
process.env.FAVILLA_LAN_HOST = '127.0.0.1';
const project = path.join(home, 'project');
const web = path.join(home, 'web');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><head><title>Favilla</title></head><body></body></html>');
fs.writeFileSync(path.join(web, 'assets', 'app-1234.js'), 'console.log(1)');
fs.writeFileSync(path.join(home, 'secret.txt'), 'not for phones');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'none/none', remote: { enabled: true } }));

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');
const { WsConnection, WsHandshakeError } = await import('../src/net/ws');
const { lanAddresses, peerAllowed } = await import('../src/remote/lan');
const e2e = await import('../src/remote/e2e');
const { scriptPrimitives: js } = await import('../src/remote/e2e-script');
const store = await import('../src/remote/store');

const web64 = e2e.webPrimitives;
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

describe('the phone’s primitives in script', () => {
  it('agree with WebCrypto byte for byte, each way', async () => {
    const a = await js.newAgreementKey();
    const b = await web64.newAgreementKey();
    const aPub = await js.rawPublic(a.publicKey);
    const bPub = await web64.rawPublic(b.publicKey);
    expect(aPub.length).toBe(65);
    expect(aPub[0]).toBe(4);
    expect(hex(await js.dh(a.privateKey, bPub))).toBe(hex(await web64.dh(b.privateKey, aPub)));
    for (const n of [0, 1, 31, 64, 1000]) {
      const data = random(n);
      const key = random(16);
      expect(hex(await js.sha256(data))).toBe(hex(await web64.sha256(data)));
      expect(hex(await js.hmac(key, data))).toBe(hex(await web64.hmac(key, data)));
      expect(hex(await js.hkdf(data, key, random(0), 64))).toBe(hex(await web64.hkdf(data, key, new Uint8Array(0), 64)));
    }
    const key = random(32);
    const iv = random(12);
    const aad = new TextEncoder().encode('to-pc');
    const plain = random(5000);
    const [jsKey, webKey] = [await js.aesGcm(key), await web64.aesGcm(key)];
    const sealed = await jsKey.seal(iv, aad, plain);
    expect(hex(sealed)).toBe(hex(await webKey.seal(iv, aad, plain)));
    expect(hex(await webKey.open(iv, aad, sealed))).toBe(hex(plain));
    sealed[3] ^= 1;
    await expect(jsKey.open(iv, aad, sealed)).rejects.toThrow();
  });

  it('refuse a point that is not on the curve, as WebCrypto does', async () => {
    const a = await js.newAgreementKey();
    const bad = new Uint8Array(65);
    bad[0] = 4;
    bad[64] = 7;
    await expect(js.dh(a.privateKey, bad)).rejects.toThrow();
    await expect(web64.dh((await web64.newAgreementKey()).privateKey, bad)).rejects.toThrow();
  });

  it('carry a whole handshake with the computer’s WebCrypto side', async () => {
    const pc = await e2e.newAgreementKey();
    const phone = await js.newAgreementKey();
    const h = await e2e.phoneHello({ phone, pc: await e2e.rawPublic(pc.publicKey), primitives: js });
    const hello = e2e.readHello(h.hello)!;
    const { welcome, channel } = await e2e.pcWelcome({ pc, hello });
    const ch = await h.finish(welcome);
    expect(await channel.open(await ch.seal('from the phone'))).toBe('from the phone');
    expect(await ch.open(await channel.seal('from the computer'))).toBe('from the computer');
  });
});

describe('who may knock', () => {
  it('lets in this computer and private networks, and turns away public addresses', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '192.168.0.9', '169.254.3.3', '100.101.1.1', 'fe80::1', 'fd12::3']) expect(peerAllowed(a), a).toBe(true);
    for (const a of ['8.8.8.8', '::ffff:1.2.3.4', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', undefined]) expect(peerAllowed(a), String(a)).toBe(false);
  });

  it('offers only private IPv4 addresses of real adapters', () => {
    for (const a of lanAddresses()) expect(/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)).toBe(true);
  });
});

const until = async (ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

let rt: ReturnType<typeof createRuntime>;
let server: Awaited<ReturnType<typeof startServer>>;
interface RemoteView {
  basis?: unknown;
  lan: boolean;
  lanState: string;
  lanPort: number;
  state: string;
  devices: { id: string; name: string; online: boolean }[];
}
const api = async <T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer local-token', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
};
let door = 0;
const doorUrl = (p = '/') => `http://127.0.0.1:${door}${p}`;

beforeAll(async () => {
  rt = createRuntime(project, { interactive: false });
  server = await startServer({ runtime: rt, token: 'local-token', port: 0, webDir: web });
  await until(async () => (await api<RemoteView>('/remote')).body.lanState === 'open');
  door = (await api<RemoteView>('/remote')).body.lanPort;
});

afterAll(async () => {
  await server.close();
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A phone on the same network: the page's socket to the door, hello first, then sealed requests. */
async function phone(keys: Awaited<ReturnType<typeof js.newAgreementKey>>, code?: Uint8Array, origin = `http://127.0.0.1:${door}`) {
  const k = await store.pcKeys();
  const sock = await WsConnection.open(`ws://127.0.0.1:${door}/ws/phone/${k.id}`, { headers: { Origin: origin } });
  const next = async () => {
    for (;;) {
      const text = await sock.next();
      if (text === null) return null;
      const f = JSON.parse(text);
      if (f.t === 'data') return f.d as string;
    }
  };
  const h = await e2e.phoneHello({ phone: keys, pc: k.kxPub, code, name: 'Wi-Fi phone', primitives: js });
  sock.sendText(JSON.stringify({ t: 'data', d: h.hello }));
  const ch = await h.finish((await next())!);
  let id = 0;
  return {
    sock,
    async ask(m: string, p: string, b?: unknown) {
      const my = ++id;
      sock.sendText(JSON.stringify({ t: 'data', d: await ch.seal(JSON.stringify({ t: 'req', id: my, m, p, b })) }));
      for (;;) {
        const frame = await next();
        if (frame === null) throw new Error('closed');
        const msg = JSON.parse(await ch.open(frame));
        if (msg.t === 'res' && msg.id === my) return msg as { s: number; b?: any };
      }
    },
  };
}

describe('the door for phones on the same network', () => {
  it('opens with remote control on and no relay, and pairs through its own address', async () => {
    const v = (await api<RemoteView>('/remote')).body;
    expect(v.lan).toBe(true);
    expect(v.state).toBe('off');
    expect(door).toBeGreaterThan(0);
    // Kept, so the door opens there again and a paired phone's page keeps its address.
    await until(() => store.lastLanPort() === door);
    expect(store.lastLanPort()).toBe(door);
    const pair = await api<{ url: string; via: string; error?: string }>('/remote/pair', { via: 'lan' });
    // A machine with no local network has no address to put in the code.
    if (lanAddresses().length) {
      expect(pair.status).toBe(200);
      expect(pair.body.via).toBe('lan');
      expect(pair.body.url).toMatch(new RegExp(`^http://[\\d.]+:${door}/#pair=[\\w-]+$`));
    } else expect(pair.status).toBe(400);
    expect((await api('/remote/pair', { via: 'relay' })).status).toBe(400);
  });

  it('serves the page marked for a phone, and nothing of the server', async () => {
    const page = await fetch(doorUrl('/'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<meta name="favilla-remote" content="1"></head>');
    expect(page.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://127.0.0.1:${door};`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const asset = await fetch(doorUrl('/assets/app-1234.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(doorUrl('/sessions/abc'))).status).toBe(200);
    for (const p of ['/api/info', '/api/remote', '/missing.js', '/..%2fsecret.txt', '/%2e%2e/secret.txt']) expect((await fetch(doorUrl(p))).status, p).toBe(404);
    expect((await fetch(doorUrl('/'), { method: 'POST', body: '{}' })).status).toBe(405);
  });

  it('pairs a phone that has no WebCrypto, answers it, and knows it next time', async () => {
    const keys = await js.newAgreementKey();
    const { code } = store.newPairingCode();
    const p = await phone(keys, code);
    const info = await p.ask('GET', '/info');
    expect(info.s).toBe(200);
    expect(info.b.cwd).toBe(project);
    // What belongs to the computer stays there, as over the relay.
    expect((await p.ask('POST', '/remote/pair', {})).s).toBe(403);
    expect((await api<RemoteView>('/remote')).body.devices.filter((d) => d.online).map((d) => d.name)).toEqual(['Wi-Fi phone']);
    p.sock.close();
    const again = await phone(keys);
    expect((await again.ask('GET', '/sessions')).s).toBe(200);
    again.sock.close();
  }, 30_000);

  it('turns away a page from elsewhere, another computer’s id, and a phone not paired', async () => {
    const k = await store.pcKeys();
    const refused = async (url: string, origin: string) => {
      try {
        const s = await WsConnection.open(url, { headers: { Origin: origin } });
        s.close();
        return 101;
      } catch (e) {
        return e instanceof WsHandshakeError ? e.status : -1;
      }
    };
    expect(await refused(`ws://127.0.0.1:${door}/ws/phone/${k.id}`, 'http://evil.test')).toBe(403);
    expect(await refused(`ws://127.0.0.1:${door}/ws/phone/AAAAAAAAAAAAAAAAAAAAAA`, `http://127.0.0.1:${door}`)).toBe(404);
    await expect(phone(await js.newAgreementKey())).rejects.toThrow(/not paired/);
  });

  it('answers the page’s keep-alive, takes a message in fragments, and closes on an unmasked frame', async () => {
    const k = await store.pcKeys();
    const raw = net.connect(door, '127.0.0.1');
    await new Promise((r) => raw.once('connect', r));
    let got = Buffer.alloc(0);
    raw.on('data', (d) => (got = Buffer.concat([got, d])));
    raw.write(`GET /ws/phone/${k.id} HTTP/1.1\r\nHost: 127.0.0.1:${door}\r\nOrigin: http://127.0.0.1:${door}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.from(random(16)).toString('base64')}\r\n\r\n`);
    await until(() => got.includes('\r\n\r\n'));
    expect(got.toString('latin1')).toMatch(/^HTTP\/1\.1 101/);
    got = got.subarray(got.indexOf('\r\n\r\n') + 4);
    const frame = (fin: boolean, op: number, text: string, masked = true) => {
      const body = Buffer.from(text);
      const mask = Buffer.from(random(4));
      const out = Buffer.from(body.map((b, i) => (masked ? b ^ mask[i & 3] : b)));
      return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, (masked ? 0x80 : 0) | body.length]), masked ? mask : Buffer.alloc(0), out]);
    };
    raw.write(frame(false, 0x1, '{"t":"pi'));
    raw.write(frame(true, 0x0, 'ng"}'));
    await until(() => got.includes('pong'));
    expect(got.subarray(2).toString()).toBe('{"t":"pong"}');
    got = Buffer.alloc(0);
    raw.write(frame(true, 0x1, '{"t":"ping"}', false));
    await until(() => got.length >= 4);
    expect(got[0]).toBe(0x88);
    expect(got.readUInt16BE(2)).toBe(1002);
    raw.destroy();
  });

  it('cuts off a phone forgotten in the settings at once', async () => {
    const keys = await js.newAgreementKey();
    const { code } = store.newPairingCode();
    const p = await phone(keys, code);
    expect((await p.ask('GET', '/info')).s).toBe(200);
    const id = (await api<RemoteView>('/remote')).body.devices.find((d) => d.online)!.id;
    await api('/remote/forget', { id });
    expect(await p.sock.next()).toBe(null);
  }, 30_000);

  it('closes when turned off in the settings, and opens again when turned on', async () => {
    const before = (await api<RemoteView>('/remote')).body;
    const off = (await api<RemoteView>('/remote/enable', { lan: false, basis: before.basis })).body;
    expect(off.lan).toBe(false);
    expect(off.lanState).toBe('off');
    const reached = await fetch(doorUrl('/')).then(
      () => true,
      () => false,
    );
    expect(reached).toBe(false);
    const on = (await api<RemoteView>('/remote/enable', { lan: true, basis: off.basis })).body;
    expect(on.lan).toBe(true);
    await until(async () => (await api<RemoteView>('/remote')).body.lanState === 'open');
    expect((await api<RemoteView>('/remote')).body.lanPort).toBe(door);
    expect((await fetch(doorUrl('/'))).status).toBe(200);
  });
});
