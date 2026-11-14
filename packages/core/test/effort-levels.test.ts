import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry, slimRegistry } from '../src/catalog/registry';
import { effortRefusal } from '../src/providers/errors';
import { buildChatBody } from '../src/providers/openai-chat';
import type { ModelInfo } from '../src/catalog/catalog';
import type { ProviderCall } from '../src/providers/types';

// A few entries in models.dev's shape: the vendor, a relay that serves the same model differently, an entry with
// only a budget, a model that does not think.
const catalogue = {
  zhipuai: {
    api: 'https://open.bigmodel.cn/api/paas/v4',
    models: {
      'glm-9': { reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }], limit: { context: 1000000, output: 131072 }, canonical_model_id: 'zhipuai/glm-9', modalities: { input: ['text'] } },
      'glm-9v': { reasoning: true, reasoning_options: [{ type: 'toggle' }], limit: { context: 64000 }, modalities: { input: ['text', 'image', 'video'] } },
    },
  },
  relay: {
    api: 'https://relay.example.com/v1',
    models: {
      'glm-9': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }], limit: { context: 200000 }, canonical_model_id: 'zhipuai/glm-9' },
      'kimi-9': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }], limit: { context: 262144 }, modalities: { input: ['text', 'image'] } },
      'qwen-9': { reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 38912 }], limit: { context: 131072 } },
      'old-9': { reasoning: false, limit: { context: 16385 } },
      'always-9': { reasoning: true, reasoning_options: [], limit: { context: 204800 } },
    },
  },
  other: {
    api: 'https://other.example.com/v1',
    models: { 'kimi-9': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } },
  },
  openai: { models: { 'gpt-9': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }], limit: { context: 1050000 } } } },
  broken: 'not a provider',
};

