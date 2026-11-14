import { settingBasis, SettingsConflict, SettingsError } from '@favilla/core/config/document';
import { LANGUAGE_NAMES, LANGUAGES, settingText } from '@favilla/core/i18n';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Box, Static, Text, render, useApp, useInput, useWindowSize } from 'ink';
import type { AgentEvent, DiffFile, Effort, ImagePart, Message, ModelInfo, PermissionRequest, QuestionRequest, QueuedInput, Runtime, Session, SessionUsage, Todo } from '@favilla/core';
import {
  VERSION,
  agentEnv,
  appPath,
  attach,
  exitProcess,
  expandMentions,
  findRoot,
  homePath,
  makeDiff,
  runRipgrep,
  runShell,
  toForward,
  updateGlobalConfig,
  withImages,
} from '@favilla/core';
import { Editor, currentToken, type Seed, type Suggestion } from './editor';
import { bareTitle, contextLines, diffLines, fmtAgo, fmtDuration, fmtTokens, ledgerLine, noticeBlock, textBlock, thinkingBlock, todoLines, toolBlock, toolLabel, userBlock } from './format';
import { added as plus, bold, dim, paint, removed as minus } from './theme';
import { renderMarkdown } from './markdown';
import { language, printSettingError, setLanguage, t } from './i18n';
import { clip, cols, padEnd } from './text';
import { settledLength, tail } from './stream';
import { addHistory, loadHistory } from './history';
import { COMMANDS, PROMPTS, expandCustom, loadCustomCommands } from './commands';
import { personaCommand } from './persona';
import { presetCommand } from './preset';
import { replayItems, transcriptLines, transcriptMarkdown, userText } from './transcript';
import { copyText } from './clipboard';
import { Pager, PermissionPrompt, PickerView, PlanPrompt, QuestionPrompt, childLines, type ChildView, type Picker } from './views';

interface TuiOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  effort?: Effort;
  mode?: Session['meta']['mode'];
  resume?: string;
}

interface Item {
  id: string;
  text: string;
  /** Printed right under the item before it; others get a blank line above. */
  tight?: boolean;
}

interface Running {
  name: string;
  title: string;
  started: number;
  tail: string;
}

interface StreamPart {
  kind: 'text' | 'reasoning' | 'tool';
  text: string;
  name?: string;
  /** Characters of the text already printed to the scrollback. */
  done: number;
}

