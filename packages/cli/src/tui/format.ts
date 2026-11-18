import path from 'node:path';
import wrapAnsi from 'wrap-ansi';
import { toForward, type ContextReport, type DiffFile, type Goal, type Message, type ToolResultPart, type Todo } from '@favilla/core';
import { guardReason } from '@favilla/core/guard/i18n';
import { added as plus, bold, dim, ground, link, paint, removed as minus } from './theme';
import { highlight, renderMarkdown } from './markdown';
import { t } from './i18n';
import { clip, cols, padEnd, strip } from './text';

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "3 minutes ago" style, for lists of sessions and messages. */
export function fmtAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86_400) return t('{n} h ago', { n: Math.floor(s / 3600) });
  return t('{n} d ago', { n: Math.floor(s / 86_400) });
}

/**
 * A message the user sent: wrapped to the terminal width before padding so every visual row carries an unbroken
 * background band even at 60 columns.
 */
export function userBlock(text: string, images: number, width: number): string {
  const bodyWidth = Math.max(10, width - 3);
  const body: string[] = [];
  const paragraphs = text.split('\n');
  for (let p = 0; p < paragraphs.length; p++) {
    const line = paragraphs[p];
    const wrapped = cols(line) <= bodyWidth ? [line] : wrapAnsi(line, bodyWidth, { hard: true, trim: false }).split('\n');
    for (let i = 0; i < wrapped.length; i++) {
      const lead = p === 0 && i === 0 ? '› ' : '  ';
      body.push(ground('user', padEnd(`${paint('blue', lead)}${paint('ink', wrapped[i])}`, width)));
    }
  }
  if (images) body.push(ground('user', padEnd(`  ${paint('violet', images === 1 ? t('[1 image]') : t('[{n} images]', { n: images }))}`, width)));
  return body.join('\n');
}

export function textBlock(text: string, width: number): string {
  return renderMarkdown(text, width);
}

/** Reasoning, folded to its start: the whole of it is in the transcript (ctrl+t). A title in ** is shown bare. */
export function thinkingBlock(text: string, width: number): string {
  const flat = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return dim(paint('muted', `✻ ${clip(flat, width * 2)}`));
}

const EXT_LANG: Record<string, string> = { '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css', '.html': 'xml', '.json': 'json', '.md': 'markdown', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.sql': 'sql', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift' };

/**
 * A patch as the terminal shows it: line numbers of the new file, added lines bright with + on their own ground,
 * removed ones dim with -, the rest highlighted for its language in greys. Long lines wrap with an 8-column hanging
 * indent so narrow 60-column terminals keep full-width ground shading without breaking into the gutter.
 */
export function diffLines(files: DiffFile[], width: number, max = 14): string[] {
  const out: string[] = [];
  const codeWidth = Math.max(10, width - 8);
  const hang = '        ';
  let shown = 0;
  for (const f of files) {
    if (f.binary || files.length > 1 || max === 0) {
      const op = f.op === 'add' ? t('added') : f.op === 'delete' ? t('deleted') : f.op === 'move' ? t('moved') : t('changed');
      out.push(`${paint('muted', op)} ${bold(f.movedTo ?? f.path)}  ${f.binary ? t('Binary file: {before} → {after} bytes', f.binary) : `${plus(f.added)} ${minus(f.removed)}`}`);
    }
    if (f.binary) continue;
    const lang = EXT_LANG[path.extname(f.movedTo ?? f.path).toLowerCase()];
    let newLine = 0;
    let oldLine = 0;
    for (const line of f.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        if (shown && (!max || shown < max)) out.push(paint('faint', '      ⋯'));
        continue;
      }
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) continue;
      if (max && shown >= max) continue;
      const code = line.slice(1).replace(/\t/g, '  ');
      const fits = cols(code) <= codeWidth;
      if (line.startsWith('+')) {
        const lit = lang ? highlight(code, lang) : paint('code', code);
        const rows = fits ? [lit] : wrapAnsi(lit, codeWidth, { hard: true, trim: false }).split('\n');
        rows.forEach((row, idx) => {
          const prefix = idx === 0 ? `${paint('faint', String(newLine).padStart(5))} ${paint('green', '+')} ` : hang;
          out.push(ground('added', padEnd(`${prefix}${row}`, width)));
        });
      } else if (line.startsWith('-')) {
        // A removed line is plain and dim through and through: a bold keyword inside would end the dim halfway.
        const rows = fits ? [code] : wrapAnsi(code, codeWidth, { hard: true, trim: false }).split('\n');
        rows.forEach((row, idx) => {
          out.push(idx === 0 ? `${paint('faint', String(oldLine).padStart(5))} ${dim(paint('muted', `- ${row}`))}` : `${hang}${dim(paint('muted', row))}`);
        });
      } else {
        const lit = lang ? highlight(code, lang) : paint('code', code);
        const rows = fits ? [lit] : wrapAnsi(lit, codeWidth, { hard: true, trim: false }).split('\n');
        rows.forEach((row, idx) => {
          out.push(idx === 0 ? `${paint('faint', String(newLine).padStart(5))}   ${row}` : `${hang}${row}`);
        });
      }
      if (!line.startsWith('-')) newLine++;
      if (!line.startsWith('+')) oldLine++;
      shown++;
    }
  }
  const total = files.reduce((n, f) => n + f.added + f.removed, 0);
  if (max && shown >= max && total > max) out.push(paint('faint', `      ${t('… {n} more changed lines · /diff shows all', { n: total - max })}`));
  return out;
}

