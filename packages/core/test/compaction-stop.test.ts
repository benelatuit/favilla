import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Deferred } from '../src/util/async';
import type { AgentEvent } from '../src/types';
import type { ProviderCall, ProviderResult } from '../src/providers/types';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-compact-stop-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
process.env.FAVILLA_STALL_MS = '40';
process.env.FAVILLA_WORDLESS_MS = '160';
const project = path.join(home, 'project');
fs.mkdirSync(project);
fs.mkdirSync(process.env.FAVILLA_HOME);
fs.writeFileSync(path.join(process.env.FAVILLA_HOME, 'config.json'), JSON.stringify({
  model: 'fake/m1',
  modelRegistry: false,
  languageServers: false,
  providers: {
    fake: { api: 'openai-chat', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none', local: true, discover: false,
      models: { m1: { toolProfile: 'favilla' }, m2: { toolProfile: 'codex' } } },
  },
}));

const { createRuntime } = await import('../src/runtime');
const { adapterFor } = await import('../src/providers');
const rt = createRuntime(project, { interactive: false });
const adapter = adapterFor('openai-chat');
const reply = (text: string, stop: ProviderResult['stop'] = 'end'): ProviderResult => ({
  parts: [{ type: 'text', text }],
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  stop,
});
const summary = reply('<summary>Work so far: the lexer drops the last token and still needs a test.</summary>');

beforeEach(() => {
  vi.spyOn(adapter, 'stream').mockResolvedValue(reply('The last token goes missing.'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  rt.dispose();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function withHistory() {
  const s = await rt.start({ cwd: project });
  await s.send('Look at the lexer.');
  const phases: string[] = [];
  s.on((e: AgentEvent) => {
    if (e.type === 'compaction') phases.push(e.phase);
  });
  return { s, phases, before: structuredClone(s.messages), start: s.activeStart };
}

// Some adapters answer an abort with a result instead of rejecting. Its partial text must never go into history.
function holdSummary(call: ProviderCall, release: Deferred<ProviderResult>): Promise<ProviderResult> {
  const cancelled = new Deferred<ProviderResult>();
  const abort = () => cancelled.resolve({ ...summary, stop: 'aborted' });
  if (call.signal.aborted) abort();
  call.signal.addEventListener('abort', abort, { once: true });
  return Promise.race([cancelled.promise, release.promise]).finally(() => call.signal.removeEventListener('abort', abort));
}

describe('stopping compaction', () => {
  it('aborts an idle manual compaction without changing the history', async () => {
    const { s, phases, before, start } = await withHistory();
    const release = new Deferred<ProviderResult>();
    const held = vi.mocked(adapter.stream).mockImplementationOnce((call) => holdSummary(call, release));
    const run = s.compact();
    try {
      expect(s.status).toBe('compacting');
      s.abort();
      expect(held.mock.calls.at(-1)?.[0].signal.aborted).toBe(true);
      expect(await run).toBe(false);
      expect(s.status).toBe('idle');
      expect(s.messages).toEqual(before);
      expect(s.activeStart).toBe(start);
      expect(phases).toEqual(['start', 'failed']);
    } finally {
      release.resolve(summary);
      await run.catch(() => {});
    }
  });

  it.each([{ keepAlives: false, limit: 40 }, { keepAlives: true, limit: 160 }])(
    'retries a silent summary attempt with keep-alives $keepAlives',
    async ({ keepAlives, limit }) => {
      const { s, phases } = await withHistory();
      const release = new Deferred<ProviderResult>();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const stream = vi.mocked(adapter.stream).mockClear()
        .mockImplementationOnce((call, emit) => {
          const timer = keepAlives ? setInterval(() => emit({ type: 'alive' }), 10) : undefined;
          return holdSummary(call, release).finally(() => clearInterval(timer));
        })
        .mockResolvedValueOnce(summary);
      const run = s.compact();
      try {
        expect(stream).toHaveBeenCalledTimes(1);
        const { signal } = stream.mock.calls[0][0];
        await vi.advanceTimersByTimeAsync(limit - 1);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(2000);
        expect(await run).toBe(true);
        expect(stream).toHaveBeenCalledTimes(2);
        expect(phases).toEqual(['start', 'end']);
      } finally {
        release.resolve(summary);
        await run.catch(() => {});
      }
    },
  );

  it('refuses a switch across tool families if its compaction was stopped', async () => {
    const { s, phases, before, start } = await withHistory();
    const release = new Deferred<ProviderResult>();
    const held = vi.mocked(adapter.stream).mockImplementationOnce((call) => holdSummary(call, release));
    const run = s.setModel('fake/m2');
    // Finish the fake attempt in the old implementation too, so a regression fails without hanging.
    try {
      expect(s.status).toBe('compacting');
      s.abort();
      const cancelled = held.mock.calls.at(-1)?.[0].signal.aborted;
      release.resolve(summary);
      await expect(run).rejects.toThrow('Cannot switch models because compaction did not finish.');
      expect(cancelled).toBe(true);
      expect(s.modelInfo.ref).toBe('fake/m1');
      expect(s.status).toBe('idle');
      expect(s.messages).toEqual(before);
      expect(s.activeStart).toBe(start);
      expect(phases).toEqual(['start', 'failed']);
    } finally {
      release.resolve(summary);
      await run.catch(() => {});
    }
  });

  it('refuses a failed compaction and still switches when there is nothing to compact', async () => {
    const { s, phases, before } = await withHistory();
    vi.mocked(adapter.stream).mockResolvedValue(reply(''));
    await expect(s.setModel('fake/m2')).rejects.toThrow('Cannot switch models because compaction did not finish.');
    expect(s.modelInfo.ref).toBe('fake/m1');
    expect(s.messages).toEqual(before);
    expect(phases).toEqual(['start', 'failed']);

    const empty = await rt.start({ cwd: project });
    vi.mocked(adapter.stream).mockClear();
    await empty.setModel('fake/m2');
    expect(empty.modelInfo.ref).toBe('fake/m2');
    expect(adapter.stream).not.toHaveBeenCalled();
  });
});
