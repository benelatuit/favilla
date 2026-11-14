// Favilla's relay for remote control, a Cloudflare Worker. It joins a computer and its paired phones and forwards
// what they say to each other; it never reads it (the two ends seal everything themselves, see
// packages/core/src/remote/e2e.ts). It also serves the Favilla page the phones open.
//
//   /ws/pc/<id>     the computer: proves it holds the signing key its id is the hash of, then stays connected
//   /ws/phone/<id>  a phone of that computer
//   anything else   the Favilla page, marked so it knows it runs remotely
//
// One Durable Object per computer holds the sockets, with hibernation, so an idle connection costs nothing.
import { DurableObject } from 'cloudflare:workers';

const ID = /^\/ws\/(pc|phone)\/([A-Za-z0-9_-]{22})$/;
// The page's own rules, as the computer serves it, with its socket back here allowed; never framed by another site
// (nobody can trick a tap on an approval inside a frame).
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' wss:; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MAX_PHONES = 8;
const HELLOS_PER_MINUTE = 30;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = ID.exec(url.pathname);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('A WebSocket is expected here.', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[2])).fetch(req);
    }
    const res = await env.ASSETS.fetch(req);
    const html = (res.headers.get('content-type') ?? '').includes('text/html');
    // The page learns it runs on a phone through the relay; nothing it shows comes from here but the page itself.
    const page = html ? new HTMLRewriter().on('head', { element: (e) => e.append('<meta name="favilla-remote" content="1">', { html: true }) }).transform(res) : res;
    const headers = new Headers(page.headers);
    if (html) headers.set('Cache-Control', 'no-store');
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(page.body, { status: page.status, headers });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req) {
    const [, role, id] = ID.exec(new URL(req.url).pathname);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (role === 'pc') {
      const nonce = b64(crypto.getRandomValues(new Uint8Array(24)));
      this.ctx.acceptWebSocket(server, ['pc']);
      server.serializeAttachment({ role: 'pc', id, nonce, authed: false });
      server.send(JSON.stringify({ t: 'challenge', n: nonce }));
    } else {
      const phones = this.ctx.getWebSockets('phone');
      const minute = Math.floor(Date.now() / 60_000);
      const recent = (await this.ctx.storage.get(`hellos:${minute}`)) ?? 0;
      if (phones.length >= MAX_PHONES || recent >= HELLOS_PER_MINUTE) return new Response('Too many phones at once.', { status: 429 });
      await this.ctx.storage.put(`hellos:${minute}`, recent + 1);
      const c = b64(crypto.getRandomValues(new Uint8Array(9)));
      this.ctx.acceptWebSocket(server, ['phone', `c:${c}`]);
      server.serializeAttachment({ role: 'phone', c });
      const pc = this.pc();
      if (pc) pc.send(JSON.stringify({ t: 'open', c }));
      else server.send(JSON.stringify({ t: 'offline' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The computer's socket once it has proved itself. */
  pc() {
    return this.ctx.getWebSockets('pc').find((ws) => ws.deserializeAttachment()?.authed) ?? null;
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    const a = ws.deserializeAttachment();
    if (a.role === 'pc') return this.fromPc(ws, a, message);
    const pc = this.pc();
    if (!pc) return ws.send(JSON.stringify({ t: 'offline' }));
    let f;
    try {
      f = JSON.parse(message);
    } catch {
      return;
    }
    if (f.t === 'data' && typeof f.d === 'string') pc.send(JSON.stringify({ t: 'data', c: a.c, d: f.d }));
  }

  async fromPc(ws, a, message) {
    let f;
    try {
      f = JSON.parse(message);
    } catch {
      return;
    }
    if (!a.authed) {
      if (f.t !== 'auth' || typeof f.pub !== 'string' || typeof f.sig !== 'string') return ws.close(4001, 'not signed in');
      const pub = unb64(f.pub);
      const idOk = b64(await crypto.subtle.digest('SHA-256', pub)).slice(0, 22) === a.id;
      let sigOk = false;
      try {
        const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(f.sig), new TextEncoder().encode(`favilla-relay:${a.nonce}:${a.id}`));
      } catch {
        sigOk = false;
      }
      if (!idOk || !sigOk) {
        ws.send(JSON.stringify({ t: 'refused', error: 'This key does not own this id.' }));
        return ws.close(4003, 'refused');
      }
      // The newest connection of the computer wins: an old one left behind by a network change goes.
      for (const old of this.ctx.getWebSockets('pc')) if (old !== ws) old.close(4000, 'replaced');
      ws.serializeAttachment({ ...a, authed: true });
      ws.send(JSON.stringify({ t: 'ok' }));
      for (const phone of this.ctx.getWebSockets('phone')) {
        const c = phone.deserializeAttachment().c;
        ws.send(JSON.stringify({ t: 'open', c }));
        phone.send(JSON.stringify({ t: 'online' }));
      }
      return;
    }
    if (typeof f.c !== 'string') return;
    const phone = this.ctx.getWebSockets(`c:${f.c}`)[0];
    if (!phone) return;
    if (f.t === 'data' && typeof f.d === 'string') phone.send(JSON.stringify({ t: 'data', d: f.d }));
    else if (f.t === 'close') phone.close(4004, 'closed by the computer');
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a?.role === 'phone') this.pc()?.send(JSON.stringify({ t: 'close', c: a.c }));
    else if (a?.role === 'pc' && a.authed && !this.pc()) for (const phone of this.ctx.getWebSockets('phone')) phone.send(JSON.stringify({ t: 'offline' }));
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
