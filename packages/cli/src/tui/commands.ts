import fs from 'node:fs';
import path from 'node:path';
import { appPath } from '@favilla/core';
import { t } from './i18n';

/** The built-in slash commands, in the order /help lists them. Details are translation keys. */
export const COMMANDS: { name: string; detail: string }[] = [
  { name: '/model', detail: 'switch model' },
  { name: '/effort', detail: 'reasoning effort' },
  { name: '/plan', detail: 'plan mode on or off (shift+tab)' },
  { name: '/rewind', detail: 'edit an earlier message and send it again, or branch from it (esc esc)' },
  { name: '/fork', detail: 'continue in a copy of this session, leaving this one as it is' },
  { name: '/diff', detail: 'every change this session made, file by file' },
  { name: '/undo', detail: 'put back the files the last turn changed' },
  { name: '/agents', detail: 'sub-agents of this session and what they did' },
  { name: '/transcript', detail: 'the whole conversation with full tool output (ctrl+t)' },
  { name: '/context', detail: 'what fills the context window' },
  { name: '/compact', detail: 'summarize the conversation to free context' },
  { name: '/rules', detail: 'edit the rules the agent follows: yours and this project\'s' },
  { name: '/persona', detail: 'who the agent is: /persona lists the personas, /persona import FILE (a character card), use NAME, inherit, none, show, delete; --global for every folder' },
  { name: '/preset', detail: 'SillyTavern presets: /preset lists them, /preset import FILE, use NAME, inherit, none, show, copy, delete; --global for every folder' },
  { name: '/copy', detail: 'copy the last answer' },
  { name: '/export', detail: 'save the conversation as markdown; /export FILE picks where' },
  { name: '/review', detail: 'review the uncommitted changes for bugs; /review FOCUS narrows it' },
  { name: '/init', detail: 'write AGENTS.md: how to build, test and work in this project' },
  { name: '/retry', detail: 'try a failed turn again from where it stopped' },
  { name: '/new', detail: 'start a new session' },
  { name: '/resume', detail: 'continue a saved session' },
  { name: '/status', detail: 'model, limits, folder, settings' },
  { name: '/settings', detail: 'language, approvals, web search, browser' },
  { name: '/cost', detail: 'tokens, cache and cost' },
  { name: '/help', detail: 'keys and commands' },
  { name: '/exit', detail: 'quit' },
];

/** Prompts behind /review and /init: written for the model, so in English whatever the interface language. */
export const PROMPTS = {
  review: (focus: string) =>
    `Review the uncommitted changes in this repository (git diff HEAD plus untracked files)${focus ? `, with this focus: ${focus}` : ''}. Read the changed code and what calls it. Report real problems only: bugs, regressions, missed cases of the same rule, broken error handling, races, security holes, tests that do not test the change. For each: severity, file:line, what goes wrong and when, and the fix in a sentence. Do not edit files. If nothing is wrong, say so in one line.`,
  init: () =>
    'Survey this project and write AGENTS.md at its root for coding agents and new contributors: what it is in two lines, how to install, build, run, test and lint (exact commands you have checked), the layout of the main folders, the conventions the code follows (naming, errors, tests, style) as you find them in the code, and anything that would surprise a newcomer. Keep it under 80 lines of plain facts, no filler. If AGENTS.md or a similar file (CLAUDE.md, CONTRIBUTING.md) exists, read it first and improve it rather than replace it.',
};

interface CustomCommand {
  name: string;
  detail: string;
  body: string;
  file: string;
}

/**
 * The user's own commands: markdown files in ~/.favilla/commands and in the project's .favilla/commands (the
 * project's win on a name clash). `$ARGUMENTS` in the file is replaced by what follows the command; a first
 * line starting with `#` or a `description:` line in front matter names what it does.
 */
export function loadCustomCommands(cwd: string): CustomCommand[] {
  const out = new Map<string, CustomCommand>();
  for (const dir of [appPath('commands'), path.join(cwd, '.favilla', 'commands')]) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let body: string;
      try {
        body = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let detail = '';
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(body);
      if (front) {
        detail = /^description:\s*(.+)$/m.exec(front[1])?.[1].trim() ?? '';
        body = body.slice(front[0].length);
      }
      if (!detail) detail = /^#\s*(.+)$/m.exec(body)?.[1].trim() ?? body.trim().split('\n')[0].slice(0, 60);
      const name = `/${f.slice(0, -3).toLowerCase().replace(/\s+/g, '-')}`;
      if (COMMANDS.some((c) => c.name === name)) continue;
      out.set(name, { name, detail: detail || t('your command'), body, file });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCustom(c: CustomCommand, args: string): string {
  return c.body.includes('$ARGUMENTS') ? c.body.split('$ARGUMENTS').join(args) : args ? `${c.body.trim()}\n\n${args}` : c.body.trim();
}
