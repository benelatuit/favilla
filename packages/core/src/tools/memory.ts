import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../auth/store';
import { appPath, projectSlug } from '../util/paths';
import { oneLine } from '../util/text';
import type { ToolDef } from './types';

/** Notes are a short list: past this size, the oldest go. */
const MAX_CHARS = 4000;

/**
 * Two kinds of note. A project's: true of this codebase or folder (how to build, run and test it, conventions,
 * pitfalls, decisions made here). Global: true of the user wherever they work (how they want the work done and
 * written, their name and sign-off, their machine and tools), read in every folder.
 */
export type MemoryScope = 'project' | 'global';

/** Where a project's notes live: in Favilla's own folder, so nothing is added to the repository. */
export function memoryFile(cwd: string): string {
  return appPath('projects', projectSlug(cwd), 'memory.md');
}

/** Where the notes about the user live, beside Favilla's config, for every folder. */
export function globalMemoryFile(): string {
  return appPath('memory.md');
}

function readNotes(file: string): string[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/^- /, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readMemory(cwd: string): string[] {
  return readNotes(memoryFile(cwd));
}

export function readGlobalMemory(): string[] {
  return readNotes(globalMemoryFile());
}

/**
 * Change a notes file as little as it takes: a note goes on at the end, a replaced one leaves its own line, and the
 * rest stays as written. The user can write in these files through Settings (headings, paragraphs, a long list), and
 * rewriting them as one bullet a line, dropping the oldest past 4,000 characters, had flattened and cut what they
 * wrote (2026-11-06). Past the size, only a file of the tool's own bullets loses its oldest; one with anything else
 * in it is left whole and the note is refused. Returns why it was refused, or null.
 */
function editNotes(file: string, o: { remove?: string; add?: string }): string | null {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    /* no notes yet */
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const strip = (l: string) => l.replace(/^- /, '').trim();
  let lines = raw.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (o.remove) lines = lines.filter((l) => strip(l) !== o.remove);
  if (o.add && !lines.some((l) => strip(l) === o.add)) lines.push(`- ${o.add}`);
  const size = () => lines.reduce((n, l) => n + l.length + 1, 0);
  if (size() > MAX_CHARS) {
    const toolsOwn = lines.every((l) => !l.trim() || l.startsWith('- '));
    if (!toolsOwn) return `The notes are full (${size()} of ${MAX_CHARS} characters) and hold text the user wrote, which is not cut: replace an outdated note (replaces: its exact text), or ask the user to shorten them in Settings.`;
    while (lines.length > 1 && size() > MAX_CHARS) lines.shift();
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!lines.some((l) => l.trim())) fs.rmSync(file, { force: true });
  else writeFileAtomic(file, lines.join(eol) + eol, { own: true });
  return null;
}

/** What reads as a credential: notes are plain files that start every prompt, so none is kept. */
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{15,}\.[\w-]{15,})|(?:password|passwd|密码|口令)\s*(?:is|=|:|：|是)\s*\S/i;

export interface RememberInput {
  note: string;
  /** The exact text of an earlier note, of either kind, this one corrects or replaces. */
  replaces?: string;
  scope?: MemoryScope;
}

/**
 * What a later session would otherwise have to find out again, kept as short notes that start every new session's
 * prompt: about this project, or about the user in every project.
 */
export const rememberTool: ToolDef<RememberInput> = {
  kind: 'todo',
  readOnly: true,
  title: (i) => `Remember${i.scope === 'global' ? ' (every project)' : ''}: ${oneLine(i.note, 90)}`,
  async execute(input, ctx) {
    const note = oneLine(input.note ?? '', 300).trim();
    if (!note) return { content: 'Give the note: one sentence a later session needs.', isError: true };
    if (SECRET.test(note)) return { content: 'Notes never hold a key, token or password: they start every prompt as plain text. Note where the user keeps it (an environment variable, a file) or nothing.', isError: true };
    const scope: MemoryScope = input.scope === 'global' ? 'global' : 'project';
    const files: Record<MemoryScope, string> = { project: memoryFile(ctx.cwd), global: globalMemoryFile() };
    const notes: Record<MemoryScope, string[]> = { project: readNotes(files.project), global: readNotes(files.global) };
    if (input.replaces) {
      // A note may move: a preference first kept for one project turns out to hold everywhere.
      const old = oneLine(input.replaces, 300).trim();
      const where = (['project', 'global'] as const).find((s) => notes[s].includes(old));
      if (!where) {
        const all = [...notes.global.map((n) => `- (every project) ${n}`), ...notes.project.map((n) => `- ${n}`)];
        return { content: `No note reads exactly "${old}". The notes are:\n${all.join('\n') || '(none)'}`, isError: true };
      }
      if (where !== scope) {
        // Added where it goes before it leaves where it was: refused there, it stays put.
        const refused = editNotes(files[scope], { add: note });
        if (refused) return { content: refused, isError: true };
        editNotes(files[where], { remove: old });
      } else {
        const refused = editNotes(files[scope], { remove: old, add: note });
        if (refused) return { content: refused, isError: true };
      }
    } else {
      const refused = editNotes(files[scope], { add: note });
      if (refused) return { content: refused, isError: true };
    }
    notes[scope] = readNotes(files[scope]);
    const n = notes[scope].length;
    const saved = scope === 'global' ? `Noted for every project (${n} note${n === 1 ? '' : 's'} about the user).` : `Noted for later sessions in this project (${n} note${n === 1 ? '' : 's'}).`;
    // The notes beside it, so one the new note makes wrong is seen and replaced: a model kept "answers in English"
    // beside "以后都用中文" (2026-11-05).
    const others = notes[scope].filter((x) => x !== note).slice(-12);
    return { content: others.length ? `${saved} The other notes there:\n${others.map((x) => `- ${x}`).join('\n')}\nIf the new note makes one of them wrong or outdated, replace it now (replaces: its exact text).` : saved };
  },
};
