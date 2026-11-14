import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { capture } from '../util/proc';
import { appPath, ensureDir, toForward } from '../util/paths';
import type { ShellInfo } from '../tools/shell';
import { ripgrepPath } from '../tools/ripgrep';
import { isCode } from '../agent/turn-checks';

const HEAVY = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.turbo', '.cache', 'coverage', '.idea', '.vs']);

/** Files that mark a folder as a code project. */
const CODE_MARKERS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile', 'CMakeLists.txt', 'deno.json', 'composer.json', 'Gemfile']);

function marksCode(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
    // A program's own source counts from one file (a main.go); styles and shell scripts sit beside documents too.
    return files.some((e) => CODE_MARKERS.has(e.name) || /\.(?:sln|csproj)$/.test(e.name) || (isCode(e.name) && !/\.(?:css|scss|sass|less|sql|sh|bash|zsh|ps1|psm1|bat|cmd)$/i.test(e.name)));
  } catch {
    return false;
  }
}

/**
 * A folder of code: a project marker or a source file at its top, or in a folder just under it (a workspace of several
 * projects). A .git folder alone does not make one: folders of documents are repositories too.
 */
export function isCodeProject(cwd: string): boolean {
  if (marksCode(cwd)) return true;
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !HEAVY.has(e.name))
      .slice(0, 40)
      .some((e) => marksCode(path.join(cwd, e.name)));
  } catch {
    return false;
  }
}

/** The folder is inside a git repository (a .git folder or file here or above). */
export function inGitRepo(cwd: string): boolean {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

interface ToolchainCache {
  at: number;
  versions: Record<string, string>;
}

const PROBES: [string, string, string[]][] = [
  ['node', 'node', ['--version']],
  ['npm', 'npm', ['--version']],
  ['pnpm', 'pnpm', ['--version']],
  ['bun', 'bun', ['--version']],
  ['python', 'python', ['--version']],
  ['uv', 'uv', ['--version']],
  ['go', 'go', ['version']],
  ['rustc', 'rustc', ['--version']],
  // A plain `java -version` commits the default first heap, a 64th of the memory: 866 MB on a 64 GB machine for a
  // version string. A small first heap and the serial collector bring it to 33 MB (2026-11-13).
  ['java', 'java', ['-Xms8m', '-XX:+UseSerialGC', '-version']],
  ['dotnet', 'dotnet', ['--version']],
  ['git', 'git', ['--version']],
  ['docker', 'docker', ['--version']],
  // Document and media tools: on the general suite half the sessions spent calls finding out which were there
  // (2026-11-06).
  ['ffmpeg', 'ffmpeg', ['-version']],
  ['ImageMagick', 'magick', ['-version']],
  ['exiftool', 'exiftool', ['-ver']],
  ['pandoc', 'pandoc', ['--version']],
];

/** Python packages for documents, data and pictures, by import name, with the name people install them by. */
const PY_PACKAGES: [string, string][] = [
  ['openpyxl', 'openpyxl'],
  ['docx', 'python-docx'],
  ['pptx', 'python-pptx'],
  ['PIL', 'Pillow'],
  ['matplotlib', 'matplotlib'],
  ['pandas', 'pandas'],
  ['numpy', 'numpy'],
  ['pypdf', 'pypdf'],
  ['fitz', 'PyMuPDF'],
  ['pdfplumber', 'pdfplumber'],
  ['reportlab', 'reportlab'],
];

/** Probes running now, by cache file: a session start asks twice at once (the environment and the folder's facts). */
const probing = new Map<string, Promise<Record<string, string>>>();

/** Versions of common toolchains, and python's document packages, cached for a day so sessions start fast. */
function toolchains(): Promise<Record<string, string>> {
  const file = appPath('cache', 'toolchains2.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as ToolchainCache;
    if (Date.now() - c.at < 24 * 3600_000) return Promise.resolve(c.versions);
  } catch {
    /* no cache */
  }
  // Both callers missed the cache and each ran every probe: two JVMs and 74 processes for one start (2026-11-13).
  let job = probing.get(file);
  if (!job) {
    job = probeToolchains(file).finally(() => probing.delete(file));
    probing.set(file, job);
  }
  return job;
}

async function probeToolchains(file: string): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  const probes: Promise<void>[] = [];
  for (const [name, cmd, args] of PROBES) {
    probes.push(
      (async () => {
        // npm and pnpm are batch files on Windows, which Node starts only through cmd: started directly they failed
        // with EINVAL and were never listed.
        const r = process.platform === 'win32' && ['npm', 'pnpm'].includes(cmd)
          ? await capture('cmd.exe', ['/d', '/s', '/c', `${cmd}.cmd ${args.join(' ')}`], { timeoutMs: 4000 })
          : await capture(cmd, args, { timeoutMs: 4000 });
        const text = `${r.stdout}\n${r.stderr}`;
        const m = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
        if (r.code === 0 && m) versions[name] = m[1];
        else if (name === 'java' && m) versions[name] = m[1];
      })(),
    );
    // Starting a process holds the thread tens of milliseconds on Windows: twelve started in one go held the desktop
    // engine 431 ms. They still run side by side.
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(probes);
  if (versions.python) {
    const code = `import importlib.util as u\nprint(' '.join(n for n in ${JSON.stringify(PY_PACKAGES.map(([m]) => m))} if u.find_spec(n)))`;
    const r = await capture('python', ['-c', code], { timeoutMs: 8000 });
    const found = new Set(r.code === 0 ? r.stdout.trim().split(/\s+/) : []);
    const names = PY_PACKAGES.filter(([m]) => found.has(m)).map(([, n]) => n);
    if (names.length) versions['python packages'] = names.join(', ');
  }
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), versions }));
  } catch {
    /* cache is optional */
  }
  return versions;
}

