import fs from 'node:fs';
import path from 'node:path';
import { appPath, openLines, sealLine } from '@favilla/core';

/**
 * What the user sent, kept across runs (~/.favilla/history.jsonl) so ↑ and ctrl+r reach last week's prompts too.
 * Only the typed text is kept, never attached files or images; each line is sealed as session lines are.
 */
const MAX = 1000;

interface Entry {
  text: string;
  cwd: string;
  at: number;
}

const file = () => appPath('history.jsonl');

export function loadHistory(): string[] {
  try {
    // Under a key that is not here the history starts empty: it is a convenience.
    const lines = openLines(fs.readFileSync(file(), 'utf8')).split('\n').filter(Boolean).slice(-MAX);
    const out: string[] = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as Entry;
        if (typeof e.text === 'string' && e.text.trim()) out.push(e.text);
      } catch {
        /* a line cut off by a crash */
      }
    }
    // The newest copy of a prompt sent twice is the one that counts.
    return out.filter((t, i) => out.lastIndexOf(t) === i);
  } catch {
    return [];
  }
}

export function addHistory(text: string, cwd: string): void {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${sealLine(JSON.stringify({ text, cwd, at: Date.now() } satisfies Entry))}\n`);
    // Keep the file small: past twice the limit, rewrite it with the newest entries.
    if (fs.statSync(f).size > 2 * 1024 * 1024) {
      const keep = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-MAX);
      fs.writeFileSync(f, `${keep.join('\n')}\n`);
    }
  } catch {
    /* history is a convenience; a read-only home must not stop a prompt */
  }
}
