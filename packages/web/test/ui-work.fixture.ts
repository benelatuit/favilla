import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { attachFiles, compose, Composer } from '../src/components/Composer';
import { ChangesView } from '../src/components/ChangesView';
import { ChildSheet } from '../src/components/ChildSheet';
import { POINTED } from '../src/components/Preview';
import { QuestionPrompt } from '../src/components/Prompts';
import { FindBar } from '../src/components/FindBar';
import { openViewer } from '../src/components/ui/Viewer';
import { watchDiagrams } from '../src/lib/mermaid';
import { remote, watchPictures } from '../src/lib/remote';
import '../src/themes/drafting.css';
import '../src/themes/nightshift.css';
import '../src/styles/timeline.css';
import '../src/styles/controls.css';
import '../src/styles/changes.css';
import { Timeline } from '../src/components/Timeline';
import { WorkPanel } from '../src/components/WorkPanel';
import { openFind, search, showBlock } from '../src/lib/find';
import { withAttached } from '../src/lib/paste';
import { actions, getState, setState, setUi, useStore } from '../src/lib/store';
import type { Message, SessionView, ToolResultPart } from '../src/lib/types';

const messages = Array.from({ length: 180 }, (_, i): Message[] => [
  { id: 'user-' + i, role: 'user', origin: 'user', time: i, turn: 't-' + i, parts: [{ type: 'text', text: 'Question ' + i }] },
  { id: 'reply-' + i, role: 'assistant', time: i, turn: 't-' + i, parts: [{ type: 'text', text: 'Answer ' + i }] },
]).flat();
const message = (id: string, text: string): Message => ({ id, role: 'assistant', time: 900, parts: [{ type: 'text', text }] });

function view(id: string, history: Message[], replaces?: string[]): SessionView {
  return {
    meta: { id, replaces, cwd: '/project', title: id, provider: 'fake', model: 'm', mode: 'build' },
    messages: history, status: 'idle', activeStart: 0, turns: [], model: { id: 'm', efforts: [] },
    pending: { permissions: [], questions: [], plans: [] },
    usage: { contextTokens: 400, contextWindow: 128000, compactAt: 96000, totalInput: 0, cacheRead: 0, totalOutput: 0, requests: 0 },
    live: { draft: null, turnStarted: null, running: [], children: [] },
  } as unknown as SessionView;
}

const views = {
  a: view('a', [...messages, message('end-a', 'End of A')]),
  b: view('b', [...messages, message('end-b', 'End of B')]),
  replacement: view('replacement', [...messages, message('end-replacement', 'End of replacement')], ['b']),
  child: view('child', [message('child-first', 'Child started')]),
};
const pasteWord = 'a beacon at the end';
const pastedMessage: Message = {
  id: 'pasted-message', role: 'user', origin: 'user', time: 0, turn: 'pasted',
  parts: [{ type: 'text', text: withAttached('A long log', [], ['first paste', 'filler\n'.repeat(3100) + pasteWord]) }],
};

class Events {
  static current: Events;
  onmessage?: (m: { data: string }) => void;
  onopen?: () => void;
  onerror?: () => void;

