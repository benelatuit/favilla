import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { browserRefuses, listenForBrowser } from '../src/net/browser-port';

/** A server that is handed the given ports in turn, since a real OS gives no refused port on request. */
function scripted(ports: number[]) {
  const s = new EventEmitter() as EventEmitter & { listens: number; closes: number };
  let now = 0;
  s.listens = 0;
  s.closes = 0;
  Object.assign(s, {
    listen: (_p: number, _h: string, done: () => void) => { now = ports[s.listens++]; queueMicrotask(done); },
    address: () => ({ port: now, address: '127.0.0.1', family: 'IPv4' }),
    close: (done: () => void) => { s.closes++; queueMicrotask(done); },
  });
  return s;
}

describe('a port a browser will open', () => {
  it('knows the ports browsers refuse', () => {
    for (const p of [1720, 6000, 6667, 10080]) expect(browserRefuses(p)).toBe(true);
    for (const p of [1721, 3000, 5173, 49152]) expect(browserRefuses(p)).toBe(false);
  });

  it('listens again when the OS hands out a refused port', async () => {
    const s = scripted([1720, 6000, 3001]);
    expect(await listenForBrowser(s as unknown as Server)).toBe(3001);
    expect([s.listens, s.closes]).toEqual([3, 2]);
  });

  it('serves on a real port of 127.0.0.1', async () => {
    const server = http.createServer((_q, r) => r.end('ok'));
    const port = await listenForBrowser(server);
    try {
      expect(browserRefuses(port)).toBe(false);
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
