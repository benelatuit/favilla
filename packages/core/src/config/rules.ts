import fs from 'node:fs';
import path from 'node:path';
import { withFileUpdate, writeFileAtomic } from '../auth/store';
import { findRoot, instructionNames } from '../prompt/instructions';
import { globalMemoryFile, memoryFile } from '../tools/memory';
import { appPath, toForward } from '../util/paths';
import { DEFAULTS, type FavillaConfig } from './config';
import { checkSettings, settingBasis, SettingsFileError, settingFileVersion, type SettingBasis } from './document';

export interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
  basis: SettingBasis;
}

/** The user's standing instructions as the settings show them. */
export interface RulesView {
  /** ~/.favilla/AGENTS.md: read in every folder. */
  global: RuleFile;
  /** The project's own file at its root: the first of the instruction names that exists, else AGENTS.md. */
  project: RuleFile;
  /** What the agent saved with remember about this project. */
  memory: RuleFile;
  /** What the agent saved with remember about the user, read in every folder. */
  globalMemory: RuleFile;
  /** Instruction files in folders between the project root and the working folder, read as well. */
  others: { path: string; chars: number }[];
  /** Characters of instruction files a new session's prompt takes in. */
  limit: number;
}

export type RuleKind = 'global' | 'project' | 'memory' | 'globalMemory';

function file(p: string, editing = false): RuleFile {
  const path = toForward(p);
  let content: string | undefined;
  try { content = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (editing && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SettingsFileError({ file: p, version: () => settingFileVersion(p) });
  }
  return { path, content: content ?? '', exists: content !== undefined, basis: settingBasis({ path, content }, [['path'], ['content']]) };
}

function projectFile(cwd: string, names: string[]): string {
  const root = findRoot(cwd);
  return names.map((n) => path.join(root, n)).find((p) => fs.existsSync(p)) ?? path.join(root, 'AGENTS.md');
}

export function rulesView(cwd: string, config: FavillaConfig, contextWindow: number): RulesView {
  const names = instructionNames(config.instructions ?? DEFAULTS.instructions);
  const root = findRoot(cwd);
  const others: { path: string; chars: number }[] = [];
  for (let dir = cwd; dir !== root && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const found = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    if (found) others.unshift({ path: toForward(found), chars: fs.statSync(found).size });
  }
  return {
    global: file(appPath('AGENTS.md')),
    project: file(projectFile(cwd, names)),
    memory: file(memoryFile(cwd)),
    globalMemory: file(globalMemoryFile()),
    others,
    limit: Math.min(60_000, Math.floor(contextWindow * 0.08 * 3.5)),
  };
}

/**
 * Save one of the three. Favilla's own files (the global rules and the notes) are removed when emptied; a
 * project's file is the user's and stays, empty if that is what they saved.
 */
export function writeRule(kind: RuleKind, cwd: string, content: string, config: FavillaConfig, basis?: SettingBasis): void {
  const target = kind === 'global' ? appPath('AGENTS.md') : kind === 'memory' ? memoryFile(cwd) : kind === 'globalMemory' ? globalMemoryFile() : projectFile(cwd, instructionNames(config.instructions ?? DEFAULTS.instructions));
  const text = content.replace(/\r\n/g, '\n');
  withFileUpdate(target, (stillHeld) => {
    const old = file(target, true);
    checkSettings(target, basis, { path: old.path, content: old.exists ? old.content : undefined }, [['path'], ['content']]);
    if (!text.trim() && kind !== 'project') {
      stillHeld();
      fs.rmSync(target, { force: true });
      return;
    }
    // The user's own text: a crash while it was written in place left half of it.
    writeFileAtomic(target, text.endsWith('\n') ? text : `${text}\n`, { own: true, beforeReplace: stillHeld });
  });
}
