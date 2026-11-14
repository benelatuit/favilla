import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, isWindows, resolvePath } from '../util/paths';

/**
 * The one safety layer: commands that would cost the user data, history or a working machine
 * need a yes first. Everything else runs without ceremony. Rules look at what a command does
 * (targets, flags) rather than at keywords, so ordinary work never trips them.
 */
export interface GuardVerdict {
  action: 'allow' | 'confirm';
  rule?: string;
  reason?: string;
}

export interface GuardContext {
  cwd: string;
  workspace: string;
  allow?: string[];
  deny?: string[];
  /** Folders that are Favilla's own for this project (its scratch folder): deleting there is ordinary work. */
  own?: string[];
  /**
   * The shell that will run the command. Unknown: the line is read both with and without its comments, since the
   * shells differ on them, and nothing is worked out from what the line itself sets.
   */
  shell?: 'posix' | 'powershell' | 'cmd';
}

const ALLOW: GuardVerdict = { action: 'allow' };

function confirm(rule: string, reason: string): GuardVerdict {
  return { action: 'confirm', rule, reason };
}

/** Split a shell command line into simple commands (on ; && || | & and newlines), honouring quotes. */
export function splitCommands(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Shell-like word splitting with quote removal. */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Commands nested in -c strings, $(...) and backticks are checked too. */
function nested(line: string): string[] {
  const found: string[] = [];
  const res = [/(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?)\s+(?:-\w+\s+)*-(?:c|Command)\s+("([^"]*)"|'([^']*)')/gi, /\$\(([^()]*)\)/g, /`([^`]*)`/g, /cmd(?:\.exe)?\s+\/[ck]\s+(.+)$/gi];
  for (const re of res) {
    for (const m of line.matchAll(re)) {
      const inner = m[2] ?? m[3] ?? m[1];
      if (inner && inner !== line) found.push(inner);
    }
  }
  return found;
}

const SENSITIVE_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.codex', '.favilla', '.claude', '.config', 'AppData'];

function criticalReason(target: string, ctx: GuardContext): string | null {
  const raw = target.trim();
  if (!raw) return null;
  // A group's closing bracket sticks to the last word ("(S=; rm -rf $S/*)"), and hid the variable from this rule.
  const named = raw.replace(/[)}]+$/, '');
  if (/^(\$\w+|\$\{[^}]*\}?|%\w+%)[\\/]?\*?$/.test(named) || /^["']?(\$\w+|\$\{[^}]*\})["']?\/\*?$/.test(named)) return `"${raw}" depends on a variable that may be empty`;
  if (/^[\\/]+\*?$/.test(raw) || /^[a-zA-Z]:[\\/]?\*?$/.test(raw) || /^\/[a-zA-Z]\/?\*?$/.test(raw)) return 'it targets a filesystem root';
  if (/^~[\\/]?\*?$/.test(raw) || /^\$HOME[\\/]?\*?$/.test(raw) || /^%USERPROFILE%[\\/]?\*?$/i.test(raw)) return 'it targets your home folder';
  const abs = resolvePath(ctx.cwd, stripGlob(raw).replace(/^\$HOME/, os.homedir()).replace(/^%USERPROFILE%/i, os.homedir()));
  const home = os.homedir();
  const norm = (p: string) => (isWindows ? p.toLowerCase() : p);
  if (norm(abs) === norm(path.parse(abs).root)) return 'it targets a filesystem root';
  if (norm(abs) === norm(home)) return 'it targets your home folder';
  // Favilla's own folder for the project is the agent's to fill and to empty, wherever the app keeps it (under ~/.favilla
  // every delete there read as one that "targets keys and app data").
  if ((ctx.own ?? []).some((d) => isInside(d, abs))) return null;
  if (isInside(abs, ctx.workspace)) return abs === path.resolve(ctx.workspace) || raw.endsWith('*') ? 'it would delete the whole workspace' : 'it would delete a folder that contains the workspace';
  // Inside the workspace the agent is at home; only the repository itself is precious.
  if (isInside(ctx.workspace, abs)) return path.basename(abs) === '.git' ? 'it deletes a git repository and its history' : null;
  // Something inside the temp folder is scratch, though on Windows the folder sits in AppData (Git Bash's /tmp is it);
  // a folder beside the workspace is another project, in temp too. On Windows that one was stopped only because the
  // temp folder is in AppData; on Linux and macOS nothing stopped it, and "rm -rf ../other-project" just ran.
  const temp = path.resolve(os.tmpdir());
  if (isInside(temp, abs) && norm(abs) !== norm(temp)) {
    if (isInside(path.dirname(ctx.workspace), abs)) return 'it deletes a folder beside the workspace, another project';
    return path.basename(abs) === '.git' ? 'it deletes a git repository and its history' : null;
  }
  const systemDirs = isWindows
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', path.join(home, 'AppData')]
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/sbin', '/sys', '/usr', '/var', '/System', '/Library', '/Applications'];
  for (const d of systemDirs) if (isInside(abs, d)) return `it targets the system folder ${d}`;
  for (const d of SENSITIVE_HOME_DIRS) if (isInside(path.join(home, d), abs)) return `it targets ${path.join('~', d)}, which holds keys and app data`;
  if (path.basename(abs) === '.git') return 'it deletes a git repository and its history';
  return null;
}

