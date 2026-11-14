import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';
import { createRuntime } from '../src/runtime';
import { startServer } from '../src/server/server';

const facts = vi.hoisted(() => vi.fn());
vi.mock('../src/prompt/env', async (original) => ({ ...await original<typeof import('../src/prompt/env')>(), projectFacts: facts }));

async function fixture() {
  facts.mockReset();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-deferred-facts-'));
  const project = path.join(home, 'project');
  const note = 'Working directory: ' + project + '\nGit: fixture\nTop-level entries: file.txt';
  const bodies: { messages: { content: string }[] }[] = [];
  const provider = http.createServer((req, res) => {
    if (req.url === '/v1/models') return void res.end('{"data":[{"id":"m"}]}');
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => text += chunk);
    req.on('end', () => {
      bodies.push(JSON.parse(text));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  vi.stubEnv('FAVILLA_HOME', home);
  vi.stubEnv('FAVILLA_PREFETCH', '0');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(home, 'cache'));
  fs.writeFileSync(path.join(home, 'cache', 'toolchains2.json'), JSON.stringify({ at: Date.now(), versions: {} }));
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const { port } = provider.address() as { port: number };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: 'fixture/m', tools: 'favilla', skills: false, languageServers: false, modelRegistry: false,
    providers: { fixture: { api: 'openai-chat', auth: 'none', local: true, baseUrl: `http://127.0.0.1:${port}/v1`, models: { m: { contextWindow: 32000 } } } },
  }));
  const rt = createRuntime(project);
  const clean = async () => {
    await rt.shutdown();
    await new Promise<void>((resolve) => { provider.close(() => resolve()); provider.closeAllConnections(); });
    vi.unstubAllEnvs();
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { rt, note, bodies, clean, project };
}

it('opens the window before Git answers, then joins its facts on send or shutdown', async () => {
  const { rt, note, bodies, clean, project } = await fixture();
  const ready = new Deferred<string>(), idleReady = new Deferred<string>();
  facts.mockReturnValueOnce(ready.promise).mockReturnValueOnce(idleReady.promise);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const window = server = await startServer({ runtime: rt });
    const open = async () => {
      const response = await fetch(window.url + 'api/sessions', {
        method: 'POST', headers: { 'Authorization': `Bearer ${window.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: project }), signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      return await response.json() as { meta: { id: string }; status: string };
    };
    const view = await open();
    expect(view.status).toBe('idle');
    expect(facts).toHaveBeenCalledTimes(1);

    const turn = rt.live.get(view.meta.id)!.send('Fixture request.');
    await delay(30);
    expect(bodies).toEqual([]);
    ready.resolve(note);
    await turn;
    expect(bodies).toHaveLength(1);
    const user = bodies[0].messages.at(-1)?.content;
    expect(user).toContain(`<harness-note>${note}</harness-note>\n\n`);
    expect(user?.endsWith('Fixture request.')).toBe(true);
    expect(facts).toHaveBeenCalledTimes(1);

    expect((await open()).status).toBe('idle');
    expect(facts).toHaveBeenCalledTimes(2);
    let closed = false;
    closing = window.close().then(() => { closed = true; });
    await delay(30);
    expect(closed).toBe(false);
    idleReady.resolve(note);
    await closing;
  } finally {
    ready.resolve(note);
    idleReady.resolve(note);
    await (closing ?? server?.close());
    await clean();
  }
});

it('does not recreate the history of a session deleted while its first send waits for facts', async () => {
  const { rt, note, bodies, clean, project } = await fixture();
  const ready = new Deferred<string>();
  facts.mockReturnValueOnce(ready.promise);
  let turn: Promise<void> | undefined;
  try {
    const s = await rt.start({ cwd: project, deferProjectFacts: true });
    const hot = rt.store.dataDir(s.meta) + '.jsonl';
    turn = s.send('First request.');
    void s.send('Queued request.');
    expect(s.messages).toEqual([]);
    expect(bodies).toEqual([]);
    rt.close(s.id);
    rt.store.delete(s.id);
    expect(fs.existsSync(hot)).toBe(false);
    ready.resolve(note);
    await turn;
    expect(fs.existsSync(hot)).toBe(false);
    expect(rt.store.metaOf(s.id)).toBeNull();
    expect(bodies).toEqual([]);
  } finally {
    ready.resolve(note);
    await turn?.catch(() => {});
    await clean();
  }
});

