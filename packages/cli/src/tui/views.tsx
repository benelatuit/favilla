import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { PermissionDecision, PermissionRequest, QuestionRequest } from '@favilla/core';
import { translateCatastropheReason } from '@favilla/core/guard/i18n';
import { borders, bold, paint } from './theme';
import { renderMarkdown } from './markdown';
import { t } from './i18n';
import { clip, cols, strip } from './text';
import { fmtDuration } from './format';

function Choice({ options, onChoose, hint }: { options: { label: string; key?: string; detail?: string }[]; onChoose: (i: number) => void; hint?: string }) {
  const [sel, setSel] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) return setSel((s) => (s - 1 + options.length) % options.length);
    if (key.downArrow || key.tab) return setSel((s) => (s + 1) % options.length);
    if (key.return) return onChoose(sel);
    const n = Number(input);
    if (n >= 1 && n <= options.length && options.length <= 9) return onChoose(n - 1);
    const k = options.findIndex((o) => o.key && o.key === input.toLowerCase());
    if (k >= 0) onChoose(k);
  });
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Text key={`${i}${o.label}`} wrap="truncate-end">
          {i === sel ? paint('blue', `▸ ${i + 1}. ${o.label}`) : paint('muted', `  ${i + 1}. ${o.label}`)}
          {o.detail ? paint('faint', `  ${o.detail}`) : ''}
        </Text>
      ))}
      {hint && <Text wrap="truncate-end">{paint('faint', hint)}</Text>}
    </Box>
  );
}

/** A one-line text field for answers typed into a prompt. */
function useLine(active: boolean, onEnter: (text: string) => void, onEscape: () => void) {
  const [text, setText] = useState('');
  useInput(
    (input, key) => {
      if (key.return) return onEnter(text);
      if (key.escape) return onEscape();
      if (key.backspace || key.delete) return setText((c) => Array.from(c).slice(0, -1).join(''));
      if (input && !key.ctrl && !key.meta) setText((c) => c + input.replace(/\r?\n/g, ' '));
    },
    { isActive: active },
  );
  return text;
}

export function PermissionPrompt({ req, onDecide }: { req: PermissionRequest; onDecide: (d: PermissionDecision) => void }) {
  const decisions: PermissionDecision[] = req.once ? ['allow', 'deny'] : ['allow', 'allow_session', 'deny'];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borders.alert} paddingX={1}>
      <Text>
        {paint('brass', bold(t('Confirm')))} {paint('muted', translateCatastropheReason(req.reason, t) ?? req.reason)}
      </Text>
      <Text>{paint('ink', req.detail)}</Text>
      <Choice
        options={[
          { label: t('Run it once'), key: 'y' },
          ...(!req.once ? [{ label: t('Allow this kind for the session'), key: 'a' }] : []),
          { label: t('Don’t run it'), key: 'n' },
        ]}
        hint={t(req.once ? 'enter chooses · y / n' : 'enter chooses · y / a / n')}
        onChoose={(i) => onDecide(decisions[i])}
      />
    </Box>
  );
}

