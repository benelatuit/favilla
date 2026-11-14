import path from 'node:path';
import { toForward, type ContextReport, type DiffFile, type Goal, type Message, type ToolResultPart, type Todo } from '@favilla/core';
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

/** A message the user sent: on its own ground, as in the desktop app, so turns are easy to find when scrolling. */
export function userBlock(text: string, images: number, width: number): string {
  const lines = text.split('\n');
  const body = lines.map((l, i) => ground('user', padEnd(`${paint('blue', i === 0 ? '› ' : '  ')}${paint('ink', l)}`, width)));
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
 * A patch as the terminal shows it: line numbers of the new file, added lines bright with + on a lighter ground,
 * removed ones dim with -, the rest highlighted for its language in greys. `max` limits the lines shown (0 for all).
 */
export function diffLines(files: DiffFile[], width: number, max = 14): string[] {
  const out: string[] = [];
  let shown = 0;
  for (const f of files) {
    if (files.length > 1 || max === 0) {
      const op = f.op === 'add' ? t('added') : f.op === 'delete' ? t('deleted') : f.op === 'move' ? t('moved') : t('changed');
      out.push(`${paint('muted', op)} ${bold(f.movedTo ?? f.path)}  ${plus(f.added)} ${minus(f.removed)}`);
    }
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
      const lit = lang ? highlight(code, lang) : paint('code', code);
      if (line.startsWith('+')) out.push(ground('added', padEnd(`${paint('faint', String(newLine).padStart(5))} ${paint('green', '+')} ${lit}`, width)));
      // A removed line is plain and dim through and through: a bold keyword inside would end the dim halfway.
      else if (line.startsWith('-')) out.push(`${paint('faint', String(oldLine).padStart(5))} ${dim(paint('muted', `- ${code}`))}`);
      else out.push(`${paint('faint', String(newLine).padStart(5))}   ${lit}`);
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

/** One finished tool call: a header line and a few lines that show what happened. */
export function toolBlock(name: string, title: string, r: ToolResultPart, width: number): string {
  const ok = !r.isError;
  const d = r.display;
  let meta = '';
  let body: string[] = [];
  const line = (s: string) => dim(clip(s, width - 6));
  switch (d?.kind) {
    case 'diff': {
      const added = d.files.reduce((n, f) => n + f.added, 0);
      const removed = d.files.reduce((n, f) => n + f.removed, 0);
      meta = `${plus(added)} ${minus(removed)}`;
      body = diffLines(d.files, width - 4);
      break;
    }
    case 'terminal': {
      const lines = strip(d.output).replace(/\r/g, '').split('\n').filter((l) => l.trim());
      const state = d.exitCode === null ? (d.background ? t('in the background: {n}', { n: d.background }) : d.timedOut ? t('timed out') : t('stopped')) : d.exitCode === 0 ? '' : t('exit {n}', { n: d.exitCode });
      meta = paint(d.exitCode ? 'red' : 'faint', [state, fmtDuration(d.durationMs)].filter(Boolean).join(' · '));
      body = lines.slice(-4).map(line);
      if (lines.length > 4) body.unshift(paint('faint', t('… {n} lines above', { n: lines.length - 4 })));
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
    case 'links':
      meta = paint('faint', [t('{n} results', { n: d.results.length }), d.engines?.join('+') ?? ''].filter(Boolean).join(' · '));
      body = d.results.slice(0, 5).map((x, i) => `${paint('faint', `${i + 1}.`)} ${link(x.url, paint('ink', clip(x.title, Math.max(20, width - 40))))} ${paint('faint', clip(x.url.replace(/^https?:\/\/(www\.)?/, ''), 32))}`);
      break;
    case 'shot':
      meta = paint('faint', `${d.width}×${d.height}`);
      break;
    case 'mail': {
      meta = paint('faint', [d.account, d.folder ?? '', d.total !== undefined ? t('{n} messages', { n: d.total }) : ''].filter(Boolean).join(' · '));
      if (d.items) body = d.items.slice(0, 5).map((m) => `${m.unread ? paint('blue', '●') : paint('faint', '○')} ${paint('muted', clip(m.from ?? '', 22))} ${clip(m.subject, Math.max(20, width - 36))}`);
      else if (d.message) body = [`${bold(clip(d.message.subject, width - 10))}`, line(`${d.message.from ?? ''} · ${d.message.date ?? ''}`)];
      else if (d.preview) body = [line(`→ ${(d.to ?? []).join(', ')}`), ...d.preview.split('\n').filter((l) => l.trim()).slice(0, 3).map(line)];
      if (d.declined) body.push(paint('brass', t('You turned this email down.')));
      break;
    }
    case 'question':
      body = Object.entries(d.answers).map(([q, a]) => dim(`${clip(q, 60)} → ${a}`));
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
        ...(x.ok ? [] : x.problems.slice(0, 4).map((pr) => dim(`    ${clip(pr, width - 8)}`))),
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
          `${a.chosen ? paint('green', '★') : paint('faint', '·')} #${a.n} ${paint(a.failed ? 'red' : 'green', `${a.passed}✓ ${a.failed}✗`)} ${paint('muted', `+${a.added} −${a.removed} · ${t('{n} files', { n: a.files })}`)}${a.note ? paint('faint', ` · ${clip(a.note, 50)}`) : ''}`,
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
  if (!ok && d?.kind !== 'terminal') body = r.content.split('\n').filter((l) => l.trim()).slice(0, 3).map((l) => paint('ink', clip(l, width - 6)));
  const broke = !ok || (d?.kind === 'terminal' && !!d.exitCode);
  const bullet = broke ? paint('red', '✗') : paint('muted', '●');
  const label = toolLabel(name);
  const head = `${bullet} ${bold(label)} ${paint('muted', clip(bareTitle(name, title), Math.max(10, width - cols(label) - cols(strip(meta)) - 8)))}${meta ? `  ${meta}` : ''}`;
  if (!body.length) return head;
  return `${head}\n${body.map((l, i) => `${paint('faint', i === 0 ? '  ⎿ ' : '    ')}${l}`).join('\n')}`;
}

/** A call's title without the tool's own name in front ("Read a.ts" under `read`, "Agent: …" under `agent`). */
export function bareTitle(name: string, title: string): string {
  const lower = title.toLowerCase();
  const n = name.toLowerCase();
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
      else if (d?.kind === 'terminal' && !d.background) {
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
  const mark = `${' '.repeat(Math.min(barWidth, Math.max(0, compactCol)))}${paint('ink', '▲')} ${paint('faint', t('compacts at {n}', { n: fmtTokens(c.compactAt) }))}`;
  const pct = Math.round((c.tokens / Math.max(1, c.window)) * 100);
  return [
    `${bold(t('Context'))}  ${fmtTokens(c.tokens)} / ${fmtTokens(c.window)} (${pct}%)${c.nativeWindow !== c.window ? paint('faint', `  ${t('provider window {n}', { n: fmtTokens(c.nativeWindow) })}`) : ''}`,
    `  ${bar}`,
    `  ${mark}`,
    ...parts.filter(([k]) => c.parts[k] > 0).map(([k, label, hue, glyph]) => `  ${paint(hue, glyph)} ${padEnd(label, 22)} ${paint('muted', fmtTokens(c.parts[k]).padStart(6))}`),
    paint('faint', `  ${t('{n} tool outputs in full, {m} cut to stubs (recall brings them back) · {c} compactions', { n: c.outputs, m: c.cut, c: c.compactions })}`),
  ];
}
