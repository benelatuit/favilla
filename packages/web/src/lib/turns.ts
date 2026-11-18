import type { Message, ToolResultPart } from './types';
import { plainTitle } from './format';
import { pictureSrc } from './markdown';

/** A finished turn as its restore point shows it: what its answer says first, and a picture of what it made. */
interface TurnFace {
  said: string;
  picture?: { src: string; name: string };
}

/**
 * The face of a turn: the first sentence of its answer (the answer's first line says what is now true), and the
 * picture its answer shows, else the last picture one of its steps took (a screenshot, a render).
 */
export function turnFace(messages: Message[], turn: string, results: Map<string, ToolResultPart>, session?: string): TurnFace {
  const own = messages.filter((m) => m.turn === turn && !m.replay);
  const answer = [...own].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text' && p.text.trim()));
  const text = answer ? answer.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : '';
  const first = text
    .split('\n')
    .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim())
    .find((l) => l && !l.startsWith('|') && !l.startsWith('```'));
  const said = plainTitle((first ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
  const shown = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(text);
  if (shown) return { said, picture: { src: pictureSrc(shown[2], session, answer?.id), name: shown[1] || said } };
  for (const m of [...own].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== 'tool_call') continue;
      const shot = (results.get(p.id)?.images ?? []).filter((i) => i.url).at(-1);
      if (shot) return { said, picture: { src: shot.url!, name: shot.name ?? said } };
    }
  }
  return { said };
}

/** What folding a turn needs to know of a timeline item: the user's messages, the turn's answer, runs of steps. */
interface TurnItem {
  kind: string;
  key: string;
  /** The turn's answer: its last piece of text. */
  final?: boolean;
  /** Whether the reply that text is in ended as a reply does (not cut, stopped or failed, nor calling tools). */
  ended?: boolean;
  /** A run of steps, tools and thoughts. */
  steps?: { kind: string }[];
  /** The answer's figures are on the folded line above it, not under it. */
  lined?: boolean;
}

/** A finished turn's work, from the user's message to the turn's answer. */
export interface Work<T> {
  kind: 'work';
  key: string;
  items: T[];
  /** The turn's answer, right under this fold: the line carries what the turn took and changed. */
  answer?: T;
}

/**
 * Finished turns: everything between the user's message and the turn's answer (the steps and the notes between them)
 * folds into one item, while mid-turn user steers, compaction dividers, and refusals stay in view on the timeline. A
 * turn without an answer or without a tool step stays as it is, and so does the last turn unless `finished` says it
 * has ended (the next user message, or the session gone idle). The fold right above the answer takes the answer along,
 * and the answer is marked `lined`: its figures are on the fold's line.
 */
export function foldTurns<T extends TurnItem>(items: T[], finished = false): (T | Work<T>)[] {
  const out: (T | Work<T>)[] = [];
  const hasTool = (seg: T[]) => seg.some((x) => x.kind === 'process' && x.steps?.some((s) => s.kind === 'tool'));
  for (let i = 0; i < items.length; ) {
    const it = items[i++];
    out.push(it);
    if (it.kind !== 'user') continue;
    let end = i;
    while (end < items.length && items[end].kind !== 'user') end++;
    if (end === items.length && !finished) continue;
    // A turn that ended on a note before a failure or a stop has no answer: it stays open.
    const answer = items.slice(i, end).findIndex((x) => x.kind === 'text' && x.final && x.ended !== false);
    const work = items.slice(i, i + Math.max(0, answer));
    if (!hasTool(work)) continue;
    let run: T[] = [];
    const flush = () => {
      if (!run.length) return;
      if (hasTool(run)) out.push({ kind: 'work', key: `w:${run[0].key}`, items: run });
      else out.push(...run);
      run = [];
    };
    for (const x of work) {
      if (x.kind === 'steer' || x.kind === 'compaction' || x.kind === 'refusal') {
        flush();
        out.push(x);
      } else {
        run.push(x);
      }
    }
    flush();
    i += work.length;
    const last = out[out.length - 1];
    if (last?.kind === 'work') {
      // A copy: the item given may be drawn elsewhere as it was (a cached build of the same turn).
      const reply = { ...items[i++], lined: true };
      (last as Work<T>).answer = reply;
      out.push(reply);
    }
  }
  return out;
}
