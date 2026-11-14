import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FavillaConfig } from '../src/config/config';

// Real sessions against a scripted local provider: finishing an answer must not silently buy another request.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-completion-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project);
let replies: string[] = [];
const bodies: { messages: { content: unknown }[] }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    bodies.push(JSON.parse(body));
    const text = replies.shift() ?? 'VERDICT: COMPLETE';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let base: string;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function answer(prompt: string, script: string[], config: Partial<FavillaConfig> = {}, openGoal = false) {
  bodies.length = 0;
  replies = [...script];
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: 'fake/m1', tools: 'favilla', modelRegistry: false, ...config,
    providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' } } } },
  }));
  const rt = createRuntime(project, { interactive: false });
  try {
    const session = await rt.start({ cwd: project, model: 'fake/m1' });
    if (openGoal) session.setUserGoal('Finish the requested change', ['Run the checks']);
    await session.send(prompt);
    return session.messages;
  } finally {
    rt.dispose();
  }
}

const several = 'Explain the inputs.\nShow the outputs.\nExplain the error cases.';

describe('finishing a turn', () => {
  it('answers several questions without an automatic second model request', async () => {
    const text = 'Inputs are strings. Outputs are numbers. Invalid strings return an error.';
    const messages = await answer(several, [text]);
    expect(bodies).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages.some((m) => m.origin === 'harness')).toBe(false);
  });

  it('does not rewrite an otherwise finished answer just for its wording', async () => {
    const messages = await answer('解释这个设计的取舍。', ['不能保证每个场景都一样，当前测试覆盖了三个边界。']);
    expect(bodies).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('lets the model finish with the user there, open criteria or not', async () => {
    await answer('Finish the change.', ['Finished.'], {}, true);
    expect(bodies).toHaveLength(1);
  });
});
