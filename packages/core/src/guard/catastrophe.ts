import os from 'node:os';
import path from 'node:path';
import { appHome } from '../util/paths';
import { splitCommands, words } from './guard';
import { catastropheReason, type catastropheText } from './i18n';

export interface Catastrophe {
  kind: keyof typeof catastropheText;
  target: string;
  reason: string;
  /** A database made successfully by this task can be cleaned up on the same connection. */
  databaseKey?: string;
}

export interface CatastropheContext {
  cwd: string;
  workspace: string;
  home?: string;
  data?: string;
}

export interface CommandEffects {
  risks: Catastrophe[];
  created: string[];
  dropped: string[];
}

const risk = (kind: Catastrophe['kind'], target: string, databaseKey?: string): Catastrophe => ({ kind, target, reason: catastropheReason(kind, target), databaseKey });
const windows = (p: string) => /^[a-z]:|^\\\\/i.test(p);

/** Lexical paths suffice here: no filesystem walk on ordinary commands, and no attempt to follow scripts or links. */
function absolute(target: string, ctx: CatastropheContext): string {
  const home = ctx.home ?? os.homedir();
  let p = target.replace(/^(?:~(?=[/\\]|$)|\$\{HOME\}|\$HOME\b|%USERPROFILE%|\$env:USERPROFILE\b|\$\{env:USERPROFILE\})/i, () => home);
  if (windows(ctx.cwd)) p = p.replace(/^\/([a-z])(?:\/|$)/i, '$1:/');
  const api = windows(p) || (windows(ctx.cwd) && (!p.startsWith('/') || p.startsWith('//'))) ? path.win32 : path.posix;
  const resolved = api.resolve(ctx.cwd, p).replace(/\\/g, '/');
  return api === path.win32 ? resolved.toLowerCase() : resolved;
}

const within = (parent: string, child: string) => parent === child || child.startsWith(parent.replace(/\/$/, '') + '/');
const device = (p: string) => /^(?:\/dev\/(?:[shv]d[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|r?disk\d+(?:s\d+)?|mapper\/.+|disk\/by-(?:id|uuid|path|label)\/.+)|\\\\\.\\(?:PhysicalDrive\d+|[a-z]:))$/i.test(p);

function gitHistory(p: string): boolean {
  return /(?:^|\/)\.git(?:$|\/(?:objects|refs)(?:\/|$)|\/(?:HEAD|packed-refs)$)/i.test(p);
}

function fileRisk(target: string, ctx: CatastropheContext): Catastrophe | null {
  const abs = absolute(target, ctx);
  if (device(target)) return risk('disk', target);
  return gitHistory(abs) ? risk('git', abs) : null;
}

function deletion(target: string, recursive: boolean, ctx: CatastropheContext): Catastrophe | null {
  if (!target) return null;
  // rm -rf "$DIR"/ becomes rm -rf / when DIR is unset. A variable this process has (TEMP, TMPDIR) is read as the
  // shell will read it, so emptying the temp folder is judged by its folder; the home folder is read in `absolute`.
  const named = /^(?:\$\{(\w+)\}|\$(\w+)|\$env:(\w+)|%(\w+)%)(?=[/\\]|$)/i.exec(target);
  const name = named && (named[1] ?? named[2] ?? named[3] ?? named[4]);
  if (named && name && !/^(?:HOME|USERPROFILE)$/i.test(name)) {
    // POSIX shells tell $tmp from $TMP; PowerShell's $env: and cmd's %…% do not (Windows reads process.env either way).
    const value = named[1] ?? named[2] ? Object.entries(process.env).find(([k]) => k === name)?.[1] : process.env[name];
    if (value) target = value + target.slice(named[0].length);
    else if (recursive && /^[^/\\]+[/\\]+\*?$/.test(target)) return risk('variable', target);
  }
  const whole = target === '*' ? '.' : target.replace(/([/\\])\*+$/, '$1');
  const abs = absolute(whole, ctx);
  if (gitHistory(abs)) return risk('git', abs);
  if (!recursive && !/[*?]/.test(target)) return null;
  const home = absolute(ctx.home ?? os.homedir(), ctx);
  const data = absolute(ctx.data ?? appHome(), ctx);
  const workspace = absolute(ctx.workspace, ctx);
  if (abs === '/' || /^[a-z]:\/$|^\/\/[^/]+\/[^/]+\/?$/i.test(abs) || [home, data, workspace].some((p) => within(abs, p))) return risk('folder', abs);
  const drive = /^[a-z]:/i.exec(home)?.[0] ?? 'c:';
  const system = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/sbin', '/sys', '/usr', '/usr/bin', '/usr/lib', '/usr/local', '/var', '/var/lib', '/System', '/Library', '/Applications', `${drive}/windows`, `${drive}/windows/system32`, `${drive}/windows/syswow64`, `${drive}/program files`, `${drive}/program files (x86)`, `${drive}/programdata`, `${home}/appdata`];
  return system.some((p) => within(abs, p)) ? risk('folder', abs) : null;
}

/** File tools cannot remove directories. They can overwrite a device, git objects, refs or a worktree's .git file. */
export function checkFileCatastrophe(kind: string, input: Record<string, unknown>, ctx: CatastropheContext): Catastrophe[] {
  const targets = (kind === 'write' || kind === 'edit') && typeof input.path === 'string' ? [input.path]
    : kind === 'patch' && typeof input.patch === 'string' ? [...input.patch.matchAll(/^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim()) : [];
  return targets.flatMap((target) => { const r = fileRisk(target, ctx); return r ? [r] : []; });
}

function deleteTargets(cmd: string, args: string[]): { targets: string[]; recursive: boolean } | null {
  if (!/^(?:rm|rmdir|rd|rimraf|del|erase|remove-item|ri)$/.test(cmd)) return null;
  if (args.some((a) => /^-whatif$/i.test(a))) return null;
  const ps = /^(?:remove-item|ri)$/.test(cmd);
  const dos = /^(?:rd|rmdir|del|erase)$/.test(cmd);
  const recursive = /^(?:rimraf|rd|rmdir)$/.test(cmd) || args.some((a) => ps ? /^-r(?:ecurse)?$/i.test(a) : /^(?:--recursive|-[a-z]*r[a-z]*|\/s)$/i.test(a));
  const targets: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { literal = true; continue; }
    if (!literal && ps && /^-(?:path|literalpath)$/i.test(a)) { targets.push(...(args[++i] ?? '').split(',')); continue; }
    if (!literal && (a.startsWith('-') || dos && /^\/[sqfap]$/i.test(a))) continue;
    targets.push(...(ps ? a.split(',') : [a]));
  }
  return { targets, recursive };
}

const executable = (s: string) => s.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase().replace(/\.(?:exe|com)$/, '');

/** Keep heredoc data out of the command list; SQL clients still receive their literal input. */
function segments(command: string): { text: string; andThen: boolean }[] {
  const line = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\s|$)/g, (_all, _quote, _end, body: string) => ` '${body.replace(/'/g, `'"'"'`)}'`);
  let end = 0;
  return splitCommands(line).map((text) => {
    end = line.indexOf(text, end) + text.length;
    return { text, andThen: /^\s*&&/.test(line.slice(end)) };
  });
}

