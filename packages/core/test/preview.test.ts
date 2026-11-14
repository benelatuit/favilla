import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servedUrl } from '../src/tools/jobs';
import { POINT_SCRIPT, previewOf, withScript } from '../src/server/preview';

describe('where a server says its page is', () => {
  it('takes the last address on this computer it printed, 0.0.0.0 as this computer', () => {
    expect(servedUrl('\x1b[32m  ➜  Local:\x1b[39m   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host')).toBe('http://localhost:5173/');
    expect(servedUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...')).toBe('http://127.0.0.1:8000/');
    expect(servedUrl('ready on http://127.0.0.1:3000\nrestarted on http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(servedUrl('see https://example.com/docs')).toBeNull();
  });
});

describe('the preview of a page', () => {
  let target: http.Server;
  let base = '';
  beforeAll(async () => {
    target = http.createServer((req, res) => {
      if (req.url === '/app.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return void res.end('console.log(1)');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" });
      res.end('<!doctype html><html><head><title>Shop</title></head><body><button>结算</button></body></html>');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  });
  afterAll(() => target.close());

  it('adds the point-and-tell script to its pages, lets the app frame them, and serves the script', async () => {
    const proxied = await previewOf(`${base}/cart?x=1`);
    expect(proxied).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cart\?x=1$/);
    const page = await fetch(proxied);
    const html = await page.text();
    expect(html).toContain(`<head><script src="${POINT_SCRIPT}"></script><title>Shop</title>`);
    expect(page.headers.get('x-frame-options')).toBeNull();
    expect(page.headers.get('content-security-policy')).not.toMatch(/frame-ancestors/);
    expect(Number(page.headers.get('content-length'))).toBe(Buffer.byteLength(html));
    const script = await fetch(new URL(POINT_SCRIPT, proxied));
    expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect(await script.text()).toContain('__favillaPoint');
  });

  it('passes everything else through as it is, and keeps one proxy for each server', async () => {
    const proxied = await previewOf(`${base}/`);
    expect(await (await fetch(new URL('/app.js', proxied))).text()).toBe('console.log(1)');
    expect(new URL(await previewOf(`${base}/other`)).origin).toBe(new URL(proxied).origin);
  });

  it('stands in front of pages on this computer alone', async () => {
    await expect(previewOf('http://example.com/')).rejects.toThrow(/Not a page served on this computer/);
    await expect(previewOf('https://localhost:5173/')).rejects.toThrow();
  });

  it('puts the script first in the head, or first in a page without one', () => {
    expect(withScript('<html><HEAD lang="x"><meta charset="utf-8"></HEAD></html>')).toBe(`<html><HEAD lang="x"><script src="${POINT_SCRIPT}"></script><meta charset="utf-8"></HEAD></html>`);
    expect(withScript('<p>hi</p>')).toBe(`<script src="${POINT_SCRIPT}"></script><p>hi</p>`);
  });
});