/** "dir/*", "*" and "./*" delete the folder's contents: treat them as the folder itself. */
function stripGlob(target: string): string {
  const t = target.replace(/[\\/]\*+$/, '');
  return t === '*' || t === '' ? '.' : t;
}

function outsideWorkspace(target: string, ctx: GuardContext): boolean {
  const abs = resolvePath(ctx.cwd, stripGlob(target));
  if (isInside(ctx.workspace, abs) || (ctx.own ?? []).some((d) => isInside(d, abs))) return false;
  const tmp = [os.tmpdir(), '/tmp', '/var/tmp'];
  return !tmp.some((t) => isInside(t, abs));
}

function checkDelete(w: string[], ctx: GuardContext): GuardVerdict {
  const cmd = path.basename(w[0]).toLowerCase().replace(/\.exe$/, '');
  const args = w.slice(1);
  let recursive = false;
  const targets: string[] = [];
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'rimraf' || cmd === 'trash') {
    for (const a of args) {
      if (a === '--') continue;
      if (/^--recursive$|^-[a-zA-Z]*[rR]/.test(a)) recursive = true;
      if (a.startsWith('-')) continue;
      targets.push(a);
    }
    if (cmd !== 'rm') recursive = true;
  } else if (cmd === 'del' || cmd === 'erase' || cmd === 'rd') {
    for (const a of args) {
      if (/^\/s$/i.test(a)) recursive = true;
      else if (!a.startsWith('/')) targets.push(a);
    }
    if (cmd === 'rd') recursive = true;
  } else if (/^(remove-item|ri)$/.test(cmd)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-r(ecurse)?$/i.test(a)) recursive = true;
      else if (/^-(path|literalpath)$/i.test(a)) targets.push(args[++i] ?? '');
      else if (!a.startsWith('-')) targets.push(a);
    }
  } else return ALLOW;
  for (const t of targets) {
    const why = criticalReason(t, ctx);
    if (why && (recursive || /[*?]/.test(t) || why.includes('keys'))) return confirm('delete-critical', `Deletes ${t}: ${why}.`);
    if (recursive && outsideWorkspace(t, ctx)) return confirm('delete-outside', `Recursively deletes ${t}, outside the workspace.`);
  }
  return ALLOW;
}

