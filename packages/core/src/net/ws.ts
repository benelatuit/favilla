import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import type { Duplex } from 'node:stream';

/**
 * A WebSocket client of our own, for the Responses socket: it sends exactly the headers it is given (the WHATWG
 * client adds browser ones a native client never sends), reads the handshake's status and headers (a refused
 * upgrade says why, and the plan meters ride on the 101), inflates permessage-deflate, and keeps a heartbeat so a
 * dead connection is found in seconds, not when a stall timer runs out.
 */

export class WsHandshakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface WsOpenOptions {
  /** Sent as given, after the handshake's own lines. */
  headers: Record<string, string>;
  /** An HTTP proxy to tunnel through (CONNECT), as the HTTP requests use. */
  proxy?: string | false;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function withTimeout<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

/** Bytes up to the end of an HTTP head (\r\n\r\n), and what came after it. */
function readHead(socket: Duplex): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 64 * 1024) done(new Error('response head too large'));
        return;
      }
      done(null, { head: buf.subarray(0, end).toString('latin1'), rest: buf.subarray(end + 4) });
    };
    const onEnd = () => done(new Error('connection closed during the handshake'));
    const done = (err: Error | null, v?: { head: string; rest: Buffer }) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onErr);
      socket.pause();
      if (err) reject(err);
      else resolve(v!);
    };
    const onErr = (e: Error) => done(e);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onErr);
    socket.resume();
  });
}

function parseHead(head: string): { status: number; headers: Record<string, string> } {
  const [line, ...rest] = head.split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const l of rest) {
    const i = l.indexOf(':');
    if (i > 0) {
      const k = l.slice(0, i).trim().toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}, ${l.slice(i + 1).trim()}` : l.slice(i + 1).trim();
    }
  }
  return { status, headers };
}

/** A TCP (ws:) or TLS (wss:) stream to the server, through the proxy's CONNECT tunnel when there is one. */
async function connectStream(url: URL, proxy: string | false | undefined): Promise<Duplex> {
  const secure = url.protocol === 'wss:';
  const port = Number(url.port) || (secure ? 443 : 80);
  let base: Duplex | undefined;
  if (proxy) {
    const p = new URL(proxy);
    const sock = net.connect(Number(p.port) || 80, p.hostname);
    sock.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
    sock.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n${auth}\r\n`);
    const { head } = await readHead(sock);
    const { status } = parseHead(head);
    if (status !== 200) {
      sock.destroy();
      throw new Error(`proxy refused the tunnel (${status})`);
    }
    base = sock;
  }
  if (!secure) {
    if (base) return base;
    const sock = net.connect(port, url.hostname);
    sock.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    return sock;
  }
  const t = tls.connect({ ...(base ? { socket: base as net.Socket } : { host: url.hostname, port }), servername: url.hostname, ALPNProtocols: ['http/1.1'] });
  await new Promise<void>((resolve, reject) => {
    t.once('secureConnect', resolve);
    t.once('error', reject);
  });
  t.setNoDelay(true);
  return t;
}

export class WsConnection {
  readonly openedAt = Date.now();
  /** When anything last came from the server (a message, a ping, a pong): the heartbeat's measure of life. */
  lastHeard = Date.now();
  closed = false;
  closeReason = '';
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentCompressed = false;
  private inbox: string[] = [];
  private waiter: (() => void) | null = null;
  private inflater?: zlib.InflateRaw;
  private order: Promise<void> = Promise.resolve();
  private heartbeat?: NodeJS.Timeout;

  private constructor(
    private readonly socket: Duplex,
    readonly responseHeaders: Record<string, string>,
    private readonly deflate: { on: boolean; serverNoTakeover: boolean; serverBits: number },
    rest: Buffer,
  ) {
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('end', () => this.finish('closed by the server'));
    socket.on('close', () => this.finish('connection closed'));
    socket.on('error', (e: Error) => this.finish(e.message));
    socket.resume();
    if (rest.length) this.onData(rest);
  }

