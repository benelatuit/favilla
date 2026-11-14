import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react';
import { api, fileToImage } from '../lib/api';
import { actions, getState, setState, setUi, toast, useStore, settingSaveError } from '../lib/store';
import { count, fill, useT } from '../lib/i18n';
import { desktop } from '../lib/desktop';
import { fmtTokens } from '../lib/format';
import type { Effort, Mode, QueuedInput } from '../lib/types';
import { ArrowUUpLeft, ArrowUp, ClipboardText, ClockCountdown, Compass, Crosshair, FileText, GaugeIcon, Hammer, ImageIcon, Paperclip, PencilSimple, ShieldCheck, ShieldSlash, ShieldWarning, Stop, X } from './icons';
import { POINTED } from './Preview';
import { pointedBlock, pointedLabel, type Pointed } from '../lib/point';
import { isLongPaste, lineCount, pasteText, takePasted, withAttached } from '../lib/paste';
import { ATTACHED } from '../lib/messages';
import { composerDraft, draftValue, editComposerDraft, submitComposerDraft, subscribeComposerDraft } from '../lib/composer-draft';
import { ModelPicker, useModel } from './ModelPicker';
import { EFFORTS, MODE_ORDER, nextMode } from '../lib/modes';
import { undoLastTurn } from '../lib/undo';
import { userWords } from '../lib/messages';
import { Select } from './ui/Select';
import { Keys } from './ui/Keys';

interface SlashCommand {
  name: string;
  hint: string;
  run: (arg: string) => void;
}

type Suggest = { kind: 'file'; items: string[]; sel: number; start: number } | { kind: 'command'; items: SlashCommand[]; sel: number };


/** What a paste's preview draws at most: the start of a very long one is enough to know it by. */
const PASTE_SHOWN = 20_000;

/** Narrower than this (the text box, in px), the dock's placeholders take their short form. */
const NARROW_BOX = 540;

/** Fill the composer from elsewhere (starters on the welcome page, "use as draft"). */
export function compose(text: string): void {
  window.dispatchEvent(new CustomEvent('favilla:compose', { detail: text }));
}

/** Files dropped anywhere in the window land here. */
export function attachFiles(files: File[]): void {
  window.dispatchEvent(new CustomEvent('favilla:attach', { detail: files }));
}

function useSlashCommands(): SlashCommand[] {
  const t = useT();
  const session = useStore((s) => s.session);
  return useMemo(() => {
    const list: SlashCommand[] = [
      { name: 'new', hint: t('Start a new session'), run: () => actions.newSession() },
      { name: 'plan', hint: t('Switch plan mode on or off'), run: () => actions.settings({ mode: (getState().session?.meta.mode ?? getState().draft.mode) === 'plan' ? 'build' : 'plan' }) },
      ...EFFORTS.map((e) => ({ name: `effort ${e}`, hint: t('Set the reasoning effort'), run: () => actions.settings({ effort: e }) })),
      { name: 'settings', hint: t('Open the settings'), run: () => setUi({ settings: true }) },
    ];
    if (session) {
      list.splice(
        2,
        0,
        { name: 'compact', hint: t('Summarize the conversation to free the context'), run: () => actions.compact().catch((e) => toast(String(e), 'error')) },
        {
          name: 'undo',
          hint: t('Undo the last turn’s file changes'),
          run: () => undoLastTurn(t),
        },
      );
    }
    return list;
  }, [t, !!session]);
}

/** Each mode with its icon and what it does; the order is MODE_ORDER's, the one Shift+Tab goes round. */
const MODE_VIEW: Record<Mode, { label: string; hint: string; icon: (p: { size: number; weight?: 'regular' | 'fill' }) => ReactNode }> = {
  build: { label: 'Default', hint: 'Reads, changes files and runs commands as it goes', icon: Hammer },
  plan: { label: 'Plan', hint: 'Plans first and changes nothing until you approve', icon: Compass },
};
const MODES = MODE_ORDER.map((value) => ({ value, ...MODE_VIEW[value] }));

