import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { debug } from '../util/log';
import type { RemoteLink } from './link';

/**
 * Remote control without a relay, for a phone on the same network: a small door on this computer that serves the
 * Favilla page and takes the phones' connections, the two things the relay does. Nothing else of the local server
 * is reachable through it: no /api, no cookie, no token. What a phone asks goes through the same link and the same
 * end-to-end handshake as over the relay (link.ts, e2e.ts), so only a paired phone gets anything done.
 *
 * The page is served over plain http, where browsers give it no WebCrypto; the phone then seals with the script
 * primitives (e2e-script.ts). Plain http also means someone able to tamper with this network's traffic could change
 * the page on its way, which is why the settings describe this as the way for a network the user trusts.
 */
export type DoorState = 'off' | 'starting' | 'open' | 'error';

export interface LanAddress {
  address: string;
  /** The adapter's name as the system gives it (Wi-Fi, Ethernet, en0). */
  name: string;
}

/** The first port tried, until one has been opened; then that one, so a paired phone's page keeps its address. */
export const LAN_PORT = 41820;
const MAX_PHONES = 8;
const HELLOS_PER_MINUTE = 30;
/** A phone's messages are requests; a picture attached from the phone is the largest. */
const MAX_MESSAGE = 8 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PAGE_META = '<meta name="favilla-remote" content="1">';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// Adapters a phone on the user's network cannot be behind: virtual switches, VPN and proxy tunnels, containers.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|vboxnet|Docker|veth|br-|virbr|bridge|TAP|TUN|Wintun|utun|Clash|Mihomo|Meta|ZeroTier|Tailscale|WireGuard|Loopback|Bluetooth|awdl|llw/i;
const WIRELESS = /Wi-?Fi|WLAN|wlp|wlan|Wireless|无线/i;

function v4(address: string): number[] | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** An address of a private network (RFC 1918), the kind a home or office network hands out. */
function privateV4([a, b]: number[]): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Who may knock at the door: this computer, private and link-local networks, and the shared range VPN meshes use.
 * A request from a public address arrived through a forwarded port or a public interface and is refused.
 */
export function peerAllowed(address: string | undefined): boolean {
  if (!address) return false;
  const p = v4(address);
  if (p) return privateV4(p) || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  const a = address.toLowerCase();
  return a === '::1' || /^fe[89ab][0-9a-f]:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a);
}

/** This computer's addresses on the networks a phone may share with it, Wi-Fi first. */
export function lanAddresses(): LanAddress[] {
  const out: (LanAddress & { rank: number })[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      const p = i.family === 'IPv4' && !i.internal ? v4(i.address) : null;
      if (p && privateV4(p)) out.push({ address: i.address, name, rank: WIRELESS.test(name) ? 0 : 1 });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ address, name }) => ({ address, name }));
}

