import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { attachFiles, compose, Composer } from '../src/components/Composer';
import { ChildSheet } from '../src/components/ChildSheet';
import { POINTED } from '../src/components/Preview';
import { QuestionPrompt } from '../src/components/Prompts';
import { FindBar } from '../src/components/FindBar';
import { openViewer } from '../src/components/ui/Viewer';
import { watchDiagrams } from '../src/lib/mermaid';
import { remote, watchPictures } from '../src/lib/remote';
import '../src/themes/drafting.css';
import '../src/themes/nightshift.css';
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
    const hit = new URL(path, location.origin).searchParams.get('q') === pasteWord
      ? { block: pastedMessage.id, kind: 'user', count: 1, paste: 1 }
      : { block: 'slow-tool', kind: 'tool', count: 1, output: true };
    return Response.json({ hits: [hit], total: 1, capped: false });
  }
  if (path.endsWith('/result/slow-tool')) return Response.json({ content: await output });
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
  );
}

watchDiagrams();
await actions.boot();
await actions.open('a');
createRoot(document.getElementById('root')!).render(h(Stage));
