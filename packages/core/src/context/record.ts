import type { Message, Part } from '../types';
import { oneLine } from '../util/text';

type Call = Extract<Part, { type: 'tool_call' }>;
type Result = Extract<Part, { type: 'tool_result' }>;

const WRITE = /^(write|Write|create|create_file|write_file)$/;
const EDIT = /^(edit|Edit|MultiEdit|str_replace|str_replace_editor|replace)$/;
const PATCH = /^(apply_patch|patch)$/;
const READ = /^(read|Read|read_file|view|cat)$/;
const SHELL = /^(shell|Bash|bash|exec_command|run|run_command|terminal)$/;
const WEB_FETCH = /^(web_fetch|WebFetch)$/;
const WEB_SEARCH = /^(web_search|WebSearch)$/;

/** How a command ended, from its result in any harness's words: Favilla's, Codex's, Claude Code's, OpenHands'. */
function exitOf(r: Result | undefined, text: string): string {
  if (!r) return 'no result';
  const m = /\[exit (\d+|none)|Exit code:? (\d+|none)|exit code (\d+)/i.exec(text);
  const code = m?.[1] ?? m?.[2] ?? m?.[3];
  return code !== undefined ? `exit ${code}` : r.isError ? 'failed' : 'exit 0';
}

/** The line of a command's output that says the most: a test count or an error near the end, else its last line. */
function lastWord(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[exit |^\[Command finished|^Exit code|^Wall time|^Output:$/i.test(l));
  const tail = lines.slice(-12);
  const telling = [...tail].reverse().find((l) => /\b(passed|failed|error|errors|exception|assert|traceback|ok\b|FAIL|PASS)/i.test(l));
  return oneLine(telling ?? tail.at(-1) ?? '', 140);
}

/**
 * The tests a run reports failing, by name, in the words of the common runners: node --test (TAP and its spec
 * reporter), vitest, jest, pytest, go and cargo. A test count near the end says how many; which ones failed is
 * further up, and after a compaction it is what the work had to remember (which test failed before the fix).
 */
export function failingTests(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const m =
      /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(line) ??
      /^\s*(?:✖|×|✕|✗)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/.exec(line) ??
      /^\s*FAIL\s+\S+\s+>\s+(.+)$/.exec(line) ??
      /^FAILED\s+(\S+)/.exec(line) ??
      /^\s*--- FAIL: (\S+)/.exec(line) ??
      /^test (\S+) \.\.\. FAILED$/.exec(line);
    // TAP escapes a # and a backslash in a test's name (ticket \#5104): the name is the test's own.
    const name = m ? oneLine(m[1].trim().replace(/\\([#\\])/g, '$1'), 100) : '';
    if (name && !/^failing tests:?$/i.test(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** A command that prints what a file holds or held (git show, cat, sed -n): its last line is code, not a verdict. */
const PRINTS_FILE = /^(?:\(in [^)]*\)\s+)?(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:git\s+(?:show|diff|cat-file|log\s+(?:-p|--patch))|cat|type|head|tail|sed\s+-n|nl|less|more|Get-Content|gc)\b/i;

const pathsOf = (c: Call): string[] => {
  const i = (c.input ?? {}) as Record<string, unknown>;
  const one = i.path ?? i.file_path ?? i.file ?? i.filename;
  const many = Array.isArray(i.paths) ? i.paths : [];
  return [...(typeof one === 'string' ? [one] : []), ...many.filter((p): p is string => typeof p === 'string')].map((p) => p.replace(/:\d+(?:-\d+)?$/, ''));
};

const patchFiles = (c: Call): { added: string[]; changed: string[] } => {
  const i = (c.input ?? {}) as Record<string, unknown>;
  const text = String(i.patch ?? i.input ?? '');
  return {
    added: [...text.matchAll(/^\*\*\* Add File: (.+)$/gm)].map((m) => m[1].trim()),
    changed: [...text.matchAll(/^\*\*\* (?:Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()),
  };
};

/**
 * What the work did, read from its calls and their results alone: the files it made and changed, the files it read,
 * each command with how it last ended, and one line a step. Beside a summary after compaction it is exact where a
 * summary forgets: compared with pi on 40 trajectories (2026-11-05), the next steps Favilla got wrong after compacting
 * were mostly a file made again or a command run again that the earlier work had already made or run. Asked after a
 * compaction how three earlier commands had ended, models knew 22% of them from the summary, 42% from pi's, and 97%
 * with this record. One line a step (log) is left out unless asked for: with it, DeepSeek checked the repository
 * (git status, git log) before going on, where it had gone straight on.
 */
export function workRecord(messages: Message[], o: { clean?: (p: string) => string; text?: (r: Result) => string; exists?: (p: string) => boolean; log?: boolean; steps?: number } = {}): string {
  const clean = o.clean ?? ((p: string) => p);
  // A result's whole output: a session lets long outputs of compacted or pruned messages go from memory (text gets
  // them back from where they are kept), and the line that says how a test run ended is near the end of a long one.
  const full = (r: Result | undefined) => (r ? (o.text?.(r) ?? r.content) : '');
  const results = new Map<string, Result>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_result') results.set(p.callId, p);
  const made = new Set<string>();
  const edits = new Map<string, number>();
  const reads = new Set<string>();
  // The reads that showed a file before its first change: its text as it was, which a later part of the work may need
  // (the rule a change removed) and recall brings back, where models went digging in git for it (2026-11-06).
  const before = new Map<string, string[]>();
  const commands = new Map<string, { runs: number; first: Result | undefined; last: Result | undefined }>();
  // What it looked up on the web, each with the call that holds the answer: a summary keeps what a page said in gist,
  // and without the list the work after a compaction searched and fetched the same things again.
  const pages = new Map<string, string>();
  const searches = new Map<string, string>();
  const steps: string[] = [];
  const touch = <K, V>(m: Map<K, V>, k: K, v: V) => {
    m.delete(k);
    m.set(k, v);
  };
  const touchSet = <T>(s: Set<T>, v: T) => {
    s.delete(v);
    s.add(v);
  };
  for (const m of messages) {
    if (m.role !== 'assistant' || m.replay) continue;
    for (const c of m.parts) {
      if (c.type !== 'tool_call') continue;
      const r = results.get(c.id);
      const failed = r?.isError ? ' (failed)' : '';
      if (WRITE.test(c.name)) {
        for (const p of pathsOf(c)) if (!r?.isError) touchSet(made, clean(p));
        steps.push(`wrote ${pathsOf(c).map(clean).join(', ')}${failed}`);
      } else if (EDIT.test(c.name)) {
        for (const p of pathsOf(c)) {
          const f = clean(p);
          if (!r?.isError) touch(edits, f, (edits.get(f) ?? 0) + 1);
        }
        steps.push(`edited ${pathsOf(c).map(clean).join(', ')}${failed}`);
      } else if (PATCH.test(c.name)) {
        const f = patchFiles(c);
        if (!r?.isError) {
          for (const p of f.added) touchSet(made, clean(p));
          for (const p of f.changed) {
            const path = clean(p);
            touch(edits, path, (edits.get(path) ?? 0) + 1);
          }
        }
        steps.push(`patched ${[...f.added, ...f.changed].map(clean).join(', ')}${failed}`);
      } else if (READ.test(c.name)) {
        for (const p of pathsOf(c)) {
          const f = clean(p);
          touchSet(reads, f);
          const ids = before.get(f) ?? [];
          if (!r?.isError && !edits.has(f) && !made.has(f) && ids.length < 3) before.set(f, [...ids, c.id]);
        }
        steps.push(`read ${pathsOf(c).map(clean).join(', ')}`);
      } else if (SHELL.test(c.name)) {
        const i = (c.input ?? {}) as Record<string, unknown>;
        const cmd = oneLine(String(i.command ?? i.cmd ?? ''), 160);
        // The same command in another folder is another command.
        const dir = typeof i.workdir === 'string' ? i.workdir : typeof i.cwd === 'string' ? i.cwd : '';
        const key = `${dir ? `(in ${clean(dir)}) ` : ''}${cmd.replace(/\s+/g, ' ')}`;
        const seen = commands.get(key);
        commands.set(key, { runs: (seen?.runs ?? 0) + 1, first: seen ? seen.first : r, last: r });
        steps.push(`ran \`${oneLine(cmd, 100)}\`: ${exitOf(r, full(r))}`);
      } else if (WEB_FETCH.test(c.name)) {
        const i = (c.input ?? {}) as Record<string, unknown>;
        const url = oneLine(String(i.url ?? ''), 160);
        const what = `${url}${typeof i.prompt === 'string' && i.prompt.trim() ? ` on "${oneLine(i.prompt, 60)}"` : ''}${typeof i.start === 'number' && i.start > 0 ? ` from character ${i.start}` : ''}`;
        if (url && r && !r.isError) pages.set(what, c.id);
        steps.push(`fetched ${what}${failed}`);
      } else if (WEB_SEARCH.test(c.name)) {
        const query = oneLine(String(((c.input ?? {}) as Record<string, unknown>).query ?? ''), 100);
        if (query && r && !r.isError) searches.set(query, c.id);
        steps.push(`searched the web for "${query}"${failed}`);
      } else steps.push(`${c.name}${failed}`);
    }
  }
  if (!steps.length) return '';
  const changedOnly = [...edits].filter(([p]) => !made.has(p));
  const readOnly = [...reads].filter((p) => !made.has(p) && !edits.has(p));
  // When a list overflows, keep the newest entries (like commands and steps below) while pinning entries with
  // pre-change recall call_ids so truncation never drops the pointers the recall cue below refers to.
  const pick = <T>(xs: T[], n: number, pin: (x: T) => boolean): T[] => {
    if (xs.length <= n) return xs;
    const pinned = xs.filter(pin).slice(-n);
    if (pinned.length >= n) return pinned;
    const held = new Set(pinned);
    const recent = new Set(xs.filter((x) => !held.has(x)).slice(-(n - pinned.length)));
    return xs.filter((x) => held.has(x) || recent.has(x));
  };
  const list = (xs: string[], n = 30) => `${xs.slice(-n).join(', ')}${xs.length > n ? `, and ${xs.length - n} more` : ''}`;
  const lines = ['What the work before this point did, read from its own calls and their results (exact, not a summary; the files are as it left them):'];
  if (made.size) lines.push(`- Files it made: ${list([...made])}`);
  const asBefore = (p: string) => (before.has(p) ? `, its text before the first: recall call_id ${before.get(p)!.join(', ')}` : '');
  const shownChanged = pick(changedOnly, 30, ([p]) => before.has(p));
  if (changedOnly.length)
    lines.push(`- Files it changed: ${shownChanged.map(([p, n]) => `${p} (${n} edit${n > 1 ? 's' : ''}${asBefore(p)})`).join(', ')}${changedOnly.length > 30 ? `, and ${changedOnly.length - 30} more` : ''}`);
  // A file read and then removed (a fixture a run used up, a file a command deleted) is no longer on disk to read
  // again: the reads that showed it are.
  const gone = o.exists ? readOnly.filter((p) => !o.exists!(p)) : [];
  const kept = readOnly.filter((p) => !gone.includes(p));
  if (kept.length) lines.push(`- Files it read and left as they were: ${list(kept)}`);
  const shownGone = pick(gone, 30, (p) => before.has(p));
  if (gone.length) lines.push(`- Files it read that are gone now: ${shownGone.map((p) => `${p}${before.has(p) ? ` (recall call_id ${before.get(p)!.join(', ')})` : ''}`).join(', ')}${gone.length > 30 ? `, and ${gone.length - 30} more` : ''}`);
  // A summary keeps how removed code worked in gist only: on a long refactoring task a run that did not look back
  // rebuilt a retired format's rule wrong, and the two that recalled its old text got it right (2026-11-06).
  if (before.size && (shownChanged.some(([p]) => before.has(p)) || shownGone.some((p) => before.has(p)))) lines.push('- Before you write code that has to keep how removed or rewritten code worked, recall that code\'s text from before the change (the call ids above): the summary keeps its gist, not every rule.');
  // How one run ended: the tests it names failing, else its telling line; a failure or an output worth reading again
  // (a file as git kept it, a long log) names its call, which takes recall straight to the whole output.
  const ended = (cmd: string, r: Result | undefined): string => {
    const text = full(r);
    const how = exitOf(r, text);
    const failing = failingTests(text);
    const word = failing.length ? `failing: ${failing.slice(0, 3).join(' · ')}${failing.length > 3 ? ` and ${failing.length - 3} more` : ''}` : PRINTS_FILE.test(cmd) ? `${text.split('\n').length} lines` : lastWord(text);
    const id = r && (how !== 'exit 0' || text.length > 600) ? ` (recall call_id ${r.callId})` : '';
    return `${how}${word ? `, ${word}` : ''}${id}`;
  };
  if (commands.size) {
    lines.push('- Commands, with how each last ended, and the first run when it ended otherwise:');
    for (const [cmd, c] of [...commands].slice(-25)) {
      const last = ended(cmd, c.last);
      const first = c.runs > 1 && c.first ? ended(cmd, c.first) : '';
      lines.push(`  - \`${cmd}\`${c.runs > 1 ? ` (${c.runs} runs)` : ''}: ${last}${first && exitOf(c.first, full(c.first)) !== exitOf(c.last, full(c.last)) ? `. The first: ${first}` : ''}`);
    }
  }
  if (searches.size) lines.push(`- Web searches it ran: ${list([...searches].map(([q, id]) => `"${q}" (call_id ${id})`), 15)}`);
  if (pages.size) lines.push(`- Web pages it read, which recall brings back word for word: ${list([...pages].map(([p, id]) => `${p} (call_id ${id})`), 20)}`);
  if (!o.log) return lines.join('\n');
  const keep = o.steps ?? 60;
  lines.push(`- Its steps, one a line${steps.length > keep ? ` (the last ${keep} of ${steps.length})` : ''}:`);
  const shown = steps.slice(-keep);
  const first = steps.length - shown.length;
  shown.forEach((s, i) => lines.push(`  ${first + i + 1}. ${s}`));
  return lines.join('\n');
}