  static async open(url: string, o: WsOpenOptions): Promise<WsConnection> {
    const u = new URL(url);
    const timeout = o.timeoutMs ?? 15_000;
    const socket = await withTimeout(connectStream(u, o.proxy), timeout, 'connecting', o.signal);
    try {
      const key = crypto.randomBytes(16).toString('base64');
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
        ...Object.entries(o.headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      const { head, rest } = await withTimeout(readHead(socket), timeout, 'the handshake', o.signal);
      const { status, headers } = parseHead(head);
      if (status !== 101) {
        // The refusal's body says why (an expired sign-in, a limit): read a little of it.
        const body = await withTimeout(
          new Promise<string>((resolve) => {
            let b = rest.toString('utf8');
            socket.on('data', (d: Buffer) => {
              b += d.toString('utf8');
              if (b.length > 8192) resolve(b);
            });
            socket.once('end', () => resolve(b));
            socket.once('close', () => resolve(b));
            socket.resume();
          }),
          3000,
          'the refusal',
        ).catch(() => rest.toString('utf8'));
        socket.destroy();
        throw new WsHandshakeError(`the server refused the WebSocket (${status})`, status, headers, body.slice(0, 8192));
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        throw new WsHandshakeError('the server answered the WebSocket handshake wrongly', status, headers, '');
      }
      const ext = headers['sec-websocket-extensions'] ?? '';
      const deflate = {
        on: /permessage-deflate/i.test(ext),
        serverNoTakeover: /server_no_context_takeover/i.test(ext),
        serverBits: Number(/server_max_window_bits=(\d+)/i.exec(ext)?.[1] ?? 15),
      };
      return new WsConnection(socket, headers, deflate, rest);
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }

  /**
   * Ping every `everyMs` and call `onDead` when nothing has come back for `deadMs`: a proxy that dropped the
   * tunnel, or a server gone quiet, shows up in seconds even while the model thinks without writing.
   */
  startHeartbeat(everyMs: number, deadMs: number, onDead: () => void, onAlive?: () => void): void {
    this.stopHeartbeat();
    this.lastHeard = Date.now();
    this.heartbeat = setInterval(() => {
      if (this.closed) return this.stopHeartbeat();
      if (Date.now() - this.lastHeard > deadMs) {
        this.stopHeartbeat();
        onDead();
        return;
      }
      // The server answered within the dead limit: whoever waits on this socket hears it is open.
      onAlive?.();
      this.write(0x9, Buffer.from(String(Date.now())));
    }, everyMs);
    this.heartbeat.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  sendText(text: string): void {
    if (this.closed) throw new Error(`the WebSocket is closed (${this.closeReason})`);
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  /** The next text message, or null once the connection has closed and nothing is left. */
  async next(): Promise<string | null> {
    for (;;) {
      if (this.inbox.length) return this.inbox.shift()!;
      if (this.closed) return null;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }

  close(code = 1000): void {
    if (this.closed) return;
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code);
      this.write(0x8, b);
    } catch {
      // Already gone.
    }
    this.finish('closed by us');
    setTimeout(() => this.socket.destroy(), 200).unref?.();
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.stopHeartbeat();
    this.inflater?.close();
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** Client frames are masked; messages go out uncompressed (permessage-deflate allows that per message). */
  private write(op: number, payload: Buffer): void {
    const len = payload.length;
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) {
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  private onData(d: Buffer): void {
    this.lastHeard = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const m = this.buf.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = this.buf.subarray(off + len);
      this.onFrame(b0 & 0x80 ? true : false, (b0 & 0x40) !== 0, b0 & 0x0f, Buffer.from(payload));
    }
  }

  private onFrame(fin: boolean, rsv1: boolean, op: number, payload: Buffer): void {
    if (op === 0x9) return this.write(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const why = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      try {
        this.write(0x8, payload.subarray(0, 2));
      } catch {
        // Gone already.
      }
      this.finish(`closed by the server (${code}${why ? `: ${why}` : ''})`);
      setTimeout(() => this.socket.destroy(), 200).unref?.();
      return;
    }
    if (op === 0x1 || op === 0x2) {
      this.fragments = [payload];
      this.fragmentCompressed = rsv1;
    } else if (op === 0x0) this.fragments.push(payload);
    else return;
    if (!fin) return;
    const whole = Buffer.concat(this.fragments);
    const compressed = this.fragmentCompressed;
    this.fragments = [];
    // Messages are delivered in order even when one has to be inflated first.
    this.order = this.order.then(async () => {
      try {
        const data = compressed && this.deflate.on ? await this.inflate(whole) : whole;
        this.inbox.push(data.toString('utf8'));
      } catch (e) {
        this.finish(`could not inflate a message: ${(e as Error).message}`);
      }
      this.wake();
    });
  }

  private inflate(data: Buffer): Promise<Buffer> {
    if (this.deflate.serverNoTakeover && this.inflater) {
      this.inflater.close();
      this.inflater = undefined;
    }
    const inf = (this.inflater ??= zlib.createInflateRaw({ windowBits: this.deflate.serverBits }));
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const onData = (c: Buffer) => out.push(c);
      const onError = (e: Error) => {
        inf.off('data', onData);
        reject(e);
      };
      inf.on('data', onData);
      inf.once('error', onError);
      inf.write(Buffer.concat([data, TAIL]));
      inf.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        inf.off('data', onData);
        inf.off('error', onError);
        resolve(Buffer.concat(out));
      });
    });
  }
}
