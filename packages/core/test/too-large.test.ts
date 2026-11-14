import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorFromStatus } from '../src/net/http';
import { fitPictures, learnPictureBudget, PICTURE_FLOOR, pictureBudget, pictureBytes } from '../src/context/images';
import type { Message } from '../src/types';

// A body refused for its size (HTTP 413): a relay in front of a hosted model turned away a session that had taken many
// screenshots, and Favilla tried three times and called the service down (2026-11-05).

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-too-large-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

/** Bytes the fake server takes; past that it answers as nginx does, passed on by a relay. */
const LIMIT = 1_500_000;
const sizes: number[] = [];
const refused: number[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    sizes.push(body.length);
    if (body.length > LIMIT) {
      refused.push(body.length);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'api server returned 413: <html> <head><title>413 Request Entity Too Large</title></head> <body> <center><h1>413 Request Entity Too Large</h1></center> <hr><center>nginx</center> </body> </html>' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'I see them.' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt', vision: true } } } } }),
  );
  rt = createRuntime(project, { interactive: true });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  try {
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Windows can hold files written a moment ago; a scratch folder left in the temp folder is no failure here.
  }
});

/** A made-up picture of about `kb` kilobytes of base64, each one different. */
let shots = 0;
const picture = (kb: number) => ({ type: 'image' as const, mediaType: 'image/png', name: `shot-${++shots}.png`, data: Buffer.alloc(Math.floor((kb * 1024 * 3) / 4), shots).toString('base64') });

describe('a request too large for the service', () => {
  it('is told apart from a service that is down, also when a relay passes it on', () => {
    const direct = errorFromStatus(413, new Headers(), '<html><title>413 Request Entity Too Large</title></html>', 'Gateway');
    expect(direct.kind).toBe('too_large');
    expect(direct.retryable).toBe(false);
    const relayed = errorFromStatus(502, new Headers(), JSON.stringify({ error: { message: 'api server returned 413: <html> <head><title>413 Request Entity Too Large</title></head></html>' } }), 'Gateway');
    expect(relayed.kind).toBe('too_large');
    expect(relayed.message).toMatch(/too large for this service \(HTTP 413\)/);
    expect(errorFromStatus(502, new Headers(), 'bad gateway', 'Gateway').kind).toBe('server');
  });

  it('leaves the oldest pictures out of the request until the rest fit, and the history as it was', () => {
    const history: Message[] = [
      { id: 'u1', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'look' }, picture(300), picture(300)], time: 1 },
      { id: 'a1', role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'browser', input: {} }], time: 2 },
      { id: 'r1', role: 'user', parts: [{ type: 'tool_result', callId: 'c1', name: 'browser', content: 'the page', images: [picture(300)] }], time: 3 },
      { id: 'u2', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'and this' }, picture(300)], time: 4 },
    ];
    const all = pictureBytes(history);
    expect(fitPictures(history, all)).toBe(history);
    const fitted = fitPictures(history, all - 1);
    // One picture goes, the oldest, and a line says so where it was.
    expect(pictureBytes(fitted)).toBeLessThan(all);
    expect(fitted[0].parts.filter((p) => p.type === 'image')).toHaveLength(1);
    expect(fitted[0].parts.some((p) => p.type === 'text' && /left out of this request/.test(p.text))).toBe(true);
    // Down to one picture: the tool's result keeps its words and says how to get its picture back.
    const lean = fitPictures(history, 400 * 1024);
    const result = lean[2].parts[0];
    expect(result.type === 'tool_result' && result.images).toEqual([]);
    expect(result.type === 'tool_result' && result.content).toMatch(/recall with call_id c1/);
    expect(lean[3].parts.filter((p) => p.type === 'image')).toHaveLength(1);
    expect(pictureBytes(history)).toBe(all);
  });

  it('learns from a refusal to carry half the pictures, never under the floor', () => {
    expect(learnPictureBudget('relay-a', 6_000_000)).toBe(3_000_000);
    expect(pictureBudget('relay-a')).toBe(3_000_000);
    expect(learnPictureBudget('relay-a', 6_000_000)).toBe(1_500_000);
    expect(learnPictureBudget('relay-a', 100_000)).toBe(PICTURE_FLOOR);
    expect(pictureBudget('relay-b')).toBeGreaterThan(PICTURE_FLOOR);
  });

  it('goes on in a session full of screenshots: the turn gets its answer with fewer pictures sent', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1', interactive: true });
    const notices: string[] = [];
    s.on((e) => {
      if (e.type === 'notice') notices.push(e.text);
    });
    await s.send('here are my screenshots', [picture(400), picture(400), picture(400), picture(400), picture(400)]);
    expect(refused.length).toBeGreaterThan(0);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(LIMIT);
    expect(s.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text === 'I see them.')).toBe(true);
    expect(notices.some((n) => /too large/.test(n))).toBe(true);
    expect(notices.some((n) => /service may be down/.test(n))).toBe(false);
    // The history keeps every picture the user sent; only the requests carried fewer.
    expect(s.messages.find((m) => m.origin === 'user')!.parts.filter((p) => p.type === 'image')).toHaveLength(5);
  });
});
