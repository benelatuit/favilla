import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WINDOW = 128_000;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-overflow-guard-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
for (let i = 0; i < 8; i++) {
  fs.writeFileSync(
    path.join(project, `seed${i}.log`),
    Array.from({ length: 500 }, (_, line) => `seed=${i} line=${line} text=${String(line * 41 + i).padEnd(64, 's')}\n`).join(''),
  );
  // Under LARGE (6,000 chars) so light pruning does not touch them when testing background draft replacement.
  fs.writeFileSync(
    path.join(project, `note${i}.txt`),
    Array.from({ length: 55 }, (_, line) => `note=${i} row=${line} body=${String(line * 19 + i).padEnd(48, 'n')}\n`).join(''),
  );
}
fs.writeFileSync(path.join(project, 'mod0.ts'), 'export const mod0 = 0;\n');
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html>\n<html><body><h1>Old</h1></body></html>\n');
fs.writeFileSync(path.join(project, 'styles.css'), 'body { color: #111; margin: 0; }\n');

interface StepSpec {
  prompt: number;
  completion?: number;
  cached?: number;
  tool?: { name: string; args: Record<string, unknown> };
  replyText?: string;
  delayMs?: number;
}

interface RecordedWire {
  kind: 'main' | 'reuse-summary' | 'sliced-reuse-summary' | 'transcript-summary';
  maxTokens: number;
  promptTokens: number;
  messagesCount: number;
}

let steps: StepSpec[] = [];
let stepIdx = 0;
let overflow400Count = 0;
let useDenseWireCount = false;
let onSummaryText: () => string = () => 'COMPACT-GUARD-SUMMARY-BODY';
const recorded: RecordedWire[] = [];

