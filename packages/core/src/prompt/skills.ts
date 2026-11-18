import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appPath, assetsDir, isInside, toForward } from '../util/paths';

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** The folder that holds the skill folders, and the skill's own folder name in it. */
  root: string;
  folder: string;
  /** Found in the project rather than in a folder under the home directory. */
  project: boolean;
}

/** `key: value` lines with indented continuation lines, for frontmatter that is not valid YAML. */
function looseFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      out[key] = m[2].trim();
    } else if (key && /^\s+\S/.test(line)) out[key] += ` ${line.trim()}`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^(['"])(.*)\1$/, '$2');
  return out;
}

function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try {
    const v = parseYaml(m[1]);
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    /* hand-written frontmatter is often not strict YAML */
  }
  return looseFields(m[1]);
}

/**
 * Where skills live, in order of precedence: the project's own folders (working directory up to the
 * repository root), Favilla's folder, the shared ~/.agents folder (Codex and others), Claude Code's,
 * any configured extra folders, then the skills Favilla ships.
 */
export function skillDirs(cwd: string, extra: string[] = []): { dir: string; project: boolean }[] {
  const home = os.homedir();
  const out: { dir: string; project: boolean }[] = [];
  for (let dir = path.resolve(cwd); dir !== home; dir = path.dirname(dir)) {
    for (const d of ['.favilla', '.agents', '.claude']) out.push({ dir: path.join(dir, d, 'skills'), project: true });
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
  for (const dir of [appPath('skills'), path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills'), ...extra]) out.push({ dir, project: false });
  // The skills that ship with Favilla come last: any folder above can replace one by its name.
  out.push({ dir: path.join(assetsDir(), 'skills'), project: false });
  return out;
}

/** Skills found in those folders: one per subfolder with a SKILL.md that has a description. The first of a name wins. */
export function discoverSkills(cwd: string, extra?: string[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { dir, project } of skillDirs(cwd, extra)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fm = frontmatter(text);
      const name = String(fm?.name ?? e.name).trim();
      const description = String(fm?.description ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name || !description || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, description, path: toForward(file), root: toForward(dir), folder: e.name, project });
    }
  }
  return out;
}

/**
 * The skills a confined run (FAVILLA_CONFINE=1) can open: those inside its own folder and those Favilla ships. A skill in
 * a folder of the user's (~/.agents, ~/.claude, Favilla's own) is refused when read there, and listing it anyway cost a
 * read that failed and was made again (twice in two runs on 2026-11-17), and showed a model reached through someone
 * else's account what the user keeps in folders it was meant to stay out of.
 */
export function confinedSkills(skills: Skill[], cwd: string): Skill[] {
  const roots = [cwd, path.join(assetsDir(), 'skills')];
  return skills.filter((s) => roots.some((root) => isInside(root, s.path)));
}

/** At most `max` characters, cut after a word, so a long description stays a hint. */
function brief(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > max * 0.6 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/**
 * The skills section of the system prompt. Folders are listed once and numbered so each skill costs one
 * short line; the model reads <folder>/<name>/SKILL.md when a skill applies.
 */
export function skillsSection(skills: Skill[], readTool: string): string {
  if (!skills.length) return '';
  const roots = [...new Set(skills.map((s) => s.root))];
  // A line each, short: the index says which skill fits, its SKILL.md says the rest. Fifty skills at 150 characters
  // were a quarter of every request's opening (2026-11-02). The skills of a folder stand under it, so no line carries
  // its folder, and an opening that only says when to use a skill gives its characters to what it is for.
  const hints = skills.map(s => brief(s.description.replace(/^use (?:this skill )?when (?:the user )?(?:explicitly )?(?:asks? (?:for |to |how to |about )?)?/i, ''), 70));
  const short = hints.map(hint => skills.length > 8 ? brief(hint, 48) : hint);
  // Keep the longer hint if truncation alone would make two procedures indistinguishable.
  const distinct = new Map<string, Set<string>>();
  short.forEach((key, i) => {
    if (!distinct.has(key)) distinct.set(key, new Set());
    distinct.get(key)!.add(hints[i]);
  });
  const lines = skills.map((s, i) => {
    const related = distinct.get(short[i])!;
    const hint = related.size === 1 ? short[i] : hints[i];
    return `- ${s.folder}${s.name !== s.folder ? ` (${s.name})` : ''}: ${hint}`;
  });
  return [
    '# Skills',
    `Skills hold the procedure for particular kinds of work. When a request matches one, read its SKILL.md with ${readTool} before you start and follow it; open the files it points to only when you need them.`,
    ...roots.flatMap((r) => [`In ${r} (a skill's file is <skill>/SKILL.md there):`, ...lines.filter((_, i) => skills[i].root === r)]),
  ].join('\n');
}