function headersFor(host: string | undefined): Record<string, string> {
  // The page connects back to where it came from; 'self' covers ws: in current browsers, the address in older ones.
  const ws = host && /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host) ? ` ws://${host}` : '';
  return {
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'${ws}; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * The server's end of one phone's WebSocket (RFC 6455), as much as the page needs: text messages, in fragments or
 * whole, pings both ways, and a close. No extensions are offered, so frames come uncompressed.
 */
class PhoneSocket {
  closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private lastHeard = Date.now();
  private beat?: NodeJS.Timeout;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });

  constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void,
  ) {}

  begin(head: Buffer): void {
    this.socket.on('data', (d: Buffer) => this.onData(d));
    this.socket.on('end', () => this.finish());
    this.socket.on('close', () => this.finish());
    this.socket.on('error', () => this.finish());
    // A phone that went to sleep or left the network says nothing; it is let go after a minute and a quarter.
    this.beat = setInterval(() => {
      if (Date.now() - this.lastHeard > 75_000) return this.destroy();
      this.write(0x9, Buffer.alloc(0));
    }, 25_000);
    this.beat.unref?.();
    if (head.length) this.onData(head);
  }

  send(text: string): void {
    if (!this.closed) this.write(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, why = ''): void {
    if (this.closed) return;
    const reason = Buffer.from(why, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(code);
    reason.copy(payload, 2);
    this.write(0x8, payload);
    this.finish();
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }

  private destroy(): void {
    this.finish();
    this.socket.destroy();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.onClose();
  }

  /** Server frames go unmasked. */
  private write(op: number, payload: Buffer): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    const len = payload.length;
    const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
    head[0] = 0x80 | op;
    if (len < 126) head[1] = len;
    else if (len < 65536) {
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    this.lastHeard = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed && this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      // No extension was agreed, so the reserved bits stay clear; and every frame from a browser is masked.
      if (b0 & 0x70 || !(b1 & 0x80)) return this.close(1002, 'protocol error');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'message too big');
        len = Number(big);
        off = 10;
      }
      if (this.fragmentBytes + len > MAX_MESSAGE) return this.close(1009, 'message too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  private onFrame(fin: boolean, op: number, payload: Buffer): void {
    if (op >= 0x8) {
      if (!fin || payload.length > 125) return this.close(1002, 'protocol error');
      if (op === 0x8) {
        this.write(0x8, payload.subarray(0, 2));
        this.finish();
        this.socket.end();
        return;
      }
      if (op === 0x9) this.write(0xa, payload);
      return;
    }
    if (op === 0x2) return this.close(1003, 'text only');
    if (op === 0x1) {
      if (this.fragments.length) return this.close(1002, 'protocol error');
    } else if (op !== 0x0 || !this.fragments.length) return this.close(1002, 'protocol error');
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (!fin) return;
    const whole = Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    let text: string;
    try {
      text = this.utf8.decode(whole);
    } catch {
      return this.close(1007, 'not UTF-8');
    }
    this.onText(text);
  }
}

export interface LanDoorOptions {
  /** The built Favilla page. */
  webDir?: string;
  /** The port asked for; the next free one after it when it is taken. */
  port: number;
  /** Where to listen: every IPv4 network unless given (tests keep to 127.0.0.1). */
  host?: string;
  /** This computer's id, the one in the phones' pairing. */
  pcId: () => Promise<string>;
  /** The link the phones' messages go to, while remote control is on. */
  link: () => RemoteLink | null;
  onState?: () => void;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => {
      server.off('listening', ok);
      reject(e);
    };
    const ok = () => {
      server.off('error', fail);
      resolve();
    };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(port, host);
  });
}

export class LanDoor {
  state: DoorState = 'off';
  error: string | undefined;
  /** The port it listens on while open. */
  port = 0;
  private server: http.Server | null = null;
  private phones = new Set<PhoneSocket>();
  private hellos: number[] = [];
  private page: { file: string; mtime: number; html: string } | null = null;

  constructor(private readonly o: LanDoorOptions) {}

