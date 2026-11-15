import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Registry, slimRegistry } from '../src/catalog/registry';

// The catalogue's lookups are kept once instead of repeated for every model (a relay serving 913 models held each
// session start 0.6 s, 2026-11-07): what they answer must be what the plain walks through the lists answered.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-lookups-'));
process.env.FAVILLA_HOME = home;
const { Catalog } = await import('../src/catalog/catalog');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const discovered = (provider: string, models: unknown[]) => {
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', `models-${provider}.json`), JSON.stringify({ fetched: Date.now(), models }));
};

describe('a model nobody describes', () => {
  it('gets a hosted model\'s window on an endpoint or a relay, and the small one on a local engine', () => {
    const relay = { api: 'openai-chat' as const, baseUrl: 'https://relay.example.net/v1', auth: 'none' as const, discover: 'openai' as const };
    const engine = { api: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:9/v1', auth: 'none' as const, local: true, discover: 'ollama' as const };
    const catalog = new Catalog({ providers: { relay: { ...relay, models: { 'set-by-hand': { contextWindow: 65536 } } }, plain: { ...relay, discover: false }, engine } });
    expect(catalog.resolve('relay/brand-new-7')).toMatchObject({ family: 'other', contextWindow: 128_000, nativeWindow: 128_000, windowAssumed: true });
    expect(catalog.resolve('plain/brand-new-7')).toMatchObject({ contextWindow: 128_000 });
    expect(catalog.resolve('engine/brand-new-7')).toMatchObject({ contextWindow: 32768 });
    // What is said about a model still decides: the settings, and a name whose family is known.
    // A window set by hand does not make the provider's figure known: the settings page still says it is assumed.
    expect(catalog.resolve('relay/set-by-hand')).toMatchObject({ contextWindow: 65536, nativeWindow: 128_000, windowAssumed: true });
    expect(catalog.resolve('relay/qwen-next')).toMatchObject({ family: 'qwen', contextWindow: 131072 });
    expect(catalog.resolve('relay/qwen-next').windowAssumed).toBeUndefined();
  });
});

describe('a window learned from a refusal', () => {
  it('shares what one folder learns with the parent and views that already resolved the model', () => {
    const config = {
      modelRegistry: false,
      providers: { relay: { api: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:9/v1', auth: 'none' as const } },
    };
    const catalog = new Catalog(config);
    const first = catalog.withConfig({ ...config });
    const second = catalog.withConfig({ ...config });
    const ref = 'relay/shared-window';
    for (const c of [catalog, first, second]) expect(c.resolve(ref).contextWindow).toBe(128_000);

    first.learnWindow(ref, 30_000);
    first.learnEfforts(ref, ['low', 'high']);
    for (const c of [catalog, second, first.withConfig({ ...config })]) {
      expect(c.resolve(ref)).toMatchObject({ contextWindow: 30_000, efforts: ['low', 'high'] });
    }
    second.learnWindow(ref, 28_000);
    expect(first.resolve(ref).contextWindow).toBe(28_000);
  });

  it('stands in for the guess in later sessions, only for a model nobody describes, and only ever gets smaller', () => {
    const relay = { api: 'openai-chat' as const, baseUrl: 'https://relay.example.net/v1', auth: 'none' as const, discover: 'openai' as const };
    const config = { providers: { relay: { ...relay, models: { 'set-by-hand': { contextWindow: 65536 } } } } };
    const first = new Catalog(config);
    expect(first.resolve('relay/small-one').contextWindow).toBe(128_000);
    first.learnWindow('relay/small-one', 30_100);
    expect(first.resolve('relay/small-one')).toMatchObject({ contextWindow: 30_100, nativeWindow: 30_100, windowAssumed: true });
    // A later, larger figure does not undo it (the refusal came later in a request), a smaller one does.
    first.learnWindow('relay/small-one', 90_000);
    expect(first.resolve('relay/small-one').contextWindow).toBe(30_100);
    first.learnWindow('relay/small-one', 28_000);
    // Another process, another day: read from the cache.
    const later = new Catalog(config);
    expect(later.resolve('relay/small-one').contextWindow).toBe(28_000);
    expect(later.resolve('relay/another').contextWindow).toBe(128_000);
    // A window set by hand, and a model whose family is known, are not touched by what was learned.
    later.learnWindow('relay/set-by-hand', 20_000);
    later.learnWindow('relay/qwen-next', 20_000);
    expect(new Catalog(config).resolve('relay/set-by-hand').contextWindow).toBe(65536);
    expect(new Catalog(config).resolve('relay/qwen-next').contextWindow).toBe(131072);
    // Nothing a window cannot be.
    later.learnWindow('relay/tiny', 4000);
    expect(new Catalog(config).resolve('relay/tiny').contextWindow).toBe(128_000);
  });
});

describe('the catalogue looked up once', () => {
  it('matches a provider to the first catalogue entry at its address, and again after its address changes', () => {
    const reg = new Registry(
      slimRegistry(
        {
          first: { api: 'https://relay.example.com/v1', models: { 'm-1': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], limit: { context: 100000 } } } },
          second: { api: 'https://relay.example.com', models: { 'm-1': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['max'] }], limit: { context: 200000 } } } },
          elsewhere: { api: 'https://other.example.com/v1', models: { 'm-1': { reasoning: false, limit: { context: 300000 } } } },
        },
        1,
      ),
    );
    const p = { id: 'mine', baseUrl: 'https://relay.example.com/v1/' };
    expect(reg.lookup(p, 'm-1')).toEqual({ efforts: ['low', 'high'], context: 100000, vision: false });
    expect(reg.lookup(p, 'm-1')).toEqual(reg.lookup(p, 'M-1'));
    expect(reg.lookup({ ...p, baseUrl: 'https://other.example.com/v1' }, 'm-1')).toEqual({ efforts: [], context: 300000, vision: false });
  });

  it('lists models as walking the list did: aliases by server id, the first of a repeated id, hidden ones left out', () => {
    discovered('loc', [
      { id: 'short', apiId: 'C:/models/short.gguf', contextWindow: 32768 },
      { id: 'dup', name: 'First' },
      { id: 'dup', name: 'Second' },
      { id: 'gone', hidden: true },
    ]);
    discovered('hid', [{ id: 'gone', hidden: true }]);
    const local = { api: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:9/v1', auth: 'none' as const, local: true, discover: 'llamacpp' as const };
    const catalog = new Catalog({ providers: { loc: local, hid: local } });
    expect(catalog.models('loc').map((m) => m.ref)).toEqual(['loc/short', 'loc/dup']);
    expect(catalog.models('loc')[1].name).toBe('First');
    expect(catalog.resolve('loc/C:/models/short.gguf')).toMatchObject({ ref: 'loc/short', contextWindow: 32768 });
    expect(catalog.isConfigured(catalog.provider('loc'))).toBe(true);
    expect(catalog.isConfigured(catalog.provider('hid'))).toBe(false);
    expect(
      catalog
        .usableModels()
        .filter((m) => m.provider === 'loc' || m.provider === 'hid')
        .map((m) => m.ref),
    ).toEqual(['loc/short', 'loc/dup']);
    // One model named by another's server id stands for that one, as before.
    discovered('loc', [
      { id: 'short', apiId: 'C:/models/short.gguf' },
      { id: 'twin', apiId: 'short' },
    ]);
    expect(new Catalog({ providers: { loc: local } }).models('loc').map((m) => m.ref)).toEqual(['loc/twin', 'loc/twin']);
  });

  it('reads the key file once for a whole list of models', () => {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ keys: { relay: 'k1' } }));
    discovered('relay', Array.from({ length: 200 }, (_, i) => ({ id: `model-${i}` })));
    const catalog = new Catalog({ providers: { relay: { api: 'openai-chat', baseUrl: 'https://relay.example.com/v1' } } });
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      expect(catalog.usableModels().filter((m) => m.provider === 'relay')).toHaveLength(200);
      const reads = read.mock.calls.filter(([f]) => path.resolve(String(f)) === path.join(home, 'auth.json')).length;
      expect(reads).toBeLessThan(catalog.providers().length);
    } finally {
      read.mockRestore();
    }
    expect(catalog.provider('relay').keys).toEqual(['k1']);
    expect(() => catalog.provider('nobody')).toThrow('Unknown provider "nobody"');
  });

  it('marks DeepSeek v4.1 and flash variants as vision-capable without models.dev', () => {
    const catalog = new Catalog({
      modelRegistry: false,
      providers: { relay: { api: 'openai-chat', baseUrl: 'https://relay.example.com/v1', auth: 'none' } },
    });
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4.1', 'deepseek-v4-1-flash', 'deepseek-v4p1-flash', 'deepseek-flash']) {
      expect(catalog.resolve(`relay/${id}`)).toMatchObject({ family: 'deepseek', vision: true, contextWindow: 1_000_000 });
    }
    for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2', 'deepseek-v4-pro']) {
      expect(catalog.resolve(`relay/${id}`).vision).toBe(false);
    }
  });
});
