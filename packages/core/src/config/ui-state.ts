import fs from 'node:fs';
import { withFileUpdate, writeFileAtomic } from '../auth/store';
import { isObject } from './schema';
import { appPath } from '../util/paths';

/**
 * What the app's window should come back to: the folder it had open, the recent folders, the last session
 * and the panels. Kept by Favilla in its own folder rather than in the page's storage, which belongs to an
 * address (a new port on each start of the desktop app meant an empty storage and an app that "forgot").
 */
export interface UiState {
  folder?: string;
  recent?: string[];
  session?: string;
  layout?: { sidebar: boolean; panel: boolean };
  /** The model and effort of the user's last message, which a new session starts with. */
  last?: { model?: string; effort?: string };
  /** Sessions kept at the top of the sidebar, and folders folded there. */
  pinned?: string[];
  collapsed?: string[];
}

const file = () => appPath('ui-state.json');

function uiState(value: unknown): value is UiState {
  if (!isObject(value)) return false;
  const { folder, session, recent, layout, last, pinned, collapsed } = value;
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((f) => typeof f === 'string'));
  return (folder === undefined || typeof folder === 'string')
    && (session === undefined || typeof session === 'string')
    && strings(recent) && strings(pinned) && strings(collapsed)
    && (layout === undefined || isObject(layout) && typeof layout.sidebar === 'boolean' && typeof layout.panel === 'boolean')
    && (last === undefined || isObject(last) && (last.model === undefined || typeof last.model === 'string') && (last.effort === undefined || typeof last.effort === 'string'));
}

function read(target: string): { value: UiState; damaged?: Buffer } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: {} };
    throw e;
  }
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (uiState(value)) return { value };
  } catch {
    // A window can be killed while writing its place.
  }
  return { value: {}, damaged: bytes };
}

export function readUiState(): UiState {
  try {
    return read(file()).value;
  } catch {
    return {};
  }
}

/** Merge the known fields of `patch` (anything else is dropped) and save; returns the new state. */
export function writeUiState(patch: Record<string, unknown>): UiState {
  const target = file();
  return withFileUpdate(target, (stillHeld) => {
    const { value: next, damaged } = read(target);
    if (damaged) writeFileAtomic(`${target}.broken`, damaged, { beforeReplace: stillHeld });
    if (typeof patch.folder === 'string') next.folder = patch.folder;
    const strings = (v: unknown[], most: number) => v.filter((f): f is string => typeof f === 'string').slice(0, most);
    if (Array.isArray(patch.recent)) next.recent = strings(patch.recent, 16);
    if (Array.isArray(patch.pinned)) next.pinned = strings(patch.pinned, 200);
    if (Array.isArray(patch.collapsed)) next.collapsed = strings(patch.collapsed, 200);
    if (typeof patch.session === 'string') next.session = patch.session;
    const l = patch.layout as { sidebar?: unknown; panel?: unknown } | undefined;
    if (l && typeof l === 'object') next.layout = { sidebar: !!l.sidebar, panel: !!l.panel };
    const last = patch.last as { model?: unknown; effort?: unknown } | undefined;
    if (last && typeof last === 'object') next.last = { ...(typeof last.model === 'string' ? { model: last.model } : {}), ...(typeof last.effort === 'string' ? { effort: last.effort } : {}) };
    writeFileAtomic(target, JSON.stringify(next, null, 2), { own: true, beforeReplace: stillHeld });
    return next;
  });
}