describe('models.dev, slimmed and looked up', () => {
  const reg = new Registry(slimRegistry(catalogue, 1));

  it('keeps the levels on Favilla\'s scale, with "none" and a toggle read as off', () => {
    const slim = slimRegistry(catalogue, 1);
    expect(slim.providers.zhipuai.models['glm-9']).toMatchObject({ e: ['low', 'high', 'max'], t: true, c: 1000000, k: 'zhipuai/glm-9' });
    expect(slim.providers.relay.models['kimi-9'].e).toEqual(['off', 'low', 'high', 'max']);
    expect(slim.providers.broken).toBeUndefined();
  });

  it('takes the provider\'s own entry when its address is listed', () => {
    expect(reg.lookup({ id: 'mine', baseUrl: 'https://relay.example.com/v1/' }, 'glm-9')).toEqual({ efforts: ['low', 'medium', 'high'], context: 200000, vision: false });
    expect(reg.lookup({ id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, 'glm-9')).toEqual({ efforts: ['low', 'high', 'max'], toggle: true, context: 1000000, vision: false });
  });

  it('for an unlisted relay, the vendor\'s entry, else what most entries say', () => {
    expect(reg.lookup({ id: 'gateway', baseUrl: 'https://gateway.example.org/v1' }, 'glm-9')).toMatchObject({ efforts: ['low', 'high', 'max'], toggle: true });
    expect(reg.lookup({ id: 'gateway', baseUrl: 'https://gateway.example.org/v1' }, 'GLM-9')?.context).toBe(1000000);
    // Two entries, no vendor named: the first of the most common.
    expect(reg.lookup({ id: 'gateway', baseUrl: 'https://gateway.example.org/v1' }, 'kimi-9')?.efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(reg.lookup({ id: 'openrouter-ish', baseUrl: 'https://x.example/v1' }, 'zhipuai/glm-9')?.efforts).toEqual(['low', 'high', 'max']);
    expect(reg.lookup({ id: 'gateway', baseUrl: 'https://gateway.example.org/v1' }, 'nothing-like-it')).toBeUndefined();
  });

  it('says which models read pictures, for a relay that lists none', () => {
    const gateway = { id: 'gateway', baseUrl: 'https://gateway.example.org/v1' };
    expect(reg.lookup(gateway, 'glm-9v')?.vision).toBe(true);
    // The vendor's entry takes text only.
    expect(reg.lookup(gateway, 'glm-9')?.vision).toBe(false);
    // One provider serves it with pictures: the model reads them.
    expect(reg.lookup(gateway, 'kimi-9')?.vision).toBe(true);
    expect(reg.lookup({ id: 'relay', baseUrl: 'https://relay.example.com/v1' }, 'qwen-9')?.vision).toBe(false);
  });

  it('a first-party API listed without an address is found by name', () => {
    expect(reg.lookup({ id: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'gpt-9')).toEqual({ efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], context: 1050000, vision: false });
  });

  it('says nothing to set for models that do not think or cannot be steered, and leaves budgets to the family', () => {
    const at = { id: 'r', baseUrl: 'https://relay.example.com/v1' };
    expect(reg.lookup(at, 'old-9')?.efforts).toEqual([]);
    expect(reg.lookup(at, 'always-9')?.efforts).toEqual([]);
    expect(reg.lookup(at, 'qwen-9')?.efforts).toBeUndefined();
    expect(reg.lookup({ id: 'z', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, 'glm-9v')).toMatchObject({ efforts: ['high'], toggle: true });
  });
});

describe('a server\'s refusal of a thinking level', () => {
  it('reads the levels it names, whatever the server is written in', () => {
    expect(effortRefusal("Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'low', 'medium', and 'high'.", ['max'])).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high'] });
    expect(effortRefusal("1 validation error for ChatRequest\nreasoning_effort\n  Input should be 'low', 'high' or 'max' [type=literal_error, input_value='xhigh', input_type=str]", ['xhigh'])).toEqual({ kind: 'levels', levels: ['low', 'high', 'max'] });
    expect(effortRefusal("Invalid enum value. Expected 'none' | 'low' | 'high', received 'medium' at reasoning_effort", ['medium'])).toEqual({ kind: 'levels', levels: ['off', 'low', 'high'] });
    expect(effortRefusal("reasoning.effort 'max' is not one of ['low', 'medium', 'high']", ['max'])).toEqual({ kind: 'levels', levels: ['low', 'medium', 'high'] });
  });

  it('a refused level with no list, and a refused setting', () => {
    expect(effortRefusal("output_config.effort: 'max' is not supported for this model", ['max'])).toEqual({ kind: 'level' });
    expect(effortRefusal('Unrecognized request argument supplied: reasoning_effort', ['high'])).toEqual({ kind: 'param' });
    expect(effortRefusal('{"detail":[{"type":"extra_forbidden","loc":["body","reasoning_effort"],"msg":"Extra inputs are not permitted"}]}', ['high'])).toEqual({ kind: 'param' });
  });

  it('leaves other errors alone', () => {
    expect(effortRefusal('max_tokens must be at most 8192', ['high'])).toBeUndefined();
    expect(effortRefusal("Invalid value for 'temperature': expected a number between 0 and 2", ['high'])).toBeUndefined();
  });
});

describe('the level on the wire', () => {
  const call = (thinkingParam: string | undefined, efforts: string[], effort: string) =>
    ({
      model: { id: 'm', vision: false, quirks: thinkingParam ? { thinkingParam } : {}, efforts },
      provider: { local: false },
      system: 'S',
      messages: [{ id: 'u', role: 'user', origin: 'user', time: 0, parts: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      effort,
      maxOutputTokens: 1000,
    }) as unknown as ProviderCall;

  it('sends the model\'s own levels, max included, beside the on-off switch', () => {
    expect(buildChatBody(call('glm', ['off', 'low', 'high', 'max'], 'max'))).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    const off = buildChatBody(call('glm', ['off', 'low', 'high', 'max'], 'off'));
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.reasoning_effort).toBeUndefined();
    // A switch alone, as before: no level.
    expect(buildChatBody(call('deepseek', ['off', 'high'], 'high')).reasoning_effort).toBeUndefined();
  });

  it('OpenAI-style servers get the level unclipped, "none" for off, and the nearest level below one it lacks', () => {
    expect(buildChatBody(call('openai', ['low', 'medium', 'high', 'xhigh', 'max'], 'xhigh')).reasoning_effort).toBe('xhigh');
    expect(buildChatBody(call('openai', ['off', 'low', 'high'], 'off')).reasoning_effort).toBe('none');
    expect(buildChatBody(call('openai', ['low', 'high'], 'medium')).reasoning_effort).toBe('low');
    expect(buildChatBody(call(undefined, ['low', 'high', 'max'], 'max')).reasoning_effort).toBe('max');
    expect(buildChatBody(call('moonshot', ['off', 'high'], 'high')).reasoning_effort).toBeUndefined();
    expect(buildChatBody(call('openrouter', ['low', 'medium', 'high', 'xhigh'], 'xhigh')).reasoning).toEqual({ effort: 'xhigh' });
  });
});

// The whole path: a relay the catalogue does not list, a model it does, and a server that takes fewer levels than
// the catalogue says.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-efforts-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const sent: (string | undefined)[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-9' }] }));
      return;
    }
    const json = JSON.parse(body);
    sent.push(json.reasoning_effort);
    if (json.reasoning_effort === 'max') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unsupported value: 'max' is not supported with this model. Supported values are: 'low' and 'high'.", type: 'invalid_request_error', param: 'reasoning_effort' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'models-dev.json'), JSON.stringify(slimRegistry(catalogue)));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'gateway/glm-9', tools: 'favilla', providers: { gateway: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, discover: 'openai' } } }));
  rt = createRuntime(project, { interactive: false });
  await rt.catalog.discover('gateway', true);
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('levels for a model behind a relay', () => {
  it('come from the vendor\'s entry, with its window', () => {
    const m: ModelInfo = rt.catalog.resolve('gateway/glm-9');
    expect(m.efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(m.contextWindow).toBe(1000000);
  });

  it('an on-off switch is offered only where Favilla can send it, and a single level is no choice', () => {
    // kimi-9 on this relay takes "none" among its levels; old-9 does not think; always-9 cannot be steered.
    expect(rt.catalog.resolve('gateway/kimi-9').efforts).toEqual(['off', 'low', 'high', 'max']);
    expect(rt.catalog.resolve('gateway/old-9').efforts).toEqual([]);
    expect(rt.catalog.resolve('gateway/always-9').efforts).toEqual([]);
  });

  it('a level the server refuses is dropped for good, and the turn goes on at the nearest one', async () => {
    const s = await rt.start({ cwd: project, model: 'gateway/glm-9', effort: 'max' });
    const events: { type: string; key?: string; model?: { efforts: string[] } }[] = [];
    s.on((e) => events.push(e as never));
    await s.send('Say done.');
    expect(sent).toEqual(['max', 'high']);
    expect(events.find((e) => e.type === 'notice')?.key).toBe('This model does not take effort {n}; switched to the nearest level it takes.');
    expect(events.find((e) => e.type === 'model')?.model?.efforts).toEqual(['off', 'low', 'high']);
    expect(s.meta.effort).toBe('high');
    // A later session starts on what the server said.
    expect(rt.catalog.resolve('gateway/glm-9').efforts).toEqual(['off', 'low', 'high']);
    sent.length = 0;
    const next = await rt.start({ cwd: project, model: 'gateway/glm-9', effort: 'max' });
    await next.send('Again.');
    expect(sent).toEqual(['high']);
  });
});
