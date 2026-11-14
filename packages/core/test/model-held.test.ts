import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';
import type { ProviderCall, ProviderResult } from '../src/providers/types';

// A model picked while a turn runs: it used to be refused with "wait for the turn", and the pick was gone, so a user
// who then stopped the turn kept the old model. Now it waits and takes over as soon as the session stops.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-model-held-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project);
fs.mkdirSync(process.env.FAVILLA_HOME);
fs.writeFileSync(
  path.join(process.env.FAVILLA_HOME, 'config.json'),
  JSON.stringify({
    model: 'fake/m1',
    modelRegistry: false,
    languageServers: false,
    providers: {
      fake: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, discover: false, models: { m1: { toolProfile: 'favilla' }, m2: { toolProfile: 'favilla' } } },
    },
  }),
);

const { createRuntime } = await import('../src/runtime');
const { adapterFor } = await import('../src/providers');
const rt = createRuntime(project, { interactive: false });
const adapter = adapterFor('openai-chat');
const reply = (text: string): ProviderResult => ({ parts: [{ type: 'text', text }], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, stop: 'end' });

/** A reply that comes when `release` says, or as stopped when the call is aborted first. */
function held(call: ProviderCall, release: Deferred<ProviderResult>): Promise<ProviderResult> {
  const stopped = new Deferred<ProviderResult>();
  call.signal.addEventListener('abort', () => stopped.resolve({ ...reply(''), stop: 'aborted' }), { once: true });
  return Promise.race([stopped.promise, release.promise]);
}

const models = () => vi.mocked(adapter.stream).mock.calls.map(([call]) => call.model.id);

beforeEach(() => {
  vi.spyOn(adapter, 'stream').mockResolvedValue(reply('Done.'));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A session in the middle of its first turn, the model's reply held. */
async function working() {
  const s = await rt.start({ cwd: project });
  const release = new Deferred<ProviderResult>();
  const asked = new Deferred<void>();
  vi.mocked(adapter.stream).mockImplementationOnce((call) => {
    asked.resolve();
    return held(call, release);
  });
  const turn = s.send('Look at the lexer.');
  await asked.promise;
  return { s, release, turn };
}

describe('a model picked while a turn runs', () => {
  it('takes over when the user stops the turn', async () => {
    const { s, turn } = await working();
    expect(await s.setModel('fake/m2')).toBe('held');
    expect(s.held).toBe('fake/m2');
    expect(s.meta.model).toBe('m1');
    s.abort();
    await turn;
    await s.settled();
    expect(s.meta.model).toBe('m2');
    expect(s.held).toBeNull();
  });

  it('takes over when the turn ends by itself, and the next message goes to it', async () => {
    const { s, release, turn } = await working();
    await s.setModel('fake/m2');
    release.resolve(reply('The last token goes missing.'));
    await turn;
    await s.settled();
    expect(s.meta.model).toBe('m2');
    await s.send('Then the parser.');
    expect(models()).toEqual(['m1', 'm2']);
  });

  it('is taken back by picking the model the turn runs on', async () => {
    const { s, turn } = await working();
    await s.setModel('fake/m2');
    expect(await s.setModel('fake/m1')).toBe('same');
    expect(s.held).toBeNull();
    s.abort();
    await turn;
    await s.settled();
    expect(s.meta.model).toBe('m1');
  });

  it('is refused at once when there is no such provider', async () => {
    const { s, turn } = await working();
    await expect(s.setModel('nobody/m9')).rejects.toThrow('Unknown model');
    expect(s.held).toBeNull();
    s.abort();
    await turn;
  });

  it('switches at once in a session at rest', async () => {
    const s = await rt.start({ cwd: project });
    expect(await s.setModel('fake/m2')).toBe('switched');
    expect(s.meta.model).toBe('m2');
  });
});