/** One menu for the mode: the default (build) and plan. */
function ModeSelect({ mode }: { mode: Mode }) {
  const t = useT();
  const Icon = (MODES.find((m) => m.value === mode) ?? MODES[0]).icon;
  return (
    <Select<Mode>
      value={mode}
      options={MODES.map((m) => ({ value: m.value, label: t(m.label), hint: t(m.hint), icon: <m.icon size={16} /> }))}
      onChange={(m) => actions.settings({ mode: m }).catch((err) => toast(String(err), 'error'))}
      tip={t('Mode')}
      keys="Shift+Tab"
      placement="top-start"
      icon={<Icon size={14} weight={mode === 'build' ? 'regular' : 'fill'} />}
      className={`mode-select ${mode !== 'build' ? 'is-on' : ''}`}
    />
  );
}

/**
 * Whether destructive commands wait for a yes: the same setting as Permissions in Settings > General, for every session, here where
 * it is seen while working. Full access is in the theme's warning ink, so it is noticed without a word.
 */
function GuardSelect() {
  const t = useT();
  const guard = useStore((s) => s.info?.config.guard ?? 'confirm');
  const options: { value: string; label: string; hint: string; icon: ReactNode }[] = [
    { value: 'confirm', label: t('Ask first'), hint: t('Destructive commands wait for a yes, in every session'), icon: <ShieldCheck size={16} /> },
    { value: 'off', label: t('Full access'), hint: t('Every command runs without asking, in every session'), icon: <ShieldWarning size={16} /> },
  ];
  // Set from the command line, refusing stays a choice while it is the one in force.
  if (guard === 'block') options.push({ value: 'block', label: t('Refuse'), hint: t('Destructive commands are refused, in every session'), icon: <ShieldSlash size={16} /> });
  const Icon = guard === 'off' ? ShieldWarning : guard === 'block' ? ShieldSlash : ShieldCheck;
  return (
    <Select
      value={guard}
      options={options}
      onChange={(v) => actions.setConfig({ 'guard.mode': v }).catch(settingSaveError)}
      tip={t('Permissions')}
      placement="top-start"
      icon={<Icon size={14} weight={guard === 'off' ? 'fill' : 'regular'} />}
      className={`guard-select ${guard === 'off' ? 'is-full' : ''}`}
    />
  );
}

/** How full the context window is, as a small ruler: ticks every tenth, the compaction mark, the reading. */
function ContextGauge() {
  const t = useT();
  const usage = useStore((s) => s.session?.usage);
  if (!usage || !usage.contextWindow) return null;
  const pct = Math.min(1, usage.contextTokens / usage.contextWindow);
  const mark = Math.min(1, usage.compactAt / usage.contextWindow);
  const tip = `${t('Context')} ${fmtTokens(usage.contextTokens)} / ${fmtTokens(usage.contextWindow)} · ${t('compacts at')} ${Math.round(mark * 100)}%`;
  return (
    <button type="button" className={`gauge ${pct > mark * 0.9 ? 'is-high' : ''}`} data-tip={tip} aria-label={tip} onClick={() => setUi({ panel: true, panelTab: 'context' })}>
      <span className="gauge-track">
        <span className="gauge-fill" style={{ transform: `scaleX(${pct})` }} />
        <span className="gauge-mark" style={{ left: `${mark * 100}%` }} />
      </span>
      <span className="gauge-value num">{Math.round(pct * 100)}%</span>
    </button>
  );
}

