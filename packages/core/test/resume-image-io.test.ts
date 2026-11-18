import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('opens compacted text-only tool history without unpacking blobs for image hints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-resume-image-io-'));
  vi.stubEnv('FAVILLA_HOME', dir);
  const { createRuntime } = await import('../src/runtime');
  const rt = createRuntime(dir);
  try {
    const m = { id: 'old', title: 'Old run', cwd: dir, created: 1, updated: 1, provider: 'openai', model: 'gpt-5.4', mode: 'build', profile: 'favilla', effort: 'medium' } as const;
    rt.store.create(m, 'System');
    const blob = rt.store.blobs.put('old text output\n'.repeat(300));
    const n = process.env.FAVILLA_BENCH_RESUME === '1' ? 999 : 1;
    for (let i = 0; i < n; i++) {
      rt.store.saveMessage(m, { id: `a${i}`, time: 1, role: 'assistant', parts: [{ type: 'tool_call', name: 'read', id: `${i}`, input: { paths: ['words.txt'] } }] });
      rt.store.saveMessage(m, { id: `t${i}`, time: 1, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', name: 'read', callId: `${i}`, content: '', contentBlob: blob }] });
    }
    rt.store.saveMessage(m, { id: 'summary', time: 2, role: 'user', origin: 'compaction', parts: [{ type: 'text', text: 'Earlier work.' }] });
    rt.store.saveCompaction(m, 2 * n);
    rt.store.saveMessage(m, { id: 'last', time: 3, role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] });
    const text = vi.spyOn(rt.store.blobs, 'text');
    const times: number[] = [];
    for (let i = 0; i < (n === 1 ? 1 : 13); i++) {
      const start = performance.now();
      const s = await rt.get(m.id);
      times.push(performance.now() - start);
      expect(s.messages.length).toBe(2 * n + 2);
      rt.close(m.id);
    }
    if (times.length > 1) console.log(`Session.open: ${times.slice(2).sort((a, b) => a - b)[5].toFixed(1)} ms median, 2000 messages, 11 warm opens`);
    expect(text).not.toHaveBeenCalledWith(blob);
  } finally {
    rt.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8 });
  }
});