const { createRuntime } = await import('../src/runtime');
const { estimateInboundTokens } = await import('../src/util/tokens');

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
    }
    const wire = JSON.parse(raw);
    const maxTokens: number = wire.max_tokens ?? wire.max_completion_tokens ?? 0;
    const lastText = JSON.stringify(wire.messages?.at(-1) ?? '');
    const isSummaryAsk = lastText.includes('The context window is nearly full');
    const isTranscript = lastText.includes('<transcript>');
    const isSlicedReuse = lastText.includes('<recent-steps>');

    let simulatedPrompt: number;
    let step: StepSpec | undefined;
    if (isSummaryAsk) {
      if (isTranscript) {
        simulatedPrompt = useDenseWireCount ? estimateInboundTokens(raw) : Math.ceil(raw.length / 3.5);
      } else if (isSlicedReuse) {
        // Prefix messages reuse the kept rounds verbatim + bounded `<recent-steps>` excerpt in the final instruction.
        const keptStepIdx = Math.max(0, Math.min(stepIdx - 1, Math.floor((wire.messages.length - 2) / 2)));
        const keptPrompt = steps[keptStepIdx]?.prompt ?? 40_000;
        simulatedPrompt = keptPrompt + estimateInboundTokens(lastText);
      } else {
        const reuseStepIdx = Math.max(0, Math.min(stepIdx - 1, Math.floor((wire.messages.length - 2) / 2) - 1));
        const prevPrompt = steps[reuseStepIdx]?.prompt ?? 40_000;
        const prevCompletion = steps[reuseStepIdx]?.completion ?? 100;
        simulatedPrompt = prevPrompt + prevCompletion + 1_600;
      }
    } else {
      step = steps[stepIdx++];
      simulatedPrompt = useDenseWireCount ? estimateInboundTokens(raw) : (step?.prompt ?? 35_000);
    }

    const kind: RecordedWire['kind'] = isSummaryAsk
      ? isTranscript
        ? 'transcript-summary'
        : isSlicedReuse
          ? 'sliced-reuse-summary'
          : 'reuse-summary'
      : 'main';
    recorded.push({ kind, maxTokens, promptTokens: simulatedPrompt, messagesCount: wire.messages?.length ?? 0 });

    // Strict provider ceiling enforcement: reject immediately with 400 if prompt + max_tokens > WINDOW.
    if (simulatedPrompt + maxTokens > WINDOW) {
      overflow400Count++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return void res.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            message: `This model's maximum context length is ${WINDOW} tokens. However, you requested ${simulatedPrompt + maxTokens} tokens (${simulatedPrompt} in the messages, ${maxTokens} in the completion).`,
          },
        }),
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    if (isSummaryAsk) {
      const bodyText = onSummaryText();
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: `<summary>${bodyText}</summary>` } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { prompt_tokens: simulatedPrompt, completion_tokens: 120, prompt_tokens_details: { cached_tokens: isTranscript ? 0 : Math.max(0, simulatedPrompt - 2000) } } });
      return void res.end('data: [DONE]\n\n');
    }

    if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step?.tool) {
      if (step.replyText) {
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: step.replyText } }] });
      }
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              ...(step.replyText ? {} : { role: 'assistant' }),
              tool_calls: [{ index: 0, id: `call_${stepIdx}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }],
            },
          },
        ],
      });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: step?.replyText ?? 'Completed cleanly.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({
      choices: [],
      usage: {
        prompt_tokens: simulatedPrompt,
        completion_tokens: step?.completion ?? 80,
        prompt_tokens_details: { cached_tokens: step?.cached ?? Math.floor(simulatedPrompt * 0.85) },
      },
    });
    res.end('data: [DONE]\n\n');
  });
});

let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'strict/deepseek-v4.1-flash',
      tools: 'favilla',
      languageServers: false,
      providers: {
        strict: {
          name: 'Strict128k',
          api: 'openai-chat',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          auth: 'none',
          slots: 4,
          models: {
            'deepseek-v4.1-flash': { contextWindow: WINDOW },
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

describe('128k compaction runway, dynamic max_tokens clamping, and stale-draft guard', () => {
  it('clamps max_tokens near compactAt and survives a sudden 30k-token output spike with zero 400 overflows', async () => {
    overflow400Count = 0;
    recorded.length = 0;
    stepIdx = 0;
    onSummaryText = () => 'SPIKE-RECOVERY-SUMMARY-BODY';

    // Distinct lines (~112k chars ≈ 30.3k tokens) so RepeatWatch does not treat it as a stuck loop,
    // and active context jumps from 107k straight past 128k so compactNow must use bounded transcriptMessage!
    const suddenLongReply = Array.from({ length: 2450 }, (_, i) => `export const symbolEntry_${i} = ${i * 31 + 7}; // line-${i}\n`).join('');
    steps = [
      { prompt: 8_000, tool: { name: 'read', args: { paths: ['seed0.log'] } } },
      { prompt: 19_500, tool: { name: 'read', args: { paths: ['seed1.log'] } } },
      { prompt: 31_000, tool: { name: 'read', args: { paths: ['seed2.log'] } } },
      { prompt: 42_500, tool: { name: 'read', args: { paths: ['seed3.log'] } } },
      { prompt: 54_000, tool: { name: 'read', args: { paths: ['seed4.log'] } } },
      { prompt: 65_500, tool: { name: 'read', args: { paths: ['seed5.log'] } } },
      { prompt: 93_000, tool: { name: 'read', args: { paths: ['seed6.log'] } } },
      // Even with a +3k tokenizer surprise (server sees 107,000 prompt tokens!), clamped max_tokens keeps 107,000 + max_tokens <= 128,000;
      // AND this step emits a sudden ~30k-token reply pushing active context to ~137k!
      { prompt: 107_000, completion: 30_000, replyText: suddenLongReply, tool: { name: 'read', args: { paths: ['mod0.ts'] } } },
      { prompt: 36_000, completion: 180, replyText: 'Finished cleanly after sudden long output.' },
    ];

    const s = await rt.start({ cwd: project });
    const phases: string[] = [];
    s.on((e) => e.type === 'compaction' && phases.push(e.phase));

    await s.send('Inspect seed logs and mod0.');
    expect(overflow400Count).toBe(0);
    expect(phases).toEqual(['start', 'end']);

    const nearCeilingMain = recorded.find((r) => r.kind === 'main' && r.promptTokens === 107_000)!;
    expect(nearCeilingMain).toBeDefined();
    expect(nearCeilingMain.maxTokens).toBeLessThan(20_480);
    expect(nearCeilingMain.promptTokens + nearCeilingMain.maxTokens).toBeLessThanOrEqual(WINDOW);

    // Because before (~137k) exceeded the full-reuse ceiling, compactNow reused the cached prefix via sliced-reuse-summary!
    expect(recorded.some((r) => r.kind === 'sliced-reuse-summary')).toBe(true);
    expect(recorded.some((r) => r.kind === 'transcript-summary')).toBe(false);
    expect(s.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text.includes('Finished cleanly'))).toBe(true);
  });

  it('clips a 370 KB pipe/backtick/digit-dense telemetry table on Turn 1 below compactAt with working runway and 100% recall preservation (even with +2k system prompt growth)', async () => {
    overflow400Count = 0;
    recorded.length = 0;
    stepIdx = 0;
    useDenseWireCount = true;
    onSummaryText = () => 'DENSE-TABLE-SUMMARY';
    const agentsMdPath = path.join(project, 'AGENTS.md');
    // Inject ~2,000 tokens of extra project/tool-style instructions so the test never sits on a knife-edge when
    // system prompts, tool descriptions, or MCP schemas grow across branches.
    fs.writeFileSync(
      agentsMdPath,
      Array.from({ length: 85 }, (_, i) => `- Project rule ${i}: preserve telemetry shard invariants \`shd-${i}\` and verify \`status:ok\`.`).join('\n') + '\n',
    );

    try {
      const tableHeader = 'HEAD-ANCHOR-9912: Inspect the shard incident table below and check mod0.ts.\n| shard_id | ts_ms | code | status |\n|---|---|---|---|\n';
      const tableRows = Array.from(
        { length: 5300 },
        (_, i) => `| \`pulse-ing-shd-${String(i % 16).padStart(2, '0')}-${String(i).padStart(4, '0')}\` | \`1731580${String(i).padStart(6, '0')}\` | \`E_${(i * 17) % 997}\` | \`degraded:${i % 7}\` |\n`,
      ).join('');
      const tableTail = '\nTAIL-ANCHOR-7741: Keep middle-row MIDDLE-CANARY-2400 accessible via recall.';
      const densePaste = `${tableHeader}${tableRows.replace('3100` |', '3100` | `MIDDLE-CANARY-2400` |')}${tableTail}`;
      expect(densePaste.length).toBeGreaterThan(350_000);

      steps = [
        { prompt: 0, completion: 120, tool: { name: 'read', args: { paths: ['mod0.ts'] } } },
        { prompt: 0, completion: 140, tool: { name: 'recall', args: { message: 0, query: 'MIDDLE-CANARY-2400' } } },
        { prompt: 0, completion: 120, replyText: 'Verified dense paste and recalled middle canary cleanly.' },
      ];

      const s = await rt.start({ cwd: project });
      const phases: string[] = [];
      s.on((e) => e.type === 'compaction' && phases.push(e.phase));

      await s.send(densePaste);
      expect(overflow400Count).toBe(0);
      // Turn 1 leaves ~20% working runway below compactAt (104,960) so full-window recall (~8.3k dense tokens) + read
      // steps reuse the clipped Turn-1 prefix with >10k tokens of margin instead of thrashing into compaction.
      expect(phases).toEqual([]);
      const mainReqs = recorded.filter((r) => r.kind === 'main');
      expect(mainReqs.length).toBe(3);
      expect(mainReqs[0].promptTokens).toBeLessThan(88_000);
      expect(mainReqs[2].promptTokens).toBeLessThan(97_500);
      expect(mainReqs[0].promptTokens + mainReqs[0].maxTokens).toBeLessThanOrEqual(WINDOW);

      const recallResult = s.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'tool_result' && p.name === 'recall');
      expect(recallResult && recallResult.type === 'tool_result' ? recallResult.content : '').toContain('MIDDLE-CANARY-2400');
    } finally {
      useDenseWireCount = false;
      fs.rmSync(agentsMdPath, { force: true });
    }
  });

  it('discards a stale background draft whose post-snapshot tail grew past 22% of the window and deduplicates non-code edits from workbench', async () => {
    overflow400Count = 0;
    recorded.length = 0;
    stepIdx = 0;
    let summarySeq = 0;
    onSummaryText = () => `SUMMARY-SEQ-${++summarySeq}`;

    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(project, `huge${i}.log`),
        Array.from({ length: 240 }, (_, line) => `2026-11-14T12:00:${String(line % 60).padStart(2, '0')}Z shard=${i} seq=${line} payload=${String(line * 97).padEnd(48, 'a')}\n`).join(''),
      );
    }

    steps = [
      // Pre-draft steps read non-prunable note files (< 6,000 chars); huge0..2 stay within KEEP_ROUNDS (5 rounds < 6).
      { prompt: 12_000, tool: { name: 'read', args: { paths: ['note0.txt'] } } },
      { prompt: 45_000, tool: { name: 'read', args: { paths: ['note1.txt'] } } },
      // Crosses DRAFT_AT (78,720) -> background draft #1 (SUMMARY-SEQ-1) starts here!
      { prompt: 79_500, delayMs: 30, tool: { name: 'read', args: { paths: ['huge0.log'] } } },
      { prompt: 84_000, delayMs: 30, tool: { name: 'read', args: { paths: ['huge1.log'] } } },
      { prompt: 89_000, tool: { name: 'edit', args: { path: 'index.html', old_string: '<h1>Old</h1>', new_string: '<h1>Updated Title</h1>' } } },
      { prompt: 90_000, tool: { name: 'edit', args: { path: 'styles.css', old_string: 'color: #111;', new_string: 'color: #222;' } } },
      // Reading huge2.log pushes contextTokens past compactAt (104,960), while calibrated post-draft tail > 22% of 128k (28,160)!
      { prompt: 93_500, tool: { name: 'read', args: { paths: ['huge2.log'] } } },
      { prompt: 40_000, replyText: 'Finished with fresh summary.' },
    ];

    const s = await rt.start({ cwd: project });
    const phases: string[] = [];
    s.on((e) => e.type === 'compaction' && phases.push(e.phase));

    await s.send('Inspect notes, logs, and update HTML/CSS.');
    expect(overflow400Count).toBe(0);
    expect(phases).toEqual(['start', 'end']);
    expect(fs.readFileSync(path.join(project, 'index.html'), 'utf8')).toContain('<h1>Updated Title</h1>');
    expect(fs.readFileSync(path.join(project, 'styles.css'), 'utf8')).toContain('color: #222;');

    const comp = s.messages.find((m) => m.origin === 'compaction')!;
    expect(comp).toBeDefined();
    const compText = JSON.stringify(comp.parts);
    expect(summarySeq).toBeGreaterThanOrEqual(2);
    expect(compText).toContain(`SUMMARY-SEQ-${summarySeq}`);
    expect(compText).not.toContain('SUMMARY-SEQ-1');

    // Non-code index.html and styles.css were edited in the kept tail, so workbench must NOT duplicate their full text inside summaryMsg!
    expect(compText).not.toContain('<h1>Updated Title</h1>');
    expect(compText).not.toContain('color: #222;');
  });

  it('does not pre-compact at 46k active context on a 128k window when a 360k-char message arrives', async () => {
    overflow400Count = 0;
    recorded.length = 0;
    stepIdx = 0;
    onSummaryText = () => 'SHOULD-NOT-COMPACT-AT-46K';

    steps = [
      { prompt: 24_000, tool: { name: 'read', args: { paths: ['seed0.log'] } } },
      { prompt: 46_000, completion: 140, replyText: 'Turn 1 complete at 46k context.' },
      // Turn 2 arrives with 360k chars: clipped into ~84k total prompt with zero pre-compaction!
      { prompt: 83_800, completion: 120, tool: { name: 'recall', args: { message: 3, query: 'TURN2-MIDDLE-CANARY-8821' } } },
      { prompt: 91_500, completion: 110, replyText: 'Turn 2 finished without redundant pre-compaction.' },
    ];

    const s = await rt.start({ cwd: project });
    const phases: string[] = [];
    s.on((e) => e.type === 'compaction' && phases.push(e.phase));

    await s.send('Step 1: inspect seed0.log.');
    expect(s.contextTokens).toBeGreaterThanOrEqual(46_000);
    expect(s.contextTokens).toBeLessThan(50_000);
    expect(phases).toEqual([]);

    const hugeTurn2 =
      'TURN2-HEAD-ANCHOR: Continue triage.\n' +
      Array.from(
        { length: 5_000 },
        (_, i) =>
          `| row-${String(i).padStart(4, '0')} | ${i === 2500 ? 'TURN2-MIDDLE-CANARY-8821' : ' PASS_BUDGET '} | metric=${String(i * 13).padEnd(36, 'x')} |\n`,
      ).join('') +
      'TURN2-TAIL-ANCHOR: End of 360k Step-2 payload.';
    expect(hugeTurn2.length).toBeGreaterThanOrEqual(360_000);

    const reqsBeforeTurn2 = recorded.length;
    await s.send(hugeTurn2);
    expect(overflow400Count).toBe(0);
    expect(phases).toEqual([]);
    // Turn-2 entry sent its main model request directly without any pre-turn compaction request.
    expect(recorded[reqsBeforeTurn2]?.kind).toBe('main');

    // Prior Turn-1 messages stay verbatim in active context (no summary replaced them).
    expect(s.messages.some((m) => m.origin === 'compaction')).toBe(false);
    const recallPart = s.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result' && p.name === 'recall');
    expect(recallPart && recallPart.type === 'tool_result' ? recallPart.content : '').toContain('TURN2-MIDDLE-CANARY-8821');
  });

  it('keeps recent rounds (non-zero tailBudget) when active context truly requires pre-compaction before a 360k-char message', async () => {
    overflow400Count = 0;
    recorded.length = 0;
    stepIdx = 0;
    onSummaryText = () => 'OVERSIZED-TURN-PRECOMPACT-SUMMARY';

    steps = [
      { prompt: 25_000, tool: { name: 'read', args: { paths: ['note0.txt'] } } },
      { prompt: 52_000, tool: { name: 'read', args: { paths: ['note1.txt'] } } },
      { prompt: 74_000, tool: { name: 'read', args: { paths: ['mod0.ts'] } } },
      { prompt: 84_000, completion: 160, replyText: 'KEPT-RECENT-ROUND-MARKER: Turn 1 finished at 84k.' },
      // After pre-compaction keeps recent rounds, Turn 2 (360k chars) clips cleanly below compactAt.
      { prompt: 83_600, completion: 130, replyText: 'Turn 2 completed with summary and kept recent rounds.' },
    ];

    const s = await rt.start({ cwd: project });
    const phases: string[] = [];
    s.on((e) => e.type === 'compaction' && phases.push(e.phase));

    await s.send('Step 1: read notes and mod0.ts.');
    expect(s.contextTokens).toBeGreaterThanOrEqual(84_000);
    expect(phases).toEqual([]);

    const hugeTurn2 =
      'TURN2-HIGH-CTX-HEAD\n' +
      Array.from({ length: 5_000 }, (_, i) => `| item=${String(i).padStart(4, '0')} | payload=${String(i * 29).padEnd(52, 'z')} |\n`).join('') +
      'TURN2-HIGH-CTX-TAIL';
    expect(hugeTurn2.length).toBeGreaterThanOrEqual(360_000);

    await s.send(hugeTurn2);
    expect(overflow400Count).toBe(0);
    expect(phases).toEqual(['start', 'end']);

    const internal = s as unknown as { active(): { role: string; origin?: string; parts: { type: string; text?: string }[] }[] };
    const active = internal.active();
    expect(active[0]?.origin).toBe('compaction');
    // Before this fix, `safeInputCeiling - incomingTokens - summaryReserve` went negative (~ -20k) and wiped `tail` to `[]`;
    // now recent Turn-1 rounds stay verbatim right after `active[0]` (`<summary>`) and before the new user turn!
    const keptBeforeNewTurn = active.slice(1, -2);
    expect(keptBeforeNewTurn.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(keptBeforeNewTurn)).toContain('KEPT-RECENT-ROUND-MARKER');
  });
});
