import { diffHtml, highlightSlices } from './diff';

/**
 * A long file's lines, or a long patch's rows, coloured without the page doing it: in a worker, in one pass, or,
 * where a worker will not start, a slice at a time in the page's idle time. Coloured in the page, a file of 5,000
 * lines took 300 ms of its idle time at a quarter speed, and the chunks drawn meanwhile were drawn again when the
 * colours came.
 */
let worker: Worker | null | undefined;
let next = 0;
const waiting = new Map<number, (html: string[] | null) => void>();

function colourWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'function' ? new Worker(new URL('./colour.worker.ts', import.meta.url), { type: 'module' }) : null;
  } catch {
    worker = null;
  }
  if (!worker) return null;
  worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
    const done = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    idle();
    done?.(e.data.html.split('\n'));
  };
  // One that will not load or fails: the page colours what was asked, and from then on.
  worker.onerror = (e) => {
    e.preventDefault();
    worker?.terminate();
    worker = null;
    const all = [...waiting.values()];
    waiting.clear();
    for (const done of all) done(null);
  };
  return worker;
}

/** Lines past this are coloured off the page: coloured in one go, a long file or patch held the page before it showed. */
export const COLOUR_AT_ONCE = 600;
/**
 * A patch's lines past this are coloured off the page. A diff colours both its sides and a sheet holds several: in the
 * page, the 250-line start of a long change took 40 ms of the changes view's opening at a quarter speed.
 */
export const DIFF_AT_ONCE = 150;

/** Colour `lines` for `path`; `done` gets one markup string a line. The returned function drops the result. */
export function colourLines(lines: string[], path: string, done: (html: string[]) => void): () => void {
  return ask({ text: lines.join('\n'), path }, () => inPage(lines, path, done), done);
}

/**
 * Colour a patch for `path`; `done` gets the markup of each row as `diffRows` lays them out. Where no worker will
 * start, the page colours it in one idle callback, which is the work it did before at once.
 */
export function colourDiff(patch: string, path: string, done: (html: string[]) => void): () => void {
  return ask({ patch, path }, () => later(() => done(diffHtml(patch, path))), done);
}

function ask(job: { path: string; text?: string; patch?: string }, fallback: () => () => void, done: (html: string[]) => void): () => void {
  const w = colourWorker();
  if (!w) return fallback();
  const id = ++next;
  let stop: (() => void) | null = null;
  waiting.set(id, (html) => {
    if (html) done(html);
    else stop = fallback();
  });
  w.postMessage({ id, ...job });
  return () => {
    stop?.();
    waiting.delete(id);
    idle();
  };
}

function later(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 300 });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 16);
  return () => window.clearTimeout(id);
}

/**
 * With nothing left to colour the worker goes, and a long file still being coloured stops with it. Kept, it held a
 * second copy of highlight.js and the grammars it had compiled until another file opened; it starts again when one does.
 */
function idle() {
  if (waiting.size || !worker) return;
  worker.terminate();
  worker = undefined;
}

function inPage(lines: string[], path: string, done: (html: string[]) => void): () => void {
  const slices = highlightSlices(lines, path);
  const html: string[] = [];
  // Between frames only: slices queued as timers kept the view from being drawn for up to 400 ms at a quarter speed.
  const hasIdle = typeof requestIdleCallback === 'function';
  let id = 0;
  const step = (deadline?: IdleDeadline) => {
    const t0 = performance.now();
    do {
      const n = slices.next();
      if (n.done) return done(html);
      html.push(...n.value);
    } while (deadline ? deadline.timeRemaining() > 6 : performance.now() - t0 < 8);
    id = hasIdle ? requestIdleCallback(step, { timeout: 300 }) : window.setTimeout(step, 16);
  };
  id = hasIdle ? requestIdleCallback(step, { timeout: 300 }) : window.setTimeout(step, 16);
  return () => (hasIdle ? cancelIdleCallback(id) : window.clearTimeout(id));
}
