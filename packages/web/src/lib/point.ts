import { ATTACHED } from './messages';
import type { Message } from './types';

/** An element the user pointed at in a preview, as the page's point-and-tell script describes it (assets/preview/point.js). */
export interface Pointed {
  page: string;
  tag: string;
  selector: string;
  text: string;
  box: [number, number, number, number];
  view: [number, number];
  style: { color: string; background: string; font: string; padding: string; margin: string; radius: string };
  html: string;
  events: { ago: number; kind: string; text: string }[];
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * What a previewed page sent as a picked element, checked field by field and cut to size: the page is the user's
 * project, not Favilla, and anything it sends goes into the composer. Null when it is not an element's description.
 */
export function asPointed(v: unknown): Pointed | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : '');
  const nums = (x: unknown, n: number) => (Array.isArray(x) && x.length === n && x.every((k) => typeof k === 'number' && Number.isFinite(k)) ? (x as number[]) : null);
  const box = nums(o.box, 4);
  const view = nums(o.view, 2);
  if (!str(o.tag, 40) || !box || !view) return null;
  const s = (o.style && typeof o.style === 'object' ? o.style : {}) as Record<string, unknown>;
  const events = Array.isArray(o.events) ? o.events.slice(-20) : [];
  return {
    page: str(o.page, 500),
    tag: str(o.tag, 40),
    selector: str(o.selector, 300),
    text: str(o.text, 120),
    box: box as Pointed['box'],
    view: view as Pointed['view'],
    style: { color: str(s.color, 60), background: str(s.background, 60), font: str(s.font, 120), padding: str(s.padding, 60), margin: str(s.margin, 60), radius: str(s.radius, 60) },
    html: str(o.html, 300),
    events: events.flatMap((e) => (e && typeof e === 'object' && typeof (e as { ago?: unknown }).ago === 'number' ? [{ ago: (e as { ago: number }).ago, kind: str((e as { kind?: unknown }).kind, 20), text: str((e as { text?: unknown }).text, 240) }] : [])),
  };
}

/** What the user sees of a pointed element: its tag and the start of its words. */
export const pointedLabel = (p: Pick<Pointed, 'tag' | 'text'>) => `${p.tag}${p.text ? ` · ${p.text.slice(0, 32)}` : ''}`;

/**
 * An element as it goes with the user's message, after their words: where it is on the page, what it looks like,
 * its markup, and what the page did in the seconds before (clicks, errors, failed requests), for the agent to find
 * it in the code and see what went wrong.
 */
export function pointedBlock(p: Pointed): string {
  const lines = [
    'The user pointed at this element in the preview of the page:',
    `${p.selector}${p.text ? ` "${p.text}"` : ''}, ${p.box[2]}×${p.box[3]} at (${p.box[0]}, ${p.box[1]}) in a ${p.view[0]}×${p.view[1]} view`,
    `style: ${p.style.color} on ${p.style.background}, ${p.style.font}, padding ${p.style.padding}, radius ${p.style.radius}`,
    `markup: ${p.html}`,
    p.events.length ? `the page's last 15 seconds: ${p.events.map((e) => `${e.ago} s before, ${e.kind}: ${e.text}`).join(' · ')}` : "the page's last 15 seconds: no clicks, errors or failed requests",
  ];
  return `<element page="${attr(p.page)}" selector="${attr(p.selector)}" label="${attr(pointedLabel(p))}">\n${lines.join('\n')}\n</element>`;
}

/** The elements a user's message pointed at, by their labels. */
export function pointedIn(m: Message): { label: string; selector: string }[] {
  const text = m.parts.map((p) => (p.type === 'text' && !p.synthetic ? p.text : '')).join('\n');
  const block = text.split(ATTACHED)[1] ?? '';
  const unattr = (s: string) => s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return [...block.matchAll(/<element page="[^"]*" selector="([^"]*)" label="([^"]*)">/g)].map((x) => ({ selector: unattr(x[1]), label: unattr(x[2]) }));
}
