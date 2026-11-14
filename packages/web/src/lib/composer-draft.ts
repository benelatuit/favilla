import { asPointed, type Pointed } from './point';

interface Attachment {
  mediaType: string;
  data: string;
  name: string;
}

interface Draft {
  text: string;
  images: Attachment[];
  points: Pointed[];
  pastes: string[];
}

interface Slot {
  key: string;
  value: Draft;
  movedTo?: Slot;
}

const empty: Draft = { text: '', images: [], points: [], pastes: [] };
const drafts = new Map<string | null, Slot>();
const listeners = new Set<() => void>();

export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function composerDraft(id: string | null): Slot {
  const kept = drafts.get(id);
  if (kept) return kept;
  const key = 'favilla.draft.' + (id ?? 'new');
  let text = '';
  let pastes: string[] = [];
  let points: Pointed[] = [];
  try {
    text = localStorage.getItem(key) ?? '';
    const stored: unknown = JSON.parse(localStorage.getItem(key + '.pastes') ?? '[]');
    if (Array.isArray(stored)) pastes = stored.filter((x): x is string => typeof x === 'string');
    const pointed: unknown = JSON.parse(localStorage.getItem(key + '.points') ?? '[]');
    if (Array.isArray(pointed)) points = pointed.map(asPointed).filter((p) => p !== null);
  } catch {
    /* The draft still works in memory when storage is unavailable. */
  }
  const slot = { key, value: { ...empty, text, pastes, points } };
  drafts.set(id, slot);
  return slot;
}

/** An async paste or a refused send may finish after its draft moved to a replacement. */
function current(slot: Slot): Slot {
  while (slot.movedTo) slot = slot.movedTo;
  return slot;
}

export const draftValue = (slot: Slot): Draft => current(slot).value;

function save(slot: Slot, value: Draft): void {
  const before = slot.value;
  slot.value = value;
  try {
    if (value.text !== before.text) {
      if (value.text) localStorage.setItem(slot.key, value.text);
      else localStorage.removeItem(slot.key);
    }
    // An image can exceed the browser's whole storage quota. Keep only it in memory.
    for (const field of ['pastes', 'points'] as const) {
      if (value[field] === before[field]) continue;
      const key = slot.key + '.' + field;
      if (value[field].length) localStorage.setItem(key, JSON.stringify(value[field]));
      else localStorage.removeItem(key);
    }
  } catch {
    /* Storage unavailable or full. */
  }
}

export function editComposerDraft<K extends keyof Draft>(slot: Slot, field: K, update: Draft[K] | ((before: Draft[K]) => Draft[K])): void {
  const to = current(slot);
  const value = typeof update === 'function' ? update(to.value[field]) : update;
  if (to.value[field] === value) return;
  save(to, { ...to.value, [field]: value });
  listeners.forEach((listener) => listener());
}

function prepend(slot: Slot, prior: Draft): void {
  const next = slot.value;
  save(slot, {
    text: [prior.text, next.text].filter(Boolean).join('\n\n'),
    images: [...prior.images, ...next.images],
    points: [...prior.points, ...next.points],
    pastes: [...prior.pastes, ...next.pastes],
  });
}

export function moveComposerDraft(from: string | null, to: string): void {
  const old = current(composerDraft(from));
  const next = current(composerDraft(to));
  if (old === next) return;
  prepend(next, old.value);
  save(old, empty);
  old.movedTo = next;
  if (from === null) drafts.delete(from);
  listeners.forEach((listener) => listener());
}

export async function submitComposerDraft(slot: Slot, send: (input: Draft, restore: () => void) => Promise<void>): Promise<void> {
  const to = current(slot);
  const sent = to.value;
  save(to, empty);
  listeners.forEach((listener) => listener());
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    prepend(current(to), sent);
    listeners.forEach((listener) => listener());
  };
  try {
    await send(sent, restore);
  } catch (error) {
    restore();
    throw error;
  }
}
