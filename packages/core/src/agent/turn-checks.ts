/** Files whose changes a run of something can verify; documents and notes need no test run. */
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|pyi|go|rs|java|kt|kts|scala|cs|fs|c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|rb|php|lua|dart|ex|exs|erl|hs|ml|clj|r|jl|zig|nim|sql|sh|bash|ps1|psm1|css|scss|less|html?|json|ya?ml|toml|gradle|cmake|proto)$/i;

export function isCode(file: string): boolean {
  return CODE.test(file) || /(?:^|[\\/])(?:Makefile|Dockerfile|Justfile)$/.test(file);
}

/** A command that runs, builds or tests something, as opposed to one that only looks around. */
const RUN_PROGRAM = /^(?:npm|npx|pnpm|yarn|bun|deno|node|tsx|python(?:\d+(?:\.\d+)?)?|py|ruby|php|java|mvn|gradle|dotnet|swift|make|cmake|bazel|zig|elixir|mix|ghc|stack|lua|curl|playwright|cypress|lighthouse|cargo)$/i;

export function runsSomething(command: string): boolean {
  return invokes(command, true);
}

/**
 * A request for something people will look at: a page, an interface, motion, a game. Words that are as often about
 * code (an interface type, a component, code style, a memory layout, state transitions, an HTML parser) are left out; "UI" and "UX" count only in capitals.
 * Charts and layout or font words are not here: a chart is drawn by a script and a translation that keeps its layout is
 * not a page, yet both got the browser, paint and the whole design guide (2026-11-06).
 */
const NAMES_LOOK = /\b(?:web ?pages?|websites?|landing pages?|home ?pages?|front[- ]?end|user interfaces?|css|tailwind|dashboards?|responsive|dark mode|navbar|sidebar|hero section|typography|colou?r palette)\b|页面|网页|网站|官网|落地页|首页|前端|界面|样式|仪表盘|看板|响应式|导航栏|好看|美观|审美|配色/i;
/** Words for what is on a screen that as often name what a program models: a game and its board, a button, a dialog. */
const SCREEN_THINGS = /\b(?:animations?|animated|animate|games?|canvas|webgl|three\.?js|buttons?|modals?|dialogs?)\b|交互|动画|动效|游戏|画布|按钮|弹窗/i;

export function asksForInterface(text: string): boolean {
  return namesInterface(text) || SCREEN_THINGS.test(text);
}

/**
 * The request names the interface itself: a page, a site, the front end, its styles. A game, a button or an animation
 * alone counts only where the project has an interface or none has begun (session.ts): every exercise that scores a
 * game in a Go or Python module got the design guide, the browser and two app styles (6 of 30 coding tasks in one
 * test, 2026-11-08).
 */
export function namesInterface(text: string): boolean {
  return NAMES_LOOK.test(text) || /\b(?:UI|UX)\b/.test(text);
}

const REDESIGN = /\bre-?(?:design|style|skin|vamp)\b|\bmake (?:it|this|the \w+) look\b|\blooks? (?:bad|ugly|generic|cheap|dated|templated)\b|重新设计|重做|改版|换个?(?:风格|样式|设计)|太丑|好丑|很丑|不好看|更好看|高级感/i;
const MAKES = /\b(?:build|create|make|design|generate|prototype|new)\b|做|写个|写一个|建|搭|设计|开发|生成|来个/i;
const REPAIRS = /\b(?:fix|bug|error|crash|broken)\b|修复|报错|崩溃|修一下/i;

// Whatever is not named here or as a page gets an art direction: asked for "the expense-claims screen" of a company, Favilla dealt a
// product-page direction in bubblegum pink (2026-11-11). So the list names the things people use, the plainly worded ones included.
const WORK_SCREEN = /\b(?:dashboards?|admin|back ?office|panels?|consoles?|inbox(?:es)?|editors?|settings|crm|tools?|apps?|clients?|players?|managers?|boards?|kanban|trackers?|workspace|screens?|calculators?|converters?|timers?|viewers?|planners?|calendars?|schedulers?|checkers?|monitors?|explorers?|generators?|spreadsheets?|wizards?|log-?in|sign-?in|sign-?up|checkout)\b|后台|管理|仪表盘|看板|控制台|编辑器|设置|工具|客户端|应用|播放器|面板|工作台|界面|系统|平台|计算器|转换器|计时器|番茄钟|待办|日历|记账|登录|注册|报表|小程序|生成器|助手/i;
const PAGE = /\b(?:landing|home ?page|marketing|portfolio|website|site|one-?pager|event page|product page)\b|落地页|官网|首页|主页|作品集|宣传/i;