/** The reply being written: printed block by block as each settles, the rest drawn live. */
interface Stream {
  id: string;
  parts: Map<number, StreamPart>;
  /** Reasoning parts already printed (folded) ahead of the first printed text. */
  reasoningShown: number;
  printed: boolean;
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Two presses of esc (or ctrl+c) within this long count as one gesture. */
const DOUBLE_MS = 1200;
/** A turn that took longer than this rings the terminal's bell when it ends. */
const BELL_AFTER_MS = 20_000;

let itemSeq = 0;
const item = (text: string, tight = false): Item => ({ id: `i${itemSeq++}`, text, tight });

/** The file a tool call is writing, the command it runs or what it looks for, read from its arguments as they stream. */
function streamingArg(json: string): string {
  const m = /"(?:path|file_path|filePath|command|pattern|query|url|description|objective)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(json);
  return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
}

/** Window title and taskbar progress (Windows Terminal, ConEmu, iTerm2 read OSC 9;4): the work shows from other tabs. */
function terminalState(title: string, busy: boolean): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\x1b]0;${busy ? '◐ ' : ''}${title.replace(/[\x00-\x1f]/g, ' ')}\x07\x1b]9;4;${busy ? 3 : 0};0\x07`);
}

function App({ rt, initial, opts }: { rt: Runtime; initial: Session; opts: TuiOptions }) {
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(40, (columns || 100) - 1);
  const height = Math.max(12, rows || 30);
  const [session, setSession] = useState<Session>(initial);
  const [epoch, setEpoch] = useState(0);
  const [items, setItems] = useState<Item[]>(() => opening(initial, rt, width));
  const [, setTick] = useState(0);
  const [running, setRunning] = useState<Map<string, Running>>(new Map());
  const [children, setChildren] = useState<Map<string, ChildView>>(new Map());
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [question, setQuestion] = useState<QuestionRequest | null>(null);
  const [plan, setPlan] = useState<{ id: string; plan: string } | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pager, setPager] = useState<{ title: string; lines: string[]; start: 'top' | 'end' } | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(initial.usage);
  const [todos, setTodos] = useState<Todo[]>(initial.todos);
  const [meta, setMeta] = useState(initial.meta);
  const [status, setStatus] = useState<string>('idle');
  /** Sub-agents at work in the background; they can outlast the turn. */
  const [background, setBackground] = useState(0);
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [armed, setArmed] = useState<{ what: 'quit' | 'esc-empty' | 'esc-text'; at: number } | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [queue, setQueue] = useState<QueuedInput[]>(initial.queued);
  const [seed, setSeed] = useState<Seed | undefined>();
  const [editing, setEditing] = useState<{ messageId: string; undo: boolean; replace: boolean; n: number } | null>(null);
  const [shellRun, setShellRun] = useState<{ command: string; tail: string; started: number; abort: AbortController } | null>(null);
  // Changing the language in /settings redraws the live part; what is already printed stays as it was.
  const [, setLang] = useState(language());

  const files = useRef<{ at: number; list: string[] }>({ at: 0, list: [] });
  const calls = useRef(new Map<string, { name: string; title: string; input: Record<string, unknown> }>());
  const stream = useRef<Stream | null>(null);
  const tickTimer = useRef<NodeJS.Timeout | null>(null);
  const held = useRef<Item[] | null>(null);
  const returned = useRef<{ text: string; images: ImagePart[] }[]>([]);
  const shellNotes = useRef<string[]>([]);
  const afterSwitch = useRef<(() => void) | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const widthRef = useRef(width);
  widthRef.current = width;
  const turnStartRef = useRef<number | null>(null);
  turnStartRef.current = turnStart;

  const customs = useMemo(() => loadCustomCommands(session.meta.cwd), [session.meta.cwd, epoch]);

  /** New scrollback; while the reader is open it waits, so nothing scrolls under the page being read. */
  const add = (tight: boolean, texts: string[]) => {
    const list = texts.filter((x) => x !== undefined && x !== '').map((x) => item(x, tight));
    if (!list.length) return;
    if (held.current) held.current.push(...list);
    else setItems((xs) => [...xs, ...list]);
  };
  const push = (...texts: string[]) => add(false, texts);
  /** A line that belongs to the item above it: a turn's ledger, a note on what just happened. */
  const pushTight = (...texts: string[]) => add(true, texts);
  const notice = (level: 'info' | 'warn' | 'error', text: string) => push(noticeBlock(level, text));
  const tick = () => {
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      setTick((x) => x + 1);
    }, 33);
  };

  const openPager = (title: string, lines: string[], start: 'top' | 'end' = 'top') => {
    held.current ??= [];
    setPager({ title, lines, start });
  };
  const closePager = () => {
    const waiting = held.current ?? [];
    held.current = null;
    setPager(null);
    if (waiting.length) setItems((xs) => [...xs, ...waiting]);
  };

  /** Show another session: its conversation is printed again below, and its events drive the screen from now on. */
  const switchTo = (next: Session, intro: string[] = [], after?: () => void) => {
    afterSwitch.current = after ?? null;
    stream.current = null;
    setRunning(new Map());
    setChildren(new Map());
    setPermission(null);
    setQuestion(null);
    setPlan(null);
    setEditing(null);
    setQueue(next.queued);
    setStatus(next.status === 'idle' ? 'idle' : next.status);
    setTurnStart(null);
    // The new conversation is printed by a new <Static> with its own items, in the same render: one that kept the
    // old items for a frame would print them all again.
    setItems(opening(next, rt, widthRef.current, intro));
    setSession(next);
    setEpoch((e) => e + 1);
  };

  useEffect(() => {
    const s = session;
    setUsage(s.usage);
    setMeta(s.meta);
    setTodos(s.todos);
    const off = s.on((e: AgentEvent) => handle(e));
    // Messages a stop of Favilla left unread come back to the input.
    const unread = s.takeUnread();
    if (unread.length) setSeed({ text: unread.map((u) => u.text).join('\n\n'), images: unread.flatMap((u) => u.images), nonce: Date.now() });
    const after = afterSwitch.current;
    afterSwitch.current = null;
    after?.();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, epoch]);

  useEffect(() => {
    const busy = status !== 'idle' || [...children.values()].some((c) => c.activity !== 'done') || !!shellRun;
    if (!busy) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(timer);
  }, [status, children, shellRun]);

  useEffect(() => {
    terminalState(`${meta.title || 'Favilla'} · Favilla`, status !== 'idle');
  }, [status, meta.title]);
  useEffect(() => () => terminalState('Favilla', false), []);

  function finishStream(m: Message): void {
    const s = stream.current;
    const texts = s ? [...s.parts.entries()].filter(([, p]) => p.kind === 'text').sort((a, b) => a[0] - b[0]).map(([, p]) => p) : [];
    let ti = 0;
    let ri = 0;
    const out: string[] = [];
    const w = widthRef.current;
    for (const p of m.parts) {
      if (p.type === 'reasoning' && p.text.trim()) {
        if (ri++ >= (s?.reasoningShown ?? 0)) out.push(thinkingBlock(p.text, w));
      } else if (p.type === 'text' && p.text.trim()) {
        const sp = texts[ti++];
        const done = sp && p.text.startsWith(sp.text.slice(0, sp.done)) ? sp.done : 0;
        const rest = p.text.slice(done);
        if (rest.trim()) out.push(textBlock(rest, w));
      }
    }
    push(...out);
    stream.current = null;
    tick();
  }

  function onStreamDelta(e: Extract<AgentEvent, { type: 'stream.text' | 'stream.reasoning' | 'stream.tool' }>): void {
    const s = stream.current;
    if (!s || s.id !== e.messageId) return;
    const kind = e.type === 'stream.text' ? 'text' : e.type === 'stream.reasoning' ? 'reasoning' : 'tool';
    const part = s.parts.get(e.index) ?? { kind, text: '', done: 0 };
    part.text += e.delta;
    if (e.type === 'stream.tool') part.name = e.name;
    s.parts.set(e.index, part);
    if (kind === 'text') {
      const rest = part.text.slice(part.done);
      const n = settledLength(rest);
      if (n > 0) {
        const w = widthRef.current;
        // Reasoning that came before goes first, folded, so the scrollback reads in order.
        if (!s.printed) {
          const before = [...s.parts.entries()].filter(([i, p]) => p.kind === 'reasoning' && i < e.index && p.text.trim()).sort((a, b) => a[0] - b[0]);
          push(...before.map(([, p]) => thinkingBlock(p.text, w)));
          s.reasoningShown = before.length;
          s.printed = true;
        }
        push(renderMarkdown(rest.slice(0, n).trimEnd(), w));
        part.done += n;
      }
    }
    tick();
  }

  function onChild(e: Extract<AgentEvent, { type: 'subagent' }>): void {
    const ev = e.event;
    setChildren((prev) => {
      const n = new Map(prev);
      const now = Date.now();
      const cur = n.get(ev.sessionId);
      const call = calls.current.get(e.callId);
      const input = call?.input ?? {};
      const c: ChildView = cur
        ? { ...cur }
        : {
            callId: e.callId,
            sessionId: ev.sessionId,
            description: call?.name === 'brief' ? toolLabel(call.name) : String(input.description ?? call?.title ?? t('sub-agent')),
            activity: 'starting',
            started: now,
            steps: [],
            tokens: 0,
            background: input.background === true,
            model: typeof input.model === 'string' ? input.model : undefined,
            effort: typeof input.effort === 'string' ? input.effort : undefined,
          };
      switch (ev.type) {
        case 'stream.start':
          c.activity = 'thinking';
          c.model ??= ev.model;
          break;
        case 'stream.reasoning':
          c.activity = 'thinking';
          break;
        case 'stream.text':
          c.activity = 'writing';
          break;
        case 'tool.start':
          c.steps = [...c.steps, { id: ev.callId, name: ev.name, title: ev.title, started: now }].slice(-200);
          c.activity = 'tool';
          break;
        case 'tool.end': {
          const failed = !!ev.result.isError || (ev.result.display?.kind === 'terminal' && !!ev.result.display.exitCode);
          c.steps = c.steps.map((x) => (x.id === ev.callId ? { ...x, ended: now, failed } : x));
          if (!c.steps.some((x) => !x.ended)) c.activity = 'thinking';
          break;
        }
        case 'usage':
          c.tokens = ev.usage.totalInput + ev.usage.totalOutput;
          break;
        case 'meta':
          c.model = `${ev.meta.provider}/${ev.meta.model}`;
          c.effort = ev.meta.effort;
          break;
        case 'status':
          if (ev.status === 'waiting') c.activity = 'waiting';
          else if (ev.status === 'idle') c.activity = 'done';
          break;
        case 'subagent':
          c.activity = 'tool';
          break;
        default:
          return prev;
      }
      n.set(ev.sessionId, c);
      return n;
    });
  }

  function handle(e: AgentEvent): void {
    const w = widthRef.current;
    switch (e.type) {
      case 'status':
        setStatus(e.status === 'running' && (e.detail === 'retrying' || e.detail === 'checking' || e.detail === 'shadow-tests' || e.detail === 'auditing' || e.detail === 'thinking') ? e.detail : e.status);
        break;
      case 'background':
        setBackground(e.running.length);
        break;
      case 'turn.start':
        setTurnStart(Date.now());
        break;
      case 'turn.end': {
        const ms = turnStartRef.current ? Date.now() - turnStartRef.current : 0;
        setTurnStart(null);
        stream.current = null;
        setRunning(new Map());
        // Sub-agents of the turn stop with it; background ones go on and report later.
        setChildren((prev) => new Map([...prev].map(([k, c]) => [k, c.background ? c : { ...c, activity: 'done' as const }])));
        if (e.reason === 'aborted') pushTight(paint('brass', `■ ${t('Interrupted.')}`));
        else if (e.reason === 'error') push(noticeBlock('error', e.error ?? t('The turn failed.')));
        else if (e.reason === 'max_steps') push(noticeBlock('warn', t('The turn reached its step limit; say "continue" to go on.')));
        else if (e.reason === 'refusal') push(noticeBlock('warn', t('The model declined to go on with this request.')));
        else pushTight(ledgerLine(sessionRef.current.messages, e.turn, ms));
        if (ms > BELL_AFTER_MS && process.stdout.isTTY) process.stdout.write('\x07');
        break;
      }
      case 'message.added': {
        const m = e.message;
        if (m.role === 'user' && m.origin === 'user') push(userBlock(userText(m), m.parts.filter((p) => p.type === 'image').length, w));
        else if (m.role === 'user' && m.origin === 'compaction') push(paint('faint', `── ${t('earlier conversation summarized; continuing from the summary')} ──`));
        else if (m.role === 'assistant') finishStream(m);
        break;
      }
      case 'stream.start':
        stream.current = { id: e.messageId, parts: new Map(), reasoningShown: 0, printed: false };
        tick();
        break;
      case 'stream.text':
      case 'stream.reasoning':
      case 'stream.tool':
        onStreamDelta(e);
        break;
      case 'stream.discard':
        if (stream.current?.id === e.messageId) {
          if (stream.current.printed) push(paint('faint', `↻ ${t('The reply above was cut off; the model is asked again.')}`));
          stream.current = null;
          tick();
        }
        break;
      case 'tool.start': {
        // A child can report after its tool ended. Its card still needs these fields.
        const { description, background, model, effort } = e.input;
        calls.current.set(e.callId, { name: e.name, title: e.title, input: { description, background, model, effort } });
        setRunning((r) => new Map(r).set(e.callId, { name: e.name, title: e.title, started: Date.now(), tail: '' }));
        break;
      }
      case 'tool.progress':
        setRunning((r) => {
          const cur = r.get(e.callId);
          return cur ? new Map(r).set(e.callId, { ...cur, tail: (cur.tail + e.chunk).slice(-1500) }) : r;
        });
        break;
      case 'tool.end': {
        const c = calls.current.get(e.callId);
        setRunning((r) => {
          const n = new Map(r);
          n.delete(e.callId);
          return n;
        });
        push(toolBlock(c?.name ?? e.result.name, c?.title ?? e.result.name, e.result, w));
        break;
      }
      case 'subagent':
        onChild(e);
        break;
      case 'permission.request':
        setPermission(e.request);
        break;
      case 'permission.resolved':
        setPermission((p) => (p?.id === e.id ? null : p));
        break;
      case 'question.request':
        setQuestion(e.request);
        break;
      case 'question.resolved':
        setQuestion((q) => (q?.id === e.id ? null : q));
        break;
      case 'plan.request':
        setPlan({ id: e.id, plan: e.plan });
        break;
      case 'plan.resolved':
        setPlan((p) => (p?.id === e.id ? null : p));
        break;
      case 'todos':
        setTodos(e.todos);
        break;
      case 'usage':
        setUsage(e.usage);
        break;
      case 'meta':
        setMeta(e.meta);
        break;
      case 'notice':
        push(noticeBlock(e.level, e.key ? t(e.key, { n: e.arg ?? '' }) : e.text));
        break;
      case 'queue':
        setQueue(e.items);
        if (e.returned?.length) {
          returned.current = e.returned;
          push(noticeBlock('warn', e.returned.length === 1 ? t('The agent did not read your last message; ↑ brings it back.') : t('The agent did not read {n} messages; ↑ brings them back.', { n: e.returned.length })));
          sessionRef.current.acknowledgeInputs(e.returned.map((p) => p.id));
        }
        break;
      case 'compaction':
        if (e.phase === 'start') push(paint('faint', `~ ${t('compacting the context…')}`));
        if (e.phase === 'end') push(paint('faint', `~ ${t('context compacted: {a} → {b} tokens', { a: fmtTokens(e.before ?? 0), b: fmtTokens(e.after ?? 0) })}`));
        if (e.phase === 'failed' && e.error) push(noticeBlock('warn', t('Compaction failed: {n}', { n: e.error ?? '' })));
        if (e.phase === 'pruned') push(paint('faint', `~ ${t('trimmed {n} old tool outputs: {m} tokens in context (recall brings them back)', { n: e.count ?? 0, m: fmtTokens(e.after ?? 0) })}`));
        break;
      case 'checkpoint':
        pushTight(paint('faint', `  ${e.files.length === 1 ? t('1 file changed this turn · /diff shows it · /undo puts it back') : t('{n} files changed this turn · /diff shows them · /undo puts them back', { n: e.files.length })}`));
        break;
    }
  }

  async function listFiles(): Promise<string[]> {
    if (Date.now() - files.current.at < 20_000) return files.current.list;
    const r = await runRipgrep(['--files', '--hidden', '--glob', '!.git', '--glob', '!node_modules'], session.meta.cwd, AbortSignal.timeout(5000));
    files.current = { at: Date.now(), list: r.stdout.split(/\r?\n/).filter(Boolean).map(toForward) };
    return files.current.list;
  }
  useEffect(() => {
    listFiles().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const allCommands = [...COMMANDS.map((c) => ({ name: c.name, detail: t(c.detail) })), ...customs.map((c) => ({ name: c.name, detail: c.detail }))];
  const suggest = (text: string, cursor: number): Suggestion[] => {
    if (text.startsWith('/') && !text.includes(' ')) {
      const q = text.toLowerCase();
      const starts = allCommands.filter((c) => c.name.startsWith(q));
      const inside = allCommands.filter((c) => !c.name.startsWith(q) && c.name.includes(q.slice(1)));
      return [...starts, ...inside].map((c) => ({ label: c.name, detail: c.detail, insert: `${c.name} ` }));
    }
    const { token } = currentToken(text, cursor);
    if (token.startsWith('@')) {
      const q = token.slice(1).toLowerCase();
      // Name matches first, then path matches, shortest first.
      const scored = files.current.list
        .map((f) => {
          const l = f.toLowerCase();
          const base = l.slice(l.lastIndexOf('/') + 1);
          return { f, s: !q ? 2 : base.startsWith(q) ? 0 : base.includes(q) ? 1 : l.includes(q) ? 2 : -1 };
        })
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.f.length - b.f.length)
        .slice(0, 8);
      return scored.map(({ f }) => ({ label: f, insert: `@${f.includes(' ') ? `"${f}"` : f} ` }));
    }
    return [];
  };

  /** Text and images as the model gets them: @files attached, and what the user ran with ! in front. */
  function prepare(text: string, images: ImagePart[]): { text: string; images: ImagePart[] } {
    const { text: full, images: attached } = expandMentions(text, session.meta.cwd);
    const ran = shellNotes.current.splice(0);
    // What the user ran goes with the attached files, so their own words show (and edit) as they typed them.
    return { text: attach(full, ran), images: [...images, ...attached] };
  }

  async function submit(raw: string, images: ImagePart[]): Promise<void> {
    const text = raw.trim();
    if (!text && !images.length) return;
    if (text && !text.startsWith('/')) {
      addHistory(text, session.meta.cwd);
      setHistory((h) => [...h.filter((x) => x !== text), text].slice(-1000));
    }
    if (editing) return resend(text, images);
    if (text.startsWith('!') && text.length > 1) return shell(text.slice(1).trim());
    if (text.startsWith('/') && !text.startsWith('//')) {
      setHistory((h) => [...h.filter((x) => x !== text), text].slice(-1000));
      return command(text, images);
    }
    const msg = prepare(text.startsWith('//') ? text.slice(1) : text, images);
    session.send(msg.text, msg.images).catch((e) => notice('error', (e as Error).message));
  }

  /** The message being edited goes out again from where the original was: in its place, or in a new branch. */
  async function resend(text: string, images: ImagePart[]): Promise<void> {
    const target = editing!;
    setEditing(null);
    try {
      const { session: branch, restored } = await rt.branch(session, target.messageId, 'before', { undo: target.undo, replace: target.replace });
      const msg = prepare(text, images);
      const intro = [
        target.replace
          ? paint('violet', `↻ ${t('Message {n} sent again; the conversation after it is gone.', { n: target.n })}`)
          : paint('violet', `⎇ ${t('New branch from message {n} of “{t}”; /resume returns to the original.', { n: target.n, t: clip(session.meta.title || t('untitled'), 40) })}`),
      ];
      if (restored.length) intro.push(paint('brass', `↺ ${t('Put back {n} files: {f}', { n: restored.length, f: restored.map((f) => toForward(f)).join(', ') })}`));
      switchTo(branch, intro, () => branch.send(msg.text, msg.images).catch((e) => notice('error', (e as Error).message)));
    } catch (e) {
      notice('error', (e as Error).message);
    }
  }

  /** `!command`: run it here and now; its output goes to the model with the next message. */
  async function shell(cmd: string): Promise<void> {
    if (!cmd) return;
    const abort = new AbortController();
    setShellRun({ command: cmd, tail: '', started: Date.now(), abort });
    const r = await runShell(session.shell, cmd, {
      cwd: session.meta.cwd,
      timeoutMs: 10 * 60_000,
      signal: abort.signal,
      logFile: path.join(os.tmpdir(), `favilla-bang-${process.pid}.log`),
      env: agentEnv(),
      onData: (d) => setShellRun((s) => (s ? { ...s, tail: (s.tail + d).slice(-1500) } : s)),
    });
    setShellRun(null);
    push(
      toolBlock(
        '!',
        cmd,
        { type: 'tool_result', callId: 'bang', name: 'shell', content: r.output, isError: false, display: { kind: 'terminal', command: cmd, output: r.output, exitCode: r.exitCode, durationMs: r.durationMs, cwd: session.meta.cwd, timedOut: r.timedOut } },
        widthRef.current,
      ),
    );
    const out = r.output.length > 4000 ? `…${r.output.slice(-4000)}` : r.output;
    shellNotes.current.push(`I ran \`${cmd}\` myself (exit ${r.exitCode ?? 'none'}):\n\`\`\`\n${out.trimEnd()}\n\`\`\``);
    pushTight(paint('faint', `  ${t('The output goes to the agent with your next message.')}`));
  }

  /** Open a file in $VISUAL / $EDITOR (Notepad on Windows); the terminal is handed over until it closes. */
  async function editFile(file: string): Promise<boolean> {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    try {
      await app.suspendTerminal(async () => {
        // On Windows the editor is found through the shell, so the path is quoted for it.
        const win = process.platform === 'win32';
        spawnSync(editor, [win ? `"${file}"` : file], { stdio: 'inherit', shell: win });
      });
      return true;
    } catch (e) {
      notice('warn', t('Could not open the editor {e}: {n}', { e: editor, n: (e as Error).message }));
      return false;
    }
  }

  async function externalEdit(text: string): Promise<string | null> {
    const file = path.join(os.tmpdir(), `favilla-prompt-${process.pid}.md`);
    fs.writeFileSync(file, text);
    try {
      return (await editFile(file)) ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') : null;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** The rule files the model reads: yours for every project, and this project's at its root. */
  function openRules(): void {
    const global = appPath('AGENTS.md');
    const root = findRoot(session.meta.cwd);
    const known = ['AGENTS.md', 'CLAUDE.md', '.favilla/AGENTS.md'].map((n) => path.join(root, n)).find((f) => fs.existsSync(f));
    const project = known ?? path.join(root, 'AGENTS.md');
    const state = (f: string) => (fs.existsSync(f) ? t('{n} lines', { n: fs.readFileSync(f, 'utf8').split('\n').length }) : t('new file'));
    setPicker({
      title: t('Rules'),
      hint: t('enter opens it in your editor · the agent reads it again when you close it'),
      options: [
        { label: t('Yours, for every project'), detail: `${toForward(global)} · ${state(global)}`, value: global },
        { label: t('This project'), detail: `${toForward(project)} · ${state(project)}`, value: project },
      ],
      onPick: async (file) => {
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, '');
        }
        const before = fs.readFileSync(file, 'utf8');
        if (!(await editFile(file))) return;
        const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!after.trim() && !before.trim()) fs.rmSync(file, { force: true });
        if (after === before) return notice('info', t('The rules did not change.'));
        await session.reloadRules();
        notice('info', t('Rules saved; the agent follows them from its next step.'));
      },
    });
  }

  function lastAnswer(): string {
    const m = [...session.messages].reverse().find((x) => x.role === 'assistant' && x.parts.some((p) => p.type === 'text' && p.text.trim()));
    return m ? m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n\n').trim() : '';
  }

  function openRewind(): void {
    const users = session.messages.filter((m) => m.role === 'user' && m.origin === 'user' && !m.replay);
    if (!users.length) return notice('info', t('No earlier messages in this session.'));
    const turns = session.checkpoints.turns();
    const changedFrom = (m: Message) => {
      const at = m.turn ? turns.indexOf(m.turn) : -1;
      if (at < 0) return 0;
      return new Set(turns.slice(at).flatMap((x) => session.turnChanges(x).map((c) => c.path))).size;
    };
    const list = users.map((m, i) => ({ m, n: i + 1 })).reverse();
    setPicker({
      title: t('Go back to an earlier message'),
      hint: t('enter chooses · esc closes'),
      options: list.map(({ m, n }) => {
        const changed = changedFrom(m);
        return { label: `${n}. ${clip(userText(m).replace(/\s+/g, ' '), Math.max(20, width - 40))}`, detail: [fmtAgo(m.time), changed ? t('{n} files changed since', { n: changed }) : ''].filter(Boolean).join(' · '), value: m.id };
      }),
      onPick: (id) => {
        const hit = list.find((x) => x.m.id === id)!;
        const changed = changedFrom(hit.m);
        // Sent again in place, the conversation after it goes; in a new branch, it stays beside it.
        const actions = [
          ...(changed ? [{ label: t('Edit and send again, putting back the {n} files changed since', { n: changed }), value: 'undo' }] : []),
          { label: changed ? t('Edit and send again, leaving the files as they are') : t('Edit and send again'), value: 'keep' },
          ...(changed ? [{ label: t('Edit and send in a new branch, putting back the {n} files changed since', { n: changed }), value: 'branch-undo' }] : []),
          { label: changed ? t('Edit and send in a new branch, leaving the files as they are') : t('Edit and send in a new branch'), value: 'branch-keep' },
          { label: t('Branch after this exchange: a new session continues from its answer'), value: 'after' },
        ];
        setPicker({
          title: t('Message {n}', { n: hit.n }),
          hint: t('Sent again, the conversation after it goes; a new branch keeps it.'),
          options: actions,
          onPick: async (how) => {
            if (how === 'after') {
              try {
                const { session: branch } = await rt.branch(session, id, 'after');
                switchTo(branch, [paint('violet', `⎇ ${t('New branch after message {n}; /resume returns to the original.', { n: hit.n })}`)]);
              } catch (e) {
                notice('error', (e as Error).message);
              }
              return;
            }
            const original = withImages(structuredClone(hit.m), rt.store.blobs);
            const imgs = original.parts.filter((p): p is ImagePart => p.type === 'image' && !!p.data);
            setEditing({ messageId: id, undo: how.endsWith('undo'), replace: !how.startsWith('branch'), n: hit.n });
            setSeed({ text: userText(hit.m), images: imgs, nonce: Date.now() });
          },
        });
      },
    });
  }

  function sessionDiff(): DiffFile[] {
    // Each file once: as it was before the session first touched it, and as it is after the last change.
    const byPath = new Map<string, { before: string | null; after: string | null }>();
    for (const turn of session.checkpoints.turns())
      for (const c of session.turnChanges(turn)) {
        const cur = byPath.get(c.path);
        byPath.set(c.path, { before: cur ? cur.before : c.before, after: c.after });
      }
    return [...byPath.entries()].filter(([, v]) => v.before !== v.after).map(([p, v]) => makeDiff(p, v.before, v.after, v.before === null ? 'add' : v.after === null ? 'delete' : 'update'));
  }

  function openAgents(): void {
    const live = [...children.values()];
    const stored = rt.store.list({ children: true }).filter((m) => m.parentId === session.id);
    const ids = new Set([...live.map((c) => c.sessionId), ...stored.map((m) => m.id)]);
    if (!ids.size) return notice('info', t('No sub-agents in this session yet.'));
    const options = [...ids].map((id) => {
      const c = live.find((x) => x.sessionId === id);
      const m = stored.find((x) => x.id === id);
      const state = c ? (c.activity === 'done' ? t('done') : t('working')) : t('done');
      return { label: clip(c?.description ?? m?.title ?? id, 50), detail: [state, c ? t('{n} steps', { n: c.steps.length }) : '', c?.model ?? m?.model ?? '', m ? fmtAgo(m.updated) : ''].filter(Boolean).join(' · '), value: id };
    });
    setPicker({
      title: t('Sub-agents'),
      options,
      onPick: (id) => {
        const child = session.descendant(id);
        const messages = child?.messages ?? rt.store.load(id)?.messages ?? [];
        const title = options.find((o) => o.value === id)?.label ?? id;
        openPager(`⎇ ${title}`, transcriptLines(messages, rt.store.blobs, widthRef.current - 1), 'end');
      },
    });
  }

  function openSettings(): void {
    rt.refreshSettings();
    const cfg = rt.config;
    const opened = rt.globalSettings;
    const on = (b: boolean | undefined, dflt: boolean) => ((b ?? dflt) ? t('on') : t('off'));
    const langNames: Record<string, string> = { auto: t('follow the system'), ...LANGUAGE_NAMES };
    setPicker({
      title: t('Settings'),
      hint: t('enter changes · esc closes · the rest is in {n}', { n: toForward(appPath('config.json')) }),
      options: [
        { label: t('Language'), detail: langNames[cfg.language ?? 'auto'], value: 'language' },
        { label: t('Approvals for risky commands'), detail: { confirm: t('ask'), block: t('refuse'), off: t('run without asking') }[cfg.guard?.mode ?? 'confirm'], value: 'guard' },
        { label: t('Web search'), detail: on(cfg.webSearch !== false, true), value: 'webSearch' },
        { label: t('Agent browser window'), detail: cfg.browser?.visible ? t('on screen') : t('hidden'), value: 'browser' },
        { label: t('Language servers'), detail: on(cfg.languageServers, true), value: 'languageServers' },
      ],
      onPick: (key) => {
        const next: Record<string, unknown> = {};
        if (key === 'language') {
          // Ten languages are too many to step through: they are listed, each under its own name.
          setPicker({
            title: t('Language'),
            hint: t('enter changes · esc closes · the rest is in {n}', { n: toForward(appPath('config.json')) }),
            options: ['auto', ...LANGUAGES].map((v) => ({ label: langNames[v], detail: v === (cfg.language ?? 'auto') ? '✓' : undefined, value: v })),
            onPick: (v) => save({ language: v }, 'language'),
          });
          return;
        } else if (key === 'guard') {
          const order = ['confirm', 'block', 'off'] as const;
          next['guard.mode'] = order[(order.indexOf(cfg.guard?.mode ?? 'confirm') + 1) % order.length];
        } else if (key === 'webSearch') next.webSearch = cfg.webSearch === false;
        else if (key === 'browser') next['browser.visible'] = !cfg.browser?.visible;
        else if (key === 'languageServers') next.languageServers = cfg.languageServers === false;
        save(next, key);
      },
    });

    function save(next: Record<string, unknown>, key: string): void {
      try {
        updateGlobalConfig(next, [], settingBasis(opened, Object.keys(next).map((k) => k.split('.'))));
        if (rt.reload()) {
          if (key === 'language') setLang(setLanguage(String(next.language)));
          session.applySettings();
          openSettings();
        }
      } catch (e) {
        notice('warn', e instanceof SettingsConflict ? `${settingText(e.problem, t)} ${t('Open /settings again to load the file’s values.')}` : e instanceof SettingsError ? settingText(e.problem, t) : (e as Error).message);
      }
    }
  }

  function statusLines(): string[] {
    const m = session.modelInfo;
    const plans = (usage.plan?.windows ?? []).map(
      (w) => `${w.minutes === 10080 ? t('week') : w.minutes === 300 ? t('5 h') : `${Math.round(w.minutes / 60)} h`} ${Math.round(Math.max(0, 100 - w.usedPercent))}% ${t('left')}${w.resetAt ? paint('faint', ` · ${t('resets {n}', { n: new Date(w.resetAt).toLocaleString() })}`) : ''}`,
    );
    const mcp = rt.mcp.status();
    const row = (k: string, v: string) => `  ${paint('muted', padEnd(k, 10))} ${v}`;
    return [
      `${paint('blue', '◢')} ${bold('Favilla')} ${paint('faint', VERSION)}`,
      row(t('model'), `${m.name} ${paint('faint', `${m.ref} · ${fmtTokens(m.contextWindow)}`)}`),
      row(t('effort'), `${meta.effort}${m.efforts.length ? paint('faint', `  (${m.efforts.join(' ')})`) : ''}`),
      row(t('mode'), meta.mode === 'plan' ? t('plan') : t('default')),
      row(t('folder'), toForward(meta.cwd)),
      row(t('session'), `${meta.title || t('untitled')} ${paint('faint', session.id)}`),
      ...(meta.branchOf ? [row(t('branch of'), `${meta.branchOf.title} ${paint('faint', meta.branchOf.id)}`)] : []),
      ...plans.map((p, i) => row(i === 0 ? t('limits') : '', p)),
      row(t('approvals'), { confirm: t('ask'), block: t('refuse'), off: t('run without asking') }[rt.config.guard?.mode ?? 'confirm']),
      row(t('shell'), session.shell.name),
      row('MCP', mcp.length ? mcp.map((s) => `${s.name} ${s.state === 'ready' ? paint('green', `${s.tools.length}`) : paint('red', s.state)}`).join(', ') : t('none')),
      row(t('usage'), `${usage.requests} ${t('requests')} · in ${fmtTokens(usage.totalInput)} (${usage.totalInput ? Math.round((usage.cacheRead / usage.totalInput) * 100) : 0}% ${t('cached')}) · out ${fmtTokens(usage.totalOutput)}${usage.cost ? ` · $${usage.cost.toFixed(4)}` : ''}`),
    ];
  }

  async function command(line: string, images: ImagePart[]): Promise<void> {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    const custom = customs.find((c) => c.name === cmd);
    if (custom) {
      const msg = prepare(expandCustom(custom, arg), images);
      session.send(msg.text, msg.images).catch((e) => notice('error', (e as Error).message));
      return;
    }
    switch (cmd) {
      case '/exit':
      case '/quit':
        return quit();
      case '/help':
        return push(
          [
            bold(t('Keys')),
            `  ${t('enter sends · shift+enter, alt+enter or ctrl+j adds a line · \\ at the end of a line + enter too')}`,
            `  ${t('esc stops the agent · esc esc goes back to an earlier message · shift+tab switches default and plan')}`,
            `  ${t('alt+v pastes a picture (ctrl+v outside Windows) · drop an image file in to attach it · @path attaches a file')}`,
            `  ${t('↑/↓ history · ctrl+r searches it · ctrl+g edits in $EDITOR · ctrl+t the whole transcript')}`,
            `  ${t('!command runs it now and gives the output to the agent · type while it works to queue a message (↑ takes it back)')}`,
            `  ${t('ctrl+c twice quits')}`,
            bold(t('Commands')),
            ...allCommands.map((c) => `  ${c.name.padEnd(12)} ${dim(c.detail)}`),
            paint('faint', `  ${t('Your own commands: markdown files in ~/.favilla/commands or .favilla/commands; $ARGUMENTS takes what follows.')}`),
          ].join('\n'),
        );
      case '/model': {
        if (arg) return switchModel(arg);
        const options: Picker['options'] = [];
        const ready = rt.catalog.providers().filter((p) => rt.catalog.isConfigured(p));
        // The providers are asked again side by side, and the list shows what is known after two seconds at most:
        // asked one after another, a relay timing out held it half a minute (2026-11-07). Later answers are kept for
        // the next time.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(ready.map((p) => rt.catalog.discover(p.id).catch(() => []))), new Promise((r) => (timer = setTimeout(r, 2000)))]);
        clearTimeout(timer);
        for (const p of ready) {
          let models: ModelInfo[] = [];
          try {
            models = rt.catalog.models(p.id);
          } catch {
            /* removed meanwhile */
          }
          for (const m of models) options.push({ label: m.ref, detail: `${fmtTokens(m.contextWindow)} · ${m.name}${m.ref === session.modelInfo.ref ? ` · ${t('current')}` : ''}`, value: m.ref });
        }
        if (!options.length) return notice('warn', t('No configured providers. Set an API key in /settings or in its environment variable.'));
        return setPicker({ title: t('Switch model'), options, onPick: (v) => switchModel(v) });
      }
      case '/effort': {
        const efforts = session.modelInfo.efforts;
        if (!efforts.length) return notice('info', t('This model has no reasoning effort setting.'));
        if (arg) return session.setEffort(arg as Effort);
        return setPicker({ title: t('Reasoning effort'), options: efforts.map((x) => ({ label: x, value: x, detail: x === meta.effort ? t('current') : undefined })), onPick: (v) => session.setEffort(v as Effort) });
      }
      case '/plan':
        return session.setMode(meta.mode === 'plan' ? 'build' : 'plan');
      case '/rewind':
        return openRewind();
      case '/fork':
      case '/branch': {
        const last = [...session.messages].reverse().find((m) => m.role === 'user' && m.origin === 'user');
        if (!last) return notice('info', t('Nothing to copy yet.'));
        try {
          const branch = await rt.fork(session, last.id, 'after');
          switchTo(branch, [paint('violet', `⎇ ${t('Continuing in a copy of “{t}”; /resume returns to the original.', { t: clip(session.meta.title || t('untitled'), 40) })}`)]);
        } catch (e) {
          notice('error', (e as Error).message);
        }
        return;
      }
      case '/diff': {
        const diff = sessionDiff();
        if (!diff.length) return notice('info', t('This session has not changed any files (in this run).'));
        const added = diff.reduce((n, f) => n + f.added, 0);
        const removed = diff.reduce((n, f) => n + f.removed, 0);
        return openPager(`${t('Changes in this session')}  ${plus(added)} ${minus(removed)}`, diffLines(diff, widthRef.current - 1, 0), 'top');
      }
      case '/transcript':
        return openPager(t('Transcript'), transcriptLines(session.messages, rt.store.blobs, widthRef.current - 1), 'end');
      case '/agents':
        return openAgents();
      case '/rules':
      case '/memory':
        return openRules();
      case '/persona': {
        const done = personaCommand(arg, session.meta.cwd);
        push(done.text);
        if (done.changed) await session.reloadRules();
        return;
      }
      case '/preset': {
        const done = presetCommand(arg, session.meta.cwd);
        push(done.text);
        if (done.changed) await session.reloadRules();
        return;
      }
      case '/copy': {
        const text = lastAnswer();
        if (!text) return notice('info', t('No answer to copy yet.'));
        return notice('info', (await copyText(text)) ? t('Copied the last answer ({n} characters).', { n: text.length }) : t('Could not reach the clipboard.'));
      }
      case '/export': {
        const title = (session.meta.title || 'session').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
        const file = arg ? path.resolve(session.meta.cwd, arg) : appPath('exports', `${title}-${session.id}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, transcriptMarkdown(session.messages, rt.store.blobs, session.meta));
        return notice('info', t('Saved the conversation to {n}', { n: toForward(file) }));
      }
      case '/context':
        return push(contextLines(session.contextReport(), widthRef.current).join('\n'));
      case '/status':
        return push(statusLines().join('\n'));
      case '/settings':
        return openSettings();
      case '/compact':
        push(paint('faint', `~ ${t('compacting…')}`));
        await session.compact('manual');
        return;
      case '/review':
      case '/init': {
        const msg = prepare(cmd === '/review' ? PROMPTS.review(arg) : PROMPTS.init(), images);
        session.send(msg.text, msg.images).catch((e) => notice('error', (e as Error).message));
        return;
      }
      case '/undo': {
        const turns = session.checkpoints.turns();
        const target = turns[turns.length - 1];
        if (!target) return notice('info', t('No file changes to undo.'));
        const restored = await session.undoFiles(target);
        return push(paint('brass', `↺ ${t('Put back {n} files: {f}', { n: restored.length, f: restored.map((f) => toForward(f)).join(', ') })}`));
      }
      case '/new': {
        const s = await rt.start({ cwd: session.meta.cwd, model: `${meta.provider}/${meta.model}`, effort: meta.effort, interactive: true });
        return switchTo(s);
      }
      case '/resume': {
        const list = rt.store.list({ cwd: session.meta.cwd, limit: 50 }).filter((m) => m.id !== session.id);
        if (!list.length) return notice('info', t('No other sessions in this folder.'));
        return setPicker({
          title: t('Resume a session'),
          options: list.map((m) => ({ label: `${m.branchOf ? '⎇ ' : ''}${m.title || t('untitled')}`, detail: `${fmtAgo(m.updated)} · ${m.model}`, value: m.id })),
          onPick: async (id) => switchTo(await rt.get(id, { interactive: true })),
        });
      }
      case '/cost': {
        const u = session.usage;
        const hit = u.totalInput ? Math.round((u.cacheRead / u.totalInput) * 100) : 0;
        return push(`${bold(t('Usage'))}  ${t('{n} requests', { n: u.requests })} · in ${fmtTokens(u.totalInput)} (${hit}% ${t('cached')}) · out ${fmtTokens(u.totalOutput)}${u.cost ? ` · $${u.cost.toFixed(4)}` : ''}`);
      }
      default:
        return notice('warn', t('Unknown command {n}. /help lists them; // at the start sends a message that begins with /.', { n: cmd }));
    }
  }

  async function switchModel(ref: string): Promise<void> {
    try {
      const done = await session.setModel(ref);
      push(paint('faint', done === 'held' ? t('{n} takes over once this turn stops.', { n: ref }) : `${t('model')} → ${ref}`));
    } catch (e) {
      notice('error', (e as Error).message);
    }
  }

  function quit(): void {
    terminalState('', false);
    rt.dispose();
    app.exit();
  }

  const busy = status !== 'idle';
  const prompting = !!(permission || question || plan || picker || pager);

  // One stop ends the turn and every sub-agent, the ones in the background too.
  const ctrlC = () => {
    if (shellRun) return shellRun.abort.abort();
    if (busy || background) return session.abort();
    if (armed?.what === 'quit' && Date.now() - armed.at < DOUBLE_MS) return quit();
    setArmed({ what: 'quit', at: Date.now() });
  };
  const escape = (empty: boolean) => {
    if (shellRun) return shellRun.abort.abort();
    if (busy || background) return session.abort();
    if (editing) {
      setEditing(null);
      setSeed({ text: '', nonce: Date.now() });
      return notice('info', t('Edit cancelled.'));
    }
    const what = empty ? 'esc-empty' : 'esc-text';
    if (armed?.what === what && Date.now() - armed.at < DOUBLE_MS) {
      setArmed(null);
      if (empty) return openRewind();
      return setSeed({ text: '', nonce: Date.now() });
    }
    setArmed({ what, at: Date.now() });
  };
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), DOUBLE_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // While a prompt has the keys, ctrl+c still stops the agent.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') ctrlC();
    },
    { isActive: prompting && !pager },
  );

  const upEmpty = (): boolean => {
    const last = queue[queue.length - 1];
    if (last) {
      const back = session.withdraw(last.id);
      if (back) {
        setSeed({ text: back.text, images: back.images, nonce: Date.now() });
        return true;
      }
    }
    if (returned.current.length) {
      const r = returned.current.splice(0);
      setSeed({ text: r.map((x) => x.text).join('\n\n'), images: r.flatMap((x) => x.images), nonce: Date.now() });
      return true;
    }
    return false;
  };

  // First prompt from the command line.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !opts.prompt) return;
    started.current = true;
    void submit(opts.prompt, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The scrollback stays mounted under the reader: a <Static> mounted again would print everything once more.
  if (pager)
    return (
      <Box flexDirection="column">
        <Static key={epoch} items={items}>
          {(it) => <Printed key={it.id} it={it} />}
        </Static>
        <Pager title={pager.title} lines={pager.lines} width={width} height={height - 1} start={pager.start} onClose={closePager} />
      </Box>
    );

  // The live part stays shorter than the screen, or the terminal would redraw all of it on every frame.
  const active = [...children.values()].filter((c) => c.activity !== 'done');
  const reserved = 8 + running.size * 2 + Math.min(active.length, 6) + Math.min(queue.length, 3) + (prompting ? 12 : 0);
  const liveRows = Math.max(4, height - reserved);
  const live = renderLive(stream.current, width, liveRows);
  const ctxPct = usage.contextWindow ? Math.round((usage.contextTokens / usage.contextWindow) * 100) : 0;
  const plans = (usage.plan?.windows ?? []).map((w) => ` · ${w.minutes === 10080 ? t('week') : w.minutes % 1440 === 0 ? `${w.minutes / 1440}d` : `${Math.round(w.minutes / 60)}h`} ${Math.round(Math.max(0, 100 - w.usedPercent))}%`).join('');
  const elapsed = turnStart ? fmtDuration(Date.now() - turnStart) : '';
  const statusText =
    status === 'compacting' ? t('Compacting context') : status === 'retrying' ? t('Retrying') : status === 'checking' ? t('Checking the answer covers every request') : status === 'shadow-tests' ? t('Running the shadow tests another model wrote from the request') : status === 'auditing' ? t('Measuring the page at desktop and phone width') : status === 'thinking' ? t('Thinking; this model does not show its thoughts') : status === 'waiting' ? t('Waiting for you') : t('Working');
  const hint = armed?.what === 'quit' ? t('press ctrl+c again to quit') : armed?.what === 'esc-empty' ? t('esc again: go back to an earlier message') : armed?.what === 'esc-text' ? t('esc again: clear the input') : '';

  return (
    <Box flexDirection="column">
      <Static key={epoch} items={items}>
        {(it) => <Printed key={it.id} it={it} />}
      </Static>
      {live ? <Text>{live}</Text> : null}
      {[...running.entries()].map(([id, r]) => (
        <Box key={id} flexDirection="column">
          <Text wrap="truncate-end">
            {paint('blue', SPIN[frame % SPIN.length])} {bold(toolLabel(r.name))} {paint('muted', clip(bareTitle(r.name, r.title), width - cols(toolLabel(r.name)) - 14))} {paint('faint', fmtDuration(Date.now() - r.started))}
          </Text>
          {r.tail ? (
            <Text wrap="truncate-end">
              {r.tail
                .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
                .split(/\r?\n/)
                .filter((l) => l.trim())
                .slice(-3)
                .map((l) => paint('faint', `    ${clip(l, width - 6)}`))
                .join('\n')}
            </Text>
          ) : null}
        </Box>
      ))}
      {active.length ? <Text wrap="truncate-end">{childLines(active, width, frame).join('\n')}</Text> : null}
      {shellRun ? (
        <Text wrap="truncate-end">
          {paint('blue', SPIN[frame % SPIN.length])} {bold('!')} {paint('muted', clip(shellRun.command, width - 20))} {paint('faint', fmtDuration(Date.now() - shellRun.started))}
          {shellRun.tail ? `\n${shellRun.tail.split(/\r?\n/).filter((l) => l.trim()).slice(-3).map((l) => paint('faint', `    ${clip(l, width - 6)}`)).join('\n')}` : ''}
        </Text>
      ) : null}
      {busy && todos.some((x) => x.status !== 'completed') ? <Text>{todoLines(todos).map((l) => `  ${l}`).join('\n')}</Text> : null}
      {permission && <PermissionPrompt req={permission} onDecide={(d) => session.respondPermission(permission.id, d)} />}
      {question && <QuestionPrompt req={question} onAnswer={(a) => session.answerQuestion(question.id, a)} />}
      {plan && <PlanPrompt plan={plan.plan} width={width} onDecide={(ok, fb) => session.respondPlan(plan.id, ok, fb)} />}
      {picker && (
        <PickerView
          picker={picker}
          height={height}
          onClose={() => setPicker(null)}
          onPick={(v) => {
            setPicker(null);
            picker.onPick(v);
          }}
        />
      )}
      {busy && !prompting ? (
        <Text wrap="truncate-end">
          {paint('blue', SPIN[frame % SPIN.length])} {paint('muted', statusText)}
          {paint('faint', ` ${elapsed} · ${t('esc to interrupt')}${status === 'running' ? ` · ${t('type to queue a message')}` : ''}`)}
        </Text>
      ) : background && !prompting ? (
        <Text wrap="truncate-end">
          {paint('blue', SPIN[frame % SPIN.length])} {paint('muted', t('{n} sub-agents in the background', { n: background }))}
          {paint('faint', ` · ${t('the agent goes on when they are done')} · ${t('esc stops them')}`)}
        </Text>
      ) : null}
      {queue.slice(-3).map((q) => (
        <Text key={q.id} wrap="truncate-end">
          {paint('faint', `  ↳ ${t('queued')}: `)}
          {paint('muted', clip(q.text.replace(/\s+/g, ' '), width - 30))}
          {q.images ? paint('violet', ` [${q.images}]`) : ''}
          {q === queue[queue.length - 1] ? paint('faint', `  ${t('↑ takes it back')}`) : ''}
        </Text>
      ))}
      <Box height={1} />
      {editing ? <Text wrap="truncate-end">{paint('violet', `✎ ${t(editing.replace ? 'Editing message {n}: enter sends it again in its place · esc cancels' : 'Editing message {n}: enter sends it in a new branch from there · esc cancels', { n: editing.n })}`)}</Text> : null}
      <Editor
        active={!prompting}
        width={width}
        cwd={session.meta.cwd}
        placeholder={
          busy
            ? t('Queue a message for the agent…')
            : meta.mode === 'plan'
              ? t('What should change? Nothing is touched until you approve the plan.')
              : t('Ask, or describe a change. @ attaches files, / for commands, alt+v pastes a picture')
        }
        history={history}
        seed={seed}
        onSubmit={(text, images) => void submit(text, images)}
        onEscape={escape}
        onCtrlC={ctrlC}
        onShiftTab={() => session.setMode(meta.mode === 'build' ? 'plan' : 'build')}
        onTranscript={() => openPager(t('Transcript'), transcriptLines(session.messages, rt.store.blobs, widthRef.current - 1), 'end')}
        onUpEmpty={upEmpty}
        onExternalEdit={externalEdit}
        onNotice={notice}
        suggest={suggest}
        maxRows={Math.max(3, Math.min(12, height - 14))}
      />
      <Text wrap="truncate-end">
        {paint('faint', ' ')}
        {paint('muted', meta.model)}
        {paint('faint', ` · ${meta.effort}`)}
        {meta.mode === 'plan' ? paint('brass', ` · ${t('plan mode')}`) : ''}
        {meta.branchOf ? paint('violet', ` · ⎇ ${t('branch')}`) : ''}
        {meta.goal?.criteria.length ? paint('blue', ` · ☑ ${meta.goal.criteria.filter((c) => c.done).length}/${meta.goal.criteria.length}`) : ''}
        {active.length ? paint('violet', ` · ⎇ ${active.length}`) : ''}
        {paint(ctxPct > 80 ? 'brass' : 'faint', ` · ctx ${ctxPct}%`)}
        {paint('faint', `${usage.cost ? ` · $${usage.cost.toFixed(3)}` : ''}${plans}`)}
        {hint ? paint('brass', ` · ${hint}`) : paint('faint', ` · ${clip(homePath(meta.cwd), 40)}`)}
      </Text>
    </Box>
  );
}

function Printed({ it }: { it: Item }) {
  return (
    <Box marginTop={it.tight ? 0 : 1}>
      <Text>{it.text}</Text>
    </Box>
  );
}

/** What opening a session prints: the banner, notes about how it was opened, and its conversation so far. */
function opening(s: Session, rt: Runtime, width: number, intro: string[] = []): Item[] {
  const head = [banner(s, width), ...(s.shell.fallback ? [noticeBlock('warn', s.shell.fallback)] : []), ...intro];
  return [...head.map((x) => item(x, true)), ...replayItems(s.messages, rt.store.blobs, width, 40).map((x) => item(x))];
}

function banner(session: Session, width: number): string {
  const m = session.modelInfo;
  const line = paint('faint', '─'.repeat(Math.min(width, 72)));
  return [
    `${paint('blue', '◢')} ${bold('Favilla')} ${paint('faint', VERSION)}  ${paint('muted', `${m.name} · ${m.ref} · ${fmtTokens(m.contextWindow)}`)}`,
    paint('faint', clip(`  ${homePath(session.meta.cwd)}`, width)),
    paint('faint', clip(`  ${t('/help for keys and commands · alt+v pastes a picture · esc esc goes back')}`, width)),
    line,
  ].join('\n');
}

/** The part of the reply not printed yet: reasoning as a short running line, text as markdown, tool calls as they are written. */
function renderLive(s: Stream | null, width: number, maxRows: number): string {
  if (!s) return '';
  const out: string[] = [];
  let i = 0;
  for (const [, p] of [...s.parts.entries()].sort((a, b) => a[0] - b[0])) {
    if (p.kind === 'reasoning') {
      if (i++ < s.reasoningShown || !p.text.trim()) continue;
      const flat = p.text.replace(/\s+/g, ' ').trim();
      out.push(dim(paint('muted', `✻ ${flat.length > width * 2 ? `…${flat.slice(-(width * 2 - 4))}` : flat}`)));
    } else if (p.kind === 'text') {
      const rest = p.text.slice(p.done);
      if (rest.trim()) out.push(renderMarkdown(rest, width));
    } else if (p.kind === 'tool') out.push(paint('faint', `◌ ${p.name ?? 'tool'} ${clip(streamingArg(p.text), width - 20)}`));
  }
  return tail(out.filter(Boolean).join('\n\n'), maxRows, (n) => paint('faint', t('… {n} lines above, printed in full when this part is done', { n })));
}

export async function runTui(rt: Runtime, opts: TuiOptions): Promise<void> {
  setLanguage(rt.config.language);
  let session: Session;
  try {
    session = opts.resume
      ? await rt.get(opts.resume, { interactive: true, model: opts.model })
      : await rt.start({ cwd: opts.cwd, model: opts.model, effort: opts.effort, mode: opts.mode, interactive: true });
  } catch (e) {
    if (e instanceof SettingsError) printSettingError(e.problem);
    else console.error((e as Error).message);
    exitProcess(1);
    return;
  }
  rt.housekeeping();
  const ink = render(<App rt={rt} initial={session} opts={opts} />, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 30,
    kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
  });
  await ink.waitUntilExit();
  await rt.shutdown();
  exitProcess(0);
}

export { App };