export function todoLines(todos: Todo[]): string[] {
  return todos.map((x) =>
    x.status === 'completed' ? paint('green', `☑ ${dim(x.content)}`) : x.status === 'in_progress' ? paint('blue', `◼ ${bold(x.activeForm || x.content)}`) : paint('muted', `☐ ${x.content}`),
  );
}

/** The agent's criteria: the objective with the count met, then each criterion and how it was shown to be met. */
function goalLines(g: Goal): string[] {
  const done = g.criteria.filter((c) => c.done).length;
  return [
    `${paint('blue', '☑')} ${bold(g.objective)}${g.criteria.length ? paint('faint', `  ${done}/${g.criteria.length}`) : ''}`,
    ...g.criteria.map((c, i) =>
      c.done
        ? `${paint('green', `  ☑ ${dim(c.text)}`)}${c.evidence ? paint('faint', `  ← ${clip(c.evidence, 60)}`) : ''}`
        : g.active === i + 1
          ? paint('blue', `  ◼ ${c.text}`)
          : paint('muted', `  ☐ ${c.text}`),
    ),
  ];
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export const toolLabel = (name: string): string => (name === 'brief' ? t('Brief') : name);

export type CliToolOutcome = 'ok' | 'failed' | 'denied' | 'cancelled';

/**
 * Exact English phrases @favilla/core writes into ToolResultPart.content for user interruptions and guard/policy
 * refusals. Guarded by a contract test against packages/core/src/{agent/session,tools/shell-tools,guard/i18n}.ts.
 */
export const CLI_CORE_STEP_PHRASES = {
  cancelledExact: ['Interrupted.', 'Interrupted by the user before it ran.'] as const,
  cancelledContains: ['Interrupted by the user.'] as const,
  deniedPrefixes: [
    'The user did not allow this command (',
    'Not run: ',
    'Plan mode is on, so ',
    'This run stays inside its folder (',
  ] as const,
};

export function toolOutcome(r: ToolResultPart): CliToolOutcome {
  const text = (r.content ?? '').trim();
  if ((CLI_CORE_STEP_PHRASES.cancelledExact as readonly string[]).includes(text)) return 'cancelled';
  if (CLI_CORE_STEP_PHRASES.cancelledContains.some((s) => text.includes(s))) return 'cancelled';
  if (CLI_CORE_STEP_PHRASES.deniedPrefixes.some((p) => text.startsWith(p))) return 'denied';
  if (r.isError || (r.display?.kind === 'terminal' && !!r.display.exitCode)) return 'failed';
  return 'ok';
}

/** Clean user-facing reason for a denied or cancelled tool call, without model-facing steering instructions. */
export function toolOutcomeDetail(r: ToolResultPart): string {
  const text = (r.content ?? '').trim();
  if (!text) return '';
  if (text === 'Interrupted.' || text === 'Interrupted by the user.' || text === 'Interrupted by the user before it ran.') return '';
  const denied = /^The user did not allow this command \(([\s\S]+?)\)\.\s*Don't run it; find another way or ask the user\.$/.exec(text);
  if (denied) return guardReason(t, denied[1]);
  const catastrophe = /^Not run: ([\s\S]+?)\.\s*Ask the user about this exact target; do not try another command to do the same thing\.$/.exec(text);
  if (catastrophe) {
    return catastrophe[1]
      .split('; ')
      .map((part) => {
        const sentence = part.endsWith('.') ? part : `${part}.`;
        return guardReason(t, sentence);
      })
      .join(' ');
  }
  if (text.startsWith('Plan mode is on, so ')) {
    const clean = text
      .replace(/\s*Finish the plan and present it for approval first\.$/, '')
      .replace(/\s*Tests, builds and commands that only look are fine; the rest waits for an approved plan\.$/, '');
    return t(clean);
  }
  if (text.startsWith('This run stays inside its folder (')) {
    return text.replace(/\s*Work with what is in the folder; a skill's SKILL\.md is read with the read tool\.$/, '');
  }
  return text.split('\n').slice(0, 2).join(' ');
}

const READ_ONLY_TOOLS = new Set([
  'read',
  'read_file',
  'Read',
  'view_image',
  'grep',
  'Grep',
  'search',
  'glob',
  'Glob',
  'list',
  'web_fetch',
  'WebFetch',
  'web_search',
  'WebSearch',
]);

export function isReadOnlyCliCall(name: string, r: ToolResultPart): boolean {
  return READ_ONLY_TOOLS.has(name) && toolOutcome(r) === 'ok';
}

/** Compact one-line summary for 2+ consecutive read-only steps in replayed conversations. */
export function compactLookBlock(calls: { name: string; title: string }[], width: number): string {
  const label = t('explored');
  const count = t('{n} steps', { n: calls.length });
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const c of calls) {
    const b = bareTitle(c.name, c.title).trim();
    if (b && !seen.has(b)) {
      seen.add(b);
      targets.push(b);
    }
  }
  const detail = targets.join(' · ');
  const room = Math.max(10, width - cols(label) - cols(count) - 7);
  return `${paint('muted', '●')} ${bold(label)} ${paint('faint', count)}${detail ? `  ${paint('muted', clip(detail, room))}` : ''}`;
}

/** One finished tool call: a header line and a few lines that show what happened. */
export function toolBlock(name: string, title: string, r: ToolResultPart, width: number): string {
  const outcome = toolOutcome(r);
  const d = r.display;
  let meta = '';
  let body: string[] = [];
  const line = (s: string) => dim(clip(s, Math.max(10, width - 6)));
  switch (d?.kind) {
    case 'diff': {
      const added = d.files.reduce((n, f) => n + f.added, 0);
      const removed = d.files.reduce((n, f) => n + f.removed, 0);
      meta = d.files.every((f) => f.binary) ? '' : removed ? `${plus(added)} ${minus(removed)}` : plus(added);
      body = diffLines(d.files, Math.max(20, width - 4));
      break;
    }
    case 'terminal': {
      const lines = strip(d.output)
        .replace(/\r/g, '')
        .split('\n')
        .filter((l) => l.trim() && !(outcome === 'cancelled' && l.includes('Interrupted by the user.')));
      const state =
        outcome === 'cancelled'
          ? t('stopped')
          : d.exitCode === null
            ? d.background
              ? t('in the background: {n}', { n: d.background })
              : d.timedOut
                ? t('timed out')
                : t('stopped')
            : d.exitCode === 0
              ? ''
              : t('exit {n}', { n: d.exitCode });
      meta = paint(outcome === 'failed' && d.exitCode ? 'red' : 'faint', [state, fmtDuration(d.durationMs)].filter(Boolean).join(' · '));
      body = lines.slice(-4).map(line);
      if (lines.length > 4) body.unshift(paint('faint', lines.length === 5 ? t('… 1 line above') : t('… {n} lines above', { n: lines.length - 4 })));
      if (d.stoppedFor) body.push(paint('red', t('Stopped: {n}', { n: d.stoppedFor })));
      break;
    }
    case 'file':
      meta = paint(
        'faint',
        d.image
          ? [d.size ? `${d.size[0]}×${d.size[1]}` : t('image'), d.region ? t('region {n}', { n: d.region.join(',') }) : ''].filter(Boolean).join(' · ')
          : d.lineCount < d.totalLines
            ? t('lines {a}-{b} of {n}', { a: d.startLine, b: d.startLine + d.lineCount - 1, n: d.totalLines })
            : t('{n} lines', { n: d.totalLines }),
      );
      break;
    case 'search':
      meta = paint('faint', d.matches ? (d.files > 1 ? t('{n} matches in {m} files', { n: d.matches, m: d.files }) : t('{n} matches', { n: d.matches })) : t('no matches'));
      break;
    case 'list':
      meta = paint('faint', t('{n} items', { n: d.total }));
      break;
    case 'todo':
      body = todoLines(d.todos);
      break;
    case 'task': {
      meta = paint('faint', [d.model, d.effort, t('{n} steps', { n: d.steps }), `${fmtTokens(d.tokens)} tokens`, d.durationMs ? fmtDuration(d.durationMs) : ''].filter(Boolean).join(' · '));
      if (d.background && !d.durationMs) body.push(paint('violet', t('running in the background; its report comes back as a message')));
      for (const c of (d.changed ?? []).slice(0, 4)) body.push(`${paint('muted', c.path)} ${plus(c.added)} ${minus(c.removed)}`);
      body.push(...r.content.split('\n').filter((l) => l.trim()).slice(0, 3).map(line));
      break;
    }
    case 'web':
      meta = paint('faint', [d.status !== 200 ? String(d.status) : '', d.chars ? t('{n} chars', { n: d.chars }) : kb(d.bytes), d.via ?? '', d.date ?? ''].filter(Boolean).join(' · '));
      if (d.title) body = [line(d.title)];
      break;
    case 'links': {
      meta = paint('faint', [t('{n} results', { n: d.results.length }), d.engines?.join('+') ?? ''].filter(Boolean).join(' · '));
      const domainMax = Math.min(32, Math.max(14, Math.floor((width - 12) * 0.36)));
      const titleMax = Math.max(16, width - domainMax - 12);
      body = d.results.slice(0, 5).map((x, i) => `${paint('faint', `${i + 1}.`)} ${link(x.url, paint('ink', clip(x.title, titleMax)))} ${paint('faint', clip(x.url.replace(/^https?:\/\/(www\.)?/, ''), domainMax))}`);
      break;
    }
    case 'shot':
      meta = paint('faint', `${d.width}×${d.height}`);
      break;
    case 'mail': {
      meta = paint('faint', [d.account, d.folder ?? '', d.total !== undefined ? t('{n} messages', { n: d.total }) : ''].filter(Boolean).join(' · '));
      if (d.items) body = d.items.slice(0, 5).map((m) => `${m.unread ? paint('blue', '●') : paint('faint', '○')} ${paint('muted', clip(m.from ?? '', Math.min(22, Math.max(12, Math.floor(width * 0.28)))))} ${clip(m.subject, Math.max(16, width - 36))}`);
      else if (d.message) body = [`${bold(clip(d.message.subject, Math.max(16, width - 10)))}`, line(`${d.message.from ?? ''} · ${d.message.date ?? ''}`)];
      else if (d.preview) body = [line(`→ ${(d.to ?? []).join(', ')}`), ...d.preview.split('\n').filter((l) => l.trim()).slice(0, 3).map(line)];
      if (d.declined) body.push(paint('brass', t('You turned this email down.')));
      break;
    }
    case 'question':
      body = Object.entries(d.answers).map(([q, a]) => dim(`${clip(q, Math.max(20, width - 20))} → ${a}`));
      break;
    case 'plan':
      meta = d.approved ? paint('green', t('approved')) : paint('brass', t('not approved'));
      break;
    case 'goal':
      body = goalLines(d.goal).slice(1);
      break;
    case 'checks': {
      const failed = d.results.filter((x) => !x.ok).length;
      meta = paint(failed ? 'red' : 'green', d.results.length ? (failed ? t('{n} of {m} failed', { n: failed, m: d.results.length }) : t('{n} passed', { n: d.results.length })) : t('none found'));
      if (d.before) meta += paint('faint', ` · ${t('on the code before your changes')}`);
      body = d.results.flatMap((x) => [
        `${x.ok ? paint('green', '✓') : paint('red', '✗')} ${x.name} ${paint('faint', `${fmtDuration(x.durationMs)}${x.summary ? ` · ${x.summary}` : ''}`)}`,
        ...(x.ok ? [] : x.problems.slice(0, 4).map((pr) => dim(`    ${clip(pr, Math.max(12, width - 8))}`))),
      ]);
      if (d.verdict) body.push(paint(d.verdict.kind === 'catches' ? 'green' : 'brass', d.verdict.kind === 'catches' ? t('The new tests fail on the old code: they catch the fix.') : d.verdict.kind === 'pass-before' ? t('The tests pass on the old code too: they do not prove the fix.') : t('The old code does not build with the new tests.')));
      if (d.probe?.results.length) {
        const caught = d.probe.results.filter((x) => x.outcome === 'detected').length;
        body.push(paint('faint', t('probe: {n} of {m} reverted lines caught by the tests', { n: caught, m: d.probe.results.length })));
      }
      break;
    }
    case 'attempts':
      meta = paint('faint', t('{n} attempts', { n: d.attempts.length }));
      body = d.attempts.map(
        (a) =>
          `${a.chosen ? paint('green', '★') : paint('faint', '·')} #${a.n} ${paint(a.failed ? 'red' : 'green', `${a.passed}✓ ${a.failed}✗`)} ${paint('muted', `+${a.added} −${a.removed} · ${t('{n} files', { n: a.files })}`)}${a.note ? paint('faint', ` · ${clip(a.note, Math.max(16, width - 40))}`) : ''}`,
      );
      if (d.reason) body.push(line(d.reason));
      break;
    case 'text':
      body = d.text.split('\n').filter((l) => l.trim()).slice(0, 3).map(line);
      break;
    case 'stages': {
      // Long work in figures and the files it wrote; what came of it is read in them.
      const on = d.stages.find((s) => s.state === 'on');
      if (on) meta = paint('faint', `${t(on.label)}${on.of ? ` ${on.done ?? 0}/${on.of}` : ''}`);
      const figure = (f: (typeof d.figures)[number]) => {
        const s = t(f.label, f.m === undefined ? { n: f.n } : { n: f.n, m: f.m });
        return f.tone === 'good' ? paint('green', s) : dim(s);
      };
      body = [...(d.figures.length ? [d.figures.map(figure).join(dim(' · '))] : []), ...(d.note ? [dim(d.note)] : []), ...(d.files ?? []).map((f) => line(toForward(f.path)))];
      // Work that went on in the background has no stages on its call: its line says so, and its result comes as a message.
      if (!d.stages.length && !d.figures.length) body = [paint('violet', t('running in the background; its result comes back as a message'))];
      break;
    }
  }

  if (outcome === 'cancelled') {
    if (!meta) meta = paint('faint', t('stopped'));
    if (d?.kind !== 'terminal') body = [];
  } else if (outcome === 'denied') {
    const planBlocked = (r.content ?? '').trim().startsWith('Plan mode is on, so ');
    meta = paint('brass', planBlocked ? t('plan mode') : t('not run'));
    const detail = toolOutcomeDetail(r);
    body = detail
      ? wrapAnsi(detail, Math.max(14, width - 6), { hard: true })
          .split('\n')
          .slice(0, 3)
          .map((l) => paint('muted', l))
      : [];
  } else if (outcome === 'failed' && d?.kind !== 'terminal') {
    body = r.content
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 3)
      .map((l) => paint('ink', clip(l, Math.max(10, width - 6))));
  }

  const bullet = outcome === 'failed' ? paint('red', '✗') : outcome === 'denied' ? paint('brass', '!') : outcome === 'cancelled' ? paint('muted', '○') : paint('muted', '●');
  const label = toolLabel(name);
  const bare = bareTitle(name, title);
  const head = `${bullet} ${bold(label)}${bare ? ` ${paint('muted', clip(bare, Math.max(10, width - cols(label) - cols(strip(meta)) - 8)))}` : ''}${meta ? `  ${meta}` : ''}`;
  if (!body.length) return head;
  // What a step showed hangs under its name by indent alone: an elbow on its first line was one more mark on every step.
  return `${head}\n${body.map((l) => `  ${l}`).join('\n')}`;
}