/** A page that persuades: a landing page, a site, a portfolio. */
export function asksForPage(text: string): boolean {
  return PAGE.test(text);
}

/** A screen people work in rather than a page that persuades: it gets app styles, not art directions. */
export function asksForWorkScreen(text: string): boolean {
  return WORK_SCREEN.test(text) && !PAGE.test(text);
}

/** Asks for how something looks to change, whatever is there already. */
export function asksForRedesign(text: string): boolean {
  return REDESIGN.test(text);
}

/** Asks for something new to be made. Repairs that mention a page are not that. */
export function asksToMake(text: string): boolean {
  return MAKES.test(text) && !REPAIRS.test(text);
}

/** Asks for something to be repaired. */
export function asksToFix(text: string): boolean {
  return REPAIRS.test(text);
}

/**
 * The request without what it rules out. "Fetch nothing (no curl … outside APIs or web pages)", the offline line of
 * every eval task, asked for a web page by its words, and the design guide and the browser's instructions came with
 * every task (3-4k tokens on each request, 2026-11-03).
 */
export function withoutProhibitions(text: string): string {
  // In Chinese only a clause that opens with the prohibition goes: "做个不要太花哨的官网" still asks for a site.
  return text.replace(/\b(?:no|not|never|nothing|without|don't|do not|must not|mustn't)\b[^.!?\n]*/gi, ' ').replace(/(^|[，,。！？!?；;\n])\s*(?:不要|别|禁止|不能|不准|不用|勿)[^，,。！？!?；;\n]*/g, '$1');
}

/** The request is about the user's email: reading, sorting, answering or sending mail. */
const MAIL = /\b(?:e-?mails?|inbox(?:es)?|mailbox(?:es)?|gmail|unread)\b|邮件|邮箱|收件箱|回信|发信/i;

export function asksAboutMail(text: string): boolean {
  return MAIL.test(text);
}

/**
 * The request makes a document, a sheet, slides, a chart or a translation, or works on many files at once: the work
 * the documents section is about. Renaming alone is left out, since in code it is a refactor. The words that also
 * describe what code does (translate, batch, a chart, "like a spreadsheet") count only when the request names no
 * source file: exercises whose code translates one notation into another got the section (8 of 30 coding tasks in
 * one test, 2026-11-08).
 */
const DOCUMENT_NAMES = /\.(?:docx?|xlsx?|pptx?|csv|tsv)\b|\b(?:excel|word documents?|powerpoint|slide decks?)\b|表格|文档|幻灯片|图表/i;
const DOCUMENT_WORDS = /\b(?:spreadsheets?|slides?|charts?|plots?|translat\w*|batch)\b|翻译|批量/i;
const SOURCE_FILE = /\b\w+\.(?:go|tsx?|jsx?|py|rs|java|cc?|cpp|h|rb|php|cs|swift|kt)\b/;

export function asksForDocuments(text: string): boolean {
  return DOCUMENT_NAMES.test(text) || (DOCUMENT_WORDS.test(text) && !SOURCE_FILE.test(text));
}

/** A file of the kind the documents section is about: a document, a sheet, slides, a table of data. */
export const DOCUMENT_FILE = /\.(?:docx?|xlsx?|pptx?|csv|tsv)$/i;

/**
 * The request asks for a standalone prose document or report (a README, postmortem, design or migration proposal,
 * release notes, guide or investigation report), as opposed to code that parses or exports reports or merely reading a
 * README before changing source files.
 */
const WRITTEN_DOC_GENRES =
  /\b(?:post-?mortems?|incident reports?|outage reports?|root-?cause (?:analysis|reports?)|release notes|change-?logs?|migration (?:plans?|proposals?|guides?)|design (?:docs?|documents?|proposals?)|architecture (?:docs?|documents?)|technical proposals?|audit reports?|investigation reports?|runbooks?)\b|复盘(?:报告|文档)?|(?:事故|故障|调查|排查|审计|技术|分析|研究)报告|发布说明|发版说明|更新日志|变更日志|(?:设计|迁移|改造|架构|技术)方案|(?:架构|使用|开发|运维|接口)(?:文档|指南|手册)/i;
const WRITTEN_DOC_ACTION_EN =
  /\b(?:write|draft|author|prepare|update|revise|document|put together|fill in)\b[^.!?\n]{0,45}\b(?:readme(?:\.md)?|contributing(?:\.md)?|changelog(?:\.md)?|documentation|user guides?|developer guides?|manuals?|proposals?|[\w./-]+\.(?:md|mdx|rst|adoc))\b/i;