async function git(cwd: string): Promise<string[]> {
  const root = await capture('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 4000 });
  if (root.code !== 0) return ['Git: not a repository'];
  // Porcelain adds the branch on its own line. Reuse the scan and skip the ahead/behind walk, which the note never shows.
  const withBranch = capture('git', ['status', '--porcelain=v1', '-uall', '--branch', '--no-ahead-behind'], { cwd, timeoutMs: 6000 });
  // Starting a Windows process can hold the thread. Let a live reply through between the two starts.
  await nextTick();
  const logJob = capture('git', ['log', '--oneline', '-n', '5', '--no-decorate'], { cwd, timeoutMs: 4000 });
  const status = await withBranch;
  const firstEnd = status.stdout.indexOf('\n');
  const header = firstEnd < 0 ? '' : status.stdout.slice(0, firstEnd).trimEnd();
  const name = /^## (?:(?:No commits yet|Initial commit) on )?([^\s]+?)(?:\.\.\..*)?$/.exec(header)?.[1];
  let branch = header === '## HEAD (no branch)' ? '' : name?.startsWith('refs/') ? undefined : name;
  let raw = status.stdout.slice(firstEnd + 1);
  if (status.code !== 0 || branch === undefined) {
    // Older Git versions and unusual HEADs still use the original commands.
    const [head, changes] = await Promise.all([
      capture('git', ['branch', '--show-current'], { cwd, timeoutMs: 4000 }),
      capture('git', ['status', '--porcelain=v1', '-uall'], { cwd, timeoutMs: 6000 }),
    ]);
    branch = head.stdout.trim();
    raw = changes.stdout;
  }
  const log = await logJob;
  const lines = raw.split('\n').filter(Boolean);
  const changed = lines.filter((l) => !l.startsWith('??'));
  const untracked = lines.filter((l) => l.startsWith('??'));
  const out = [`Git: repository at ${toForward(root.stdout.trim())}, branch ${branch || '(detached)'}; ${changed.length} changed and ${untracked.length} untracked files`];
  if (lines.length) out.push(`  ${lines.slice(0, 12).map((l) => l.trim()).join('\n  ')}${lines.length > 12 ? `\n  … ${lines.length - 12} more` : ''}`);
  if (log.stdout.trim()) out.push(`Recent commits:\n  ${log.stdout.trim().split('\n').join('\n  ')}`);
  return out;
}

function projectFiles(cwd: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`).sort();
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const all = [...dirs, ...files];
  const shown = all.slice(0, 50);
  const out = [`Top-level entries: ${shown.join(', ')}${all.length > shown.length ? `, … (${all.length} total)` : ''}`];
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = Object.keys(pkg.scripts ?? {});
      const pm = pkg.packageManager ? `, packageManager ${pkg.packageManager}` : '';
      out.push(`package.json: ${pkg.name ?? '(unnamed)'}${pm}${scripts.length ? `; scripts: ${scripts.slice(0, 20).join(', ')}` : ''}${pkg.workspaces ? '; workspaces' : ''}`);
    } catch {
      /* unreadable package.json */
    }
  }
  const markers: [string, string][] = [
    ['pyproject.toml', 'Python project (pyproject.toml)'],
    ['requirements.txt', 'requirements.txt'],
    ['go.mod', 'Go module'],
    ['Cargo.toml', 'Rust crate'],
    ['pom.xml', 'Maven project'],
    ['build.gradle', 'Gradle project'],
    ['build.gradle.kts', 'Gradle project'],
    ['Makefile', 'Makefile'],
    ['CMakeLists.txt', 'CMake project'],
    ['docker-compose.yml', 'docker compose'],
    ['pnpm-workspace.yaml', 'pnpm workspace'],
  ];
  const found = markers.filter(([f]) => fs.existsSync(path.join(cwd, f))).map(([, d]) => d);
  if (entries.some((e) => /\.(sln|csproj)$/.test(e.name))) found.push('.NET solution');
  if (found.length) out.push(`Project markers: ${[...new Set(found)].join(', ')}`);
  // Not .git: every repository was told node_modules existed (2026-11-06).
  if (dirs.some((d) => d !== '.git/' && HEAVY.has(d.slice(0, -1)))) out.push('(Generated or dependency folders such as node_modules exist; searches skip them.)');
  return out;
}

function osName(): string {
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0);
    return `Windows ${build >= 22000 ? '11' : '10'} (build ${os.release()}, ${os.arch()})`;
  }
  if (process.platform === 'darwin') return `macOS (Darwin ${os.release()}, ${os.arch()})`;
  return `${os.type()} ${os.release()} (${os.arch()})`;
}

export interface EnvOptions {
  shell: ShellInfo;
  modelName: string;
  contextWindow: number;
}

/**
 * Facts gathered once at session start so the model does not spend turns discovering them: here what is the same for
 * every session on this machine that day, at the end of the system prompt; the folder's own in projectFacts.
 */
export async function environmentSection(o: EnvOptions): Promise<string> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const chains = await toolchains();
  const chainText = [...Object.entries(chains).filter(([k]) => k !== 'python packages').map(([k, v]) => `${k} ${v}`), ...(ripgrepPath() ? ['rg (ripgrep)'] : [])].join(', ');
  const lines = [
    '# Environment',
    `Platform: ${osName()}; shell: ${o.shell.label}`,
    `Date: ${today} (${tz})`,
    `Model: ${o.modelName}, context window ${o.contextWindow.toLocaleString('en-US')} tokens`,
    ...(chainText ? [`Installed: ${chainText}`] : []),
    ...(chains['python packages'] ? [`Python packages: ${chains['python packages']}`] : []),
  ];
  return lines.join('\n');
}

/** How the folder's facts begin, which is how a history shows they were given. */
export const FACTS_START = 'Working directory: ';

/**
 * The folder a session works in, as the session finds it: what differs from one project and session to the next.
 * It goes with the first message, not in the system prompt, so the rules and the tools after them read the same in
 * every project and a provider's cache of them carries over to the next session. DeepSeek puts the tools after the
 * system prompt: with the folder at its end, a new session found only the rules cached, 6.6k of 12.8k tokens
 * (2026-11-08).
 */
export async function projectFacts(o: { cwd: string; scratch?: string }): Promise<string> {
  const [chains, gitLines] = await Promise.all([toolchains(), git(o.cwd)]);
  const lines = [
    `${FACTS_START}${toForward(o.cwd)}`,
    ...(o.scratch ? [`Scratch folder: ${toForward(o.scratch)}`] : []),
    ...gitLines,
    ...projectFiles(o.cwd),
    ...goToolchain(o.cwd, chains.go),
  ];
  return lines.join('\n');
}

/**
 * A Go module that asks for a newer Go than the one installed. go fetches or picks that toolchain by itself; told
 * only "go 1.24.5", agents set GOTOOLCHAIN=local and every go command failed (14 of 347 eval sessions).
 */
export function goToolchain(cwd: string, installed?: string): string[] {
  let mod: string;
  try {
    mod = fs.readFileSync(path.join(cwd, 'go.mod'), 'utf8');
  } catch {
    return [];
  }
  const want = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(mod)?.[1] ?? /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(mod)?.[1];
  if (!want || !installed) return [];
  const newer = (a: string, b: string) => {
    const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
  };
  if (!newer(want, installed)) return [];
  return [`go.mod asks for Go ${want}, newer than the installed go ${installed}: go runs the toolchain the module asks for by itself, so leave GOTOOLCHAIN unset (GOTOOLCHAIN=local makes every go command here fail).`];
}