export function QuestionPrompt({ req, onAnswer }: { req: QuestionRequest; onAnswer: (a: Record<string, string> | null) => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState(0);
  const q = req.questions[index];
  const record = (value: string) => {
    const next = { ...answers, [q.question]: value };
    setAnswers(next);
    setTyping(false);
    setPicked(new Set());
    setSel(0);
    if (index + 1 < req.questions.length) setIndex(index + 1);
    else onAnswer(next);
  };
  const custom = useLine(typing, (s) => s.trim() && record(s.trim()), () => setTyping(false));
  const options: { label: string; detail?: string }[] = [...q.options.map((o) => ({ label: o.label, detail: o.description })), { label: t('Something else (type it)') }, { label: t('Skip: let the agent decide') }];
  // Several answers at once: space ticks, enter sends what is ticked.
  useInput(
    (input, key) => {
      if (key.upArrow) return setSel((s) => (s - 1 + options.length) % options.length);
      if (key.downArrow || key.tab) return setSel((s) => (s + 1) % options.length);
      if (input === ' ' && sel < q.options.length) return setPicked((p) => (p.has(sel) ? new Set([...p].filter((x) => x !== sel)) : new Set([...p, sel])));
      if (key.return) {
        if (sel === q.options.length) return setTyping(true);
        if (sel === q.options.length + 1) return onAnswer(Object.keys(answers).length ? answers : null);
        const chosen = picked.size ? [...picked].sort((a, b) => a - b) : [sel];
        record(chosen.map((i) => q.options[i].label).join(', '));
      }
    },
    { isActive: !typing && !!q.multiSelect },
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borders.prompt} paddingX={1}>
      <Text>
        {paint('blue', bold(q.header ? `${q.header}: ` : `${t('Question')}: `))}
        {q.question}
        {req.questions.length > 1 ? paint('faint', `  (${index + 1}/${req.questions.length})`) : ''}
      </Text>
      {typing ? (
        <Text wrap="truncate-end">
          {paint('blue', '› ')}
          {custom}
          {'\x1b[7m \x1b[27m'}
          {paint('faint', `  ${t('enter sends · esc goes back')}`)}
        </Text>
      ) : q.multiSelect ? (
        <Box flexDirection="column">
          {options.map((o, i) => (
            <Text key={`${i}${o.label}`} wrap="truncate-end">
              {i === sel ? paint('blue', '▸ ') : '  '}
              {i < q.options.length ? (picked.has(i) ? paint('green', '☑ ') : paint('faint', '☐ ')) : '  '}
              {i === sel ? paint('blue', o.label) : paint('muted', o.label)}
              {o.detail ? paint('faint', `  ${o.detail}`) : ''}
            </Text>
          ))}
          <Text wrap="truncate-end">{paint('faint', t('space ticks · enter sends what is ticked'))}</Text>
        </Box>
      ) : (
        <Choice
          key={index}
          options={options}
          onChoose={(i) => {
            if (i < q.options.length) record(q.options[i].label);
            else if (i === q.options.length) setTyping(true);
            else onAnswer(Object.keys(answers).length ? answers : null);
          }}
        />
      )}
    </Box>
  );
}

export function PlanPrompt({ plan, width, onDecide }: { plan: string; width: number; onDecide: (ok: boolean, feedback?: string) => void }) {
  const [typing, setTyping] = useState(false);
  const text = useLine(typing, (s) => onDecide(false, s.trim() || undefined), () => setTyping(false));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borders.prompt} paddingX={1}>
      <Text>{paint('blue', bold(t('Plan ready for review')))}</Text>
      <Text>{renderMarkdown(plan, Math.max(20, width - 4))}</Text>
      {typing ? (
        <Text>
          {paint('blue', `${t('What should change?')} › `)}
          {text}
          {'\x1b[7m \x1b[27m'}
        </Text>
      ) : (
        <Choice options={[{ label: t('Approve and start building'), key: 'y' }, { label: t('Keep planning (give feedback)'), key: 'n' }]} onChoose={(i) => (i === 0 ? onDecide(true) : setTyping(true))} />
      )}
    </Box>
  );
}

type PickerOption = { label: string; detail?: string; value: string };
export type Picker = { title: string; options: PickerOption[]; onPick: (v: string) => void; hint?: string };

export function PickerView({ picker, onPick, onClose, height }: { picker: Picker; onPick: (v: string) => void; onClose: () => void; height: number }) {
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');
  const shown = picker.options.filter((o) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const size = Math.max(4, Math.min(14, height - 6));
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(shown.length - 1, s + 1));
    if (key.pageUp) return setSel((s) => Math.max(0, s - size));
    if (key.pageDown) return setSel((s) => Math.min(shown.length - 1, s + size));
    if (key.return) return shown[sel] && onPick(shown[sel].value);
    if (key.backspace || key.delete) return setFilter((f) => Array.from(f).slice(0, -1).join(''));
    if (input && !key.ctrl && !key.meta) {
      setFilter((f) => f + input);
      setSel(0);
    }
  });
  const start = Math.max(0, Math.min(sel - Math.floor(size / 2), shown.length - size));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borders.prompt} paddingX={1}>
      <Text wrap="truncate-end">
        {paint('blue', bold(picker.title))}
        {paint('faint', `  ${filter ? `${t('filter')}: ${filter}` : t('type to filter')} · ${picker.hint ?? t('enter chooses · esc closes')}`)}
      </Text>
      {shown.slice(start, start + size).map((o, i) => (
        <Text key={o.value} wrap="truncate-end">
          {start + i === sel ? paint('blue', `▸ ${o.label}`) : paint('muted', `  ${o.label}`)}
          {o.detail ? paint('faint', `  ${o.detail}`) : ''}
        </Text>
      ))}
      {!shown.length && <Text>{paint('faint', `  ${t('nothing matches')}`)}</Text>}
      {shown.length > size && <Text>{paint('faint', `  ${sel + 1}/${shown.length}`)}</Text>}
    </Box>
  );
}

