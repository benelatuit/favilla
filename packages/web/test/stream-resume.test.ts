import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, vi } from 'vitest';
import type { ConnectionState, ServerEvent } from '../src/lib/api';
import { buildFullTimeline, keysOf } from '../src/lib/timeline';
import type { Draft, Message, SessionView, StreamDraft } from '../src/lib/types';

const mock = vi.hoisted(() => ({
  event: (_: ServerEvent) => {},
  connection: (_: ConnectionState) => {},
  api: vi.fn(),
}));
vi.mock('../src/lib/api', () => ({
  api: mock.api,
  connectEvents: (event: typeof mock.event, connection: typeof mock.connection) => {
    mock.event = event;
    mock.connection = connection;
    return () => {};
  },
}));
vi.mock('../src/lib/notify', () => ({ notifyAway: () => {} }));

type EventBody<E> = E extends { sessionId: string } ? Omit<E, 'sessionId'> : never;
type Event = EventBody<ServerEvent>;
type Piece = Extract<Event, { type: 'stream.text' | 'stream.tool' }>;
type Part = StreamDraft['parts'][number];

const sessionId = 's1';
const chunks = Array.from({ length: 300 }, (_, i) => i.toString(36).padStart(4, '0') + ' 文字🎨.');
const complete = chunks.join('');
const toolChunks = new Map([[1, ''], [45, '{"paths":'], [75, '["fixture'], [175, '.ts"]'], [240, '}']]);
let store: typeof import('../src/lib/store');
let requests: ((view: SessionView) => void)[];
let gets: number;
let emitted: Map<string, Map<number, Part>>;

