import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { catastropheReason, catastropheRefusal, catastropheText } from '@favilla/core/guard/i18n';
import {
  computeRevealPath,
  dispatchFold,
  EMPTY_FOLD_STATE,
  foldKey,
  foldReducer,
  getFoldState,
  lookRows,
  resetFoldStore,
  revealFoldPath,
  selectIsOpen,
  stepRows,
  syncFoldAliases,
  toggleFoldOpen,
} from '../src/lib/fold-state';
import { zh } from '../src/lib/i18n';
import { CORE_STEP_PHRASES, isReadOnlyLookStep, stepOutcome, stepOutcomeDetail } from '../src/lib/steps';
import { buildFullTimeline, buildTimeline, type TimelineBuild } from '../src/lib/timeline';
import { foldTurns } from '../src/lib/turns';
import type { Draft, Message, RunningTool, ToolResultPart } from '../src/lib/types';

const tZh = (k: string) => zh[k] ?? k;

describe('pure fold-state reducer and user override priority', () => {
  beforeEach(() => {
    resetFoldStore();
  });

  it('auto-opens live process groups and auto-collapses on finish only when user did not manually toggle (Bug 2)', () => {
    let state = EMPTY_FOLD_STATE;
    const key = 'p:msg1:0';

    // Untouched: follows live boolean (true while streaming, false once settled).
    expect(selectIsOpen(state, key, true)).toBe(true);
    expect(selectIsOpen(state, key, false)).toBe(false);

    // User manually closes while streaming -> stays closed even while live=true continues.
    state = foldReducer(state, { type: 'TOGGLE', key, currentOpen: true });
    expect(selectIsOpen(state, key, true)).toBe(false);

    // User manually re-opens -> stays open even after streaming finishes (defaultOpen flips true -> false)!
    state = foldReducer(state, { type: 'TOGGLE', key, currentOpen: false });
    expect(selectIsOpen(state, key, true)).toBe(true);
    expect(selectIsOpen(state, key, false)).toBe(true);
  });

  it('preserves process and step fold state across stream.tool -> message.added -> tool.start key transitions (Bug 1)', () => {
    const drafts = new Map<string, Draft>([
      ['msg_42', { id: 'msg_42', parts: new Map([[0, { kind: 'tool', name: 'shell', text: '{"command":"pnpm test"}' }]]) }],
    ]);
    const duringDraft = buildFullTimeline({
      messages: [{ id: 'u1', turn: 't1', time: 1, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Run tests' }] }],
      results: new Map(),
      running: new Map(),
      drafts,
      live: true,
      embedded: false,
      sessionId: 's1',
    });
    const draftProc = duringDraft.find((it) => it.kind === 'process')!;
    expect(draftProc.anchorKey).toBe('p:msg_42:0');

    // User collapses the process while arguments are still streaming.
    toggleFoldOpen('s1', foldKey.process(draftProc), true, draftProc.key);
    expect(selectIsOpen(getFoldState('s1'), foldKey.process(draftProc), true, draftProc.key)).toBe(false);

    // Now message.added arrives with real callId = 'call_99' and draft disappears.
    const running = new Map<string, RunningTool>([
      ['call_99', { callId: 'call_99', name: 'shell', title: 'pnpm test', input: { command: 'pnpm test' }, started: 10, output: '', sub: [] }],
    ]);
    const afterAdded = buildFullTimeline({
      messages: [
        { id: 'u1', turn: 't1', time: 1, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Run tests' }] },
        { id: 'msg_42', turn: 't1', time: 2, role: 'assistant', stop: 'tool_use', parts: [{ type: 'tool_call', id: 'call_99', name: 'shell', input: { command: 'pnpm test' } }] },
      ],
      results: new Map(),
      running,
      drafts: new Map(),
      live: true,
      embedded: false,
      sessionId: 's1',
    });
    const settledProc = afterAdded.find((it) => it.kind === 'process')!;
    expect(settledProc.anchorKey).toBe('p:msg_42:0');
    expect(settledProc.key).toBe('p:call_99');

    syncFoldAliases('s1', afterAdded);
    expect(selectIsOpen(getFoldState('s1'), foldKey.process(settledProc), true, settledProc.key)).toBe(false);

    // Reverse arrival order: tool.start ('p:call_77') toggled before message.added ('p:msg_50:0') arrives.
    toggleFoldOpen('s2', 'p:call_77', true);
    expect(selectIsOpen(getFoldState('s2'), 'p:call_77', true)).toBe(false);
    dispatchFold('s2', { type: 'REGISTER_ALIASES', pairs: [['p:call_77', 'p:msg_50:0']] });
    expect(selectIsOpen(getFoldState('s2'), 'p:msg_50:0', true, 'p:call_77')).toBe(false);
  });

  it('retains fold state per session across session switches', () => {
    toggleFoldOpen('session-a', 'w:p:c1', false);
    toggleFoldOpen('session-b', 'w:p:c1', false);
    toggleFoldOpen('session-b', 'w:p:c1', true); // closed again in B

    expect(selectIsOpen(getFoldState('session-a'), 'w:p:c1', false)).toBe(true);
    expect(selectIsOpen(getFoldState('session-b'), 'w:p:c1', false)).toBe(false);
  });

  it('computes and opens all 4 nested fold layers in one pass for Ctrl+F, while allowing manual close afterwards (Bug 7)', () => {
    const messages: Message[] = [
      { id: 'u1', turn: 't1', time: 1, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Inspect files' }] },
      {
        id: 'm1',
        turn: 't1',
        time: 2,
        role: 'assistant',
        stop: 'tool_use',
        parts: [
          { type: 'reasoning', text: 'First thought', provider: 'p', model: 'm' },
          { type: 'reasoning', text: 'Second thought with needle', provider: 'p', model: 'm' },
          { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'src/a.ts' } },
          { type: 'tool_call', id: 'c2', name: 'grep', input: { pattern: 'needle', path: 'src' } },
        ],
      },
      {
        id: 'r1',
        turn: 't1',
        time: 3,
        role: 'user',
        origin: 'tool',
        parts: [
          { type: 'tool_result', callId: 'c1', name: 'read_file', content: 'line 1' },
          { type: 'tool_result', callId: 'c2', name: 'grep', content: 'src/a.ts:1:needle' },
        ],
      },
      { id: 'a1', turn: 't1', time: 4, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Found it.' }] },
      { id: 'u2', turn: 't2', time: 5, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Next' }] },
    ];
    const results = new Map<string, ToolResultPart>();
    for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);

    const items = buildFullTimeline({ messages, results, running: new Map(), drafts: new Map(), live: false, embedded: false, sessionId: 's1' });
    syncFoldAliases('s1', items);

    // Target c2 sits inside WorkFold -> ProcessGroup -> LookGroup -> ToolEntry!
    const pathToTool = computeRevealPath(items, 'c2');
    expect(pathToTool).toEqual(['w:p:m1:0', 'p:m1:0', 'look-m1:2', 'step:m1:3']);

    revealFoldPath('s1', pathToTool);
    const s = getFoldState('s1');
    for (const k of pathToTool) expect(selectIsOpen(s, k, false)).toBe(true);

    // User can still manually close the revealed LookGroup afterwards.
    toggleFoldOpen('s1', 'look-m1:2', true);
    expect(selectIsOpen(getFoldState('s1'), 'look-m1:2', false)).toBe(false);

    // Header-only match (openStep: false) opens WorkFold + ProcessGroup + LookGroup without forcing the tool body open.
    expect(computeRevealPath(items, 'c2', { openStep: false })).toEqual(['w:p:m1:0', 'p:m1:0', 'look-m1:2']);

    // Target 'm1:1' (merged into ThoughtRun keyed by 'm1:0') opens both the outer ThoughtRun and the inner Thought('m1:1').
    expect(computeRevealPath(items, 'm1:1')).toEqual(['w:p:m1:0', 'p:m1:0', 'thought-run:m1:0', 'thought:m1:1']);
  });
});

describe('strict read-only LookGroup classification (Bug 3 & Bug 4)', () => {
  const okTerm = (command: string, exitCode = 0): ToolResultPart => ({
    type: 'tool_result',
    callId: 'c1',
    name: 'shell',
    content: 'ok',
    isError: exitCode !== 0,
    display: { kind: 'terminal', command, output: 'ok', exitCode, durationMs: 5, cwd: '/w' },
  });

  it('rejects multi-line mutating shell commands, redirects, subshells, xargs, and mutating git/find flags', () => {
    const badCommands = [
      'ls -la\nrm -rf dist',
      'git status && npm test',
      'cat src/a.ts > src/b.ts',
      'ls $(touch pwned)',
      'ls `rm -f x`',
      'find . -name "*.tmp" -delete',
      'find . -name "*.log" -exec rm {} +',
      'rg -l foo | xargs sed -i "s/foo/bar/g"',
      'git branch -D old-feature',
      'git branch -m main master',
      'git diff --output=out.patch',
      'Get-ChildItem src; Remove-Item dist -Recurse',
    ];
    for (const command of badCommands) {
      expect(
        isReadOnlyLookStep({ kind: 'tool', id: 'c1', name: 'shell', input: { command }, result: okTerm(command, 0) }),
        `should NOT classify as read-only look: ${command}`,
      ).toBe(false);
    }
  });

  it('accepts pure read-only commands (including rg exit 1 empty match) and live look tools', () => {
    expect(isReadOnlyLookStep({ kind: 'tool', id: 'c1', name: 'shell', input: { command: 'cd packages/web && ls -la\ngit status --short' }, result: okTerm('ls', 0) })).toBe(true);
    expect(isReadOnlyLookStep({ kind: 'tool', id: 'c1', name: 'shell', input: { command: 'git branch -a' }, result: okTerm('git branch -a', 0) })).toBe(true);
    expect(isReadOnlyLookStep({ kind: 'tool', id: 'c1', name: 'shell', input: { command: 'rg -n needle src 2>/dev/null' }, result: okTerm('rg -n needle src', 1) })).toBe(true);
    expect(isReadOnlyLookStep({ kind: 'tool', id: 'm1:0', name: 'read_file', forming: '{"path":"a.ts"}' })).toBe(true);
  });

  it('excludes failed, cancelled, denied, and pending steps from LookGroup so errors stay visible on the rail', () => {
    const rows = stepRows([
      { kind: 'tool', key: 'c1', id: 'c1', name: 'read_file', title: 'read a.ts', result: { type: 'tool_result', callId: 'c1', name: 'read_file', content: 'ok' } },
      { kind: 'tool', key: 'c2', id: 'c2', name: 'read_file', title: 'read missing.ts', result: { type: 'tool_result', callId: 'c2', name: 'read_file', content: 'ENOENT: missing.ts', isError: true } },
      { kind: 'tool', key: 'c3', id: 'c3', name: 'grep', title: '"foo"', result: { type: 'tool_result', callId: 'c3', name: 'grep', content: 'a.ts:1:foo' } },
      { kind: 'tool', key: 'c4', id: 'c4', name: 'glob', title: '*.ts', result: { type: 'tool_result', callId: 'c4', name: 'glob', content: 'a.ts' } },
    ]);
    const grouped = lookRows(rows);
    expect(grouped.map((r) => r.kind === 'look' ? `look:${r.rows.length}` : r.key)).toEqual(['c1', 'c2', 'look:2']);
  });
});

describe('turn folding around mid-turn user steers and compactions (Bug 5) and incremental books preservation (Bug 11)', () => {
  it('keeps steer and compaction items visible at top level instead of swallowing them inside WorkFold', () => {
    const items = [
      { kind: 'user', key: 'u1' },
      { kind: 'process', key: 'p1', steps: [{ kind: 'tool' }] },
      { kind: 'steer', key: 's1' },
      { kind: 'process', key: 'p2', steps: [{ kind: 'tool' }] },
      { kind: 'compaction', key: 'c1' },
      { kind: 'process', key: 'p3', steps: [{ kind: 'tool' }] },
      { kind: 'text', key: 'a1', final: true },
      { kind: 'user', key: 'u2' },
    ];
    const folded = foldTurns(items);
    expect(folded.map((x) => x.key)).toEqual(['u1', 'w:p1', 's1', 'w:p2', 'c1', 'w:p3', 'a1', 'u2']);
  });

  it('preserves historical turn ledgers across incremental buildTimeline updates (Bug 11)', () => {
    const res1: ToolResultPart = {
      type: 'tool_result',
      callId: 'c1',
      name: 'edit',
      content: 'edited',
      display: { kind: 'diff', files: [{ path: 'src/a.ts', op: 'update', added: 4, removed: 1, patch: '' }] },
    };
    const baseMessages: Message[] = [
      { id: 'u1', turn: 't1', time: 10, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Edit a.ts' }] },
      { id: 'm1', turn: 't1', time: 20, role: 'assistant', stop: 'tool_use', parts: [{ type: 'tool_call', id: 'c1', name: 'edit', input: { path: 'src/a.ts' } }] },
      { id: 'r1', turn: 't1', time: 30, role: 'user', origin: 'tool', parts: [res1] },
      { id: 'a1', turn: 't1', time: 40, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Done t1.' }] },
      { id: 'u2', turn: 't2', time: 50, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Now t2' }] },
    ];
    const results = new Map<string, ToolResultPart>([['c1', res1]]);
    let build: TimelineBuild = buildTimeline({
      messages: baseMessages,
      results,
      running: new Map(),
      drafts: new Map(),
      live: true,
      embedded: false,
      sessionId: 's1',
    });
    expect(build.books.get('t1')?.files).toEqual([{ path: 'src/a.ts', added: 4, removed: 1 }]);

    // Incremental append in t2 (history.end stays at u2, pending has only t2 messages).
    const nextMessages: Message[] = [
      ...baseMessages,
      { id: 'a2', turn: 't2', time: 60, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Done t2.' }] },
    ];
    build = buildTimeline(
      { messages: nextMessages, results, running: new Map(), drafts: new Map(), live: false, embedded: false, sessionId: 's1' },
      build,
    );
    expect(build.books.get('t1')?.files).toEqual([{ path: 'src/a.ts', added: 4, removed: 1 }]);
  });
});

describe('stepOutcome classification and @favilla/core refusal/interruption drift guard (Bug 9)', () => {
  it('distinguishes forming, running, pending, ok, failed, cancelled, and denied tool steps', () => {
    expect(stepOutcome({ name: 'shell', forming: '{"command":' })).toBe('forming');
    expect(stepOutcome({ name: 'shell', live: { started: 1 } })).toBe('running');
    expect(stepOutcome({ id: 'call_1', name: 'shell' })).toBe('pending');
    expect(stepOutcome({ id: 'msg_1:0', name: 'web_search', opaque: true })).toBe('ok');

    expect(stepOutcome({ result: { content: 'Interrupted.' } })).toBe('cancelled');
    expect(stepOutcome({ result: { content: 'Interrupted by the user before it ran.', isError: true } })).toBe('cancelled');
    expect(stepOutcome({ result: { content: 'partial output\n[exit 130 · 1.2 s · Interrupted by the user.]', isError: true } })).toBe('cancelled');

    const deniedCmd = "The user did not allow this command (git reset --hard discards uncommitted changes.). Don't run it; find another way or ask the user.";
    expect(stepOutcome({ result: { content: deniedCmd, isError: true } })).toBe('denied');
    expect(stepOutcomeDetail({ content: deniedCmd }, tZh)).toBe('git reset --hard 会丢弃未 commit 的改动。');

    for (const kind of Object.keys(catastropheText) as (keyof typeof catastropheText)[]) {
      const refusal = catastropheRefusal(catastropheReason(kind, '/srv/prod'));
      expect(stepOutcome({ result: { content: refusal, isError: true } })).toBe('denied');
      const detail = stepOutcomeDetail({ content: refusal }, tZh);
      expect(detail).not.toContain('Ask the user about this exact target');
      expect(detail).toContain('/srv/prod');
    }

    expect(stepOutcome({ result: { content: 'Plan mode is on, so files cannot be changed yet. Finish the plan and present it for approval first.', isError: true } })).toBe('denied');
    expect(stepOutcome({ result: { content: 'This run stays inside its folder (/repo), and ../secret is outside it, so this was not run. Work with what is in the folder; a skill\'s SKILL.md is read with the read tool.', isError: true } })).toBe('denied');
    expect(stepOutcome({ result: { content: 'TypeError: boom', isError: true } })).toBe('failed');
  });

  it('contract guard: every phrase matched by CORE_STEP_PHRASES exists verbatim in @favilla/core source', () => {
    const coreRoot = path.resolve(__dirname, '../../core/src');
    const sessionSrc = fs.readFileSync(path.join(coreRoot, 'agent/session.ts'), 'utf8');
    const shellSrc = fs.readFileSync(path.join(coreRoot, 'tools/shell-tools.ts'), 'utf8');
    const guardI18nSrc = fs.readFileSync(path.join(coreRoot, 'guard/i18n.ts'), 'utf8');
    const corpus = `${sessionSrc}\n${shellSrc}\n${guardI18nSrc}`;

    for (const exact of CORE_STEP_PHRASES.cancelledExact) {
      expect(corpus, `core source still contains cancelled phrase: ${exact}`).toContain(exact);
    }
    for (const sub of CORE_STEP_PHRASES.cancelledContains) {
      expect(corpus, `core source still contains interrupted substring: ${sub}`).toContain(sub);
    }
    for (const prefix of CORE_STEP_PHRASES.deniedPrefixes) {
      // Template literals in session.ts use `${...}` after `(`; check the literal prefix up to `${`.
      expect(corpus, `core source still contains denied prefix: ${prefix}`).toContain(prefix);
    }
  });
});