/** A sub-agent as the terminal follows it: what it is doing now and the steps it took. */
export interface ChildView {
  callId: string;
  sessionId: string;
  description: string;
  model?: string;
  effort?: string;
  activity: 'starting' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'done';
  started: number;
  steps: { id: string; name: string; title: string; started: number; ended?: number; failed?: boolean }[];
  tokens: number;
  background: boolean;
}

/** One line per sub-agent at work, under the running tools: the main agent's helpers never look stuck. */
export function childLines(children: ChildView[], width: number, frame: number): string[] {
  const spin = ['◐', '◓', '◑', '◒'][frame % 4];
  const descMax = width < 72 ? 20 : 36;
  return children
    .filter((c) => c.activity !== 'done')
    .slice(0, 6)
    .map((c) => {
      const now = c.steps.find((s) => !s.ended);
      const doing = now ? now.title : c.activity === 'writing' ? t('writing its report') : c.activity === 'waiting' ? t('waiting for you') : c.activity === 'starting' ? t('starting') : t('thinking');
      const head = `${paint('violet', `${spin} ⎇`)} ${bold(clip(c.description, descMax))}${c.background ? paint('violet', ` ${t('background')}`) : ''}`;
      const modelNote = width >= 76 && c.model ? ` · ${c.model}${c.effort ? `/${c.effort}` : ''}` : '';
      const tail = paint('faint', ` · ${t('{n} steps', { n: c.steps.length })} · ${fmtDuration(Date.now() - c.started)}${modelNote}`);
      const room = Math.max(8, width - cols(head) - cols(tail) - 4);
      return `  ${head} ${paint('muted', clip(doing, room))}${tail}`;
    });
}

/**
 * A full-screen reader inside the app (transcripts, diffs, a sub-agent's work): it needs no `less`, which
 * Windows does not have, and the agent goes on working underneath.
 */
export function Pager({ title, lines, width, height, start = 'top', onClose }: { title: string; lines: string[]; width: number; height: number; start?: 'top' | 'end'; onClose: () => void }) {
  const rows = useMemo(() => lines.flatMap((l) => wrapAnsi(l, Math.max(10, width), { hard: true, trim: false }).split('\n')), [lines, width]);
  const page = Math.max(3, height - 2);
  const last = Math.max(0, rows.length - page);
  const [top, setTop] = useState(start === 'end' ? last : 0);
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState('');
  const go = (n: number) => setTop(Math.max(0, Math.min(last, n)));
  const find = (q: string, from: number, dir: 1 | -1) => {
    const needle = q.toLowerCase();
    for (let i = from; i >= 0 && i < rows.length; i += dir) if (strip(rows[i]).toLowerCase().includes(needle)) return go(i);
  };
  useInput((input, key) => {
    if (query !== null) {
      if (key.escape) return setQuery(null);
      if (key.return) {
        setFound(query);
        setQuery(null);
        return find(query, top + 1, 1);
      }
      if (key.backspace || key.delete) return setQuery(Array.from(query).slice(0, -1).join(''));
      if (input && !key.ctrl) setQuery(query + input);
      return;
    }
    if (key.escape || input === 'q' || (key.ctrl && input === 't')) return onClose();
    if (key.upArrow || input === 'k') return go(top - 1);
    if (key.downArrow || input === 'j' || key.return) return go(top + 1);
    if (key.pageUp || input === 'b') return go(top - page);
    if (key.pageDown || input === ' ' || input === 'f') return go(top + page);
    if (input === 'g' || key.home) return go(0);
    if (input === 'G' || key.end) return go(last);
    if (input === '/') return setQuery('');
    if (input === 'n' && found) return find(found, top + 1, 1);
    if (input === 'N' && found) return find(found, top - 1, -1);
  });
  const shown = rows.slice(top, top + page);
  while (shown.length < page) shown.push('');
  const pos = rows.length ? `${top + 1}-${Math.min(rows.length, top + page)}/${rows.length}` : '0/0';
  const keys = width < 76 ? `↑↓ · / ${t('search')} · q ${t('closes')}` : `↑↓ pgup pgdn g G · / ${t('search')} n N · q ${t('closes')}`;
  const legend = `${pos} · ${keys}`;
  const headTitle = clip(title, Math.max(12, width - cols(legend) - 3));
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        {paint('blue', bold(headTitle))}
        {paint('faint', `  ${legend}`)}
      </Text>
      <Text wrap="truncate-end">{shown.join('\n')}</Text>
      <Text wrap="truncate-end">{query !== null ? `${paint('blue', '/')}${query}${'\x1b[7m \x1b[27m'}` : paint('faint', top >= last ? t('(end)') : '')}</Text>
    </Box>
  );
}
