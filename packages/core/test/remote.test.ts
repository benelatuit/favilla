import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-remote-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'none/none' }));

const { createRuntime } = await import('../src/runtime');
const { startServer } = await import('../src/server/server');
const { RemoteLink } = await import('../src/remote/link');
const e2e = await import('../src/remote/e2e');
const store = await import('../src/remote/store');

/** A queue a socket reads from. */
class Pipe {
  private items: (string | null)[] = [];
  private wait: ((v: string | null) => void) | null = null;
  push(v: string | null) {
    if (this.wait) {
      const w = this.wait;
      this.wait = null;
      w(v);
    } else this.items.push(v);
  }
  next(): Promise<string | null> {
    return this.items.length ? Promise.resolve(this.items.shift()!) : new Promise((r) => (this.wait = r));
  }
}

/**
 * The relay's rules in memory, as the Worker keeps them: the computer proves its id with its signing key, phones
 * get a connection id, and each side's text goes to the other wrapped as data.
 */
class Relay {
  pc: { pipe: Pipe; id?: string; nonce: string } | null = null;
  phones = new Map<string, Pipe>();
  refused = 0;
  async openPc(url: string) {
    const id = /\/ws\/pc\/([\w-]+)$/.exec(url)![1];
    const pipe = new Pipe();
    const nonce = e2e.b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    this.pc = { pipe, nonce };
    pipe.push(JSON.stringify({ t: 'challenge', n: nonce }));
    const relay = this;
    return {
      closeReason: '',
      sendText(text: string) {
        const f = JSON.parse(text);
        if (f.t === 'auth') {
          void (async () => {
            const pub = e2e.unb64(f.pub);
            const ok = (await e2e.pcIdOf(pub)) === id && (await e2e.verify(pub, `favilla-relay:${nonce}:${id}`, f.sig));
            if (!ok) relay.refused++;
            pipe.push(JSON.stringify(ok ? { t: 'ok' } : { t: 'refused' }));
            if (ok) relay.pc!.id = id;
          })();
        } else if (f.t === 'data') relay.phones.get(f.c)?.push(JSON.stringify({ t: 'data', d: f.d }));
        else if (f.t === 'close') {
          relay.phones.get(f.c)?.push(null);
          relay.phones.delete(f.c);
        }
      },
      next: () => pipe.next(),
      close() {
        pipe.push(null);
      },
    };
  }
  /** A phone's socket: what it sends goes to the computer as data; what comes back is read with next(). */
  phone() {
    const c = Math.random().toString(36).slice(2);
    const pipe = new Pipe();
    this.phones.set(c, pipe);
    this.pc!.pipe.push(JSON.stringify({ t: 'open', c }));
    return {
      send: (d: string) => this.pc!.pipe.push(JSON.stringify({ t: 'data', c, d })),
      next: async () => {
        const v = await pipe.next();
        return v === null ? null : (JSON.parse(v).d as string);
      },
    };
  }
}

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

let rt: ReturnType<typeof createRuntime>;
let server: Awaited<ReturnType<typeof startServer>>;
let link: InstanceType<typeof RemoteLink>;
const relay = new Relay();

beforeAll(async () => {
  rt = createRuntime(project, { interactive: false });
  server = await startServer({ runtime: rt, token: 'local-token', port: 0 });
  link = new RemoteLink({ relay: 'https://relay.test', port: server.port, token: 'local-token', open: (url) => relay.openPc(url) });
  link.start();
  await until(() => link.state === 'online');
});