function options(args: string[], ...names: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1] !== undefined) found.push(args[i + 1]);
      else if (args[i].startsWith(name + '=')) found.push(args[i].slice(name.length + 1));
      else if (/^-\w$/.test(name) && args[i].startsWith(name) && args[i].length > name.length) found.push(args[i].slice(name.length));
    }
  }
  return found;
}
const option = (args: string[], ...names: string[]) => options(args, ...names)[0];

function databaseEffects(cmd: string, args: string[], stdin: string, environment: string[], effects: CommandEffects): void {
  if (!/^(?:psql|createdb|dropdb|mysql|mysqladmin|mariadb|sqlcmd|sqlite3|duckdb|mongo|mongosh|redis-cli)$/.test(cmd)) return;
  if (args.some((a) => /^(?:--help|--version|-\?|-V)$/.test(a))) return;
  const family = /^(?:psql|createdb|dropdb)$/.test(cmd) ? 'postgres' : /^(?:mysql|mysqladmin|mariadb)$/.test(cmd) ? 'mysql' : cmd === 'mongo' ? 'mongosh' : cmd;
  const uri = [option(args, '-d', '--dbname', '-u', '--uri'), ...args].find((a) => a && /^(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\//i.test(a));
  const address = uri?.replace(/\/\/[^/@]*@/, '//').replace(/[?#].*$/, '');
  const host = option(args, '-h', '--host', '-S') ?? '';
  const port = option(args, family === 'mysql' ? '-P' : '-p', '--port') ?? '';
  const user = option(args, '-U', '-u', '--username', '--user') ?? '';
  const valued = /^(?:-h|-p|-P|-U|-u|-d|-S|-c|-e|-Q|-q|-O|-T|-E|-l|--host|--port|--username|--user|--dbname|--database|--command|--execute|--eval|--owner|--template|--encoding|--locale|--maintenance-db)$/;
  const positional = args.filter((a, i) => !a.startsWith('-') && !(i && valued.test(args[i - 1])));
  const db = option(args, '-d', '--dbname', '--database') ?? address?.split('/').slice(3).join('/') ?? positional[0] ?? '';
  const settings = options(args, '--defaults-file', '--defaults-extra-file', '--login-path', '--service', '--protocol', '--socket', '--maintenance-db');
  const connection = JSON.stringify([family, uri ?? '', host, port, user, environment, settings, db.includes('=') ? db : '']);
  const add = (kind: 'database' | 'schema', name: string, create: boolean) => {
    const key = JSON.stringify([connection, kind, kind === 'schema' ? db : '', name]);
    if (create) effects.created.push(key);
    else { effects.dropped.push(key); effects.risks.push(risk(kind, name, key)); }
  };
  if (cmd === 'createdb' || cmd === 'dropdb') {
    if (positional[0]) add('database', positional[0], cmd === 'createdb');
    return;
  }
  if (cmd === 'mysqladmin') {
    for (let i = 0; i < positional.length - 1; i++) {
      if (positional[i] === 'drop') add('database', positional[++i], false);
      else if (positional[i] === 'create' && !args.includes('--force') && !args.includes('-f')) add('database', positional[++i], true);
    }
    return;
  }
  if (cmd === 'redis-cli') {
    const flush = args.find((a) => /^flush(?:all|db)$/i.test(a));
    const endpoint = address?.replace(/^(redis:\/\/[^/]+)(?:\/.*)?$/, '$1') ?? `redis://${host || 'localhost'}:${port || '6379'}`;
    const selected = option(args, '-n') ?? address?.split('/').slice(3).join('/') ?? '0';
    if (flush) effects.risks.push(risk('store', `${endpoint}/${/^flushall$/i.test(flush) ? '*' : selected || '0'}`));
    return;
  }
  const queries = options(args, '-c', '--command', '-e', '--execute', '-Q', '-q', '--eval');
  const sql = queries.length ? queries.join(';') : stdin || positional.find((a) => /\b(?:DROP|CREATE)\s+(?:DATABASE|SCHEMA)\b/i.test(a)) || '';
  if (family === 'mongosh') {
    for (const sibling of sql.matchAll(/db\.getSiblingDB\(\s*['"]([^'"]+)['"]\s*\)\.dropDatabase\(/g)) add('database', sibling[1], false);
    if (/\bdb\.dropDatabase\(/.test(sql)) add('database', db || 'test', false);
    return;
  }
  const identifier = '"[^"\\n]+"|`[^`\\n]+`|\\[[^\\]\\n]+\\]|[\\w.-]+';
  const statements = new RegExp(`(?:^|;)\\s*(CREATE|DROP)\\s+(DATABASE|SCHEMA)\\s+(IF\\s+(?:NOT\\s+)?EXISTS\\s+)?((?:${identifier})(?:\\s*,\\s*(?:${identifier}))*)`, 'gi');
  for (const m of sql.matchAll(statements)) {
    // IF NOT EXISTS does not establish ownership: the database may have existed before this task.
    if (/^create$/i.test(m[1]) && (m[3] || sql.split(';').filter((s) => s.trim()).length !== 1 || args.includes('--force') || args.includes('-f') || /^authorization$/i.test(m[4]))) continue;
    for (const name of m[4].matchAll(new RegExp(identifier, 'g'))) add(m[2].toLowerCase() as 'database' | 'schema', name[0].replace(/^["`\[]|["`\]]$/g, ''), /^create$/i.test(m[1]));
  }
}

export function checkCatastrophe(command: string, ctx: CatastropheContext): CommandEffects {
  const effects: CommandEffects = { risks: [], created: [], dropped: [] };
  let cwds = [ctx.cwd];
  let previous = cwds;
  const stack: string[][] = [];
  let stdin = '';
  const vars = new Map<string, string>();
  const commands = segments(command);
  for (const { text: seg, andThen } of commands) {
    let w = words(seg);
    const assignment = /^\$?(\w+)\s*=\s*(.*)$/.exec(seg);
    if (assignment && (!assignment[2].trim() || words(assignment[2]).length === 1)) { vars.set(assignment[1], words(assignment[2])[0] ?? ''); continue; }
    const environment: string[] = [];
    while (w.length) {
      if (/^\w+=/.test(w[0])) { environment.push(w.shift()!); continue; }
      const wrapper = executable(w[0]);
      if (!/^(?:sudo|doas|env|command|exec|nohup|time)$/.test(wrapper)) break;
      w.shift();
      if (wrapper === 'sudo' || wrapper === 'doas') {
        environment.push(wrapper);
        while (w[0]?.startsWith('-')) {
          const flag = w.shift()!;
          environment.push(flag);
          if (/^(?:-u|-g|--user|--group)$/.test(flag)) environment.push(w.shift() ?? '');
        }
      }
    }
    if (!w.length) continue;
    const cmd = executable(w[0]);
    const args = w.slice(1).map((a) => a.replace(/\$\{(\w+)\}|\$(\w+)\b|%(\w+)%/g, (raw, a, b, c) => vars.get(a ?? b ?? c) ?? raw));
    const contexts = cwds.map((cwd) => ({ ...ctx, cwd }));
    if (cmd === 'popd' || cmd === 'pop-location') { cwds = stack.pop() ?? cwds; continue; }
    if (/^(?:cd|chdir|set-location|sl|pushd)$/.test(cmd)) {
      const dir = args.find((a) => (!a.startsWith('-') || a === '-') && a.toLowerCase() !== '/d');
      if (dir) {
        const old = cwds;
        if (cmd === 'pushd') stack.push(old);
        const next = dir === '-' ? previous : contexts.map((local) => absolute(dir, local));
        // Without &&, a failed cd leaves the deletion in the old folder: cd missing; rm -rf * can wipe the project.
        cwds = [...new Set(andThen ? next : [...next, ...old])];
        previous = old;
      }
      continue;
    }
    if (/^(?:bash|sh|zsh|pwsh|powershell|cmd)$/.test(cmd)) {
      const i = args.findIndex((a) => /^(?:-[a-z]*c|--command|-command|\/[ck])$/i.test(a));
      if (i >= 0 && args[i + 1]) for (const local of contexts) {
        const inner = checkCatastrophe(cmd === 'cmd' ? args.slice(i + 1).join(' ') : args[i + 1], local);
        effects.risks.push(...inner.risks); effects.created.push(...inner.created); effects.dropped.push(...inner.dropped);
      }
      continue;
    }
    const del = deleteTargets(cmd, args);
    if (del) for (const local of contexts) for (const target of del.targets) { const r = deletion(target, del.recursive, local); if (r) effects.risks.push(r); }
    if (cmd === 'find' && (args.includes('-delete') || args.includes('-exec') && args.includes('rm')) && !args.some((a) => /^-(?:name|iname|path|regex|mtime|mmin)$/.test(a))) {
      const end = args.findIndex((a) => a.startsWith('-'));
      for (const local of contexts) for (const target of end > 0 ? args.slice(0, end) : ['.']) {
        const r = deletion(target, true, local);
        if (r) effects.risks.push(r);
      }
    }
    const readOnly = args.some((a) => /^(?:--help|-h|--version|-whatif|--no-act)$/i.test(a));
    if (!readOnly && /^(?:mkfs(?:\.\w+)?|mke2fs|wipefs|fdisk|sfdisk|gdisk|sgdisk|parted|blkdiscard|diskpart|format|format-volume|clear-disk|initialize-disk|remove-partition)$/.test(cmd)) {
      const listing = /^(?:fdisk|sfdisk|parted)$/.test(cmd) && (args.includes('-l') || args.includes('--list') || args.includes('--dump'))
        || cmd === 'parted' && args.includes('print') && !args.some((a) => /^(?:mklabel|mkpart|rm|resizepart|rescue|set|disk_set)$/.test(a))
        || cmd === 'wipefs' && !args.some((a) => /^(?:-a|--all|-o|--offset)/.test(a))
        || /^(?:mke2fs|mkfs\.ext[234])$/.test(cmd) && args.includes('-n');
      if (!listing) {
        const letter = option(args, '-DriveLetter', '-driveletter');
        const number = option(args, '-Number', '-DiskNumber', '-number', '-disknumber');
        const target = letter ? `${letter}:/` : number ? `disk ${number}` : args.find((a) => device(a) || /^[a-z]:[/\\]?$/i.test(a));
        if (target || /^(?:diskpart|format-volume|clear-disk|initialize-disk|remove-partition)$/.test(cmd)) effects.risks.push(risk('disk', target ?? seg));
      }
    }
    const output = cmd === 'dd' ? args.find((a) => a.startsWith('of='))?.slice(3) : cmd === 'tee' ? args.find((a) => !a.startsWith('-')) : undefined;
    if (output) for (const local of contexts) { const r = fileRisk(output, local); if (r) effects.risks.push(r); }
    if (cmd === 'shred' || cmd === 'cp') for (const target of cmd === 'cp' ? args.slice(-1) : args) {
      if (device(target)) effects.risks.push(risk('disk', target));
    }
    for (const m of seg.matchAll(/"[^"]*"|'[^']*'|\d*>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
      if (m[1]) for (const local of contexts) { const r = fileRisk(words(m[1])[0], local); if (r) effects.risks.push(r); }
    }
    databaseEffects(cmd, args, stdin, environment, effects);
    stdin = /^(?:echo|printf)$/.test(cmd) ? args.join(' ') : '';
  }
  effects.risks = effects.risks.filter((r, i, all) => all.findIndex((other) => other.kind === r.kind && other.target === r.target && other.databaseKey === r.databaseKey) === i);
  // A compound command's exit status cannot establish that its CREATE succeeded (createdb x; echo done).
  if (commands.length !== 1) effects.created = [];
  return effects;
}

/** Only an affirmative instruction and an exact target in the same clause count, never a mere mention. */
export function explicitlyRequested(text: string, r: Catastrophe, ctx: CatastropheContext): boolean {
  if (r.kind === 'variable') return false;
  if (r.kind === 'disk' && !device(r.target) && !/^[a-z]:[/\\]?$|^disk \d+$/i.test(r.target)) return false;
  const run = /^(?:please\s+)?(?:run|execute|请执行|执行)\s*(?:this command\s*:\s*|以下命令\s*[:：]\s*)?(?:`([^`]+)`|```(?:\w+)?\n([\s\S]*?)\n```)\s*[.!。！]?$/i.exec(text.trim());
  if (run) return checkCatastrophe(run[1] ?? run[2], ctx).risks.some((asked) => asked.kind === r.kind && asked.target === r.target && asked.databaseKey === r.databaseKey);
  const verbs = r.kind === 'disk' ? 'format|wipe|erase|clear|overwrite|repartition|格式化|擦除|清空|重新分区'
    : r.kind === 'database' || r.kind === 'schema' || r.kind === 'store' ? 'drop|delete|destroy|flush|erase|清空|删除|删掉|销毁'
      : 'delete|remove|wipe|erase|destroy|删除|删掉|清空|清理|移除';
  const [english, chinese] = [verbs.split('|').filter((v) => /^[a-z]/.test(v)).join('|'), verbs.split('|').filter((v) => !/^[a-z]/.test(v)).join('|')];
  const imperative = new RegExp(`^(?:(?:please|now|then|also)\\s+|(?:can|could|would) you\\s+|I (?:want|need) you to\\s+)*(?:${english})\\b\\s*|^(?:(?:请|帮我|现在|直接|麻烦|彻底)\\s*)*(?:${chinese})\\s*`, 'i');
  const objectFirst = new RegExp(`^(?:(?:请|帮我|现在|直接|麻烦)\\s*)*(?:把|将)\\s*(.+?)\\s*(?:全部|整个|彻底)?(?:${chinese})(?:吧|掉|了)?$`);
  const prohibited = /\b(?:not|never|don['’]?t|without|avoid|if|unless|until|after|before|when|example|explain|why|whether|preserve|keep)\b|不要|别|禁止|不能|不得|避免|如果|示例|例子|是否|为什么|保留|等到|之后|之前/i;
  for (const clause of text.replace(/```[\s\S]*?```/g, '').split(/[\n;；。!?！？]|\.(?=\s|$)/)) {
    const s = clause.trim();
    if (!s || prohibited.test(s)) continue;
    const verb = imperative.exec(s);
    const objects = verb ? s.slice(verb[0].length) : objectFirst.exec(s)?.[1];
    if (!objects) continue;
    // The target must be the verb's object. "Delete logs from /home/me" does not authorize deleting /home/me.
    for (const [i, object] of objects.split(/\s+and\s+|[,，、]|和/).entries()) {
      const named = object.trim().replace(imperative, '').replace(/^(?:(?:the|entire|whole|folder|directory|repository|database|schema|drive|volume)\s+|文件夹|目录|数据库|磁盘|整个|全部)*/i, '').trim();
      const m = /^(?:`([^`]+)`|"([^"]+)"|'([^']+)'|(\S+))/.exec(named);
      if (!m) continue;
      if (i && !imperative.test(object.trim()) && named.slice(m[0].length).trim()) continue;
      let name = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (r.kind === 'database' || r.kind === 'schema' || r.kind === 'store') {
        if (name === r.target) return true;
      } else {
        if (r.kind === 'disk' && /^disk \d+$/i.test(r.target) && named.toLowerCase() === r.target) return true;
        if (r.kind === 'disk' && /^[a-z]:$/i.test(name)) name += '/';
        // Relative '.' and '..' depend on a shell's workdir, which need not be the user's folder.
        if (name !== '.' && name !== '..' && absolute(name, ctx) === absolute(r.target, ctx)) return true;
      }
    }
  }
  return false;
}