  constructor() {
    Events.current = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
}

Object.assign(window, { EventSource: Events });
const asks: string[] = [];
const sent: unknown[] = [];
const answered: unknown[] = [];
let rejectSend: boolean | 'replaced' = false;
let changes: unknown[] = [];
let context: unknown = null;
let heldChanges: Promise<unknown[]> | undefined;
let server = '';
const previewPages = new Map<string, string[]>();
const heldPreviews = new Map<string, Promise<void>>();
let output: Promise<string> | undefined;
let retryCount = 0;
let retryHold: Promise<string> | undefined;
// One turn's changes: a short file, and a long one with two changes 25 lines apart, whose unchanged runs open in place.
const longLines = (changed: boolean) => Array.from({ length: 40 }, (_, i) => (changed && (i === 4 || i === 29) ? `line ${i + 1} changed` : `line ${i + 1}`));
const hunk = (from: number, to: number, at: number[]) => {
  const out: string[] = [];
  const [a, b] = [longLines(false), longLines(true)];
  for (let i = from; i < to; i++) out.push(...(at.includes(i) ? ['-' + a[i], '+' + b[i]] : [' ' + a[i]]));
  return out;
};
const turnFiles = () => [
  { path: 'short.txt', op: 'update', added: 1, removed: 1, patch: ['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n') },
  { path: 'long.txt', op: 'update', added: 2, removed: 2, patch: ['@@ -2,7 +2,7 @@', ...hunk(1, 8, [4]), '@@ -27,7 +27,7 @@', ...hunk(26, 33, [29])].join('\n') },
];
const wholeFile = (file: string) => ({ path: file, op: 'update', added: 2, removed: 2, patch: ['@@ -1,40 +1,40 @@', ...hunk(0, 40, [4, 29])].join('\n') });
const fail = () => Response.json({ error: 'Send refused by the fixture' }, { status: 503 });
const emit = (event: unknown) => Events.current.onmessage?.({ data: JSON.stringify(event) });
const child = (event: { type: string; [key: string]: unknown }) => emit({
  type: 'subagent', sessionId: 'a', callId: 'sub', event: { sessionId: 'child', ...event },
});
window.fetch = async (route, init) => {
  const path = String(route).replace(/^\/api/, '');
  asks.push(path);
  if (path === '/info') return Response.json({ cwd: '/project', config: { language: 'en' } });
  if (path.startsWith('/sessions?')) return Response.json([views.a.meta, views.b.meta]);
  if (path.endsWith('/changes')) return Response.json(heldChanges ? await heldChanges : changes);
  const turnChanges = /^\/sessions\/[^/]+\/changes\/[^/?]+(?:\?file=(.*))?$/.exec(path);
  if (turnChanges) return turnChanges[1] ? Response.json(wholeFile(decodeURIComponent(turnChanges[1]))) : Response.json([{ turn: 't1', files: turnFiles() }]);
  if (path.endsWith('/context')) return Response.json(context);
  const preview = /^\/sessions\/([^/]+)\/preview(?:\?|$)/.exec(path);
  if (preview) {
    await heldPreviews.get(preview[1]);
    const addresses = previewPages.get(preview[1]) ?? (server ? [server] : []);
    const chosen = new URL(path, location.origin).searchParams.get('url');
    const url = chosen && addresses.includes(chosen) ? chosen : addresses[0];
    return Response.json({ pages: addresses.map((url) => ({ url })), ...(url ? { url, proxied: url } : {}) });
  }
  if (path.endsWith('/answer')) {
    answered.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }
  if (path.includes('/find?')) {
    const q = new URL(path, location.origin).searchParams.get('q');
    const hit = q === pasteWord
      ? { block: pastedMessage.id, kind: 'user', count: 1, paste: 1 }
      : q === 'deeply nested beacon'
        ? { block: 'nested-grep', kind: 'tool', count: 1, output: true }
        : { block: 'slow-tool', kind: 'tool', count: 1, output: true };
    return Response.json({ hits: [hit], total: 1, capped: false });
  }
  if (path.endsWith('/result/slow-tool')) return Response.json({ content: await output });
  if (path.endsWith('/result/retry-tool')) {
    retryCount++;
    if (retryCount === 1) return Response.json({ error: 'temporary failure' }, { status: 503 });
    return Response.json({ content: await retryHold });
  }
  if (path.endsWith('/send')) {
    sent.push(JSON.parse(String(init?.body)));
    if (rejectSend === 'replaced') return Response.json({ error: 'This session was replaced.', replacementId: 'replacement' }, { status: 410 });
    return rejectSend ? fail() : Response.json({ ok: true });
  }
  if (path.startsWith('/sessions/')) return Response.json(views[path.split('/')[2] as keyof typeof views]);
  return Response.json([]);
};

const fixture = {
  asks, sent, answered, emit, child, views, getState, compose, showBlock,
  open: (id: string) => actions.open(id),
  tab: (panelTab: 'changes' | 'context' | 'outline' | 'preview', panel: boolean) => setUi({ panel, panelTab }),
  sheet: () => setUi({ sheet: { sessionId: 'child', title: 'Child' } }),
  turnChanges: () => setUi({ changesView: { session: 'a', turn: 't1' } }),
  status: (status: SessionView['status'], tokens: number) => {
    const session = getState().session!;
    setState({ session: { ...session, status, usage: { ...session.usage, contextTokens: tokens } } });
  },
  send: (fails: boolean | 'replaced') => {
    rejectSend = fails;
    document.querySelector<HTMLButtonElement>('button.send')!.click();
  },
  attachments: () => {
    attachFiles([new File(['picture'], 'test.png', { type: 'image/png' })]);
    window.dispatchEvent(new CustomEvent(POINTED, { detail: { tag: 'button', selector: '#the-button', text: 'Press', page: location.href, box: [1, 2, 3, 4], view: [640, 480], style: {}, html: '<button>Press</button>', events: [] } }));
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'a long paste\n'.repeat(10));
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  },
  scroll: (top: number) => {
    const box = document.querySelector<HTMLElement>('.main .scroll')!;
    box.scrollTop = top;
    box.dispatchEvent(new Event('scroll'));
  },
  gap: () => {
    const box = document.querySelector<HTMLElement>('.main .scroll')!;
    return box.scrollHeight - box.clientHeight - box.scrollTop;
  },
  changes: (turn: string) => { changes = [{ turn, files: [{ path: turn + '.txt', op: 'modify', added: 1, removed: 0, patch: '' }] }]; },
  holdChanges: () => {
    const held = Promise.withResolvers<unknown[]>();
    heldChanges = held.promise;
    return () => { heldChanges = undefined; held.resolve(changes); };
  },
  preview: () => { server = location.origin + '/fixture-page'; },
  previewFor: (id: string, pages: string[]) => {
    previewPages.set(id, pages.map((p) => location.origin + '/fixture-page?page=' + p));
  },
  holdPreview: (id: string) => {
    const held = Promise.withResolvers<void>();
    heldPreviews.set(id, held.promise);
    return () => { heldPreviews.delete(id); held.resolve(); };
  },
  question: () => emit({
    type: 'question.request', sessionId: 'a', request: { id: 'ask', questions: [
      { question: 'Colors?', multiSelect: true, options: [{ label: 'Red, blue' }, { label: 'Green' }] },
      { question: 'Direction?', options: [{ label: 'Left, right' }, { label: 'Up' }] },
    ] },
  }),
  findTool: () => {
    const held = Promise.withResolvers<string>();
    output = held.promise;
    const result: ToolResultPart = { type: 'tool_result', callId: 'slow-tool', name: 'shell', content: 'Preview only', truncated: true };
    const session = getState().session!;
    const call: Message = { id: 'slow', role: 'assistant', time: 1000, turn: 'slow', parts: [{ type: 'tool_call', id: result.callId, name: 'shell', input: { command: 'test' } }] };
    const reply: Message = { id: 'slow-result', role: 'user', origin: 'tool', time: 1001, turn: 'slow', parts: [result] };
    setState({ session: { ...session, messages: [...session.messages, call, reply] }, results: new Map([[result.callId, result]]) });
    openFind();
    search('the missing phrase', () => null);
    return () => held.resolve('Here is the missing phrase');
  },
  findPaste: async () => {
    views.a.messages = [pastedMessage, ...views.a.messages];
    await actions.open('a');
    openFind();
    search(pasteWord, () => null);
  },
  pictureViewer: (id: string) => {
    const img = document.getElementById(id) as HTMLImageElement;
    openViewer([{ src: img.src, name: 'fixture' }], 0, img);
    return getState().ui.viewer?.images[0].src;
  },
  pictures: (failFirst = true) => {
    const info = { requests: 0, revoked: [] as string[] };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { info.revoked.push(url); revoke(url); };
    remote.state = 'open';
    remote.request = async () => {
      info.requests++;
      return failFirst && info.requests === 1 ? { s: 503 } : { s: 200, ct: 'image/png', b64: 'aW1hZ2U' };
    };
    return { info, stop: watchPictures(), add: (id: string) => {
      const img = document.createElement('img');
      img.id = id;
      img.setAttribute('src', '/api/blob/fixture');
      document.body.append(img);
    } };
  },
  reconnect: () => Events.current.onerror?.(),
  seedOutcomes: () => {
    const session = getState().session!;
    const rCancelled: ToolResultPart = { type: 'tool_result', callId: 'call-cancelled', name: 'shell', content: 'Interrupted by the user before it ran.', isError: true };
    const rDenied: ToolResultPart = {
      type: 'tool_result',
      callId: 'call-denied',
      name: 'shell',
      content: "The user did not allow this command (git reset --hard discards uncommitted changes.). Don't run it; find another way or ask the user.",
      isError: true,
    };
    const rRetry: ToolResultPart = { type: 'tool_result', callId: 'retry-tool', name: 'shell', content: 'Preview line', truncated: true };
    const rTask: ToolResultPart = {
      type: 'tool_result',
      callId: 'call-task',
      name: 'agent',
      content: 'Sub-agent summary report.',
      display: { kind: 'task', agent: 'explore', description: 'Inspect child', childSession: 'child-scoped', steps: 1, tokens: 120, durationMs: 400 },
    };
    (views as Record<string, SessionView>)['child-scoped'] = {
      ...view('child-scoped', [
        { id: 'cm1', role: 'assistant', time: 10, parts: [{ type: 'tool_call', id: 'child-read-1', name: 'read_file', input: { path: 'src/child-only.ts' } }] },
        { id: 'cm2', role: 'user', origin: 'tool', time: 11, parts: [{ type: 'tool_result', callId: 'child-read-1', name: 'read_file', content: 'export const x = 1;', durationMs: 9 }] },
      ]),
      meta: { ...view('child-scoped', []).meta, cwd: '/child-workspace' },
    };
    retryCount = 0;
    const held = Promise.withResolvers<string>();
    retryHold = held.promise;
    const callMsg: Message = {
      id: 'm-outcomes',
      role: 'assistant',
      time: 2000,
      turn: 't-outcomes',
      stop: 'tool_use',
      parts: [
        { type: 'tool_call', id: 'call-cancelled', name: 'shell', input: { command: 'sleep 10' } },
        { type: 'tool_call', id: 'call-denied', name: 'shell', input: { command: 'git reset --hard' } },
        { type: 'tool_call', id: 'call-pending', name: 'write_file', input: { path: 'src/unexecuted.ts', content: '' } },
        { type: 'tool_call', id: 'retry-tool', name: 'shell', input: { command: 'cat big.log' } },
        { type: 'tool_call', id: 'call-task', name: 'agent', input: { description: 'Inspect child' } },
      ],
    };
    const resMsg: Message = {
      id: 'm-outcomes-res',
      role: 'user',
      origin: 'tool',
      time: 2001,
      turn: 't-outcomes',
      parts: [rCancelled, rDenied, rRetry, rTask],
    };
    const nextResults = new Map(getState().results);
    for (const r of [rCancelled, rDenied, rRetry, rTask]) nextResults.set(r.callId, r);
    setState({ session: { ...session, messages: [...session.messages, callMsg, resMsg] }, results: nextResults });
    return () => held.resolve('Full loaded log body');
  },
  openScopedSheet: () => setUi({ sheet: { sessionId: 'child-scoped', title: 'Scoped Child' } }),
  seedToolchainBugs: () => {
    // Turn 1 (settled & folded into WorkFold -> ProcessGroup -> LookGroup -> nested-grep)
    const rRead1: ToolResultPart = { type: 'tool_result', callId: 'nested-read', name: 'read_file', content: 'export const alpha = 1;' };
    const rGrep2: ToolResultPart = { type: 'tool_result', callId: 'nested-grep', name: 'grep', content: 'src/alpha.ts:1:deeply nested beacon' };
    const rEditFail: ToolResultPart = { type: 'tool_result', callId: 'settled-fail', name: 'edit', content: 'Error: old_string not found in src/alpha.ts', isError: true };
    const rDiffMod: ToolResultPart = {
      type: 'tool_result',
      callId: 'settled-diff',
      name: 'edit',
      content: 'Updated src/alpha.ts',
      display: { kind: 'diff', files: [{ path: 'src/alpha.ts', op: 'modify' as 'update', added: 2, removed: 1, patch: '@@ -1,1 +1,2 @@\n-export const alpha = 1;\n+export const alpha = 2;\n+export const beta = 3;' }] },
    };

    // Turn 2 (tail turn with a 25-step toolchain so opening it near the bottom tests scroll anchoring, plus 1-step -> 2-step + parallel live test)
    const tailParts: Message['parts'] = [];
    const tailResParts: ToolResultPart[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `tail-step-${i}`;
      tailParts.push({ type: 'tool_call', id, name: 'shell', input: { command: `echo line-${i}` } });
      tailResParts.push({
        type: 'tool_result',
        callId: id,
        name: 'shell',
        content: `line-${i}`,
        isError: i === 3,
        display: { kind: 'terminal', command: `echo line-${i}`, output: `line-${i}\n`, exitCode: i === 3 ? 1 : 0, durationMs: 12, cwd: '/project' },
      });
    }

    const baseMessages: Message[] = [
      { id: 'tb-u1', turn: 'tb-1', time: 100, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Inspect alpha' }] },
      {
        id: 'tb-m1',
        turn: 'tb-1',
        time: 101,
        role: 'assistant',
        stop: 'tool_use',
        parts: [
          { type: 'tool_call', id: 'nested-read', name: 'read_file', input: { path: 'src/alpha.ts' } },
          { type: 'tool_call', id: 'nested-grep', name: 'grep', input: { pattern: 'beacon', path: 'src' } },
          { type: 'tool_call', id: 'settled-fail', name: 'edit', input: { path: 'src/alpha.ts' } },
          { type: 'tool_call', id: 'settled-diff', name: 'edit', input: { path: 'src/alpha.ts' } },
        ],
      },
      { id: 'tb-r1', turn: 'tb-1', time: 102, role: 'user', origin: 'tool', parts: [rRead1, rGrep2, rEditFail, rDiffMod] },
      { id: 'tb-a1', turn: 'tb-1', time: 103, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Done alpha.' }] },
      { id: 'tb-u2', turn: 'tb-2', time: 200, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Run batch\n'.repeat(6).trim() }] },
      { id: 'tb-m2', turn: 'tb-2', time: 201, role: 'assistant', stop: 'tool_use', parts: tailParts },
      { id: 'tb-r2', turn: 'tb-2', time: 202, role: 'user', origin: 'tool', parts: tailResParts },
      { id: 'tb-a2', turn: 'tb-2', time: 203, role: 'assistant', stop: 'end', parts: [{ type: 'text', text: 'Batch finished.' }] },
    ];
    const nextResults = new Map<string, ToolResultPart>([
      [rRead1.callId, rRead1],
      [rGrep2.callId, rGrep2],
      [rEditFail.callId, rEditFail],
      [rDiffMod.callId, rDiffMod],
      ...tailResParts.map((r): [string, ToolResultPart] => [r.callId, r]),
    ]);
    views.a.messages = baseMessages;
    const session = getState().session!;
    setState({ session: { ...session, status: 'idle', messages: baseMessages }, results: nextResults, running: new Map(), drafts: new Map() });
  },
  findNested: () => {
    openFind();
    search('deeply nested beacon', () => null);
  },
  seedSingleStepThenSecond: () => {
    const session = getState().session!;
    const u3: Message = { id: 'tb-u3', turn: 'tb-3', time: 300, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Live step test' }] };
    const m3: Message = { id: 'tb-m3', turn: 'tb-3', time: 301, role: 'assistant', stop: 'tool_use', parts: [{ type: 'tool_call', id: 'live-1', name: 'shell', input: { command: 'npm run build' } }] };
    const running = new Map([
      ['live-1', { callId: 'live-1', name: 'shell', title: 'npm run build', input: { command: 'npm run build' }, started: Date.now() - 500, output: 'building...\n', sub: [] }],
    ]);
    setState({ session: { ...session, status: 'running', messages: [...session.messages, u3, m3] }, running });
    return () => {
      const cur = getState().session!;
      const m3b: Message = {
        id: 'tb-m3',
        turn: 'tb-3',
        time: 301,
        role: 'assistant',
        stop: 'tool_use',
        parts: [
          { type: 'tool_call', id: 'live-1', name: 'shell', input: { command: 'npm run build' } },
          { type: 'tool_call', id: 'live-2', name: 'shell', input: { command: 'npm run lint' } },
        ],
      };
      const nextRunning = new Map([
        ['live-1', { callId: 'live-1', name: 'shell', title: 'npm run build', input: { command: 'npm run build' }, started: Date.now() - 600, output: 'building...\n', sub: [] }],
        ['live-2', { callId: 'live-2', name: 'shell', title: 'npm run lint', input: { command: 'npm run lint' }, started: Date.now() - 100, output: 'linting...\n', sub: [] }],
      ]);
      setState({ session: { ...cur, status: 'running', messages: [...cur.messages.slice(0, -1), m3b] }, running: nextRunning });
    };
  },
  seedFollowScenario: () => {
    const history: Message[] = [];
    for (let i = 0; i < 3; i++) {
      history.push({ id: `fs-u-${i}`, turn: `fs-${i}`, time: 10 + i * 2, role: 'user', origin: 'user', parts: [{ type: 'text', text: `Earlier request ${i}: check layout stability across streaming steps.` }] });
      history.push({
        id: `fs-a-${i}`,
        turn: `fs-${i}`,
        time: 11 + i * 2,
        role: 'assistant',
        stop: 'end',
        parts: [{ type: 'text', text: `Earlier reply ${i}: verified baseline scroll metrics across components.\n\nSecond paragraph confirming zero bounce during auto-folding.` }],
      });
    }
    history.push({ id: 'fs-u-live', turn: 'fs-live', time: 100, role: 'user', origin: 'user', parts: [{ type: 'text', text: 'Run live follow-scroll suite' }] });
    history.push({
      id: 'fs-m-live',
      turn: 'fs-live',
      time: 101,
      role: 'assistant',
      stop: 'tool_use',
      parts: [{ type: 'tool_call', id: 'fs-shell-1', name: 'shell', input: { command: 'pnpm test' } }],
    });
    const running = new Map([
      [
        'fs-shell-1',
        {
          callId: 'fs-shell-1',
          name: 'shell',
          title: 'pnpm test',
          input: { command: 'pnpm test' },
          started: Date.now() - 400,
          output: 'suite 1 pass\nsuite 2 pass\nsuite 3 pass\n',
          sub: [],
        },
      ],
    ]);
    const session = getState().session!;
    setState({
      activeId: 'follow-s1',
      session: { ...session, meta: { ...session.meta, id: 'follow-s1' }, status: 'running', messages: history },
      results: new Map(),
      running,
      drafts: new Map(),
    });
    return {
      foldIntoProcess() {
        const cur = getState().session!;
        const r1: ToolResultPart = {
          type: 'tool_result',
          callId: 'fs-shell-1',
          name: 'shell',
          content: 'suite 1..3 pass',
          durationMs: 120,
          display: { kind: 'terminal', command: 'pnpm test', output: 'suite 1..3 pass', exitCode: 0, durationMs: 120, cwd: '.' },
        };
        const r2: ToolResultPart = {
          type: 'tool_result',
          callId: 'fs-read-2',
          name: 'read',
          content: 'export const ok = true;',
          durationMs: 8,
          display: { kind: 'file', path: 'src/ok.ts', preview: 'export const ok = true;', startLine: 1, lineCount: 1, totalLines: 1 },
        };
        const mFolded: Message = {
          id: 'fs-m-live',
          turn: 'fs-live',
          time: 101,
          role: 'assistant',
          stop: 'tool_use',
          parts: [
            { type: 'tool_call', id: 'fs-shell-1', name: 'shell', input: { command: 'pnpm test' } },
            { type: 'tool_call', id: 'fs-read-2', name: 'read', input: { path: 'src/ok.ts' } },
          ],
        };
        const toolMsg: Message = { id: 'fs-r-live', turn: 'fs-live', time: 102, role: 'user', origin: 'tool', parts: [r1, r2] };
        setState({
          session: { ...cur, status: 'running', messages: [...cur.messages.slice(0, -1), mFolded, toolMsg] },
          results: new Map([
            [r1.callId, r1],
            [r2.callId, r2],
          ]),
          running: new Map(),
        });
      },
      appendAnswer(text: string) {
        const drafts = new Map([['fs-ans', { id: 'fs-ans', parts: new Map([[0, { kind: 'text' as const, text }]]) }]]);
        setState({ drafts });
      },
      startTallLiveShell() {
        const cur = getState().session!;
        const mBridge: Message = {
          id: 'fs-a-bridge',
          turn: 'fs-live',
          time: 104,
          role: 'assistant',
          stop: 'end',
          parts: [{ type: 'text', text: 'Starting full build now.' }],
        };
        const mShell: Message = {
          id: 'fs-m-tall',
          turn: 'fs-live-2',
          time: 105,
          role: 'assistant',
          stop: 'tool_use',
          parts: [{ type: 'tool_call', id: 'fs-tall-shell', name: 'shell', input: { command: 'pnpm build --verbose' } }],
        };
        const lines = Array.from({ length: 32 }, (_, i) => `\x1b[32m[chunk ${i}]\x1b[0m compiled module_${i}.ts\n`).join('');
        setState({
          session: { ...cur, status: 'running', messages: [...cur.messages, mBridge, mShell] },
          drafts: new Map(),
          running: new Map([
            [
              'fs-tall-shell',
              { callId: 'fs-tall-shell', name: 'shell', title: 'pnpm build --verbose', input: { command: 'pnpm build --verbose' }, started: Date.now() - 200, output: lines, sub: [] },
            ],
          ]),
        });
      },
      appendTallShell(extra: string) {
        const curRun = getState().running.get('fs-tall-shell');
        if (!curRun) return;
        setState({
          running: new Map([['fs-tall-shell', { ...curRun, output: curRun.output + extra }]]),
        });
      },
    };
  },
};
Object.assign(window, { fixture });

function Stage() {
  const session = useStore((s) => s.session)!;
  const results = useStore((s) => s.results);
  const drafts = useStore((s) => s.drafts);
  const running = useStore((s) => s.running);
  return h('div', null,
    h('main', { className: 'main' },
      h(FindBar),
      h('div', { className: 'scroll', style: { height: 240, overflowY: 'auto' } },
        h(Timeline, { messages: session.messages, results, drafts, running,
          footer: session.pending.questions.map((req) => h(QuestionPrompt, { key: req.id, req })),
        })),
      h(Composer)),
    h(WorkPanel),
    h(ChildSheet),
    h(ChangesView),
  );
}

watchDiagrams();
await actions.boot();
await actions.open('a');
createRoot(document.getElementById('root')!).render(h(Stage));