afterAll(async () => {
  link.stop();
  await server.close();
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A phone through the relay: hello (with a pairing code the first time), then sealed requests. */
async function phone(keys: Awaited<ReturnType<typeof e2e.newAgreementKey>>, code?: Uint8Array) {
  const k = await store.pcKeys();
  const sock = relay.phone();
  const h = await e2e.phoneHello({ phone: keys, pc: k.kxPub, code, name: 'Test phone' });
  sock.send(h.hello);
  const ch = await h.finish((await sock.next())!);
  let id = 0;
  return {
    sock,
    ch,
    async ask(m: string, p: string, b?: unknown) {
      const my = ++id;
      sock.send(await ch.seal(JSON.stringify({ t: 'req', id: my, m, p, b })));
      for (;;) {
        const frame = await sock.next();
        if (frame === null) throw new Error('closed');
        const msg = JSON.parse(await ch.open(frame));
        if (msg.t === 'res' && msg.id === my) return msg as { s: number; b?: any };
      }
    },
  };
}

describe('remote control through a relay', () => {
  it('proves the computer to the relay, pairs a phone with a code shown here, and answers its requests', async () => {
    expect(link.state).toBe('online');
    expect(relay.refused).toBe(0);
    const keys = await e2e.newAgreementKey();
    const { code } = store.newPairingCode();
    const p = await phone(keys, code);
    const info = await p.ask('GET', '/info');
    expect(info.s).toBe(200);
    expect(info.b.cwd).toBe(project);
    expect(store.devices().map((d) => d.name)).toEqual(['Test phone']);
    // The same phone comes back later without a code: it is known.
    const again = await phone(keys);
    expect((await again.ask('GET', '/sessions')).s).toBe(200);
  }, 30_000);

  it('turns away a phone that is not paired, and one whose code was used already', async () => {
    const k = await store.pcKeys();
    const stranger = relay.phone();
    const h = await e2e.phoneHello({ phone: await e2e.newAgreementKey(), pc: k.kxPub, name: 'Stranger' });
    stranger.send(h.hello);
    await expect(h.finish((await stranger.next())!)).rejects.toThrow(/not paired/);
    const { code } = store.newPairingCode();
    await phone(await e2e.newAgreementKey(), code);
    const late = relay.phone();
    const h2 = await e2e.phoneHello({ phone: await e2e.newAgreementKey(), pc: k.kxPub, code });
    late.send(h2.hello);
    await expect(h2.finish((await late.next())!)).rejects.toThrow(/not paired/);
  }, 30_000);

  it('keeps what belongs to the computer on the computer, and drops a phone that replays a message', async () => {
    const { code } = store.newPairingCode();
    const p = await phone(await e2e.newAgreementKey(), code);
    expect((await p.ask('POST', '/storage/recovery-key', {})).s).toBe(403);
    expect((await p.ask('POST', '/remote/pair', {})).s).toBe(403);
    // Paths that resolve to those are checked as resolved.
    for (const sly of ['/x/../remote/pair', '/x/%2e%2e/storage/recovery-key', '/x\\..\\remote/pair']) expect((await p.ask('POST', sly, {})).s, sly).toBe(403);
    // A sealed request sent twice: the second is refused and the phone is cut off.
    const frame = await p.ch.seal(JSON.stringify({ t: 'req', id: 99, m: 'GET', p: '/info' }));
    p.sock.send(frame);
    let got: string | null;
    do got = await p.sock.next();
    while (got !== null && JSON.parse(await p.ch.open(got)).id !== 99);
    p.sock.send(frame);
    expect(await p.sock.next()).toBeNull();
  }, 30_000);

  it('reassembles a completed request and cancels its expiry', async () => {
    const { code } = store.newPairingCode();
    const p = await phone(await e2e.newAgreementKey(), code);
    const request = JSON.stringify({ t: 'req', id: 42, m: 'GET', p: '/info' });
    const chunks = [request.slice(0, 12), request.slice(12)];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const i of [1, 0]) {
        p.sock.send(await p.ch.seal(JSON.stringify({ t: 'part', k: 'request', i, of: 2, s: chunks[i] })));
      }
      const answer = JSON.parse(await p.ch.open((await p.sock.next())!));
      expect(answer).toMatchObject({ t: 'res', id: 42, s: 200, b: { cwd: project } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await p.ask('GET', '/info')).s).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an incomplete message after it stops arriving on a still-open link', async () => {
    const { code } = store.newPairingCode();
    const p = await phone(await e2e.newAgreementKey(), code);
    const first = await p.ch.seal(JSON.stringify({ t: 'part', k: 'incomplete', i: 0, of: 2, s: '{' }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      p.sock.send(first);
      await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000), { timeout: 1200 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p.sock.next()).toBeNull();
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('cuts off a phone forgotten in the settings, then and on its next try', async () => {
    const keys = await e2e.newAgreementKey();
    const { code } = store.newPairingCode();
    await phone(keys, code);
    const mine = e2e.b64(await e2e.rawPublic(keys.publicKey));
    const d = store.devices().find((x) => x.pub === mine)!;
    store.forgetDevice(d.id);
    const k = await store.pcKeys();
    const sock = relay.phone();
    const h = await e2e.phoneHello({ phone: keys, pc: k.kxPub });
    sock.send(h.hello);
    await expect(h.finish((await sock.next())!)).rejects.toThrow(/not paired/);
  }, 30_000);
});

describe('one direction of a connection', () => {
  it('seals in the order asked and opens each frame once, however many are under way', async () => {
    const pcKeys = await e2e.newAgreementKey();
    const phoneKeys = await e2e.newAgreementKey();
    const pcPub = await e2e.rawPublic(pcKeys.publicKey);
    const { hello, finish } = await e2e.phoneHello({ phone: phoneKeys, pc: pcPub });
    const { welcome, channel: pc } = await e2e.pcWelcome({ pc: pcKeys, hello: e2e.readHello(hello)! });
    const phoneSide = await finish(welcome);
    // A long message and short ones sealed together come out, and so go out, in the order they were asked for: the
    // short ones had been ready first and sent first, and the long one was then refused as a replay.
    const done: number[] = [];
    const frames = await Promise.all(['x'.repeat(2_000_000), 'a', 'b', 'c'].map((t, i) => phoneSide.seal(t).then((f) => (done.push(i), f))));
    expect(done).toEqual([0, 1, 2, 3]);
    expect(frames.map((f) => JSON.parse(f).n)).toEqual([0, 1, 2, 3]);
    const opened = await Promise.all(frames.map((f) => pc.open(f)));
    expect(opened.slice(1)).toEqual(['a', 'b', 'c']);
    // The same frame twice at once: one opens, the other is refused.
    const again = await phoneSide.seal('once');
    const both = await Promise.allSettled([pc.open(again), pc.open(again)]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});
