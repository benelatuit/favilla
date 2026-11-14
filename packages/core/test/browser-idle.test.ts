import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBrowser, type BrowserSession } from '../src/tools/browser';
import type { FavillaConfig } from '../src/config/config';

// The agent's headless browser goes away when it has been unused between turns, and comes back when it is needed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-idle-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
process.env.FAVILLA_BROWSER_IDLE_MS = '500';
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const exe = findBrowser();
let plan: { name: string; args: unknown }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const call = plan.shift();
    if (call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
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
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', languageServers: false, providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const open = (s: unknown) => (s as { browserSession: unknown }).browserSession;

describe.skipIf(!exe)('the agent browser between turns', () => {
  it.each([{ interactive: false, confine: false }, { interactive: false, confine: true }, { interactive: true, confine: true }])('ignores window and attachment settings before any tool starts: %j', async ({ interactive, confine }) => {
    const s = await rt.start({ cwd: project, interactive });
    const access = s as unknown as { config: FavillaConfig; browser(): BrowserSession };
    const previous = { browser: access.config.browser, confine: access.config.confine };
    access.config.browser = { visible: true, keepLogins: true, use: 'chrome' };
    access.config.confine = confine;
    try {
      // Construct only: neither a real browser nor an attachment is started by this regression.
      const b = access.browser();
      expect(b.visible).toBe(false);
      expect((b as unknown as { opts: unknown }).opts).toMatchObject({ profileDir: undefined, attachDir: undefined });
    } finally {
      access.config.browser = previous.browser;
      access.config.confine = previous.confine;
    }
  });

  it('closes after a while unused, and starts again for the next paint', async () => {
    const s = await rt.start({ cwd: project });
    plan = [{ name: 'paint', args: { canvas: 'a', doc: 'size: [64, 64]\nlayers:\n  - items: [{ fill: flat, rect: [8, 8, 40, 40], color: "#333" }]\n' } }];
    await s.send('Paint it.');
    expect(open(s)).toBeTruthy();
    for (let i = 0; i < 60 && open(s); i++) await new Promise((r) => setTimeout(r, 100));
    expect(open(s)).toBeNull();
    plan = [{ name: 'paint', args: { canvas: 'a', layer: 'more', items: '- { stroke: pen, color: "#000", size: 2, points: [[0, 0], [60, 60]] }\n' } }];
    await s.send('Add a line.');
    expect(s.messages.some((m) => m.parts.some((p) => p.type === 'tool_result' && !p.isError && p.content.includes('more 1')))).toBe(true);
  }, 60_000);
});