function view(draft?: StreamDraft | null, messages: Message[] = []): SessionView {
  return {
    meta: { id: sessionId, model: 'm1' }, messages, status: 'running', activeStart: 0, turns: [], model: { id: 'm1' },
    pending: { permissions: [], questions: [], plans: [] },
    live: { ...(draft !== undefined ? { draft } : {}), turnStarted: 0, running: [], children: [] },
  } as unknown as SessionView;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  requests = [];
  gets = 0;
  emitted = new Map();
  mock.api.mockReset().mockImplementation((route: string) => {
    if (route === '/info') return Promise.resolve({ cwd: '/project', config: {} });
    if (route === '/sessions/' + sessionId) {
      gets++;
      assert.equal(requests.length, 0, 'Two session views were requested at once.');
      return new Promise<SessionView>((resolve) => { requests.push(resolve); });
    }
    return Promise.resolve([]);
  });
  store = await import('../src/lib/store');
  await store.actions.boot();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function prefixes() {
  for (const [id, draft] of store.getState().drafts) {
    for (const [index, part] of draft.parts) {
      const actual = emitted.get(id)?.get(index)?.text ?? '';
      assert.ok(actual.startsWith(part.text), `A non-prefix was shown for ${id}:${index}.`);
    }
  }
}

function flush() {
  vi.advanceTimersByTime(50);
  prefixes();
}

function receive(event: Event, now = true) {
  mock.event({ ...event, sessionId } as ServerEvent);
  prefixes();
  if (now) flush();
}

function start(id: string) {
  receive({ type: 'stream.start', messageId: id, model: 'm1' });
}

async function respond(snapshot: SessionView) {
  const resolve = requests.shift();
  assert.ok(resolve, 'Expected a pending session view.');
  resolve(snapshot);
  await vi.advanceTimersByTimeAsync(0);
  prefixes();
}

async function open(snapshot: SessionView) {
  const opened = store.actions.open(sessionId);
  await respond(snapshot);
  await opened;
}

function fixture(id = 'reply') {
  const parts = new Map<number, Part>();
  emitted.set(id, parts);
  const events: Piece[] = [];
  let sent = 0;
  const push = (piece: Piece) => {
    const index = piece.index;
    const text = (parts.get(index)?.text ?? '') + piece.delta;
    parts.set(index, piece.type === 'stream.tool' ? { index, kind: 'tool', text, id: piece.id, name: piece.name } : { index, kind: 'text', text });
    events.push(piece);
  };
  const through = (end: number, deliver: (piece: Piece) => void = receive) => {
    while (sent < end) {
      const piece: Piece = { type: 'stream.text', messageId: id, index: 0, at: sent * 10, delta: chunks[sent++] };
      push(piece);
      deliver(piece);
      const tool = toolChunks.get(sent);
      if (tool !== undefined) {
        const part: Piece = { type: 'stream.tool', messageId: id, index: 1, id: 'call', name: 'read', at: parts.get(1)?.text.length ?? 0, delta: tool };
        push(part);
        deliver(part);
      }
      prefixes();
    }
  };
  const shown = () => store.getState().drafts.get(id)?.parts.get(0)?.text ?? '';
  const snapshot = () => view({ messageId: id, parts: [...parts.values()] });
  const exact = () => {
    const expected = new Map([...parts.values()].map((p) => [p.index, { kind: p.kind, text: p.text, name: p.kind === 'tool' ? p.name : undefined }]));
    assert.deepStrictEqual(store.getState().drafts.get(id), { id, parts: expected });
  };
  return { id, through, events, snapshot, exact, shown };
}

const unseen = () => {};
const queued = (piece: Piece) => receive(piece, false);
const unnumbered = ({ at: _at, ...piece }: Piece) => receive(piece);

it('opens on the full prefix from the view when the start and all previous pieces were missed', async () => {
  const f = fixture();
  f.through(120, unseen);
  await open(f.snapshot());
  f.exact();
  start(f.id);
  f.exact();
  for (const piece of f.events.slice(-2)) receive(piece);
  f.exact();
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(f.shown(), complete);
  assert.equal(gets, 1);
});

it('joins pieces received before the view resolves and cuts their overlap with it', async () => {
  mock.connection('open');
  const f = fixture();
  f.through(90, unseen);
  const earlier = f.snapshot();
  const opening = store.actions.open(sessionId);
  receive(f.events[0]);
  assert.equal(f.shown(), '');
  for (const piece of f.events.slice(-2)) receive(piece);
  f.through(145, queued);
  receive({ type: 'subagent', callId: 'agent', event: {
    type: 'stream.reasoning', sessionId: 'child', messageId: 'child-reply', index: 0, at: 0, delta: 'Thinking.',
  } }, false);
  assert.equal(f.shown(), '');
  assert.equal(gets, 1);
  await respond(earlier);
  await opening;
  f.exact();
  assert.equal(store.getState().children.size, 0);
  flush();
  assert.equal(store.getState().children.get('agent')?.[0].thought, 'Thinking.');
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(f.shown(), complete);
  assert.equal(gets, 1);
});

it('asks for exactly one more view when the event connection joins after the initial snapshot', async () => {
  const f = fixture();
  f.through(70, unseen);
  const earlier = f.snapshot();
  const opening = store.actions.open(sessionId);
  f.through(110, unseen);
  mock.connection('open');
  f.through(145);
  assert.equal(f.shown(), '');
  assert.equal(gets, 1);
  await respond(earlier);
  await opening;
  assert.equal(f.shown(), complete.slice(0, 700));
  assert.equal(gets, 2);
  f.through(165);
  await respond(f.snapshot());
  f.exact();
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(gets, 2);
});

it('refreshes a snapshot taken before the event connection joined even without a later piece', async () => {
  const f = fixture();
  f.through(70, unseen);
  const earlier = f.snapshot();
  const opening = store.actions.open(sessionId);
  f.through(300, unseen);
  mock.connection('open');
  await respond(earlier);
  await opening;
  assert.equal(f.shown(), complete.slice(0, 700));
  assert.equal(gets, 2);
  await respond(f.snapshot());
  f.exact();
  assert.equal(gets, 2);
});

it('keeps the shown prefix over a 40-piece disconnect and heals it with the reconnect view', async () => {
  mock.connection('open');
  await open(view(null));
  const f = fixture();
  start(f.id);
  f.through(100);
  f.exact();
  mock.connection('closed');
  f.through(140, unseen);
  assert.equal(f.shown(), complete.slice(0, 1000));
  const rejoined = f.snapshot();
  mock.connection('open');
  f.through(190, (piece) => {
    receive(piece);
    assert.equal(f.shown(), complete.slice(0, 1000));
  });
  assert.equal(gets, 2);
  await respond(rejoined);
  f.exact();
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(gets, 2);
});

it('leaves unnumbered events on the old start-then-append path', async () => {
  await open(view());
  const lost = fixture('lost');
  lost.through(300, unnumbered);
  assert.equal(store.getState().drafts.size, 0);
  assert.equal(store.getState().draftTails.size, 0);
  assert.equal(gets, 1);
  const f = fixture();
  start(f.id);
  f.through(300, (piece) => { unnumbered(piece); f.exact(); });
  assert.equal(f.shown(), complete);
  assert.equal(gets, 1);
});

it('produces the old drafts at each event from a known start and draws no empty part', async () => {
  await open(view(null));
  const f = fixture();
  start(f.id);
  let prior: Draft = { id: f.id, parts: new Map() };
  assert.deepStrictEqual(store.getState().drafts, new Map([[f.id, prior]]));
  f.through(300, (piece) => {
    const kind = piece.type === 'stream.text' ? 'text' : 'tool';
    const cur = prior.parts.get(piece.index) ?? { kind, text: '' };
    const parts = new Map(prior.parts);
    parts.set(piece.index, { ...cur, text: cur.text + piece.delta, name: piece.type === 'stream.tool' ? piece.name ?? cur.name : cur.name });
    prior = { ...prior, parts };
    receive(piece);
    assert.deepStrictEqual(store.getState().drafts, new Map([[f.id, prior]]));
    if (piece.type === 'stream.tool' && !piece.delta) {
      const { drafts, results, running } = store.getState();
      const drawn = buildFullTimeline({ messages: [], drafts, results, running, live: true, embedded: false }).flatMap(keysOf);
      assert.ok(!drawn.includes(f.id + ':' + piece.index));
    }
  });
  receive({ type: 'stream.end', messageId: f.id });
  assert.deepStrictEqual(store.getState().drafts, new Map([[f.id, prior]]));
  assert.equal(store.getState().draftTails.size, 0);
  assert.equal(gets, 1);
});

it('forgets a discarded draft and its tail even if its old view arrives during the retry', async () => {
  await open(view(null));
  const f = fixture();
  start(f.id);
  f.through(40);
  f.through(80, unseen);
  f.through(130);
  const stale = f.snapshot();
  assert.ok(store.getState().draftTails.has(f.id));
  receive({ type: 'stream.discard', messageId: f.id });
  assert.ok(!store.getState().drafts.has(f.id) && !store.getState().draftTails.has(f.id));
  const retry = fixture('retry');
  start(retry.id);
  retry.through(100);
  await respond(stale);
  assert.ok(!store.getState().drafts.has(f.id) && !store.getState().draftTails.has(f.id));
  retry.exact();
  await respond(retry.snapshot());
  retry.through(300, (piece) => { receive(piece); retry.exact(); });
});

it('removes the tail and keeps the committed reply when a pre-commit view arrives late', async () => {
  await open(view(null));
  const f = fixture();
  start(f.id);
  f.through(100);
  f.through(130, unseen);
  f.through(300);
  const stale = f.snapshot();
  assert.ok(store.getState().draftTails.has(f.id));
  const message: Message = { id: f.id, role: 'assistant', time: 1, parts: [
    { type: 'text', text: complete }, { type: 'tool_call', id: 'call', name: 'read', input: { paths: ['fixture.ts'] } },
  ] };
  receive({ type: 'message.added', message });
  assert.equal(store.getState().drafts.size, 0);
  assert.equal(store.getState().draftTails.size, 0);
  assert.deepStrictEqual(store.getState().session?.messages, [message]);
  await respond(stale);
  assert.equal(store.getState().drafts.size, 0);
  assert.deepStrictEqual(store.getState().session?.messages, [message]);
  await respond(view(null, [message]));
  assert.deepStrictEqual(store.getState().session?.messages, [message]);
});

it('keeps disjoint pieces in one batch separate and follows up if the latest tail is still ahead', async () => {
  await open(view(null));
  const f = fixture();
  start(f.id);
  f.through(40, queued);
  f.through(55, unseen);
  f.through(70, queued);
  flush();
  assert.equal(f.shown(), complete.slice(0, 400));
  assert.equal(gets, 2);
  const first = f.snapshot();
  f.through(95, unseen);
  f.through(110, queued);
  flush();
  assert.equal(store.getState().draftTails.get(f.id)?.get(0)?.at, 950);
  await respond(first);
  assert.equal(f.shown(), complete.slice(0, 700));
  assert.equal(gets, 3);
  await respond(f.snapshot());
  f.exact();
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(gets, 3);
});

it('keeps a newer shown prefix when the view was captured earlier', async () => {
  await open(view(null));
  const f = fixture();
  start(f.id);
  f.through(60);
  const earlier = f.snapshot();
  const refreshed = store.actions.refreshSession();
  f.through(150);
  await respond(earlier);
  await refreshed;
  f.exact();
  f.through(300, (piece) => { receive(piece); f.exact(); });
  assert.equal(gets, 2);
});
