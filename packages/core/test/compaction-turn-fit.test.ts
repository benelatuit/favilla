import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobRefs, fullText } from '../src/store/pack';
import { recallTool } from '../src/tools/recall';
import type { ToolContext } from '../src/tools/types';
import type { Message, TextPart } from '../src/types';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-compaction-fit-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'index.ts'), 'export const ready = true;\n');

interface RecordedReq {
  body: Record<string, unknown>;
  raw: string;
}

const requests: RecordedReq[] = [];
let nextPromptTokens = 1200;
let nextSummaryReply = '<summary>Completed earlier setup and verified src/index.ts.</summary>';
let nextChatReply = 'Done.';

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ body: parsed, raw });
    const msgs = (parsed.messages as { role: string; content: unknown }[]) ?? [];
    const lastText = JSON.stringify(msgs.at(-1)?.content ?? '');
    const isCompactionReq =
      lastText.includes('<summary>') || lastText.includes('hand-off summary') || JSON.stringify(parsed.messages).includes('Write a thorough hand-off summary');
    const content = isCompactionReq ? nextSummaryReply : nextChatReply;
    const promptTokens = isCompactionReq ? 1500 : nextPromptTokens;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 40 } })}\n\n`);
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
      model: 'fake/m1',
      tools: 'favilla',
      languageServers: false,
      providers: {
        fake: {
          api: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          auth: 'none',
          local: true,
          models: { m1: { contextWindow: 32_000, maxOutput: 4_000, family: 'gpt' } },
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

describe('turn-entry compaction and single-message window fitting', () => {
  it('restores contextTokens on reopen and pre-compacts completed turns before a large incoming turn overflows', async () => {
    requests.length = 0;
    nextPromptTokens = 21_500;
    nextSummaryReply = '<summary>Turn 1 finished setting up port 8443 and retry count 4.</summary>';
    nextChatReply = 'Acknowledged Turn 1.';

    const s1 = await rt.start({ cwd: project, model: 'fake/m1' });
    await s1.send('Turn 1: configure port 8443 and retry count 4.');
    const sessionId = s1.id;
    const savedTokens = s1.contextTokens;
    expect(savedTokens).toBeGreaterThanOrEqual(21_500);
    rt.close(sessionId);

    // Reopen as CLI `-c` / headless multi-turn runner does between turns.
    const s2 = await rt.get(sessionId, { model: 'fake/m1' });
    expect(s2.contextTokens).toBe(savedTokens);

    requests.length = 0;
    nextPromptTokens = 9_500;
    nextChatReply = 'Acknowledged Turn 2.';
    const turn2Payload = `Turn 2 payload start: ${'config_line=ok; '.repeat(1900)}Turn 2 payload end.`;
    await s2.send(turn2Payload);

    // Request 0 is the pre-turn compaction of Turn 1; Request 1 is Turn 2's main model call (no double compaction).
    expect(requests.length).toBe(2);
    expect(requests[0].raw).toContain('Turn 1: configure port 8443');
    expect(requests[0].raw).not.toContain('Turn 2 payload start:');
    expect(requests[1].raw).toContain('<summary>');
    expect(requests[1].raw).toContain('Turn 2 payload start:');
    expect(requests[1].raw).toContain('Turn 2 payload end.');
  });

  it('clips a single Turn-1 message exceeding the context window while keeping 100% of raw text in BlobStore for recall', async () => {
    requests.length = 0;
    nextPromptTokens = 24_000;
    nextChatReply = 'Inspected oversized payload.';

    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    const huge = `HEAD_TOKEN=alpha\n${'row=0123456789abcdef\n'.repeat(4500)}MIDDLE_NEEDLE=99182\n${'row=fedcba9876543210\n'.repeat(4500)}TAIL_TOKEN=omega`;
    expect(huge.length).toBeGreaterThan(180_000);

    await s.send(huge);
    expect(requests.length).toBe(1);
    // Sent payload fits inside the 32k window instead of sending all 180k+ chars raw.
    expect(requests[0].raw.length).toBeLessThan(120_000);
    expect(requests[0].raw).toContain('HEAD_TOKEN=alpha');
    expect(requests[0].raw).toContain('TAIL_TOKEN=omega');
    expect(requests[0].raw).toContain('chars omitted so this message fits the context window');
    expect(requests[0].raw).toContain('message=0, from=');

    const internal = s as unknown as { messages: Message[]; deps: { store: { blobs: ToolContext['blobs'] } } };
    const msg0 = internal.messages[0];
    const bodyPart = msg0.parts.find((p): p is TextPart => p.type === 'text' && !p.synthetic)!;
    expect(bodyPart.textBlob).toBeTruthy();
    expect(blobRefs(msg0)).toContain(bodyPart.textBlob);
    expect(fullText(bodyPart, internal.deps.store.blobs)).toBe(huge);

    const ctx = { history: () => internal.messages, blobs: internal.deps.store.blobs, outputChars: 30_000 } as unknown as ToolContext;
    const found = await recallTool.execute({ message: 0, query: 'MIDDLE_NEEDLE' }, ctx);
    expect(found.content).toContain('MIDDLE_NEEDLE=99182');
  });

  it('deterministically carries forward [img-NN] notes across repeated compactions when a later summary omits them', async () => {
    const s = (await rt.start({ cwd: project, model: 'fake/m1' })) as unknown as {
      push(m: unknown): void;
      compact(r?: 'manual' | 'switch'): Promise<boolean>;
      active(): Message[];
    };
    s.push({ id: 'u_img_1', role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Inspect header alignment.' }], time: 1 });
    for (let i = 0; i < 6; i++) {
      s.push({ id: `a_img_${i}`, role: 'assistant', parts: [{ type: 'tool_call', id: `ci_${i}`, name: 'shell', input: { command: `echo ${i}` } }], time: 2 + i });
      s.push({ id: `r_img_${i}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: `ci_${i}`, name: 'shell', content: `${i}\n[exit 0 · 0.1 s]` }], time: 2 + i });
    }

    nextSummaryReply = '<summary>Initial UI review complete.\n- [img-01] Header nav height 64px, accent #0F172A, badge misaligned by 14px</summary>';
    expect(await s.compact('manual')).toBe(true);

    for (let i = 6; i < 12; i++) {
      s.push({ id: `a_img_${i}`, role: 'assistant', parts: [{ type: 'tool_call', id: `ci_${i}`, name: 'shell', input: { command: `echo ${i}` } }], time: 10 + i });
      s.push({ id: `r_img_${i}`, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId: `ci_${i}`, name: 'shell', content: `${i}\n[exit 0 · 0.1 s]` }], time: 10 + i });
    }

    requests.length = 0;
    nextSummaryReply = '<summary>Updated TypeScript build configuration and passed unit checks.</summary>';
    expect(await s.compact('manual')).toBe(true);

    expect(requests.at(-1)!.raw).toContain('An earlier <summary> appears at the start of this context.');
    const secondSummaryText = (s.active()[0].parts[0] as TextPart).text;
    expect(secondSummaryText).toContain('[img-01] Header nav height 64px, accent #0F172A, badge misaligned by 14px');
  });
});
