import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { markMarkdownEdited, renderMarkdown, renderStreamingParts, updateStreamingMarkdown } from '../../lib/markdown';
import { useSessionScope } from '../tools/SessionScope';
import { openViewer } from '../ui/Viewer';

/**
 * Pictures in markdown: a click opens the viewer, and one that cannot be read becomes a line naming it instead of
 * the browser's broken-image mark.
 */
export function useMarkdownImages(ref: React.RefObject<HTMLElement | null>, missing: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const img = e.target as HTMLImageElement;
      if (img.tagName !== 'IMG' || !img.closest('.md')) return;
      openViewer([{ src: img.src, name: img.alt || 'image' }], 0, img);
    };
    const onError = (e: Event) => {
      const img = e.target as HTMLImageElement;
      if (img.tagName !== 'IMG' || !img.closest('.md')) return;
      const span = document.createElement('span');
      span.className = 'md-img-missing';
      const path = new URL(img.src, location.href).searchParams.get('path');
      span.textContent = `${missing}: ${img.alt || path || img.src}`;
      // A figure goes with its picture: its words are in the line that stands in.
      markMarkdownEdited(img);
      (img.closest('.md-figure') ?? img).replaceWith(span);
    };
    el.addEventListener('click', onClick);
    // Load errors do not bubble; they are seen on the way down.
    el.addEventListener('error', onError, true);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('error', onError, true);
    };
  }, [ref, missing]);
}

/** Copy buttons in code blocks rendered from markdown. */
export function useCodeCopy(ref: React.RefObject<HTMLElement | null>, done: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('[data-copy-code]') as HTMLButtonElement | null;
      if (!btn) return;
      const code = btn.closest('pre')?.querySelector('code')?.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => {
        markMarkdownEdited(btn);
        btn.classList.add('is-done');
        btn.dataset.tip = done;
        setTimeout(() => btn.classList.remove('is-done'), 1400);
      });
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [ref, done]);
}

/** `stamp`: the message the text is in, so its pictures are loaded for it and not taken from an earlier answer's (see pictureSrc). */
export const Markdown = memo(function Markdown({ text, streaming, className, stamp }: { text: string; streaming?: boolean; className?: string; stamp?: string }) {
  const { sessionId: session } = useSessionScope();
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<typeof updateStreamingMarkdown>>(undefined);
  const parts = streaming ? renderStreamingParts(text, session, stamp) : undefined;
  useLayoutEffect(() => {
    mounted.current = parts && updateStreamingMarkdown(ref.current!, parts, mounted.current);
  }, [parts]);
  return <div ref={ref} className={`md ${className ?? ''}`} dangerouslySetInnerHTML={parts ? undefined : { __html: renderMarkdown(text, session, stamp) }} />;
});
