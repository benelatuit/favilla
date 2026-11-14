import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A reply that only sets or marks criteria takes a request of its own. The model is told so where it happens, twice a
// turn at most, and not when the same calls come along with a step's work.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-tracked-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');

const NOTE = 'only kept track of the work';
const bodies: { messages: unknown[]; tools?: { function: { name: string } }[] }[] = [];
type Call = { name: string; args: unknown };
// What the model answers, request by request; the names of the tools come from the request itself.
const script = (goal: string, read: string): (Call[] | string)[] => [
  [{ name: goal, args: { objective: 'Change the file', criteria: ['a.txt is read', 'a.txt is reported'] } }],
  [{ name: goal, args: { done: [1], evidence: 'read it' } }, { name: read, args: { path: 'a.txt' } }],
  [{ name: goal, args: { done: [2], evidence: 'reported' } }],
  [{ name: goal, args: { done: [2], evidence: 'reported again' } }],
  'Done.',
];
const relay = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'tracker-1' }] }));
    }
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    const names: string[] = (parsed.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
    const goal = names.find((n) => n === 'criteria' || n === 'goal') ?? 'goal';
    const read = names.find((n) => /^read$/i.test(n)) ?? 'read';
    const step = script(goal, read)[bodies.length - 1] ?? 'Done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (typeof step === 'string') {
      send({ role: 'assistant', content: step });
      send({}, 'stop');
    } else {
      send({ role: 'assistant', tool_calls: step.map((c, i) => ({ index: i, id: `call_${bodies.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
      send({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const port = (relay.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'relay/tracker-1',
      tools: 'favilla',
      languageServers: false,
      providers: { relay: { name: 'Relay', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', discover: 'openai' } },
    }),
  );
});

afterAll(async () => {
  relay.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const notes = (i: number) => JSON.stringify(bodies[i].messages).split(NOTE).length - 1;

describe('a reply that only keeps track of the work', () => {
  it('is told that it cost a request, twice a turn at most, and not when it comes with the work', async () => {
    const { createRuntime } = await import('../src/runtime');
    const rt = createRuntime(project, { interactive: true });
    try {
      const s = await rt.start({ cwd: project, interactive: true });
      await s.send('Read a.txt and report.');
      expect(bodies.length).toBe(5);
      expect(notes(0)).toBe(0);
      // Criteria set alone: said once.
      expect(notes(1)).toBe(1);
      // A mark sent with a read is how it should be: nothing more is said.
      expect(notes(2)).toBe(1);
      // A mark alone: said a second time. A third reply of the kind passes without a word.
      expect(notes(3)).toBe(2);
      expect(notes(4)).toBe(2);
      // The note follows the call's result, and the history before it is as it was sent.
      expect(JSON.stringify(bodies[4].messages).startsWith(JSON.stringify(bodies[3].messages).slice(0, -1))).toBe(true);
    } finally {
      rt.dispose();
    }
  }, 60_000);
});
