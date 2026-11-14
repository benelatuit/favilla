import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appPath, toForward } from '../util/paths';

export interface InstructionFile {
  path: string;
  content: string;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Inline `@path` lines (one level deep), the convention AGENTS.md / CLAUDE.md files use for includes. */
function expandImports(text: string, baseDir: string, budget: { left: number }): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^@(\S+)\s*$/.exec(line.trim());
      if (!m) return line;
      const target = path.resolve(baseDir, m[1].replace(/^~(?=[\\/])/, os.homedir()));
      const inner = read(target);
      if (inner === null || inner.length > budget.left) return line;
      budget.left -= inner.length;
      return `<!-- included from ${toForward(target)} -->\n${inner.trim()}`;
    })
    .join('\n');
}

/** The repository root above `cwd` (the nearest folder with .git), or `cwd` itself outside a repository. */
export function findRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/**
 * Project instruction files: the global ~/.favilla/AGENTS.md, then one file per folder from the
 * repository root down to the working directory (AGENTS.md first, then the other known names).
 */
export const instructionNames = (names: string[] | string): string[] => typeof names === 'string' ? [names] : names;

export function loadInstructions(cwd: string, names: string[] | string, maxChars: number): InstructionFile[] {
  const files = instructionNames(names);
  const budget = { left: maxChars };
  const out: InstructionFile[] = [];
  const add = (file: string) => {
    const text = read(file);
    if (!text?.trim() || text.length > budget.left) return;
    budget.left -= text.length;
    out.push({ path: toForward(file), content: expandImports(text.trim(), path.dirname(file), budget) });
  };
  add(appPath('AGENTS.md'));
  const root = findRoot(cwd);
  const chain: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    for (const name of files) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        add(file);
        break;
      }
    }
  }
  return out;
}
