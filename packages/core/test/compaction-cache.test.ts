import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../src/providers/anthropic';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-compact-cache-'));
delete process.env.FAVILLA_HOME;
process.env.FAVILLA_HOME = path.join(home, 'favilla');
process.env.FAVILLA_DEBUG = '1';
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(project, `m${i}.ts`), `export const m${i} = ${i};\n`);

type ChatWireBody = {
  model: string;
  tool_choice?: unknown;
  tools?: unknown[];
  parallel_tool_calls?: boolean;
  thinking?: unknown;
  reasoning_effort?: unknown;
  messages: { role: string; content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }[];
};

type AnthropicWireBody = {
  model: string;
  system: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: unknown;
  output_config?: unknown;
  messages: { role: 'user' | 'assistant'; content: unknown[] }[];
};

const seen: ChatWireBody[] = [];
let onSummary: ((body: ChatWireBody, index: number) => { content?: string; tool?: { name: string; args: Record<string, unknown> } }) | undefined;
let summaryCount = 0;
let mainSteps: { prompt: number; read?: string; delayMs?: number }[] = [];
let mainIndex = 0;

const fake = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8').on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [] }));
    }
    const wire = JSON.parse(raw) as ChatWireBody;
    seen.push(wire);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const lastText = JSON.stringify(wire.messages?.at(-1) ?? '');
    const isSummaryCall = lastText.includes('The context window is nearly full') || JSON.stringify(wire.messages?.[0] ?? '').includes('You write precise hand-off summaries');
    if (isSummaryCall) {
      const reply = onSummary?.(wire, summaryCount++) ?? { content: '<summary>DEFAULT-SUMMARY-BODY-FOR-HANDOFF</summary>' };
      if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
      if (reply.tool) {
        send({
          choices: [
            {
              index: 0,
              delta: {
                ...(reply.content ? {} : { role: 'assistant' }),
                tool_calls: [{ index: 0, id: `bad_call_${summaryCount}`, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }],
              },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 50_000, completion_tokens: 60, prompt_tokens_details: { cached_tokens: wire.tool_choice === 'auto' ? 49_000 : 6_000 } } });
      return void res.end('data: [DONE]\n\n');
    }

    const step = mainSteps[mainIndex++] ?? { prompt: 20_000 };
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.read) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: `Reading ${step.read}.`, tool_calls: [{ index: 0, id: `c${mainIndex}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: [step.read] }) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Wrapping up.', content: 'Done.' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: step.prompt, completion_tokens: 20, prompt_tokens_details: { cached_tokens: Math.max(0, step.prompt - 2_000) } } });
    res.end('data: [DONE]\n\n');
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
      model: 'relay/deepseek-v4.1-flash',
      tools: 'favilla',
      modelRegistry: false,
      languageServers: false,
      skills: false,
      providers: {
        relay: {
          name: 'Relay',
          api: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          auth: 'none',
          slots: 4,
          models: {
            'deepseek-v4.1-flash': { contextWindow: 100_000 },
            'deepseek-chat': { contextWindow: 100_000 },
            'qwen-plus': { contextWindow: 100_000 },
            'plain-2': { contextWindow: 100_000 },
            'plain-2-measured': { contextWindow: 100_000, quirks: { toolChoiceBreaksCache: true } },
            'gpt-5': { contextWindow: 100_000 },
            'gemini-2.5-pro': { contextWindow: 100_000 },
          },
        },
        anth: {
          name: 'Anthropic',
          api: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'test-key',
          models: {
            'claude-sonnet-4-5': { contextWindow: 200_000 },
            'claude-opus-5-5': { contextWindow: 200_000 },
          },
        },
        'anth-opt': {
          name: 'Anthropic Opt-In',
          api: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'test-key',
          quirks: { toolChoiceBreaksCache: true },
          models: {
            'claude-sonnet-4-5': { contextWindow: 200_000 },
            'claude-opus-5-5': { contextWindow: 200_000 },
          },
        },
      },
    }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function anthropicEvents(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

describe('summary request prompt-cache reuse and fallback', () => {
  it('enables toolChoiceBreaksCache only on deepseek by default and honors explicit quirks opt-in', () => {
    expect(rt.catalog.resolve('relay/deepseek-v4.1-flash').quirks.toolChoiceBreaksCache).toBe(true);
    expect(rt.catalog.resolve('relay/deepseek-chat').quirks.toolChoiceBreaksCache).toBe(true);
    expect(rt.catalog.resolve('relay/qwen-plus').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('relay/plain-2').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('anth/claude-sonnet-4-5').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('anth/claude-opus-5-5').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('relay/gpt-5').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('relay/gemini-2.5-pro').quirks.toolChoiceBreaksCache).toBeUndefined();
    expect(rt.catalog.resolve('relay/plain-2-measured').quirks.toolChoiceBreaksCache).toBe(true);
  });

  it('discards a tool-calling summary reply without executing the tool, logs fallback, and falls back once to tool_choice: none', async () => {
    const forbidden = path.join(project, 'forbidden.txt');
    const debugLog = path.join(process.env.FAVILLA_HOME!, 'logs', 'debug.log');
    fs.rmSync(debugLog, { force: true });
    const startedTools: string[] = [];

    // 1. Synchronous compactNow path: reply carries BOTH <summary> text AND a write tool call.
    seen.length = 0;
    summaryCount = 0;
    mainIndex = 0;
    mainSteps = [{ prompt: 25_000, read: 'm0.ts' }, { prompt: 30_000 }];
    onSummary = (wire) =>
      wire.tool_choice === 'auto'
        ? {
            content: '<summary>UNSAFE-SUMMARY-WITH-TOOL-CALL-MUST-BE-DISCARDED</summary>',
            tool: { name: 'write', args: { path: 'forbidden.txt', content: 'should never run\n' } },
          }
        : { content: '<summary>SAFE-FALLBACK-SUMMARY-FROM-NONE-CONSTRAINT</summary>' };

    const s1 = await rt.start({ cwd: project, model: 'relay/deepseek-v4.1-flash' });
    s1.on((e) => e.type === 'tool.start' && startedTools.push(`${e.name}:${JSON.stringify(e.input)}`));
    await s1.send('Inspect m0.ts.');
    expect(await s1.compact('manual')).toBe(true);

    expect(fs.existsSync(forbidden)).toBe(false);
    expect(startedTools.some((t) => t.includes('forbidden.txt'))).toBe(false);
    const manualSummaries = seen.slice(2);
    expect(manualSummaries.map((r) => r.tool_choice)).toEqual(['auto', 'none']);
    expect(manualSummaries[1].tools?.length).toBeGreaterThan(0);
    const installed1 = JSON.stringify(s1.messages.find((m) => m.origin === 'compaction')?.parts ?? []);
    expect(installed1).toContain('SAFE-FALLBACK-SUMMARY-FROM-NONE-CONSTRAINT');
    expect(installed1).not.toContain('UNSAFE-SUMMARY-WITH-TOOL-CALL');

    // 2. Background maybeDraft path: tool-calling reply on 'auto' triggers the 'none' fallback once and swaps cleanly.
    seen.length = 0;
    summaryCount = 0;
    mainIndex = 0;
    mainSteps = [
      { prompt: 25_000, read: 'm0.ts' },
      { prompt: 45_000, read: 'm1.ts' },
      { prompt: 58_000, read: 'm2.ts', delayMs: 80 },
      { prompt: 63_000, read: 'm3.ts', delayMs: 80 },
      { prompt: 70_000, read: 'm4.ts' },
      { prompt: 35_000 },
    ];
    const s2 = await rt.start({ cwd: project, model: 'relay/deepseek-v4.1-flash' });
    s2.on((e) => e.type === 'tool.start' && startedTools.push(`${e.name}:${JSON.stringify(e.input)}`));
    await s2.send('Read the modules.');

    expect(fs.existsSync(forbidden)).toBe(false);
    expect(startedTools.some((t) => t.includes('forbidden.txt'))).toBe(false);
    const draftCalls = seen.filter((r) => JSON.stringify(r.messages.at(-1)).includes('The context window is nearly full'));
    expect(draftCalls.map((r) => r.tool_choice)).toEqual(['auto', 'none']);
    const installed2 = JSON.stringify(s2.messages.find((m) => m.origin === 'compaction')?.parts ?? []);
    expect(installed2).toContain('SAFE-FALLBACK-SUMMARY-FROM-NONE-CONSTRAINT');

    const fallbackLogs = fs.readFileSync(debugLog, 'utf8').split('\n').filter((l) => l.includes('[compaction] summary fallback to tool_choice: none'));
    expect(fallbackLogs).toHaveLength(2);

    // 3. Families without the flag stay on today's path (tool_choice: 'none' immediately, no 'auto' probe).
    for (const plainRef of ['relay/gpt-5', 'relay/qwen-plus']) {
      seen.length = 0;
      summaryCount = 0;
      mainIndex = 0;
      mainSteps = [{ prompt: 25_000, read: 'm0.ts' }, { prompt: 30_000 }];
      const s3 = await rt.start({ cwd: project, model: plainRef });
      await s3.send('Inspect m0.ts.');
      expect(await s3.compact('manual')).toBe(true);
      expect(seen.slice(2).map((r) => r.tool_choice)).toEqual(['none']);
    }
  });

  it('matches what prompt caches key on (tools, tool_choice, system, thinking, and every message before the ask) for chat-completions and Anthropic', async () => {
    // 1. Chat-completions converter at HEAD: both reasoningEcho: 'all' (deepseek-v4.1-flash) and 'turn' (deepseek-chat).
    for (const modelRef of ['relay/deepseek-v4.1-flash', 'relay/deepseek-chat']) {
      seen.length = 0;
      summaryCount = 0;
      mainIndex = 0;
      mainSteps = [
        { prompt: 30_000, read: 'm0.ts' },
        { prompt: 58_000, read: 'm1.ts', delayMs: 80 },
        { prompt: 62_000 },
      ];
      onSummary = () => ({ content: '<summary>CACHE-IDENTICAL-CHAT-SUMMARY-BODY</summary>' });
      const s = await rt.start({ cwd: project, model: modelRef });
      await s.send('Read m0 and m1.');

      const draftIdx = seen.findIndex((r) => JSON.stringify(r.messages.at(-1)).includes('The context window is nearly full'));
      expect(draftIdx).toBeGreaterThan(0);
      const draft = seen[draftIdx];
      const main = seen.find((r, i) => i !== draftIdx && r.messages.length === draft.messages.length - 1)!;
      expect(main).toBeDefined();

      expect(draft.model).toBe(main.model);
      expect(draft.tools?.length).toBeGreaterThan(0);
      expect(draft.tools).toEqual(main.tools);
      expect(draft.tool_choice).toBe('auto');
      expect(draft.tool_choice).toBe(main.tool_choice);
      expect(draft.parallel_tool_calls).toBe(main.parallel_tool_calls);
      expect(draft.thinking).toEqual(main.thinking);
      expect(draft.reasoning_effort).toBe(main.reasoning_effort);
      expect(draft.messages[0]).toEqual(main.messages[0]);
      // Every message before the appended summary ask matches the main request's messages (reasoning_content included).
      expect(draft.messages.slice(0, -1)).toEqual(main.messages);
      expect(main.messages.some((m) => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0)).toBe(true);
      expect(draft.messages.at(-1)?.role).toBe('user');
      expect(String(draft.messages.at(-1)?.content ?? '')).toContain('The context window is nearly full');
    }

    // 2. Anthropic converter at HEAD (exercised via opt-in quirks across budget and adaptive thinking).
    for (const modelRef of ['anth-opt/claude-sonnet-4-5', 'anth-opt/claude-opus-5-5']) {
      const captured: { kind: 'main' | 'summary'; body: AnthropicWireBody }[] = [];
      let step = 0;
      const clientSpy = vi.spyOn(AnthropicAdapter.prototype as unknown as { client: () => unknown }, 'client').mockImplementation(() => ({
        beta: {
          messages: {
            stream: (reqBody: AnthropicWireBody) => {
              const last = JSON.stringify(reqBody.messages.at(-1) ?? '');
              if (last.includes('The context window is nearly full')) {
                captured.push({ kind: 'summary', body: structuredClone(reqBody) });
                return anthropicEvents([
                  { type: 'message_start', message: { usage: { input_tokens: 1_000, cache_read_input_tokens: 129_000, cache_creation_input_tokens: 0 } } },
                  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<summary>ANTHROPIC-CACHED-SUMMARY-BODY-TEXT</summary>' } },
                  { type: 'content_block_stop', index: 0 },
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80 } },
                ]);
              }
              captured.push({ kind: 'main', body: structuredClone(reqBody) });
              step++;
              if (step <= 2) {
                const args = JSON.stringify({ paths: [`m${step - 1}.ts`] });
                return anthropicEvents([
                  { type: 'message_start', message: { usage: { input_tokens: step === 1 ? 10_000 : 80_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 } } },
                  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
                  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `Step ${step} thinking.` } },
                  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig_${step}` } },
                  { type: 'content_block_stop', index: 0 },
                  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${step}`, name: 'read' } },
                  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } },
                  { type: 'content_block_stop', index: 1 },
                  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
                ]);
              }
              return anthropicEvents([
                { type: 'message_start', message: { usage: { input_tokens: 5_000, cache_read_input_tokens: 130_000, cache_creation_input_tokens: 0 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Final thinking.' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_final' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'All inspected.' } },
                { type: 'content_block_stop', index: 1 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
              ]);
            },
          },
        },
      }));

      try {
        const s = await rt.start({ cwd: project, model: modelRef });
        await s.send('Inspect m0 and m1.');

        // Mid-turn background draft (active ends with a user tool_result turn, into which Anthropic merges instruction).
        const draft = captured.find((c) => c.kind === 'summary')!.body;
        const midMain = captured.find((c) => c.kind === 'main' && c.body.messages.length === draft.messages.length)!.body;
        expect(draft.model).toBe(midMain.model);
        expect(draft.tools?.length).toBeGreaterThan(0);
        expect(draft.tools).toEqual(midMain.tools);
        expect(draft.tool_choice).toEqual({ type: 'auto' });
        expect(draft.tool_choice).toEqual(midMain.tool_choice);
        expect(draft.system).toEqual(midMain.system);
        expect(draft.thinking).toEqual(midMain.thinking);
        expect(draft.output_config).toEqual(midMain.output_config);
        expect(draft.messages.slice(0, -1)).toEqual(midMain.messages.slice(0, -1));
        expect(JSON.stringify(draft.messages.slice(0, -1))).toContain('"signature":"sig_1"');
        expect(draft.messages.at(-1)?.role).toBe('user');
        expect(draft.messages.at(-1)?.content.slice(0, -1)).toEqual(midMain.messages.at(-1)?.content);
        expect(JSON.stringify(draft.messages.at(-1)?.content.at(-1))).toContain('The context window is nearly full');

        // Idle manual compact (after an assistant reply, so Anthropic appends a trailing user turn after all messages).
        const afterIdleMain = captured.filter((c) => c.kind === 'main').at(-1)!;
        captured.length = 0;
        expect(await s.compact('manual')).toBe(true);
        const manual = captured.find((c) => c.kind === 'summary')!.body;
        expect(manual.tools).toEqual(afterIdleMain.body.tools);
        expect(manual.tool_choice).toEqual({ type: 'auto' });
        expect(manual.system).toEqual(afterIdleMain.body.system);
        expect(manual.thinking).toEqual(afterIdleMain.body.thinking);
        expect(manual.output_config).toEqual(afterIdleMain.body.output_config);
        expect(manual.messages.at(-1)?.role).toBe('user');
        expect(manual.messages.at(-2)?.role).toBe('assistant');
        expect(manual.messages.slice(0, -2)).toEqual(afterIdleMain.body.messages);
      } finally {
        clientSpy.mockRestore();
      }
    }
  });
});
