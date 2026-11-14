import type { Mermaid } from 'mermaid';

let loading: Promise<Mermaid> | null = null;
let drawing = Promise.resolve();
let initialized: string | undefined;
let seq = 0;
const tried = new WeakMap<HTMLElement, string>();
const theme = () => document.documentElement.dataset.theme ?? '';
const ready = (el: Element) => !el.closest('.is-streaming');

/** The diagram library is large, so it loads the first time a finished answer has a diagram. */
function load(): Promise<Mermaid> {
  return (loading ??= import('mermaid').then(({ default: mermaid }) => mermaid));
}

function initialize(mermaid: Mermaid, current: string): void {
  if (initialized === current) return;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    // Drawn in the theme's own inks on the sheet, like everything else on the vellum.
    themeVariables: {
      background: 'transparent',
      primaryColor: v('--sheet'),
      primaryTextColor: v('--ink'),
      primaryBorderColor: v('--rule-strong'),
      secondaryColor: v('--sheet-2'),
      tertiaryColor: v('--paper'),
      lineColor: v('--ink-3'),
      textColor: v('--ink'),
      noteBkgColor: v('--accent-wash'),
      noteBorderColor: v('--accent-line'),
      fontFamily: v('--font-sans'),
      fontSize: v('--fs-ui'),
    },
  });
  initialized = current;
}

/** Render after the answer ends, so streamed HTML cannot put the source back under a drawing. */
async function draw(root: ParentNode): Promise<void> {
  const current = theme();
  const blocks = [...root.querySelectorAll<HTMLElement>('.mermaid-block')].filter((el) => ready(el) && tried.get(el) !== current);
  if (!blocks.length) return;
  const mermaid = await load();
  if (theme() !== current) return;
  initialize(mermaid, current);
  for (const el of blocks) {
    if (theme() !== current) return;
    if (!el.isConnected || !ready(el)) continue;
    const src = el.dataset.mermaidSrc ?? '';
    tried.set(el, current);
    try {
      if (!(await mermaid.parse(src, { suppressErrors: true }))) continue;
      const { svg } = await mermaid.render(`diagram-${++seq}`, src);
      if (!el.isConnected || !ready(el) || theme() !== current) {
        tried.delete(el);
        continue;
      }
      el.innerHTML = svg;
      el.classList.add('is-drawn');
    } catch {
      /* A broken diagram keeps its source. */
    }
  }
}

/** Mermaid's configuration is global, so a theme change waits for any render already in progress. */
function drawDiagrams(root: ParentNode = document): Promise<void> {
  const next = drawing.then(() => draw(root));
  drawing = next.catch(() => {});
  return next;
}

/** Watch for completed answers, re-rendered markup and changes of the document's theme. */
export function watchDiagrams(): () => void {
  let timer = 0;
  const soon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void drawDiagrams().catch(() => {}), 250);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName === 'data-theme') return soon();
      if (r.attributeName === 'class' && r.target instanceof HTMLElement && r.target.matches('.answer:not(.is-streaming)') && r.target.querySelector('.mermaid-block')) return soon();
      for (const n of r.addedNodes) {
        if (n instanceof HTMLElement && ready(n) && (n.matches('.mermaid-block') || n.querySelector('.mermaid-block'))) return soon();
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  soon();
  return () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
}