function checkGit(w: string[]): GuardVerdict {
  const i = w.findIndex((x) => x === 'git' || x.endsWith('/git') || x.endsWith('\\git.exe') || x === 'git.exe');
  if (i === -1) return ALLOW;
  const rest = w.slice(i + 1).filter((x, k, arr) => !(k > 0 && arr[k - 1] === '-C') && x !== '-C');
  const sub = rest.find((x) => !x.startsWith('-')) ?? '';
  const flags = rest.filter((x) => x.startsWith('-'));
  const has = (re: RegExp) => flags.some((f) => re.test(f));
  switch (sub) {
    case 'reset':
      if (has(/^--hard$|^--merge$|^--keep$/)) return confirm('git-reset-hard', 'git reset --hard discards uncommitted changes.');
      break;
    case 'clean':
      if (has(/^-[a-zA-Z]*f|^--force$/) && !has(/^-[a-zA-Z]*n|^--dry-run$/)) return confirm('git-clean', 'git clean -f permanently deletes untracked files.');
      break;
    case 'checkout': {
      const after = rest.slice(rest.indexOf('checkout') + 1);
      const dd = after.indexOf('--');
      if (dd !== -1 || after.some((a) => a === '.' || a === '*')) return confirm('git-discard', 'git checkout on paths discards uncommitted changes to them.');
      if (has(/^-f$|^--force$/)) return confirm('git-discard', 'git checkout --force discards uncommitted changes.');
      break;
    }
    case 'restore':
      if (!has(/^--staged$|^-S$/) || has(/^--worktree$|^-W$/)) return confirm('git-discard', 'git restore discards uncommitted changes to those paths.');
      break;
    case 'stash':
      if (rest.includes('drop') || rest.includes('clear')) return confirm('git-stash-drop', 'Dropping stashes deletes saved work.');
      break;
    case 'branch':
      if (has(/^-D$|^--delete$/) && has(/^-D$|^--force$|^-f$/)) return confirm('git-branch-delete', 'Force-deleting a branch can lose unmerged commits.');
      break;
    case 'push':
      if (has(/^-f$|^--force$|^--force-with-lease|^--force-if-includes$|^--mirror$|^--delete$|^-d$/) || rest.some((a) => /^\+/.test(a) || /^:[^:]/.test(a)))
        return confirm('git-push-force', 'This push rewrites or deletes history on the remote.');
      break;
    case 'filter-branch':
    case 'filter-repo':
      return confirm('git-rewrite', 'Rewrites the whole repository history.');
    case 'reflog':
      if (rest.includes('expire') || rest.includes('delete')) return confirm('git-reflog', 'Expiring the reflog removes the safety net for lost commits.');
      break;
    case 'gc':
      if (has(/^--prune/)) return confirm('git-prune', 'Pruning removes unreachable commits for good.');
      break;
  }
  return ALLOW;
}

const SYSTEM_RULES: { re: RegExp; rule: string; reason: string }[] = [
  { re: /^mkfs(\.\w+)?$|^mke2fs$|^wipefs$|^diskpart$|^fdisk$|^sfdisk$|^parted$|^gdisk$/i, rule: 'disk', reason: 'Partitions or formats a disk.' },
  { re: /^format(\.com)?$/i, rule: 'disk', reason: 'Formats a drive.' },
  { re: /^(shutdown|reboot|poweroff|halt|stop-computer|restart-computer)$/i, rule: 'power', reason: 'Shuts down or restarts the machine.' },
  { re: /^bcdedit$/i, rule: 'boot', reason: 'Changes the boot configuration.' },
];

