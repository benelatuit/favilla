import { WsConnection } from '../net/ws';
import { readSse } from '../net/http';
import { debug } from '../util/log';
import { pcWelcome, readHello, sign, type Channel } from './e2e';
import { admit, pcKeys, type Device } from './store';
import { RemoteParts } from './parts';

/**
 * This computer's end of remote control: one connection out to the relay (through the proxy Favilla already uses, so
 * it works wherever the computer can reach the internet), on which paired phones reach the local server. Each phone
 * runs its own end-to-end handshake (e2e.ts); the relay only forwards what neither side can read.
 *
 * What a phone may do is what the window may do, less a few things that stay on the computer: pairing new devices,
 * the recovery key, signing in to accounts and opening windows on this screen.
 */
export type LinkState = 'off' | 'connecting' | 'online' | 'error';

/** Requests a phone may not make: they belong to someone at this computer. */
const ONLY_HERE = [/^\/remote(\/|\?|$)/, /^\/storage\/(recovery-key|import-key)/, /^\/reveal/, /^\/pick-folder/, /^\/browser\/open/, /^\/auth\//];
/** Above this a message goes in parts: the relay takes at most about a megabyte at a time. */
const PART = 512 * 1024;
const BACKOFF = [1, 2, 5, 10, 30, 60].map((s) => s * 1000);

/** The connection to the relay as the link uses it (a WebSocket; a stand-in in tests). */
export interface LinkSocket {
  sendText(text: string): void;
  next(): Promise<string | null>;
  close(code?: number): void;
  startHeartbeat?(everyMs: number, deadMs: number, onDead: () => void): void;
  closeReason?: string;
}

export interface LinkOptions {
  relay: string;
  /** The local server the phones' requests go to, and its token. */
  port: number;
  token: string;
  proxy?: string | false;
  onState?: (state: LinkState, error?: string) => void;
  /** How to reach the relay; a WebSocket through the proxy unless given. */
  open?: (url: string) => Promise<LinkSocket>;
}

interface Phone {
  device?: Device;
  channel?: Channel;
  events?: AbortController;
  /** Parts of a long message being put back together. */
  parts: RemoteParts;
}

export class RemoteLink {
  state: LinkState = 'off';
  error: string | undefined;
  private conn: LinkSocket | null = null;
  private stopped = true;
  private tries = 0;
  private phones = new Map<string, Phone>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: LinkOptions) {}

  get relay(): string {
    return this.o.relay;
  }

  /** A phone forgotten in the settings is cut off at once, not at its next connection. */
  dropDevice(id: string): void {
    for (const [c, p] of this.phones) if (p.device?.id === id) this.drop(c, true);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.phones.keys()) this.drop(c, false);
    this.conn?.close(1000);
    this.conn = null;
    this.set('off');
  }

  /** Phones connected right now, by device id. */
  connected(): string[] {
    return [...this.phones.values()].map((p) => p.device?.id).filter((x): x is string => !!x);
  }

  private set(state: LinkState, error?: string): void {
    this.state = state;
    this.error = error;
    this.o.onState?.(state, error);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set('connecting');
    try {
      const k = await pcKeys();
      const url = `${this.o.relay.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/pc/${k.id}`;
      const conn: LinkSocket = this.o.open ? await this.o.open(url) : await WsConnection.open(url, { headers: { 'User-Agent': 'Favilla' }, proxy: this.o.proxy, timeoutMs: 20_000 });
      this.conn = conn;
      conn.startHeartbeat?.(25_000, 75_000, () => conn.close(1001));
      for (;;) {
        const text = await conn.next();
        if (text === null) break;
        let f: { t?: string; n?: string; c?: string; d?: string; error?: string };
        try {
          f = JSON.parse(text);
        } catch {
          continue;
        }
        if (f.t === 'challenge' && f.n) conn.sendText(JSON.stringify({ t: 'auth', pub: Buffer.from(k.signPub).toString('base64url'), sig: await sign(k.sign, `favilla-relay:${f.n}:${k.id}`) }));
        else if (f.t === 'ok') {
          this.tries = 0;
          this.set('online');
        } else if (f.t === 'refused') throw new Error(f.error ?? 'the relay refused this computer');
        else if (f.t === 'open' && f.c) this.addPhone(f.c);
        else if (f.t === 'close' && f.c) this.drop(f.c, false);
        else if (f.t === 'data' && f.c && typeof f.d === 'string') void this.fromPhone(f.c, f.d).catch((e) => this.fail(f.c!, e));
      }
      throw new Error(conn.closeReason || 'the relay closed the connection');
    } catch (e) {
      this.conn = null;
      for (const c of [...this.phones.keys()]) this.drop(c, false);
      if (this.stopped) return;
      const wait = BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)];
      debug('remote', `link down, again in ${wait / 1000} s`, String(e));
      this.set('error', (e as Error).message);
      this.timer = setTimeout(() => void this.connect(), wait);
    }
  }

  private toPhone(c: string, d: string): void {
    this.conn?.sendText(JSON.stringify({ t: 'data', c, d }));
  }

  private addPhone(c: string): Phone {
    this.drop(c, false);
    const phone = { parts: new RemoteParts(() => this.drop(c, true), 199) };
    this.phones.set(c, phone);
    return phone;
  }

  private drop(c: string, tell: boolean): void {
    const p = this.phones.get(c);
    p?.events?.abort();
    p?.parts.clear();
    this.phones.delete(c);
    if (tell) this.conn?.sendText(JSON.stringify({ t: 'close', c }));
  }

  private fail(c: string, e: unknown): void {
    debug('remote', 'phone dropped', String(e));
    this.drop(c, true);
  }

  /** One message to a phone, sealed, in parts when it is long. */
  private async send(c: string, message: unknown): Promise<void> {
    const p = this.phones.get(c);
    if (!p?.channel) return;
    const text = JSON.stringify(message);
    if (text.length <= PART) return this.toPhone(c, await p.channel.seal(text));
    const k = Math.random().toString(36).slice(2);
    const of = Math.ceil(text.length / PART);
    for (let i = 0; i < of; i++) this.toPhone(c, await p.channel.seal(JSON.stringify({ t: 'part', k, i, of, s: text.slice(i * PART, (i + 1) * PART) })));
  }

  private async fromPhone(c: string, d: string): Promise<void> {
    const p = this.phones.get(c) ?? this.addPhone(c);
    if (!p.channel) {
      const hello = readHello(d);
      const device = hello ? await admit(hello) : null;
      if (!hello || !device) {
        this.toPhone(c, JSON.stringify({ t: 'welcome', error: 'This phone is not paired with this computer: pair it again from Settings > Remote on the computer.' }));
        return this.drop(c, true);
      }
      const k = await pcKeys();
      const { welcome, channel } = await pcWelcome({ pc: k.kx, hello });
      p.device = device;
      p.channel = channel;
      this.toPhone(c, welcome);
      return;
    }
    let m = JSON.parse(await p.channel.open(d)) as { t?: string; id?: number; m?: string; p?: string; b?: unknown; k?: string; i?: number; of?: number; s?: string };
    if (this.phones.get(c) !== p) return;
    if (m.t === 'part') {
      const text = p.parts.take(m);
      if (text === null) return;
      m = JSON.parse(text);
    }
    if (m.t === 'req' && typeof m.id === 'number' && typeof m.p === 'string') return this.request(c, m.id, m.m ?? 'GET', m.p, m.b, p.device?.id);
    if (m.t === 'sub') return this.subscribe(c, p);
    if (m.t === 'unsub') p.events?.abort();
  }

  /** A phone's request, made of the local server as the window makes it, with the phone named (its notifications). */
  private async request(c: string, id: number, method: string, asked: string, body: unknown, device?: string): Promise<void> {
    // Checked as the server will take it: /x/../remote/pair, backslashes and %2e%2e resolve to the path they point at,
    // where the check read the path as written and the request then went to the resolved one.
    let path = '';
    try {
      const u = new URL(asked, 'http://favilla.invalid');
      path = `${u.pathname}${u.search}`;
    } catch {
      /* not a path */
    }
    if (!asked.startsWith('/') || asked.startsWith('//') || !path || ONLY_HERE.some((re) => re.test(path))) return this.send(c, { t: 'res', id, s: 403, b: { error: 'That is done on the computer itself.' } });
    try {
      const res = await fetch(`http://127.0.0.1:${this.o.port}/api${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.o.token}`, ...(device ? { 'X-Favilla-Device': device } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get('content-type') ?? '';
      if (/json/.test(type)) return this.send(c, { t: 'res', id, s: res.status, b: await res.json() });
      if (/^text\//.test(type)) return this.send(c, { t: 'res', id, s: res.status, text: await res.text(), ct: type });
      return this.send(c, { t: 'res', id, s: res.status, b64: Buffer.from(await res.arrayBuffer()).toString('base64'), ct: type });
    } catch (e) {
      return this.send(c, { t: 'res', id, s: 502, b: { error: (e as Error).message } });
    }
  }

  /** The server's live events for a phone, gathered a tenth of a second at a time. */
  private async subscribe(c: string, p: Phone): Promise<void> {
    p.events?.abort();
    const stop = new AbortController();
    p.events = stop;
    const res = await fetch(`http://127.0.0.1:${this.o.port}/api/events`, { headers: { Authorization: `Bearer ${this.o.token}` }, signal: stop.signal });
    let batch: unknown[] = [];
    let flush: NodeJS.Timeout | null = null;
    const out = () => {
      flush = null;
      const es = batch;
      batch = [];
      if (es.length) void this.send(c, { t: 'evs', es });
    };
    try {
      for await (const sse of readSse(res.body!, stop.signal)) {
        if (!sse.data) continue;
        try {
          batch.push(JSON.parse(sse.data));
        } catch {
          continue;
        }
        flush ??= setTimeout(out, 100);
      }
    } catch {
      /* stopped */
    } finally {
      if (flush) clearTimeout(flush);
      out();
    }
  }
}