const WRITTEN_DOC_ACTION_ZH =
  /(?:写|撰写|起草|整理|整理成|写成|编写|补|补齐|更新)(?:一份|一篇|一个|一下)?[^，。！？!?\n]{0,18}(?:readme(?:\.md)?|说明文档|项目文档|文档|报告|方案|指南|手册|[\w./-]+\.(?:md|mdx|rst|adoc))/i;
const CODE_ARTIFACT_AFTER =
  /\b(?:readme|docs?|documentation|reports?|proposals?|markdown)\s+(?:generators?|exporters?|parsers?|builders?|formatters?|renderers?|loaders?|handlers?|tests?|specs?)\b/i;

export function asksForWrittenDoc(text: string): boolean {
  if (CODE_ARTIFACT_AFTER.test(text)) return false;
  return WRITTEN_DOC_GENRES.test(text) || WRITTEN_DOC_ACTION_EN.test(text) || WRITTEN_DOC_ACTION_ZH.test(text);
}

/** A standalone prose document written in the project (not read-only context like reading README.md during code work). */
export const WRITTEN_DOC_FILE = /\.(?:md|mdx|rst|adoc|docx)$/i;

/** A source file, as opposed to a document, a picture or data: what the engineering standards are for. */
export const CODE_FILE = /\.(?:go|tsx?|jsx?|mjs|cjs|py|rs|java|kts?|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|lua|sh|ps1|vue|svelte|html?|css|scss|sql)$/i;

/** The user asks for sub-agents, work side by side, or work in the background. */
const AGENTS = /\bsub-?agents?\b|\bagents?\b[^.\n]{0,20}\b(?:in parallel|at once|side by side)|\bin parallel\b|\bin the background\b|\bdelegat|子代理|子智能体|并行|分头|同时(?:跑|做|查|开)|后台|委派/i;

export function asksForAgents(text: string): boolean {
  return AGENTS.test(text);
}

/** A check runs a checker, a runner's check subcommand, or a script named for the job it does. */
const CHECK_PROGRAM = /^(?:tests|py\.test|pytest|unittest|jest|vitest|mocha|ava|tap|tsc|eslint|biome|ruff|mypy|pyright|flake8|clippy|phpunit|rspec|ctest|golangci-lint|pylint|shellcheck|checkstyle|rubocop|stylelint|vue-tsc|tsd|cmp|diff)$/i;
const CHECK_TASK = /(?:^|[.:\-_])(?:tests?|lint|build|check|type-?check|verify|validate|spec)(?=$|[.:\-_])/i;
const TASK_NAME = /^[\w.:\-]+$/;
const CHECK_SCRIPT = /(?:^|[.\-_])(?:tests?|unittests?|runtests?|smoke|lint|checks?|type-?check|verify|validate|spec)(?=$|[.\-_])/i;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|py|rb|php|ps1|sh|bat|cmd|pl|r|lua|exe)$/i;
const SUBCOMMAND = new Map<string, RegExp>(Object.entries({
  cargo: /^(?:test|check|build|clippy|nextest)$/,
  go: /^(?:test|vet|build)$/,
  dotnet: /^(?:test|build)$/,
  deno: /^(?:test|lint|check|compile)$/,
  swift: /^(?:test|build)$/,
  mix: /^(?:test|compile)$/,
  forge: /^(?:test|build)$/,
  zig: /^test$/,
  bazel: /^(?:test|build)$/,
  stack: /^(?:test|build)$/,
  meson: /^(?:test|compile)$/,
  ant: /^(?:test|check|build)$/,
  playwright: /^test$/,
  cypress: /^run$/,
}));
const TAKES_VALUE = new Set(['-C', '-d', '--distribution', '-p', '-w', '-f', '-s', '--prefix', '--cwd', '--directory', '--filter', '--package', '--workspace', '--project', '--project-dir', '--manifest-path', '--config', '--file', '--settings']);
const NODE_VALUE = new Set(['--require', '-r', '--import', '--loader', '--conditions']);
const CHECK_SHELL = /^(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd)$/;
const SHELL_LITERAL = /'(?:[^']|'')*'|"(?:[^"\\]|\\[\s\S])*"/g;
const COMMAND_WORDS = /(?<![^\s;|&(){}])#[^\r\n]*|(?:'(?:[^']|'')*'|"(?:[^"\\]|\\[\s\S])*"|\\[ \t;&|()]|[^\s;&|(){}'"])+|&&|\|\||[;&|(){}\n]/g;

function basename(program: string): string {
  return program.split(/[\\/]/).at(-1)!.toLowerCase();
}