function checkSystem(w: string[], seg: string, ctx: GuardContext): GuardVerdict {
  const cmd = path.basename(w[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  for (const r of SYSTEM_RULES) if (r.re.test(cmd)) return confirm(r.rule, r.reason);
  if (cmd === 'dd' && w.some((a) => /^of=\/dev\//.test(a))) return confirm('disk', 'dd writes directly to a device.');
  if (/>\s*\/dev\/(sd|nvme|hd|disk)/.test(seg)) return confirm('disk', 'Writes directly to a disk device.');
  if (cmd === 'vssadmin' && /delete/i.test(seg)) return confirm('shadow-copies', 'Deletes Windows shadow copies (restore points).');
  if (cmd === 'wmic' && /shadowcopy\s+delete/i.test(seg)) return confirm('shadow-copies', 'Deletes Windows shadow copies.');
  if (cmd === 'cipher' && /\/w/i.test(seg)) return confirm('wipe', 'Wipes free disk space.');
  if (cmd === 'reg' && /^delete$/i.test(w[1] ?? '') && /HK(LM|CR|U|EY_LOCAL_MACHINE|EY_CLASSES_ROOT|EY_USERS)/i.test(seg)) return confirm('registry', 'Deletes machine-wide registry keys.');
  if ((cmd === 'chmod' || cmd === 'chown' || cmd === 'icacls' || cmd === 'takeown') && /(^|\s)(-R|\/t|\/r)(\s|$)/i.test(seg)) {
    const target = w[w.length - 1];
    const why = criticalReason(target, ctx);
    if (why) return confirm('permissions', `Changes permissions recursively on ${target}: ${why}.`);
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(seg)) return confirm('fork-bomb', 'This is a fork bomb.');
  if (cmd === 'kill' && w.includes('-1')) return confirm('kill-all', 'Kills every process you own.');
  if ((cmd === 'taskkill' && /\/im/i.test(seg)) || cmd === 'pkill' || cmd === 'killall' || (cmd === 'stop-process' && /-name/i.test(seg)))
    return confirm('kill-by-name', 'Kills processes by name, which can hit unrelated programs (editors, other agents, servers).');
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && w[1] === 'publish') return confirm('publish', 'Publishes a package to a public registry.');
  if (cmd === 'cargo' && w[1] === 'publish') return confirm('publish', 'Publishes a crate.');
  if (cmd === 'twine' && w[1] === 'upload') return confirm('publish', 'Uploads a package to PyPI.');
  if (cmd === 'gh' && ((w[1] === 'repo' && /^(delete|archive)$/.test(w[2] ?? '')) || (w[1] === 'release' && w[2] === 'delete')))
    return confirm('github-delete', 'Deletes a GitHub repository or release.');
  if (cmd === 'docker' && ((w[1] === 'system' && w[2] === 'prune') || (w[1] === 'volume' && /^(rm|prune)$/.test(w[2] ?? ''))))
    return confirm('docker-prune', 'Deletes Docker data (volumes or images).');
  if (/\b(drop\s+(database|schema|table)|truncate\s+table)\b/i.test(seg) && /\b(psql|mysql|sqlite3|mongo|mongosh|sqlcmd|duckdb|prisma|knex|sequelize)\b/i.test(seg))
    return confirm('database', 'Drops or truncates database objects.');
  if (/\bdelete\s+from\s+\w+\s*;?\s*["']?\s*$/i.test(seg) && /\b(psql|mysql|sqlite3|sqlcmd|duckdb)\b/i.test(seg)) return confirm('database', 'Deletes every row of a table.');
  if (cmd === 'find' && (w.includes('-delete') || (w.includes('-exec') && w.some((x) => /^(rm|del)$/.test(x))))) {
    const root = w[1] && !w[1].startsWith('-') ? w[1] : '.';
    const why = criticalReason(root, ctx);
    if (why || outsideWorkspace(root, ctx)) return confirm('delete-critical', `find … -delete under ${root}${why ? `: ${why}` : ', outside the workspace'}.`);
  }
  return ALLOW;
}

/**
 * Whether a word names a place on disk: it starts like a path (a root, a drive, the home folder) or climbs (..), and it
 * or its folder exists. A search pattern that starts with a slash ("/api/users") names nothing there. Right under a
 * root the folder always exists, so there the word itself must, unless something is written to it: "/api", "\d+" and
 * the "\|" of a grep pattern are patterns, "> /out.txt" is a place.
 */
function namesPath(word: string, cwd: string, written = false): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return null;
  if (!/^(\/|\\|~|\$\{?HOME\}?|%USERPROFILE%|[a-zA-Z]:[\\/])/i.test(word) && !/(^|[\\/])\.\.([\\/]|$)/.test(word)) return null;
  const abs = resolvePath(cwd, word.replace(/^\$\{?HOME\}?/, os.homedir()).replace(/^%USERPROFILE%/i, os.homedir()));
  if (fs.existsSync(abs)) return abs;
  const dir = path.dirname(abs);
  return fs.existsSync(dir) && (written || dir !== path.parse(abs).root) ? abs : null;
}

/** What runs the text it is given as commands: a here-document for one of these is read like the command itself. */
const RUNS_TEXT = /(^|[\s;&|(`$/\\])((ba|z|da|k|fi)?sh|pwsh|powershell|cmd|eval|source|exec|ssh|sudo|su|doas|xargs|env|wsl|docker|podman|kubectl)(\.exe)?(?=$|[\s;&|)])|(^|[;&|(]\s*)\.\s/i;

/**
 * A command without the text of its here-documents, where a program reads that text and no shell does: it is a script
 * for python or node, or the contents of a file for cat, and none of it is a word of the command. There `/` divides
 * or joins a path and `//` is a division or opens a comment: read as words they named the root of the disk, and a
 * confined run was refused `python - <<'PY'` with `path = folder / "store.json"` in it (8 of the 11 refusals in 21
 * runs on 2026-11-10, in 7 of them, each followed by the same script written into the project instead). The text
 * stays when the line that opens it names a shell or something that runs text as one (bash <<EOF, sudo, xargs), and
 * when its delimiter is unquoted and it holds a command substitution, which the shell runs. A `<<` inside quotes is
 * text (a shift in a script given with -c, the here-document of a quoted $(…)), and one whose closing line is not
 * found opens nothing: for those nothing is taken out.
 */
function withoutHereText(command: string): string {
  if (!command.includes('<<')) return command;
  const opener = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/y;
  let out = '';
  let lineStart = 0;
  let quote: string | null = null;
  let open: { delimiter: string; tabs: boolean; quoted: boolean }[] = [];
  for (let i = 0; i < command.length; ) {
    const c = command[i];
    if (quote) {
      // Inside quotes a << is text (a shift in a script given with -c), and so is all that follows it.
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        out += c + command[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '\\' && i + 1 < command.length && command[i + 1] !== '\n') {
      out += c + command[i + 1];
      i += 2;
      continue;
    } else if (c === '<' && command[i + 1] === '<') {
      opener.lastIndex = i;
      const m = command[i + 2] === '<' ? null : opener.exec(command);
      const whole = m ? m[0] : command[i + 2] === '<' ? '<<<' : '<<';
      if (m) open.push({ delimiter: m[2] ?? m[3] ?? m[5], tabs: m[1] === '-', quoted: m[2] !== undefined || m[3] !== undefined || m[4] === '\\' });
      out += whole;
      i += whole.length;
      continue;
    } else if (c === '\n' && open.length) {
      // The texts follow the line that opened them, in order, each up to a line that is its delimiter alone.
      const runsIt = RUNS_TEXT.test(out.slice(lineStart));
      let at = i + 1;
      let kept = '';
      let closed = true;
      for (const h of open) {
        let from = at;
        let end = -1;
        while (from <= command.length) {
          const nl = command.indexOf('\n', from);
          const stop = nl < 0 ? command.length : nl;
          const line = command.slice(from, stop).replace(/\r$/, '');
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delimiter) {
            end = stop;
            break;
          }
          if (nl < 0) break;
          from = nl + 1;
        }
        if (end < 0) {
          closed = false;
          break;
        }
        const text = command.slice(at, from);
        if (runsIt || (!h.quoted && /\$\(|`/.test(text))) kept += text;
        at = Math.min(end + 1, command.length);
      }
      open = [];
      if (closed) {
        out += `\n${kept}`;
        lineStart = out.length;
        i = at;
        continue;
      }
    }
    out += c;
    i++;
    if (c === '\n' && !quote) lineStart = out.length;
  }
  return out;
}

/**
 * A confined run (a model reached through someone else's relay, FAVILLA_CONFINE=1) touches nothing outside its folder:
 * the first path a command names outside it, or null. Every simple command is read, nested ones included, and the
 * value of an option (--out=…) or a redirection (2>…) counts as a word. The null and standard devices are not places.
 * On 2026-11-03 a brief agent on a relay, told to stay, listed the folder above its own and the repository
 * around it.
 */
export function outsidePath(command: string, cwd: string, workspace: string, also: string[] = []): string | null {
  const queue = [withoutHereText(command)];
  const seen = new Set<string>();
  while (queue.length) {
    const line = queue.shift()!;
    if (seen.has(line)) continue;
    seen.add(line);
    queue.push(...nested(line));
    for (const seg of splitCommands(line)) {
      let prev = '';
      for (const word of words(seg)) {
        const bare = word.replace(/^\d*(>>?|<)/, '').replace(/^-[-\w]*=/, '');
        const written = /^\d*>/.test(word) || /^\d*>>?$/.test(prev);
        prev = word;
        // A lone backslash is an escape the shell left as a word (a line joined, a space kept), not the drive's root.
        if (!bare || bare === '\\' || /^(\/dev\/(null|stdin|stdout|stderr|tty)|nul)$/i.test(bare)) continue;
        const abs = namesPath(bare, cwd, written);
        if (abs && ![workspace, ...also].some((root) => isInside(root, abs))) return bare;
      }
    }
  }
  return null;
}

/** The same for a tool's own path arguments (path, paths, dir, file…; a read's line range is not part of the path).
 *  The names are those after a tool's normalize: where a picture or a film is written (out), the picture cut out
 *  (cut), the page filmed and its sound, the folder a mail's attachments are saved to and the files a mail sends.
 *  Without them a confined paint, music or film call wrote wherever out pointed. A web address is not a path. */
export function outsideArgs(input: Record<string, unknown>, cwd: string, workspace: string, also: string[] = []): string | null {
  const named: unknown[] = [];
  for (const k of ['path', 'dir', 'root', 'workdir', 'cwd', 'file', 'target', 'from', 'to', 'out', 'cut', 'page', 'sound', 'saveTo']) named.push(input[k]);
  for (const k of ['paths', 'files', 'attachments']) if (Array.isArray(input[k])) named.push(...(input[k] as unknown[]));
  for (const v of named) {
    if (typeof v !== 'string' || !v.trim() || /^https?:\/\//i.test(v.trim())) continue;
    const p = v.trim().replace(/:\d+(-\d+)?$/, '');
    const abs = resolvePath(cwd, p);
    if (![workspace, ...also].some((root) => isInside(root, abs))) return p;
  }
  return null;
}

export function checkCommand(command: string, ctx: GuardContext): GuardVerdict {
  for (const pattern of ctx.allow ?? []) {
    try {
      if (new RegExp(pattern).test(command)) return ALLOW;
    } catch {
      /* ignore bad user regex */
    }
  }
  for (const pattern of ctx.deny ?? []) {
    try {
      if (new RegExp(pattern).test(command)) return confirm('user-rule', `Matches your rule /${pattern}/.`);
    } catch {
      /* ignore bad user regex */
    }
  }
  // What the shell will not run is not read: a comment (cmd has none), and for a POSIX shell the text a
  // here-document hands a program. An apostrophe in either used to open a quote that swallowed the commands after it,
  // so "# don't touch" above "rm -rf /" passed. A shell not named is read both ways.
  const posix = ctx.shell === 'posix';
  const tops = ctx.shell === 'cmd' ? [command] : ctx.shell ? [withoutComments(posix ? withoutHereText(command) : command)] : [command, withoutComments(command)];
  const queue = [...tops];
  const seen = new Set<string>();
  while (queue.length) {
    const line = queue.shift()!;
    if (seen.has(line)) continue;
    seen.add(line);
    queue.push(...nested(line));
    const list: Step[] = posix && tops.includes(line) ? steps(line, ctx.cwd) : splitCommands(line).map((text) => ({ text, cwd: ctx.cwd }));
    for (const step of list) {
      let w = words(step.text);
      while (w.length && /^(sudo|doas|env|nohup|time|command|exec|xargs|nice|\w+=\S*)$/.test(w[0])) w = w.slice(1);
      if (!w.length) continue;
      for (const cwd of step.also ? [step.cwd, step.also] : [step.cwd]) {
        const there = cwd === ctx.cwd ? ctx : { ...ctx, cwd };
        for (const check of [checkDelete(w, there), checkGit(w), checkSystem(w, step.text, there)]) if (check.action !== 'allow') return check;
      }
    }
  }
  return ALLOW;
}

/** The line without its comments: a `#` that starts a word, outside quotes, to the end of its line. */
function withoutComments(line: string): string {
  if (!line.includes('#')) return line;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"' && i + 1 < line.length) out += line[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      out += c + line[++i];
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

/** One simple command of a line, with the folder it certainly runs in (and that folder with its links followed, when that differs). */
interface Step {
  text: string;
  cwd: string;
  also?: string;
}

interface Statement {
  parts: string[];
  /** Joined by anything but &&: a pipe, an ||, a background &. What such a statement sets or enters is not known after it. */
  mixed: boolean;
}

/** A line as its statements (ended by ; or a new line), each as the simple commands its operators join. */
function statementsOf(line: string): Statement[] {
  const all: Statement[] = [];
  let parts: string[] = [];
  let mixed = false;
  let text = '';
  let quote: string | null = null;
  const part = () => {
    if (text.trim()) parts.push(text.trim());
    text = '';
  };
  const end = () => {
    part();
    if (parts.length) all.push({ parts, mixed });
    parts = [];
    mixed = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      text += c;
      if (c === '\\' && quote === '"' && i + 1 < line.length) text += line[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      text += c + line[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      text += c;
    } else if (c === ';' || c === '\n') end();
    else if (c === '&' && line[i + 1] === '&') {
      part();
      i++;
    } else if (c === '&' && (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>')) text += c;
    else if (c === '&' || c === '|') {
      part();
      mixed = true;
      if (line[i + 1] === '|' || (c === '|' && line[i + 1] === '&')) i++;
    } else text += c;
  }
  end();
  return all;
}

/** Words past which a line no longer runs top to bottom in this shell, or sets what cannot be read off it. */
const COMPOUND = /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|coproc|trap|eval|source|\.|exec|readonly|declare|typeset|local|alias|!)$/;
/** A value the line gives in plain text: nothing the shell expands, nothing that would read as an operator when put back. */
const PLAIN = /^[\w@%+=:,./-][\w@%+=:,./ -]*$/;
/** Variables that change how the rest of the line is read: where ~ and cd lead, how words split. */
const STEERS = /^(IFS|HOME|PWD|OLDPWD|CDPATH|PATH|BASH_ENV|ENV)$/;

/** The text with everything quoted taken out, but for the command substitutions double quotes still run. */
function unquoted(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === '`' || (c === '$' && text[i + 1] === '('))) out += c === '`' ? c : '$(';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else out += c;
  }
  return out;
}

/** `$NAME` and `${NAME}` replaced by the values known, outside single quotes. */
function filled(text: string, valueOf: (name: string) => string | null | undefined): string {
  if (!text.includes('$')) return text;
  const ref = /\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/y;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '\\' && quote !== "'" && i + 1 < text.length) {
      out += c + text[i + 1];
      i += 2;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    if (c === '$' && quote !== "'") {
      ref.lastIndex = i;
      const m = ref.exec(text);
      const value = m ? valueOf(m[1] ?? m[2]) : null;
      if (m && typeof value === 'string') {
        out += value;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * A POSIX shell's line as its simple commands, each with what the line itself has made certain by the time it runs:
 * a variable given a plain value earlier (`S=/x/scratch && rm -rf "$S"` names /x/scratch), and the folder a `cd`
 * joined by && has entered (`cd dist && rm -rf *` empties dist, `cd .. && rm -rf project` deletes the project).
 * Certain means the command cannot run without it: a value set at the start of a statement holds from there on, one
 * set after an && holds to the end of that statement, a folder entered holds to the end of its statement (a cd on a
 * line of its own may fail and leave the next line where it was), and once a statement has changed folder the ones
 * after it start somewhere unknown, so only a cd to a full path is followed there. Nothing is taken from a statement
 * with a pipe, an || or a background &, and at the first compound command, substitution, group or here-document the
 * reading stops. Whatever is not certain is checked as written, in the folder the line started in, as every command
 * was before.
 */
function steps(line: string, cwd: string): Step[] {
  const out: Step[] = [];
  const vars = new Map<string, string>();
  let reading = true;
  // The folder a statement starts in: the line's own until some statement has changed folder, unknown after that.
  let base: string | null = cwd;
  const assigned = (w: string) => /^([A-Za-z_]\w*)\+?=/.exec(w)?.[1];
  const stops = (p: string) => /[(){}`]|<</.test(unquoted(p).replace(/\$\{\w+\}/g, '')) || COMPOUND.test(words(p)[0] ?? '');
  const moves = (w: string[]) => w[0] === 'cd' || w[0] === 'pushd' || w[0] === 'popd';
  for (const st of statementsOf(line)) {
    if (reading && st.mixed && st.parts.some(stops)) reading = false;
    if (!reading) {
      for (const p of st.parts) out.push({ text: p, cwd });
      continue;
    }
    if (st.mixed) {
      for (const p of st.parts) {
        out.push({ text: filled(p, (n) => vars.get(n)), cwd });
        const w = words(p);
        for (const x of w) vars.delete(assigned(x) ?? x);
        if (moves(w)) base = null;
      }
      continue;
    }
    // Set after an && in this statement: known to its end, unknown after it (null: not known even here).
    const here = new Map<string, string | null>();
    let at = base;
    for (const [i, p] of st.parts.entries()) {
      if (reading && stops(p)) reading = false;
      if (!reading) {
        out.push({ text: p, cwd });
        continue;
      }
      const text = filled(p, (n) => (here.has(n) ? here.get(n) : vars.get(n)));
      let w = words(text);
      if (w[0] === 'export' && w.length > 1 && w.slice(1).every((x) => assigned(x))) w = w.slice(1);
      if (w.length && w.every((x) => assigned(x))) {
        for (const x of w) {
          const name = assigned(x)!;
          const value = x.slice(x.indexOf('=') + 1);
          const plain = !x.slice(0, x.indexOf('=')).endsWith('+') && PLAIN.test(value) && !value.startsWith('~') ? value : null;
          if (STEERS.test(name)) reading = false;
          if (i === 0) {
            if (plain === null) vars.delete(name);
            else vars.set(name, plain);
          } else here.set(name, plain);
        }
        out.push({ text, cwd: at ?? cwd });
        continue;
      }
      out.push(at !== null && at !== cwd ? { text, cwd: at, ...linksFollowed(at, cwd) } : { text, cwd });
      // A name given to a command bare (read S, unset S, S=x as a prefix) may come back changed.
      for (const x of w) {
        const name = assigned(x) ?? x;
        if (vars.has(name) || here.has(name)) here.set(name, null);
      }
      if (w[0] === 'cd' || w[0] === 'pushd') {
        const to = w.slice(1).filter((x) => x !== '--');
        const absolute = to.length === 1 && /^(\/|[A-Za-z]:[\\/])/.test(to[0]);
        const known = to.length === 1 && PLAIN.test(to[0]) && !/^[-~]/.test(to[0]) && (absolute || (at !== null && (!process.env.CDPATH || /^\.{1,2}(\/|$)/.test(to[0]))));
        at = known ? resolvePath(at ?? cwd, to[0]) : null;
        base = null;
      } else if (w[0] === 'popd') {
        at = null;
        base = null;
      }
    }
    for (const name of here.keys()) vars.delete(name);
    if (!reading) vars.clear();
  }
  return out;
}

/** The folder with its links followed, when that is another place: `..` from there leads elsewhere than its path says. */
function linksFollowed(dir: string, from: string): { also?: string } {
  try {
    // Links above the starting folder are the same for both and say nothing: only one the cd went through counts.
    const real = fs.realpathSync(dir);
    return path.relative(real, path.resolve(fs.realpathSync(from), path.relative(from, dir))) === '' ? {} : { also: real };
  } catch {
    return {};
  }
}