/** A call's title without the tool's own name in front ("Read a.ts" under `read`, "Agent: …" under `agent`). */
export function bareTitle(name: string, title: string): string {
  const lower = title.toLowerCase();
  const n = name.toLowerCase();
  if (lower === n) return '';
  if (lower.startsWith(`${n}: `)) return title.slice(n.length + 2);
  if (lower.startsWith(`${n} `)) return title.slice(n.length + 1);
  return title;
}

export function noticeBlock(level: 'info' | 'warn' | 'error', text: string): string {
  const hue = level === 'error' ? 'red' : level === 'warn' ? 'brass' : 'muted';
  return paint(hue, `${level === 'info' ? '·' : level === 'error' ? '✗' : '!'} ${text}`);
}

/** What a turn took and did, from what Favilla recorded: the line under each finished turn. */
export function ledgerLine(messages: Message[], turn: string, ms: number): string {
  let requests = 0;
  const files = new Map<string, { added: number; removed: number }>();
  let runs = 0;
  let failedRuns = 0;
  for (const m of messages) {
    if (m.turn !== turn || m.replay) continue;
    if (m.role === 'assistant') requests++;
    for (const p of m.parts) {
      if (p.type !== 'tool_result') continue;
      const d = p.display;
      if (d?.kind === 'diff')
        for (const f of d.files) {
          const cur = files.get(f.path) ?? { added: 0, removed: 0 };
          cur.added += f.added;
          cur.removed += f.removed;
          files.set(f.path, cur);
        }
      else if (d?.kind === 'checks')
        for (const x of d.results) {
          runs++;
          if (!x.ok) failedRuns++;
        }
      else if (d?.kind === 'terminal' && !d.background && toolOutcome(p) !== 'cancelled') {
        runs++;
        if (d.exitCode) failedRuns++;
      }
    }
  }
  const added = [...files.values()].reduce((n, f) => n + f.added, 0);
  const removed = [...files.values()].reduce((n, f) => n + f.removed, 0);
  // A quick plain answer needs no line under it.
  if (requests <= 1 && !files.size && !runs && ms < 3000) return '';
  const bits = [fmtDuration(ms)];
  if (requests > 1) bits.push(t('{n} requests', { n: requests }));
  if (files.size) bits.push(`${t(files.size === 1 ? '1 file' : '{n} files', { n: files.size })} ${plus(added)}${paint('faint', ' ')}${minus(removed)}`);
  if (runs) bits.push(failedRuns ? paint('brass', t('{n} of {m} runs failed', { n: failedRuns, m: runs })) : t(runs === 1 ? '1 run' : '{n} runs', { n: runs }));
  return paint('faint', `✓ ${bits.join(paint('faint', ' · '))}`);
}

