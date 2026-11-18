import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentEvent, Runtime, SessionUsage } from '@favilla/core';
import { runHeadless } from '../src/headless';

it('counts cumulative input and output on resume, without counting cache hits twice', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-usage-'));
  const summaryFile = path.join(folder, 'summary.json');
  let listener: (e: AgentEvent) => void;
  const abort = vi.fn();
  const initial = { totalInput: 80, cacheRead: 60, totalOutput: 10, requests: 1 } as SessionUsage;
  const session = {
    id: 'resume', meta: { cwd: folder, provider: 'openai', model: 'test', effort: 'high' }, modelInfo: { vision: true }, messages: [], usage: initial,
    abort, on(fn: typeof listener) { listener = fn; return () => {}; }, async settled() {}, async send() {
      this.usage = { ...initial, totalOutput: 20 };
      listener({ type: 'usage', sessionId: this.id, usage: this.usage });
      expect(abort).not.toHaveBeenCalled();
      this.usage = { ...this.usage, totalInput: 81, requests: 2 };
      listener({ type: 'usage', sessionId: this.id, usage: this.usage });
      expect(abort).toHaveBeenCalledOnce();
    },
  };
  try {
    await runHeadless({ get: async () => session } as unknown as Runtime, { cwd: folder, resume: session.id, prompt: 'go', output: 'stream-json', tokenLimit: 100, summaryFile });
    expect(JSON.parse(fs.readFileSync(summaryFile, 'utf8'))).toMatchObject({ usageAtStart: initial, usage: { requests: 2, totalInput: 81, totalOutput: 20 } });
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