function unquoteWord(word: string): string {
  return word.replace(SHELL_LITERAL, (s) => s[0] === "'" ? s.slice(1, -1).replace(/''/g, "'") : s.slice(1, -1).replace(/\\(["$\\])/g, '$1'));
}

interface ShellCommand {
  words: string[];
  input?: string;
}

function* simpleCommands(line: string): Generator<ShellCommand> {
  const bodies: string[] = [];
  const variables = new Map<string, string>();
  const block = (body: string, stdin: boolean) => {
    const index = bodies.push(body) - 1;
    return String.fromCharCode(stdin ? 1 : 0) + index;
  };
  // Keep literal input separate from the shell's words. It may be a program, but only if a runner receives it.
  const text = line.replace(/\\\r?\n/g, '').replace(
    /@(['"])\r?\n([\s\S]*?)^\1@|<<-?[ \t]*(['"]?)(\w+)\3([^\r\n]*)\r?\n([\s\S]*?)^[ \t]*\4[ \t]*(?=\r?$)|'(?:[^']|'')*'|"(?:[^"\\]|\\[\s\S])*"/gm,
    (all, ps, here, _quote, end, rest, stdin) => ps ? ' ' + block(here, false) : end ? ' ' + block(stdin, true) + rest + '\n' : all,
  );
  let words: string[] = [];
  let input: string | undefined;
  for (const [token] of (text + '\n').matchAll(COMMAND_WORDS)) {
    if (token.startsWith('#')) continue;
    if (token.charCodeAt(0) === 1) {
      input = bodies[Number(token.slice(1))];
      continue;
    }
    if (!/^[;&|(){}\n]+$/.test(token)) {
      words.push(unquoteWord(token));
      continue;
    }
    if (!words.length) continue;
    const literal = words.at(-1)!;
    if (literal.charCodeAt(0) === 0) {
      const name = /^(\$\w+)\s*=$/.exec(words.slice(0, -1).join(' '))?.[1];
      if (name) variables.set(name.toLowerCase(), bodies[Number(literal.slice(1))]);
    }
    yield { words, input };
    input = token === '|' && words.length === 1
      ? literal.charCodeAt(0) === 0 ? bodies[Number(literal.slice(1))] : variables.get(literal.toLowerCase())
      : undefined;
    words = [];
  }
}

/** The first operand, past options that set up the runner. Anything after it belongs to that operand. */
function operand(args: string[], extra?: ReadonlySet<string>): number {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
    if (args[i] === '--') return i + 1;
    i += TAKES_VALUE.has(args[i]) || extra?.has(args[i]) ? 2 : 1;
  }
  return i;
}

function checkScript(file: string): boolean {
  const name = file.split(/[\\/]/).at(-1)!.replace(/([a-z\d])([A-Z])/g, '$1-$2');
  return (SCRIPT_FILE.test(name) || /[\\/]/.test(file) && !name.includes('.')) && CHECK_SCRIPT.test(name);
}

function checkTask(task: string): boolean {
  return TASK_NAME.test(task) && (CHECK_TASK.test(task.replace(/([a-z\d])([A-Z])/g, '$1-$2')) ||
    /^(?:unittests?|(?:test|check|lint|build)(?:all|suite|unit|integration|e2e|types))$/i.test(task));
}

/** Check a program the shell passes to an interpreter. Strings and comments may describe checks they never run. */
function inlineCheck(name: string, code: string | undefined): boolean {
  if (!code) return false;
  const python = /^(?:py|python)/.test(name);
  const syntax = python
    ? /'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|#[^\r\n]*/g
    : /'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|\x60(?:[^\x60\\]|\\[\s\S])*\x60|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const bare = code.replace(syntax, (s) => s.replace(/[^\r\n]/g, ' '));
  return python
    ? /(?:^|[;\n])\s*assert(?:\s|\()|\b(?:pytest|unittest)\.main\s*\(|\.assert[A-Z]\w*\s*\(/.test(bare)
    : name === 'node' && /\b(?:assert(?:\.\w+)?\s*\(|throw\s+new\s+Error\s*\()/.test(bare);
}

function checks({ words, input }: ShellCommand, depth: number, anyRun: boolean): boolean {
  if (depth > 8) return false;
  const start = words.findIndex((w) => !/^(?:!|if|then|elif|else|while|until|do|command|exec|call|time)$|^[\w]+=/i.test(w));
  if (start < 0) return false;
  const file = words[start];
  const name = basename(file).replace(/\.(?:exe|com|cmd|bat)$/, '');
  const args = words.slice(start + 1 + (name === 'cargo' && words[start + 1]?.startsWith('+') ? 1 : 0));
  const run = (nested: string[]) => checks({ words: nested }, depth + 1, anyRun);
  const shell = (text: string) => {
    for (const nested of simpleCommands(text)) if (checks(nested, depth + 1, anyRun)) return true;
    return false;
  };
  if (checkScript(file) || CHECK_PROGRAM.test(name) && !args.some((a) => a === '--help' || a === '--version')) return true;

  const i = operand(args, name === 'node' ? NODE_VALUE : undefined);
  const action = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  if (CHECK_SHELL.test(name)) {
    const flag = args.slice(0, i).findIndex((a) => /^-[a-z]*c$|^-command$/i.test(a));
    if (flag >= 0) return shell(args[flag + 1] ?? '');
    if (name === 'cmd' && /^\/[ck]$/i.test(args[0])) return shell(args.slice(1).join(' '));
    return !!args[i] && checkScript(args[i]);
  }
  if (name === 'wsl') return run(args.slice(i));
  if (name === 'timeout') return run(rest);
  if (anyRun && (RUN_PROGRAM.test(name) || name === 'go' && /^(?:test|build|vet|run)$/.test(action ?? ''))) return true;

  if (/^(?:python(?:\d+(?:\.\d+)?)?|py|node|ruby|php|tsx|ts-node|perl|lua|Rscript)$/i.test(name)) {
    for (let j = 0; j < i; j++) {
      if (name === 'node' && /^(?:--test|--check|-c)$/.test(args[j])) return true;
      if (/^(?:--eval|-e|-c)$/.test(args[j])) return inlineCheck(name, args[j + 1]);
      if (args[j] === '-m') return CHECK_PROGRAM.test(args[j + 1] ?? '') || /^(?:compileall|py_compile)$/.test(args[j + 1] ?? '') || /^(?:check|test|lint|verify)$/.test(args[j + 2] ?? '');
      if (TAKES_VALUE.has(args[j]) || name === 'node' && NODE_VALUE.has(args[j])) j++;
    }
    if (name === 'php' && action === 'artisan' && rest[0] === 'test') return true;
    return !action || action === '-' ? inlineCheck(name, input) : checkScript(args[i]);
  }
  if (name === 'npx' || name === 'bunx' || name === 'env' || name === 'sudo') return run(args.slice(i));
  if (/^(?:uv|uvx|pipenv|poetry|bundle)$/.test(name)) return name === 'uvx' ? run(args.slice(i)) : /^(?:run|exec)$/.test(action ?? '') && run(rest.slice(operand(rest)));
  if (/^(?:npm|pnpm|yarn|bun)$/.test(name)) {
    if (action && /^(?:exec|dlx|x)$/.test(action)) return run(rest.slice(operand(rest)));
    const task = action && /^(?:run|run-script)$/.test(action) ? rest[operand(rest)] : args[i];
    return !!task && (checkTask(task) || CHECK_PROGRAM.test(task) || name === 'npm' && task === 't');
  }
  if (/^(?:make|gmake|just|task|gradlew?|rake|mvnw?)$/.test(name)) {
    return args.slice(i).some((a) => checkTask(a) || /^mvnw?$/.test(name) && a === 'package');
  }
  if (name === 'zig' && action === 'build') return rest.some(checkTask);
  if (name === 'deno' && action === 'task') return !!rest[0] && checkTask(rest[0]);
  if (/[\\/]/.test(file) && args.some((arg) => /^-test\.(?:run|bench|list|fuzz)(?:=|$)/.test(arg))) return true;
  if (name === 'prettier' || name === 'black') return args.includes('--check');
  if (name === 'git') return action === 'diff' && rest.includes('--check');
  if (name === 'cmake') return args[0] === '--build';
  if (name === 'go' && action === 'tool') return run(rest);
  if (/^(?:gofmt|gofumpt|goimports)$/.test(name)) return args.includes('-l') && !args.includes('-w');
  return !!(action && SUBCOMMAND.get(name)?.test(action));
}

function invokes(command: string, anyRun = false): boolean {
  for (const words of simpleCommands(command)) if (checks(words, 0, anyRun)) return true;
  return false;
}

export function isCheckCommand(command: string): boolean {
  return invokes(command);
}

/** Lines only a failed test run prints: Go, pytest, unittest, jest, vitest, mocha, cargo. */
const FAILED_RUN = /^(?:\s*--- FAIL: |FAIL(?:\s|$)|FAILED \(|FAILED \S+::|(?:=+ )?(?:\d+ \w+, )*\d+ failed\b|\s*Tests:?\s+(?:\d+ \w+, )*\d+ failed\b|\s*\d+ failing\b|test result: FAILED\b)/m;

/** A successful process exit is not test evidence when the runner says it exercised nothing. */
export function ranNoTests(output: string): boolean {
  const empty = /\[no tests to run\]|\[no test files\]|^\s*Ran 0 tests?\b|^\s*NO TESTS RAN\b|^\s*running 0 tests\b|^\s*No tests found\b|^\s*0 passing\b|\b(?:collected 0 items|no tests ran)\b/gim;
  if (!empty.test(output)) return false;
  // Cargo's doctests and Go's other packages can be empty after real tests in the same command.
  const rest = output.split(/\r?\n/).filter((line) => !ranEmptyLine(line)).join('\n');
  return !/^\s*(?:ok\s+\S+\s+(?:[\d.]+s|\(cached\))|(?:Ran|running) [1-9]\d* tests?\b|[1-9]\d* (?:passed|passing)\b|Tests?:?\s+[1-9]\d* passed\b|test result: ok\. [1-9]\d* passed\b)/m.test(rest);

  function ranEmptyLine(line: string): boolean {
    empty.lastIndex = 0;
    return empty.test(line);
  }
}

/** Commands that change the project, by what they say. Quoted text is left out first, so a search for "rm " is no removal. */
const CHANGES: [RegExp, string][] = [
  [/(^|[^<>&\d-])>{1,2}\s*(?!\/dev\/null|&)\S/, 'writes a file'],
  [/(^|[;&|(]\s*|\bxargs\s+|\bsudo\s+)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|unzip|tar\s+-?x\w*)\b/, 'changes files'],
  [/\b(sed|perl|ruby)\s+(-\w+\s+)*-\w*i\b|\bsed\s+--in-place\b/, 'edits a file in place'],
  [/\b(gofmt|goimports|rustfmt)\s+(-\w+\s+)*-w\b|\bgo\s+(fmt|generate)\b|\bprettier\b.*--write\b|\beslint\b.*--fix\b|\bruff\s+(format|check\s+.*--fix)\b|\bblack\b|\bcargo\s+fmt\b/, 'rewrites source files'],
  [/\bgit\s+(-[cC]\s+\S+\s+|-\S+\s+)*(add|am|apply|checkout|cherry-pick|clean|clone|commit|fetch|init|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag)\b/, 'changes git state'],
  [/\b(npm|pnpm|yarn|bun)\s+(add|ci|i|install|link|publish|remove|rm|uninstall|up|update)\b/, 'changes installed packages'],
  [/\b(pip3?|uv|poetry|pipenv|conda)\s+(add|install|remove|sync|uninstall|update)\b/, 'changes installed packages'],
  [/\bgo\s+(get|install|mod\s+(edit|init|tidy|vendor))\b|\bcargo\s+(add|install|remove|update)\b/, 'changes installed packages'],
  [/\b(docker|podman|kubectl|helm|terraform)\s+(?!(ps|logs|images|get|describe|version|plan)\b)\S/, 'changes running systems'],
];

/** What a command would change, as far as its words show, or null. A rule of thumb for plan mode, not a sandbox. */
export function changesProject(command: string): string | null {
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  for (const [re, what] of CHANGES) if (re.test(bare)) return what;
  return null;
}

/**
 * A message that states something meant to hold beyond this task: a rule ("这个项目别再用 lodash", "提交信息一律用中文"),
 * a preference "from now on", something to keep. Told only in the doc, the models saved the user's preferences but no
 * rule about the project in 18 runs of three (2026-11-05); "这次先别……" is about this task and is not one. 以后 counts at
 * the start of a sentence: after a number or a verb it means "after" ("充电到 80% 以后", "改完以后"), which every model
 * of a test was told to save as a rule (2026-11-06). "Always" and "never" count only opening a sentence, as an order
 * ("Always use pnpm here"): inside one they describe ("The first column is always the order date", "the log should
 * always show the line it failed on"), and 14 of 60 runs of coding tasks saved such a sentence as the user's rule
 * (2026-11-08). "Every project" is the user's own projects ("in all my projects"): an issue saying a check "is
 * repeated in every project" states no rule. Code blocks are left out.
 */
const STANDING = /(?:^|[，。！？、,.!?;:：\n])\s*(?:以后|今后|往后)|从现在起|从今天起|一律|一直都?要|每次都|别再|不要再|不许再|统一用|所有项目|每个项目|记住|记一下|记下来|\b(?:from now on|going forward|in (?:all|every) (?:of )?(?:my|our) projects?|remember (?:that|this))\b|(?:^|[.!?;:\n])\s*(?:always|never)\b(?!\s+mind\b)/i;

export function statesStandingRule(text: string): boolean {
  return STANDING.test(text.replace(/```[\s\S]*?(?:```|$)/g, ' '));
}

/** Words only code has: a path, `ticks`, a call, camelCase, snake_case. */
const CODE_WORD = /`[^`\n]+`|\b\w+\.(?:go|tsx?|jsx?|py|rs|java|cc?|cpp|h|rb|php|cs|swift|kt)\b|\b\w+\(\)|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b/;

/** A request that names something in the code, so looking it up ahead of the first step can save that step. */
export function namesCode(text: string): boolean {
  return CODE_WORD.test(text);
}

const ENGLISH_WORDS = new Set('the a an is are was were be been it its this that these those to of and or in on at for with from by as not no do does did can could should would will how what why when where which who if then there here please i you we my your our me us'.split(' '));

const wordSet = (list: string) => new Set(list.split(' '));

/**
 * Words frequent in one language written in Latin letters and rare in the others, with the letters only it uses:
 * each counts once. Words two of them share stay out ("de", "que", "la"), or the one with more of its own wins.
 */
const LATIN: [string, Set<string>, RegExp | null][] = [
  ['English', ENGLISH_WORDS, null],
  ['Spanish', wordSet('el los las del y es está están una unos por para con pero más qué cómo cuál dónde cuando porque muy hay este esta estos esto puedes puede quiero hacer tengo funciona también sin sobre ya'), /[ñ¿¡]/g],
  ['Portuguese', wordSet('não você vocês é são está estão um uma umas uns do da dos das ao aos em no na nos nas com para por mas mais isso esse essa este esta como quando porque muito tem ter fazer quero pode também sem já'), /[ãõ]/g],
  ['French', wordSet("le les des du et est sont une un dans pour pas sur ce cette ces il elle ils je vous nous avec au aux ne mais ou où comment pourquoi quand faire peut veux très aussi sans déjà qui c'est j'ai"), /[œ]/g],
  ['German', wordSet('der die das den dem des und ist sind nicht ein eine einen einem zu von mit sich auf für im es ich du sie wir wie was warum wann bitte kann können diese dieser dieses oder aber auch noch nur wenn dass ob wird werden habe hat'), /[ß]/g],
  ['Italian', wordSet('il lo gli della dello delle dei degli che è sono non per con questo questa questi come cosa perché anche ma nel nella mi ti ci puoi posso voglio fare molto già senza'), null],
  ['Dutch', wordSet('het een en van ik je niet dat op zijn met voor er maar om wat hoe waarom wanneer kun deze dit ook nog wel geen naar bij'), /ij/g],
  ['Turkish', wordSet('bir ve bu için ile değil var yok ama gibi daha çok nasıl neden lütfen şu olarak olan'), /[ğşı]/g],
  ['Indonesian', wordSet('yang dan di ke dari ini itu untuk dengan tidak ada saya kamu anda apa bagaimana kenapa mengapa bisa tolong juga atau sudah akan'), null],
  ['Polish', wordSet('się nie jest że jak co czy na do ale tak dla po przez jestem możesz proszę ten'), /[ąęłśźżń]/g],
  ['Vietnamese', wordSet('và của là có không được cho này một những các trong để với tôi bạn làm sao thì đã sẽ cũng'), /[ăđơư]/g],
];

/** The Latin-script language `s` is in and how sure (its marks), when one has two marks or more and more than any other. */
function latin(s: string): [string, number] | null {
  const lower = s.toLowerCase().replace(/’/g, "'");
  const found = lower.match(/\p{Script=Latin}+(?:'\p{Script=Latin}+)?/gu) ?? [];
  const scores = LATIN.map(([name, list, letters]): [string, number] => [name, found.filter((w) => list.has(w)).length + Math.min(2, letters ? (lower.match(letters)?.length ?? 0) : 0)]);
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] >= 2 && scores[0][1] > scores[1][1] ? scores[0] : null;
}

/**
 * The language of a script other than Latin when it outweighs the Latin words in `s`: Chinese, Japanese or Korean
 * (a Han character for a word), or an alphabet's words against Latin ones. Where several languages share an
 * alphabet, the letters only one of them uses tell it; Cyrillic without such letters is taken for Russian.
 */
function byScript(s: string): string | null {
  const count = (re: RegExp) => s.match(re)?.length ?? 0;
  const words = count(/\p{Script=Latin}+(?:'\p{Script=Latin}+)?/gu);
  const kana = count(/[぀-ヿ]/g);
  const han = count(/[一-鿿]/g);
  const hangul = count(/[가-힯]/g);
  if (kana >= 2 && kana + han >= words) return 'Japanese';
  if (hangul >= 2 && hangul >= words) return 'Korean';
  if (han && han >= words && (han >= 2 || !words)) return 'Chinese';
  const outweighs = (re: RegExp) => {
    const n = count(re);
    return n > 0 && n >= words;
  };
  if (outweighs(/\p{Script=Cyrillic}+/gu)) {
    if (/[іїєґ]/iu.test(s)) return 'Ukrainian';
    if (/[ђћџљњј]/iu.test(s)) return 'Serbian';
    if (/[ѓќѕ]/iu.test(s)) return 'Macedonian';
    if (/ъ/iu.test(s) && !/[ыэё]/iu.test(s)) return 'Bulgarian';
    return 'Russian';
  }
  if (outweighs(/\p{Script=Arabic}+/gu)) return /[پچژگ]/u.test(s) && !/[ٹڈڑںے]/u.test(s) ? 'Persian' : /[ٹڈڑںے]/u.test(s) ? 'Urdu' : 'Arabic';
  if (outweighs(/\p{Script=Greek}+/gu)) return 'Greek';
  if (outweighs(/\p{Script=Hebrew}+/gu)) return 'Hebrew';
  if (outweighs(/\p{Script=Thai}+/gu)) return 'Thai';
  if (outweighs(/\p{Script=Devanagari}+/gu)) return 'Hindi';
  if (outweighs(/\p{Script=Bengali}+/gu)) return 'Bengali';
  return null;
}

/**
 * The language a message is written in, with code, links and quotes left out; null when it cannot tell
 * ("continue", a bare path). The user's own words open or close a message, and what sits between is often pasted: a
 * Chinese question over an English log is Chinese, and an English task over an issue whose template is half Chinese
 * is English (any Han character made that one Chinese, and its report came back in Chinese, 2026-11-05). Otherwise
 * the script that outweighs the rest; in Latin letters, the language whose own words are most among them, read
 * first in the opening and closing lines. Only Chinese, Japanese, Korean and English were told apart before, so a
 * question in Spanish or Russian came with no language named, and under answer rules whose examples are Chinese.
 */
export function languageOf(text: string): string | null {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]|「[^」\n]*」|『[^』\n]*』/g, ' ');
  const lines = prose.split('\n').filter((l) => /\p{L}/u.test(l));
  const ends = [...new Set([lines[0], lines.at(-1)])].filter((l): l is string => !!l);
  for (const line of ends) {
    const lang = byScript(line);
    if (lang) return lang;
  }
  const whole = byScript(prose);
  if (whole) return whole;
  let best: [string, number] | null = null;
  for (const line of ends) {
    const found = latin(line);
    if (found && (!best || found[1] > best[1])) best = found;
  }
  return best?.[0] ?? latin(prose)?.[0] ?? null;
}

/** A check that exited 0 and still printed a failure: something after it ate the code (`; tail`, `|| true`). */
export function printsFailure(command: string, output: string): boolean {
  // Python scripts need not name a test runner; a following diff or echo can hide their exit code.
  // A standalone shell negation explicitly tests for failure. `|| true` merely discards it.
  const negativePython = /^\s*!\s*(?:python[\d.]*|py)\b[^\n;&|]*$/.test(command);
  return (isCheckCommand(command) && FAILED_RUN.test(output)) ||
    (runsSomething(command) && !negativePython && /^Traceback \(most recent call last\):\r?$/m.test(output));
}

/** A line that opens a plan, or a sentence that commits to a change. "Step" or "change" alone also fill explanations. */
const PLAN_WORDS = /^\W*(?:here(?:'s| is) (?:the |my )?|the |my |proposed )?(?:plan|steps|approach|implementation|changes?)\b|\bfiles? to change\b|\bI(?:'ll| will) (?:add|change|create|edit|fix|move|remove|rename|update|write)\b|^\W*(?:计划|方案|步骤|改动|实施)|我(?:将|会|打算|计划)(?:修改|新增|改|添加|重命名)/im;

/** An answer laid out as a plan: steps or sections about what will change. A short reply or an explanation is not one. */
export function looksLikePlan(text: string): boolean {
  const items = text.match(/^\s*(?:\d+[.)]|[-*]|#{1,4})\s+\S/gm)?.length ?? 0;
  return text.length > 200 && items >= 3 && PLAN_WORDS.test(text);
}
