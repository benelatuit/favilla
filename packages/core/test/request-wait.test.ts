import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../src/agent/session';
import type { Runtime } from '../src/runtime';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-wait-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const bodies: string[] = [];
const asks = new Map<string, number>();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }

    bodies.push(body);
    const sent = JSON.parse(body).messages as { role: string; content: string }[];
    const last = sent.findLast((m) => m.role === 'user')?.content ?? '';
    const asked = last.replace(/^(?:<harness-note>[\s\S]*?<\/harness-note>\n\n)+/, '');
    const count = (asks.get(asked) ?? 0) + 1;
    asks.set(asked, count);
    if (count === 1 && (asked === 'Busy.' || asked === 'Busy again.')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'api_error' } }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const delta = (content: string) => chunk({ choices: [{ index: 0, delta: { role: 'assistant', content } }] });
    const finish = (text = 'Done.') => {
      delta(text);
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    };
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      res.once('close', () => clearTimeout(timer));
    };

    if (count === 1 && (asked === 'Dropped.' || asked === 'Long.')) {
      delta(asked === 'Dropped.' ? 'x'.repeat(40) : 'x = 1\n'.repeat(900));
      later(50, () => res.socket?.destroy());
    } else if (asked === 'Quiet.') {
      const pings = setInterval(() => res.write(': keep-alive\n\n'), 50);
      res.once('close', () => clearInterval(pings));
      later(500, () => {
        clearInterval(pings);
        finish();
      });
    } else if (asked === 'Pause.') {
      delta('One. ');
      later(1200, () => finish('Two.'));
    } else {
      // A continuation carries the harness's note as its last user message.
      finish();
    }
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'wait/m1',
      tools: 'favilla',
      languageServers: false,
      providers: {
        wait: { name: 'Waiting relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } },
      },
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function withSession(run: (s: Session, rt: Runtime) => Promise<void>): Promise<void> {
  const { createRuntime } = await import('../src/runtime');
  const rt = createRuntime(project, { interactive: true });
  try {
    const s = await rt.start({ cwd: project, interactive: true });
    await run(s, rt);
  } finally {
    rt.dispose();
  }
}

const replies = (s: Session) => s.messages.filter((m) => m.role === 'assistant');

function replyWait(s: Session) {
  const wait = replies(s).at(-1)?.wait;
  expect(wait).toBeDefined();
  return wait!;
}

describe('waiting for a model reply', () => {
  it('records the only attempt and its first events', () => withSession(async (s) => {
    await s.send('Plain.');
    const wait = replyWait(s);
    expect(wait).toMatchObject({
      tries: 1, lostMs: 0, ms: expect.any(Number), firstByteMs: expect.any(Number), firstWordMs: expect.any(Number),
    });
    expect(wait.firstByteMs).toBeLessThanOrEqual(wait.firstWordMs!);
    expect(wait.firstWordMs).toBeLessThanOrEqual(wait.ms);
    expect(Object.hasOwn(wait, 'failed')).toBe(false);
    expect(Object.hasOwn(wait, 'longestGapMs')).toBe(false);
  }));

  it('records an overload and the time lost to its retry', () => withSession(async (s) => {
    await s.send('Busy.');
    const wait = replyWait(s);
    expect(wait.tries).toBe(2);
    expect(wait.failed).toHaveLength(1);
    const failure = wait.failed![0];
    expect(failure).toMatchObject({ kind: 'overloaded', status: 503, got: 0 });
    expect(wait.lostMs).toBeGreaterThanOrEqual(1000);
    expect(wait.lostMs).toBeGreaterThanOrEqual(failure.ms);
  }), 30_000);

  it('records what arrived before a dropped connection', () => withSession(async (s) => {
    await s.send('Dropped.');
    const wait = replyWait(s);
    expect(wait.tries).toBe(2);
    expect(wait.failed).toHaveLength(1);
    const failure = wait.failed![0];
    expect(failure).toMatchObject({ kind: 'network', got: 40 });
    expect(Object.hasOwn(failure, 'status')).toBe(false);
    expect(wait.lostMs).toBeGreaterThanOrEqual(250);
  }), 30_000);

  it('counts a keep-alive as a byte before the first word', () => withSession(async (s) => {
    await s.send('Quiet.');
    const wait = replyWait(s);
    expect(wait.firstByteMs).toBeLessThan(300);
    expect(wait.firstWordMs).toBeGreaterThanOrEqual(400);
  }));

  it('records a long silence between deltas', () => withSession(async (s) => {
    await s.send('Pause.');
    const wait = replyWait(s);
    expect(wait.longestGapMs).toBeGreaterThanOrEqual(1100);
    expect(wait.longestGapMs).toBeLessThanOrEqual(wait.ms);
  }));

  it('records a kept cut and its continuation as separate replies', () => withSession(async (s) => {
    await s.send('Long.');
    const messages = replies(s);
    expect(messages).toHaveLength(2);
    const [cut, continuation] = messages;
    expect(cut.stop).toBe('cut');
    expect(cut.wait?.tries).toBe(1);
    expect(Object.hasOwn(cut.wait!, 'failed')).toBe(false);
    expect(continuation.wait).toMatchObject({ tries: 1, lostMs: 0 });
  }));

  it('keeps the wait with the same message on disk', () => withSession(async (s, rt) => {
    await s.send('Busy again.');
    const reply = replies(s).at(-1)!;
    const saved = rt.store.load(s.id)?.messages.find((m) => m.role === 'assistant' && m.id === reply.id);
    expect(saved?.wait).toEqual(reply.wait);
    expect(saved?.wait?.tries).toBe(2);
  }), 30_000);

  it('never sends wait fields in any request body', () => withSession(async (s) => {
    await s.send('Plain.');
    await s.send('Plain.');
    for (const field of ['firstWordMs', 'firstByteMs', 'lostMs', 'longestGapMs']) {
      expect(bodies.some((body) => body.includes(field)), field).toBe(false);
    }
  }));
});
