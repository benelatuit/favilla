import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Claims, claimsForTest } from '../src/agent/claims';
import { OpenAIChatAdapter } from '../src/providers/openai-chat';
import type { ProviderCall, ProviderResult } from '../src/providers/types';
import { createRuntime } from '../src/runtime';

const { covers, overlaps } = claimsForTest;
const root = path.resolve('/work/app');

describe('sub-agent files', () => {
  it('a claim covers its files, folders and globs, nothing else', () => {
    expect(covers('src/a.ts', 'src/a.ts')).toBe(true);
    expect(covers('src', 'src/deep/b.ts')).toBe(true);
    expect(covers('src/**/*.test.ts', 'src/x/y.test.ts')).toBe(true);
    expect(covers('src/*.ts', 'src/x/y.ts')).toBe(false);
    expect(covers('src/a.ts', 'src/a.tsx')).toBe(false);
    expect(covers('lib', 'library/x.ts')).toBe(false);
  });

  it('claims overlap when they could touch the same file', () => {
    expect(overlaps(['src/a.ts'], ['src/b.ts'])).toBe(false);
    expect(overlaps(['src/a.ts'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src/**/*.ts'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src/**/*.ts'], ['docs/a.md'])).toBe(false);
    expect(overlaps(['web/*.css'], ['web/app.tsx'])).toBe(false);
    expect(overlaps(null, ['docs/a.md'])).toBe(true);
  });

  it('refuses changes outside the brief and queues agents whose files overlap', async () => {
    const claims = new Claims(root);
    expect(claims.check(['src/a.ts'], path.join(root, 'src/a.ts'))).toBeNull();
    expect(claims.check(['src/a.ts'], path.join(root, 'src/b.ts'))).toMatch(/only src\/a\.ts; src\/b\.ts is not among them/);
    expect(claims.check(null, path.join(root, 'anything.ts'))).toBeNull();

    const order: string[] = [];
    const signal = new AbortController().signal;
    await claims.acquire('one', 'parser', ['src/parse.ts'], () => order.push('never'), signal);
    // Separate files: no wait.
    await claims.acquire('two', 'docs', ['docs'], () => order.push('never'), signal);
    // The same file: waits until the first lets go.
    const third = claims.acquire('three', 'tests', ['src/parse.ts', 'test'], (holder) => order.push(`waits for ${holder}`), signal).then(() => order.push('three runs'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['waits for parser']);
    claims.release('one');
    await third;
    expect(order).toEqual(['waits for parser', 'three runs']);

    // A stop while waiting gives up the wait.
    const stop = new AbortController();
    const fourth = claims.acquire('four', 'everything', null, () => {}, stop.signal);
    stop.abort();
    await expect(fourth).rejects.toThrow(/Stopped while waiting/);
  });

  it('shares a role-scoped cacheGroup across sequential sub-agents without mixing explore and general', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-subagent-cache-'));
    const prevHome = process.env.FAVILLA_HOME;
    process.env.FAVILLA_HOME = path.join(tmp, 'home');
    const work = path.join(tmp, 'work');
    fs.mkdirSync(process.env.FAVILLA_HOME, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'app.ts'), 'export const x = 1;\n');
    fs.writeFileSync(
      path.join(process.env.FAVILLA_HOME, 'config.json'),
      JSON.stringify({
        model: 'fake/m1',
        tools: 'favilla',
        languageServers: false,
        providers: {
          fake: {
            name: 'Fake',
            api: 'openai-chat',
            baseUrl: 'http://127.0.0.1:9/v1',
            auth: 'none',
            local: true,
            models: { m1: { contextWindow: 128000, family: 'gpt', vision: false, efforts: ['low', 'medium', 'high'] } },
          },
        },
      }),
    );

    const calls: { sessionId: string; cacheKey?: string; toolCount: number }[] = [];
    let mainStep = 0;
    const spy = vi.spyOn(OpenAIChatAdapter.prototype, 'stream').mockImplementation(async (call: ProviderCall): Promise<ProviderResult> => {
      calls.push({ sessionId: call.sessionId, cacheKey: call.cacheKey, toolCount: call.tools.length });
      if (!call.cacheKey) {
        mainStep++;
        if (mainStep === 1) {
          return {
            parts: [{ type: 'tool_call', id: 'tc_1', name: 'agent', input: { type: 'explore', description: 'Check 1', prompt: 'Inspect app.ts' } }],
            usage: { input: 500, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            stop: 'tool_use',
          };
        }
        if (mainStep === 2) {
          return {
            parts: [
              { type: 'tool_call', id: 'tc_2', name: 'agent', input: { type: 'explore', description: 'Check 2', prompt: 'Inspect again' } },
              { type: 'tool_call', id: 'tc_3', name: 'agent', input: { type: 'general', description: 'Edit check', prompt: 'Verify build', files: ['app.ts'] } },
            ],
            usage: { input: 600, output: 30, reasoning: 0, cacheRead: 400, cacheWrite: 0 },
            stop: 'tool_use',
          };
        }
        return { parts: [{ type: 'text', text: 'All done.' }], usage: { input: 700, output: 10, reasoning: 0, cacheRead: 500, cacheWrite: 0 }, stop: 'end' };
      }
      return { parts: [{ type: 'text', text: 'Sub-agent report.' }], usage: { input: 300, output: 15, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, stop: 'end' };
    });

    const rt = await createRuntime();
    try {
      const s = await rt.start({ cwd: work, model: 'fake/m1', effort: 'high' });
      await s.send('Delegate two explore tasks and one general task.');
      const childCalls = calls.filter((c) => c.cacheKey !== undefined);
      expect(childCalls).toHaveLength(3);
      expect(new Set(childCalls.map((c) => c.sessionId)).size).toBe(3);
      expect(childCalls[0].cacheKey).toBe(`${s.id}:explore`);
      expect(childCalls[1].cacheKey).toBe(`${s.id}:explore`);
      expect(childCalls[2].cacheKey).toBe(`${s.id}:general`);
      expect(childCalls[0].toolCount).toBe(childCalls[1].toolCount);
      expect(childCalls[2].toolCount).toBeGreaterThan(childCalls[0].toolCount);
    } finally {
      spy.mockRestore();
      await rt.shutdown();
      if (prevHome === undefined) delete process.env.FAVILLA_HOME;
      else process.env.FAVILLA_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