export function Composer({ variant = 'dock' }: { variant?: 'dock' | 'hero' }) {
  const t = useT();
  const session = useStore((s) => s.session);
  const draft = useStore((s) => s.draft);
  const info = useStore((s) => s.info);
  const folder = useStore((s) => s.session?.meta.cwd ?? s.folder);
  const sessionId = useStore((s) => s.activeId);
  const status = session?.status ?? 'idle';
  const busy = status !== 'idle';
  // Between turns, sub-agents can still be at work in the background: Stop and Esc reach them too.
  const background = useStore((s) => s.background.length);
  const stoppable = busy || background > 0;
  const slot = composerDraft(sessionId);
  const { text, images, points, pastes } = useSyncExternalStore(subscribeComposerDraft, () => draftValue(slot));
  const setText = (value: SetStateAction<string>) => editComposerDraft(slot, 'text', value);
  const setImages = (value: SetStateAction<typeof images>) => editComposerDraft(slot, 'images', value);
  const setPoints = (value: SetStateAction<typeof points>) => editComposerDraft(slot, 'points', value);
  const setPastes = (value: SetStateAction<typeof pastes>) => editComposerDraft(slot, 'pastes', value);
  // Long pastes wait as chips. `viewing` is the one opened to read.
  const [viewing, setViewing] = useState(-1);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The box is one line high in the dock: in a narrow one (a phone, a window with both side columns docked) the
  // long placeholders wrapped to a second line the box cut in half, so there they have a short form.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || variant !== 'dock' || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < NARROW_BOX));
    watch.observe(el);
    return () => watch.disconnect();
  }, [variant]);
  const commands = useSlashCommands();

  const modelRef = session ? `${session.meta.provider}/${session.meta.model}` : (draft.model ?? info?.config.model ?? '');
  const model = useModel(modelRef);
  const efforts = session?.model.efforts ?? model?.efforts ?? [];
  const effort = session?.meta.effort ?? draft.effort ?? info?.config.effort ?? model?.defaultEffort ?? 'medium';
  const mode = session?.meta.mode ?? draft.mode ?? 'build';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, variant === 'hero' ? 320 : 300)}px`;
  }, [text, variant]);

  useEffect(() => {
    setViewing(-1);
    ref.current?.focus();
  }, [sessionId]);

  // Messages the agent never read (the turn was interrupted or failed) come back into the box.
  const returned = useStore((s) => s.returned);
  useEffect(() => {
    if (!returned) return;
    setState({ returned: null });
    const taken = returned.items.map((i) => takePasted(i.text));
    const back = taken.map((x) => x.text).filter((x) => x.trim()).join('\n\n');
    if (back) setText((tx) => (tx.trim() ? `${back}\n\n${tx}` : back));
    if (taken.some((x) => x.pastes.length)) setPastes((xs) => [...taken.flatMap((x) => x.pastes), ...xs]);
    const imgs = returned.items.flatMap((i) => i.images).map((i) => ({ mediaType: i.mediaType, data: i.data, name: i.name ?? 'image' }));
    if (imgs.length) setImages((xs) => [...imgs, ...xs]);
    toast(t('The agent did not read your last message; it is back in the box.'), 'info');
    requestAnimationFrame(() => ref.current?.focus());
  }, [returned]);

  /** Take a waiting message back: to edit it here, or to drop it. */
  async function takeBack(q: QueuedInput, edit: boolean): Promise<void> {
    try {
      const back = await actions.unqueue(q.id);
      if (!back) {
        toast(t('The agent has already read it.'), 'info');
        return;
      }
      if (!edit) return;
      const taken = takePasted(back.text);
      if (taken.text.trim()) setText((tx) => (tx.trim() ? `${taken.text}\n\n${tx}` : taken.text));
      if (taken.pastes.length) setPastes((xs) => [...taken.pastes, ...xs]);
      if (back.images.length) setImages((xs) => [...back.images.map((i) => ({ mediaType: i.mediaType, data: i.data, name: i.name ?? 'image' })), ...xs]);
      requestAnimationFrame(() => ref.current?.focus());
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  const queued = session?.queued ?? [];
  /** A waiting message in its row: the words typed; for one that is only attachments, what they are. */
  const queuedWords = (raw: string) => {
    const words = raw.split(ATTACHED)[0].trim();
    if (words) return words;
    const n = takePasted(raw).pastes.length;
    return n ? count(t, n, '{n} pasted text', '{n} pasted texts') : t('(images only)');
  };

  // Window events use the draft that is open when they arrive, even after switching sessions.
  const compose = useEffectEvent((text: string) => {
    setText(text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  });
  const attach = useEffectEvent((files: File[]) => addFiles(files));
  const point = useEffectEvent((value: Pointed) => {
    setPoints((xs) => [...xs, value].slice(-4));
    ref.current?.focus();
  });
  useEffect(() => {
    const onCompose = (e: Event) => compose((e as CustomEvent<string>).detail);
    const onAttach = (e: Event) => attach((e as CustomEvent<File[]>).detail);
    const onPointed = (e: Event) => point((e as CustomEvent<Pointed>).detail);
    window.addEventListener('favilla:compose', onCompose);
    window.addEventListener('favilla:attach', onAttach);
    window.addEventListener(POINTED, onPointed);
    return () => {
      window.removeEventListener('favilla:compose', onCompose);
      window.removeEventListener('favilla:attach', onAttach);
      window.removeEventListener(POINTED, onPointed);
    };
  }, []);

  async function updateSuggest(value: string, caret: number): Promise<void> {
    if (/^\/[\w ]*$/.test(value) && caret === value.length) {
      const q = value.slice(1).toLowerCase();
      const items = commands.filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)));
      return setSuggest(items.length ? { kind: 'command', items, sel: 0 } : null);
    }
    let start = caret;
    while (start > 0 && !/\s/.test(value[start - 1])) start--;
    const token = value.slice(start, caret);
    if (!token.startsWith('@')) return setSuggest(null);
    try {
      const items = await api<string[]>(`/files?cwd=${encodeURIComponent(folder)}&q=${encodeURIComponent(token.slice(1))}`);
      setSuggest(items.length ? { kind: 'file', items: items.slice(0, 8), sel: 0, start } : null);
    } catch {
      setSuggest(null);
    }
  }

  function accept(index: number): void {
    if (!suggest || !ref.current) return;
    if (suggest.kind === 'command') {
      const c = suggest.items[index];
      setText('');
      setSuggest(null);
      c.run('');
      return;
    }
    const item = suggest.items[index];
    const caret = ref.current.selectionStart;
    const quoted = /\s/.test(item) ? `"${item}"` : item;
    const next = `${text.slice(0, suggest.start)}@${quoted} ${text.slice(caret)}`;
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const pos = suggest.start + quoted.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  }

  async function submit(): Promise<void> {
    const body = text.trim();
    if (!body && !images.length && !points.length && !pastes.length) return;
    const slash = /^\/(\w+)(?:\s+(.*))?$/.exec(body);
    const cmd = slash && commands.find((c) => c.name === slash[1] || c.name === `${slash[1]} ${slash[2] ?? ''}`.trim());
    if (cmd) {
      setText('');
      setSuggest(null);
      cmd.run(slash![2] ?? '');
      return;
    }
    // No model set up yet: the provider settings, where one is set up, and the words stay in the box. Sending had
    // shown the command line's "No model configured" in a toast.
    const providers = getState().providers;
    if (providers.length && !providers.some((p) => p.configured && p.models.length)) {
      setUi({ settings: 'providers' });
      return;
    }
    setViewing(-1);
    setSuggest(null);
    try {
      await submitComposerDraft(slot, (sent, restore) => actions.send(
        withAttached(sent.text.trim(), sent.points.map(pointedBlock), sent.pastes), sent.images,
        () => {
          restore();
          toast(t('The agent did not read your last message; it is back in the box.'), 'info');
        },
      ));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    const big = imgs.filter((f) => f.size >= 5 * 1024 * 1024);
    if (big.length) toast(t('Images over 5 MB are left out.'), 'warn');
    if (imgs.length > big.length) {
      const loaded = await Promise.all(imgs.filter((f) => f.size < 5 * 1024 * 1024).map(fileToImage));
      setImages((xs) => [...xs, ...loaded]);
    }
    const paths = others.map((f) => desktop?.pathForFile(f) || (f as File & { path?: string }).path).filter(Boolean) as string[];
    if (paths.length) setText((tx) => `${tx}${tx && !tx.endsWith(' ') ? ' ' : ''}${paths.map((p) => `@${/\s/.test(p) ? `"${p}"` : p}`).join(' ')} `);
    else if (others.length && !desktop) toast(t('Mention files with @ to attach them.'), 'info');
    ref.current?.focus();
  }

  const dropPaste = (i: number) => {
    setPastes((xs) => xs.filter((_, k) => k !== i));
    setViewing((v) => (v === i ? -1 : v > i ? v - 1 : v));
  };
  /** A paste back into the box as plain text, at the caret, for editing it there. */
  const intoText = (i: number) => {
    const el = ref.current;
    const at = el ? el.selectionStart : text.length;
    const pasted = pastes[i];
    setText((tx) => `${tx.slice(0, at)}${pasted}${tx.slice(at)}`);
    dropPaste(i);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + pasted.length, at + pasted.length);
    });
  };

  const lastUserText = () => {
    const last = [...(getState().session?.messages ?? [])].reverse().find((m) => m.origin === 'user');
    return last ? userWords(last) : '';
  };

  const sel = suggest?.sel ?? 0;
  return (
    <div
      className={`composer is-${variant} ${dragging ? 'is-drop' : ''} ${mode === 'plan' ? 'is-plan' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
      }}
    >
      {suggest && (
        <ul className="suggest" role="listbox" aria-label={suggest.kind === 'file' ? t('Files') : t('Commands')}>
          {suggest.kind === 'file'
            ? suggest.items.map((it, i) => (
                <li key={it} role="option" aria-selected={i === sel} className={i === sel ? 'is-sel' : ''} onMouseDown={(e) => (e.preventDefault(), accept(i))}>
                  <FileText size={14} />
                  <span className="mono">{it}</span>
                </li>
              ))
            : suggest.items.map((c, i) => (
                // Each command written as it is typed, slash and all: the same lightning mark on every row said nothing.
                <li key={c.name} role="option" aria-selected={i === sel} className={i === sel ? 'is-sel' : ''} onMouseDown={(e) => (e.preventDefault(), accept(i))}>
                  <span className="mono">/{c.name}</span>
                  <span className="suggest-hint">{c.hint}</span>
                </li>
              ))}
        </ul>
      )}
      {queued.length > 0 && (
        <ol className="queued" aria-label={t('Waiting for the agent')}>
          {queued.map((q) => (
            <li key={q.id} className="queued-item">
              <ClockCountdown size={14} className="queued-icon" data-tip={t('The agent reads this after its current step')} aria-hidden />
              <span className="queued-text">{queuedWords(q.text)}</span>
              {q.images > 0 && (
                <span className="queued-images num" data-tip={count(t, q.images, '{n} image', '{n} images')}>
                  <ImageIcon size={14} aria-hidden />
                  {q.images}
                </span>
              )}
              <span className="queued-actions">
                <button type="button" className="icon-btn is-small" data-tip={t('Edit')} aria-label={t('Edit')} onClick={() => takeBack(q, true)}>
                  <PencilSimple size={14} />
                </button>
                <button type="button" className="icon-btn is-small" data-tip={t('Take back')} aria-label={t('Take back')} onClick={() => takeBack(q, false)}>
                  <ArrowUUpLeft size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((img, i) => (
            <figure key={i} className="thumb">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
              <button type="button" className="thumb-remove" aria-label={t('Remove')} onClick={() => setImages((xs) => xs.filter((_, k) => k !== i))}>
                <X size={11} weight="bold" />
              </button>
            </figure>
          ))}
        </div>
      )}
      {(points.length > 0 || pastes.length > 0) && (
        <div className="pointed">
          {pastes.map((p, i) => (
            <span key={`paste${i}`} className={`pointed-chip is-paste ${viewing === i ? 'is-open' : ''}`}>
              <button type="button" className="paste-open" aria-expanded={viewing === i} data-tip={viewing === i ? undefined : t('Show the pasted text')} onClick={() => setViewing(viewing === i ? -1 : i)}>
                <ClipboardText size={12} />
                <span>{fill(t('Pasted text {n}'), i + 1)}</span>
                <span className="paste-lines num">{count(t, lineCount(p), '{n} line', '{n} lines')}</span>
              </button>
              <button type="button" className="pointed-remove" aria-label={t('Remove')} onClick={() => dropPaste(i)}>
                <X size={11} weight="bold" />
              </button>
            </span>
          ))}
          {points.map((p, i) => (
            <span key={i} className="pointed-chip" data-tip={p.selector}>
              <Crosshair size={12} />
              <bdi>{pointedLabel(p)}</bdi>
              <button type="button" className="pointed-remove" aria-label={t('Remove')} onClick={() => setPoints((xs) => xs.filter((_, k) => k !== i))}>
                <X size={11} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
      {viewing >= 0 && viewing < pastes.length && (
        <div className="paste-view">
          <pre tabIndex={0}>{pastes[viewing].length > PASTE_SHOWN ? `${pastes[viewing].slice(0, PASTE_SHOWN)}\n…` : pastes[viewing]}</pre>
          <div className="paste-view-bar">
            <span className="paste-view-note">{t('Sent with your message, after your words.')}</span>
            <button type="button" className="paste-view-act" onClick={() => intoText(viewing)}>
              {t('Put it in the message box')}
            </button>
          </div>
        </div>
      )}
      <textarea
        ref={ref}
        rows={variant === 'hero' ? 3 : 1}
        value={text}
        aria-label={t('Message')}
        placeholder={
          busy
            ? t(narrow ? 'Add to what the agent is doing' : 'Add to what the agent is doing; it reads this at its next step')
            : mode === 'plan'
              ? t(narrow ? 'What should change?' : 'What should change? Nothing is touched until you approve the plan.')
              : variant === 'hero'
                ? t('Describe a change, ask about the code, or paste an error')
                : t('Message Favilla')
        }
        onChange={(e) => {
          setText(e.target.value);
          updateSuggest(e.target.value, e.target.selectionStart);
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.some((f) => f.type.startsWith('image/'))) {
            e.preventDefault();
            addFiles(files);
            return;
          }
          const pasted = pasteText(e.clipboardData.getData('text/plain'));
          if (isLongPaste(pasted)) {
            e.preventDefault();
            setPastes((xs) => [...xs, pasted]);
          }
        }}
        onKeyDown={(e) => {
          if (suggest) {
            const n = suggest.items.length;
            if (e.key === 'ArrowDown') return e.preventDefault(), setSuggest({ ...suggest, sel: (sel + 1) % n } as Suggest);
            if (e.key === 'ArrowUp') return e.preventDefault(), setSuggest({ ...suggest, sel: (sel - 1 + n) % n } as Suggest);
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return e.preventDefault(), accept(sel);
            if (e.key === 'Escape') return e.preventDefault(), setSuggest(null);
          }
          if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            // Build and plan, as the mode menu lists them.
            actions.settings({ mode: nextMode(mode) }).catch((err) => toast(String(err), 'error'));
            return;
          }
          if (e.key === 'ArrowUp' && !text && !e.shiftKey) {
            const last = lastUserText();
            if (last) {
              e.preventDefault();
              setText(last);
            }
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape' && stoppable) {
            e.preventDefault();
            actions.abort();
          }
        }}
      />
      <div className="composer-bar">
        <label className="icon-btn" data-tip={t('Attach images or files')} aria-label={t('Attach images or files')}>
          <Paperclip size={16} />
          <input type="file" multiple hidden onChange={(e) => e.target.files && (addFiles([...e.target.files]), (e.target.value = ''))} />
        </label>
        <ModelPicker
          value={session?.held ?? modelRef}
          onPick={(ref) =>
            actions
              .settings({ model: ref })
              // Picked while the agent works: the server keeps it and puts it in once the turn ends or is stopped.
              .then(() => busy && ref !== modelRef && toast(fill(t('{n} takes over once this turn stops.'), ref.slice(ref.indexOf('/') + 1))))
              .catch((err) => toast(String(err), 'error'))
          }
        />
        {efforts.length > 0 && (
          <Select<Effort>
            value={effort}
            options={efforts.map((e) => ({ value: e, label: e }))}
            onChange={(e) => actions.settings({ effort: e }).catch((err) => toast(String(err), 'error'))}
            tip={t('Reasoning effort')}
            placement="top-start"
            icon={<GaugeIcon size={14} />}
            className="effort-select"
          />
        )}
        <ModeSelect mode={mode} />
        <GuardSelect />
        <span className="composer-fill" />
        <ContextGauge />
        {stoppable && !text.trim() && !images.length && !points.length && !pastes.length ? (
          <button
            type="button"
            className="send is-stop"
            onClick={() => actions.abort()}
            aria-label={busy ? t('Stop') : t('Stop the sub-agents in the background')}
            data-tip={busy ? (background ? t('Stop, with every sub-agent') : t('Stop')) : fill(t('Stop the {n} sub-agents in the background'), background)}
            data-keys="Esc"
          >
            <Stop size={14} weight="fill" />
          </button>
        ) : (
          <button
            type="button"
            className="send"
            onClick={submit}
            disabled={!text.trim() && !images.length && !points.length && !pastes.length}
            aria-label={busy ? t('Queue') : t('Send')}
            data-tip={busy ? t('Queue for the agent') : t('Send')}
            data-keys="Enter"
          >
            <ArrowUp size={16} weight="bold" />
          </button>
        )}
      </div>
      {/* The keys that do it, written: a lightning mark said "commands" without saying that / opens them. */}
      {variant === 'dock' && (
        <div className="composer-hint" aria-hidden>
          <span>
            <Keys combo="@" /> {t('attach a file')}
          </span>
          <span>
            <Keys combo="/" /> {t('commands')}
          </span>
          <span>
            <Keys combo="Shift+Enter" /> {t('new line')}
          </span>
        </div>
      )}
    </div>
  );
}