/** The context as a bar of what fills it, then the numbers. */
export function contextLines(c: ContextReport, width: number): string[] {
  const parts: [keyof ContextReport['parts'], string, 'muted' | 'faint' | 'ink', string][] = [
    ['system', t('system prompt'), 'muted', '█'],
    ['tools', t('tool definitions'), 'faint', '█'],
    ['summary', t('summary of earlier work'), 'ink', '▒'],
    ['conversation', t('conversation'), 'ink', '█'],
    ['reasoning', t('reasoning'), 'ink', '▓'],
    ['outputs', t('tool output'), 'muted', '▓'],
    ['cut', t('tool output cut to stubs'), 'muted', '░'],
  ];
  const barWidth = Math.max(20, Math.min(60, width - 10));
  const scale = barWidth / Math.max(1, c.window);
  let bar = '';
  let used = 0;
  for (const [k, , hue, glyph] of parts) {
    const n = Math.round(c.parts[k] * scale);
    bar += paint(hue, glyph.repeat(n));
    used += n;
  }
  const compactCol = Math.round(c.compactAt * scale);
  const rest = Math.max(0, barWidth - used);
  bar += paint('faint', '░'.repeat(rest));
  const markLabel = `${paint('ink', '▲')} ${paint('faint', t('compacts at {n}', { n: fmtTokens(c.compactAt) }))}`;
  const markIndent = Math.max(0, Math.min(barWidth, compactCol, width - cols(strip(markLabel)) - 3));
  const mark = `${' '.repeat(markIndent)}${markLabel}`;
  const pct = Math.round((c.tokens / Math.max(1, c.window)) * 100);
  const footer = wrapAnsi(t('{n} tool outputs in full, {m} cut to stubs (recall brings them back) · {c} compactions', { n: c.outputs, m: c.cut, c: c.compactions }), Math.max(20, width - 3), { hard: true })
    .split('\n')
    .map((l) => paint('faint', `  ${l}`));
  return [
    `${bold(t('Context'))}  ${fmtTokens(c.tokens)} / ${fmtTokens(c.window)} (${pct}%)${c.nativeWindow !== c.window ? paint('faint', `  ${t('provider window {n}', { n: fmtTokens(c.nativeWindow) })}`) : ''}`,
    `  ${bar}`,
    `  ${mark}`,
    ...parts.filter(([k]) => c.parts[k] > 0).map(([k, label, hue, glyph]) => `  ${paint(hue, glyph)} ${padEnd(label, 22)} ${paint('muted', fmtTokens(c.parts[k]).padStart(6))}`),
    ...footer,
  ];
}
