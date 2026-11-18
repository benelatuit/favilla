import { diffHtml, highlightLines } from './diff';

/**
 * Colours a whole file, or a long patch, away from the page. Lines go both ways as one string each way, joined at
 * their breaks: one string costs a fraction of five thousand to copy between the threads. A patch comes back as its
 * rows' markup, word marks included, in the order `diffRows` lays the rows out in the page.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; path: string; text?: string; patch?: string }>) => void) | null;
  postMessage(message: unknown): void;
};
scope.onmessage = (e) => {
  const { id, text, patch, path } = e.data;
  const html = patch !== undefined ? diffHtml(patch, path) : highlightLines((text ?? '').split('\n'), path);
  scope.postMessage({ id, html: html.join('\n') });
};
