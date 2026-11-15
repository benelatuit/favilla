import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ansiChunkToHtml, ansiToHtml, createAnsiState, liveTailLines, type AnsiState } from '../../lib/ansi';
import { useFollow } from '../../lib/follow';
import { fill, useT } from '../../lib/i18n';
import { highlightCode } from '../../lib/markdown';
import { viewCommand } from '../../lib/steps';
import type { ToolDisplay } from '../../lib/types';

/** A command as its step line: what it does in words when the model said, then the command itself, quieter. */
export function CommandTarget({ command, said, cwd }: { command: string; said?: string; cwd: string }) {
  const t = useT();
  const v = viewCommand(command, cwd);
  return (
    <span className="step-target step-cmd">
      {said && <span className="cmd-said">{said}</span>}
      <span className={`cmd-text mono ${said ? 'is-quiet' : ''}`}>
        {v.dir && <span className="cmd-dir">{v.dir} › </span>}
        {v.script ? (
          <span className="cmd-script">
            {v.script.writes ? fill(t('writes {n}'), v.script.writes) : fill(t('{n} script'), v.script.tool || 'shell')} · {fill(t('{n} lines'), v.script.lines)}
          </span>
        ) : (
          <>
            {v.head}
            {v.lines > 1 && <span className="cmd-more num"> +{v.lines - 1}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/** A command in full: where it runs, the command in shell colours, and a script it feeds in its own language. */
export function CommandBlock({ command, said, cwd }: { command: string; said?: string; cwd: string }) {
  const v = viewCommand(command, cwd);
  const sh = (text: string) => highlightCode(text, 'command.sh');
  return (
    <div className="term-cmd mono">
      {(said || v.dir) && (
        <div className="term-about">
          {said && <span className="term-said">{said}</span>}
          {v.dir && <span className="term-dir">{v.dir}</span>}
        </div>
      )}
      <div className="term-line">
        <span className="term-prompt">$</span>
        <code dangerouslySetInnerHTML={{ __html: sh(v.script ? v.script.before : v.rest) }} />
      </div>
      {v.script && (
        <>
          <pre className="term-script">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(v.script.body, v.script.as) }} />
          </pre>
          <div className="term-line">
            <code dangerouslySetInnerHTML={{ __html: sh(v.script.after) }} />
          </div>
        </>
      )}
    </div>
  );
}

interface LiveChunk {
  el: HTMLSpanElement;
  raw: string;
}

/**
 * Streaming terminal pane that appends settled lines incrementally in O(delta) time instead of re-parsing and
 * replacing all 60 KB of DOM on every progress frame, preserving selection and inner scroll state.
 */
function LiveTerminal({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);
  const followingRef = useRef(true);
  const cacheRef = useRef<{ settledRaw: string; chunks: LiveChunk[]; ansi: AnsiState; tailHtml: string }>({
    settledRaw: '',
    chunks: [],
    ansi: createAnsiState(),
    tailHtml: '',
  });

  // Populate new output chunks before `useFollow`'s layout effect reads `pre.scrollHeight`.
  useLayoutEffect(() => {
    const pre = ref.current;
    const tailEl = tailRef.current;
    if (!pre || !tailEl) return;
    const cache = cacheRef.current;

    if (!text.startsWith(cache.settledRaw)) {
      const probeStart = Math.max(0, cache.settledRaw.length - 128);
      const probe = cache.settledRaw.slice(probeStart);
      const hit = probe.length >= 16 ? text.indexOf(probe) : -1;
      const trimmed = hit >= 0 && hit < probeStart ? probeStart - hit : 0;
      if (trimmed > 0 && text.startsWith(cache.settledRaw.slice(trimmed))) {
        const heightBefore = pre.scrollHeight;
        let removed = 0;
        while (cache.chunks.length && removed + cache.chunks[0].raw.length <= trimmed) {
          const old = cache.chunks.shift()!;
          removed += old.raw.length;
          old.el.remove();
        }
        if (removed < trimmed && cache.chunks.length) {
          const head = cache.chunks[0];
          head.raw = head.raw.slice(trimmed - removed);
          head.el.innerHTML = ansiToHtml(head.raw);
        }
        cache.settledRaw = cache.settledRaw.slice(trimmed);
        if (!followingRef.current && pre.scrollTop > 0) {
          const lost = heightBefore - pre.scrollHeight;
          if (lost > 0) pre.scrollTop = Math.max(0, pre.scrollTop - lost);
        }
      } else {
        for (const c of cache.chunks) c.el.remove();
        cache.chunks = [];
        cache.settledRaw = '';
        cache.ansi = createAnsiState();
        cache.tailHtml = '';
      }
    }

    const remainder = text.slice(cache.settledRaw.length);
    const nl = remainder.lastIndexOf('\n');
    let tailRaw = remainder;
    if (nl >= 0) {
      const fresh = remainder.slice(0, nl + 1);
      const span = document.createElement('span');
      span.innerHTML = ansiChunkToHtml(fresh, cache.ansi);
      pre.insertBefore(span, tailEl);
      cache.chunks.push({ el: span, raw: fresh });
      cache.settledRaw += fresh;
      tailRaw = remainder.slice(nl + 1);
    }
    const nextTailHtml = tailRaw ? ansiChunkToHtml(tailRaw, { ...cache.ansi }) : cache.chunks.length ? '' : ' ';
    if (nextTailHtml !== cache.tailHtml) {
      tailEl.innerHTML = nextTailHtml;
      cache.tailHtml = nextTailHtml;
    }
  }, [text]);

  const { following } = useFollow(() => ref.current, { enabled: true, live: true });
  followingRef.current = following;

  return (
    <pre ref={ref} className="plate terminal">
      <span ref={tailRef}> </span>
    </pre>
  );
}

export function Terminal({ text, follow }: { text: string; follow?: boolean }) {
  if (follow) return <LiveTerminal text={text} />;
  return <pre className="plate terminal" dangerouslySetInnerHTML={{ __html: ansiToHtml(text || ' ') }} />;
}

export function LiveTail({ text }: { text: string }) {
  const lines = liveTailLines(text, 3);
  if (!lines.length) return null;
  return <pre className="step-tail">{lines.join('\n')}</pre>;
}

export function ShellResultView({
  d,
  said,
  cwd,
  more,
}: {
  d: Extract<ToolDisplay, { kind: 'terminal' }>;
  said?: string;
  cwd: string;
  more: ReactNode;
}) {
  const t = useT();
  return (
    <div className="plate terminal-plate">
      <CommandBlock command={d.command} said={said} cwd={cwd} />
      {d.clipped && <div className="term-note mono">{t('Showing the end of the output')}</div>}
      <Terminal text={d.output} />
      {more}
      {d.logPath && (
        <div className="term-note mono" data-ctx="file" data-path={d.logPath}>
          {t('Full log')}: {d.logPath}
        </div>
      )}
    </div>
  );
}