  /** The port the settings asked for, to tell when they changed. */
  get asked(): number {
    return this.o.port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.serve(req, res));
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(req, socket, head).catch(() => socket.destroy()));
    server.on('clientError', (_e, socket: Duplex) => socket.destroy());
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    this.server = server;
    this.set('starting');
    const host = this.o.host ?? '0.0.0.0';
    // A port taken, or reserved by the system (Windows sets ranges aside for Hyper-V), moves the door to the next.
    const ports = [...Array.from({ length: 20 }, (_, i) => this.o.port + i).filter((p) => p <= 65535), 0];
    let last: Error | null = null;
    for (const p of ports) {
      try {
        await listen(server, p, host);
      } catch (e) {
        last = e as Error;
        const code = (e as NodeJS.ErrnoException).code;
        if (this.server !== server) return;
        if (code === 'EADDRINUSE' || code === 'EACCES') continue;
        break;
      }
      if (this.server !== server) {
        server.close();
        return;
      }
      this.port = (server.address() as AddressInfo).port;
      debug('remote', `local network door open on ${host}:${this.port}`);
      return this.set('open');
    }
    if (this.server !== server) return;
    this.server = null;
    this.set('error', last?.message ?? 'no port to listen on');
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    for (const ws of [...this.phones]) ws.close(1001, 'closed by the computer');
    this.phones.clear();
    server?.close();
    server?.closeAllConnections?.();
    this.port = 0;
    if (this.state !== 'off') this.set('off');
  }

  private set(state: DoorState, error?: string): void {
    this.state = state;
    this.error = error;
    this.o.onState?.();
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    const plain = (status: number, text: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headersFor(undefined) });
      res.end(text);
    };
    if (!peerAllowed(req.socket.remoteAddress)) return plain(403, 'Only devices on this network.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Only pages are served here.');
    if (!this.o.webDir) return plain(404, 'The Favilla page is not built on this computer.');
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://door.invalid').pathname);
    } catch {
      return plain(400, 'Not a path.');
    }
    if (/^\/(api|ws)(\/|$)/.test(pathname)) return plain(404, 'Not here.');
    const root = path.resolve(this.o.webDir);
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) return plain(404, 'Not here.');
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!stat || stat.isDirectory()) {
      // A missing file is missing; a route of the page (no extension) is the page.
      if (path.extname(pathname)) return plain(404, 'Not here.');
      file = path.join(root, 'index.html');
    }
    const ext = path.extname(file);
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', ...headersFor(req.headers.host) };
    if (ext === '.html') {
      let html: string;
      try {
        html = this.pageOf(file);
      } catch {
        return plain(404, 'The Favilla page is not built on this computer.');
      }
      headers['Cache-Control'] = 'no-store';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    headers['Cache-Control'] = file.startsWith(path.join(root, 'assets') + path.sep) ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  /** The page as the relay serves it: marked so it knows it runs on a phone. */
  private pageOf(file: string): string {
    const mtime = fs.statSync(file).mtimeMs;
    if (this.page?.file === file && this.page.mtime === mtime) return this.page.html;
    const raw = fs.readFileSync(file, 'utf8');
    const html = raw.includes('</head>') ? raw.replace('</head>', `${PAGE_META}</head>`) : PAGE_META + raw;
    this.page = { file, mtime, html };
    return html;
  }

  private async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, why: string) => {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
    };
    if (!peerAllowed(req.socket.remoteAddress)) return refuse(403, 'Only devices on this network.');
    const m = /^\/ws\/phone\/([A-Za-z0-9_-]{22})$/.exec(new URL(req.url ?? '/', 'http://door.invalid').pathname);
    if (!m || m[1] !== (await this.o.pcId())) return refuse(404, 'Not here.');
    // Only the page this door served may connect: a site open elsewhere in the phone's browser may not.
    const host = req.headers.host;
    if (!host || req.headers.origin !== `http://${host}`) return refuse(403, 'Only the page from this computer connects here.');
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return refuse(400, 'A WebSocket is expected here.');
    const link = this.o.link();
    if (!link || !this.server) return refuse(503, 'Remote control is off on this computer.');
    const now = Date.now();
    this.hellos = this.hellos.filter((t) => now - t < 60_000);
    if (this.phones.size >= MAX_PHONES || this.hellos.length >= HELLOS_PER_MINUTE) return refuse(429, 'Too many phones at once.');
    this.hellos.push(now);
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    (socket as Socket).setNoDelay?.(true);
    let peer: ReturnType<RemoteLink['attachLocal']> | null = null;
    const ws = new PhoneSocket(
      socket,
      (text) => {
        // The same frames the relay speaks with a phone, so the page cannot tell the two apart.
        if (text === '{"t":"ping"}') return ws.send('{"t":"pong"}');
        let f: { t?: string; d?: unknown };
        try {
          f = JSON.parse(text);
        } catch {
          return;
        }
        if (f?.t === 'data' && typeof f.d === 'string') peer?.data(f.d);
      },
      () => {
        this.phones.delete(ws);
        peer?.closed();
      },
    );
    this.phones.add(ws);
    peer = link.attachLocal({ send: (d) => ws.send(JSON.stringify({ t: 'data', d })), close: () => ws.close(4004, 'closed by the computer') });
    ws.begin(head);
  }
}
