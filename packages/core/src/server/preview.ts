import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { listenForBrowser } from '../net/browser-port';
import { assetsDir } from '../util/paths';

/** Where the page asks for the point-and-tell script; nothing a project serves is likely to sit there. */
export const POINT_SCRIPT = '/__favilla/point.js';

/** Hosts a preview may stand in front of: this computer only. */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

const proxies = new Map<string, Promise<string>>();

/**
 * The page a session serves, as the app shows it: a proxy on this computer in front of the dev server, which adds
 * Favilla's point-and-tell script to every HTML page it passes on and lets the app frame it. Everything else goes
 * through as it is, websockets (a dev server's live reload) included. One proxy for each server, kept while the
 * process runs; it listens on 127.0.0.1 alone and stands in front of addresses on this computer alone.
 */
export function previewOf(target: string): Promise<string> {
  const url = new URL(target);
  if (url.protocol !== 'http:' || !LOOPBACK.test(url.hostname)) return Promise.reject(new Error(`Not a page served on this computer: ${target}`));
  const origin = url.origin;
  let open = proxies.get(origin);
  if (!open) {
    open = startProxy(url);
    proxies.set(origin, open);
    open.catch(() => proxies.delete(origin));
  }
  return open.then((base) => `${base}${url.pathname}${url.search}`);
}

async function startProxy(target: URL): Promise<string> {
  const port = Number(target.port || 80);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const server = http.createServer((req, res) => {
    if (req.url === POINT_SCRIPT) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(pointScript());
      return;
    }
    // Asked for whole: a compressed page could not have the script added.
    const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
    const up = http.request({ host, port, method: req.method, path: req.url, headers }, (r) => {
      const out = { ...r.headers };
      // Framed in the app on purpose, on this computer.
      delete out['x-frame-options'];
      if (typeof out['content-security-policy'] === 'string') out['content-security-policy'] = out['content-security-policy'].replace(/frame-ancestors[^;]*;?/i, '');
      // A page sent compressed all the same (the server ignored the ask) goes through as it is, without the script.
      const packed = !!out['content-encoding'] && out['content-encoding'] !== 'identity';
      if (!/text\/html/i.test(String(out['content-type'] ?? '')) || r.statusCode !== 200 || packed) {
        res.writeHead(r.statusCode ?? 502, out);
        r.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      // A page cut off on the way (the dev server restarting) ends the answer too, where the frame waited for good.
      r.on('aborted', () => res.destroy());
      r.on('error', () => res.destroy());
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => {
        const html = withScript(Buffer.concat(chunks).toString('utf8'));
        delete out['content-length'];
        delete out['content-encoding'];
        delete out['transfer-encoding'];
        res.writeHead(200, { ...out, 'content-length': Buffer.byteLength(html) });
        res.end(html);
      });
    });
    up.on('error', () => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The page is not being served any more.');
    });
    req.pipe(up);
  });
  // A dev server's live reload: the websocket goes through untouched.
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(port, host, () => {
      const lines = Object.entries({ ...req.headers, host: target.host }).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]));
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  const own = await listenForBrowser(server);
  server.unref();
  return `http://127.0.0.1:${own}`;
}

/** The page with the script added: first thing in its head, or at its start when it has none. */
export function withScript(html: string): string {
  const tag = `<script src="${POINT_SCRIPT}"></script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  return tag + html;
}

let script: string | undefined;
function pointScript(): string {
  script ??= fs.readFileSync(`${assetsDir()}/preview/point.js`, 'utf8');
  return script;
}
