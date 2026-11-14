import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sub-agents on the model and effort the main agent asks for, against a scripted server with two models.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-subagent-models-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });

const asked: { model: string; system: string; tools: string[] }[] = [];
let mainSteps = 0;
let plan: { name: string; args: unknown }[] = [];
const reply = (res: http.ServerResponse, r: { text?: string; call?: { name: string; args: unknown } }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (r.call) {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
  res.end('data: [DONE]\n\n');
};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    const json = JSON.parse(body);
    const system = String(json.messages?.[0]?.content ?? '');
    asked.push({ model: json.model, system, tools: (json.tools ?? []).map((t: { function: { name: string } }) => t.function.name) });
    if (system.includes('research sub-agent')) return reply(res, { text: 'Found it in src/config.ts.' });
    const call = plan[mainSteps++];
    return reply(res, call ? { call } : { text: 'Done.' });
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
    JSON.stringify({
      model: 'fake/m1',
      tools: 'favilla',
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt' }, m2: { contextWindow: 64000, family: 'gpt', name: 'Model Two' } } } },
    }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(() => {
  fake.close();
});

describe('sub-agent models', () => {
  it('runs a sub-agent on the model and effort asked for, with no list of models in every request', async () => {
    mainSteps = 0;
    asked.length = 0;
    plan = [{ name: 'agent', args: { description: 'Find the config', prompt: 'Where is the config read?', type: 'explore', model: 'fake/m2', effort: 'low' } }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    // The models come back when a name fits none (below), not with every request.
    const spec = s.toolSpecs.find((t) => t.name === 'agent')!;
    expect(JSON.stringify(spec.parameters)).not.toContain('fake/m2');
    await s.send('Find where the config is read with a sub-agent on the second model.');
    const child = asked.find((a) => a.system.includes('research sub-agent'));
    expect(child?.model).toBe('m2');
    const result = s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result') as { display?: { kind: string; model?: string; effort?: string; durationMs?: number } };
    expect(result.display).toMatchObject({ kind: 'task', model: 'fake/m2', effort: 'low' });
    expect(result.display?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('finds a model by its name or under a wrong provider name, and says which models exist when none fits', async () => {
    mainSteps = 0;
    asked.length = 0;
    plan = [
      { name: 'agent', args: { description: 'Look around', prompt: 'List the files.', model: 'Model Two' } },
      { name: 'agent', args: { description: 'Look again', prompt: 'List the files.', model: 'nope/unknown-model' } },
      { name: 'agent', args: { description: 'Look once more', prompt: 'List the files.', model: 'new-provider/m2' } },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Use the sub-agents.');
    const results = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result') as { content: string; isError?: boolean; display?: { model?: string } }[];
    expect(results[0].display?.model).toBe('fake/m2');
    expect(results[1].isError).toBe(true);
    // The machine's own signed-in providers may come first in the list.
    // Every provider is named, each with its models.
    expect(results[1].content).toMatch(/no model "nope\/unknown-model" is available\. Sub-agents can run on: .*fake\/m1, fake\/m2/);
    // The right model under a provider name that does not exist.
    expect(results[2].display?.model).toBe('fake/m2');
  });
});
