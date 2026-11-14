/**
 * Fills the interface's other languages from its Chinese tables, by asking a model.
 *
 *   pnpm exec tsx scripts/translate-ui.mts [--lang ja,de] [--model provider/model] [--parallel 2] [--check]
 *
 * Three tables hold the Chinese: the engine's words (core/src/i18n.ts with the backstop's in guard/i18n.ts), the
 * window's (web/src/lib/i18n.ts) and the terminal's (cli/src/tui/i18n.ts). Each language gets a file beside each,
 * in a locales folder, keyed by the same English text. What a file already holds is kept, so a line corrected by
 * hand stays; a key the Chinese no longer has is dropped. --check asks no model: it only says what is missing and
 * drops what is stale.
 *
 * The model sees the English (what the text says) with the shipped Chinese (what it means where it is shown: "Share"
 * is a proportion in the usage table, not a button). The short labels go first; their translations are then given
 * with every later request, so a sentence uses the same word for a session or a folder as the label does. Every
 * answer is checked (each placeholder, flag, command and file name kept, no Han characters where the language has
 * none, no Simplified forms in Traditional Chinese); what fails is asked once more on its own, and what fails again
 * is left out, so the interface shows it in English and the next run asks again.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Catalog, fitEffort, loadConfig } from '../packages/core/src/index';
import { adapterFor } from '../packages/core/src/providers/index';
import { catastropheZh } from '../packages/core/src/guard/i18n';
import { LANGUAGE_NAMES, LANGUAGES, sharedZh, type Language } from '../packages/core/src/i18n';
import { translationProblem as problem } from '../packages/core/src/i18n-check';

const ROOT = path.resolve(import.meta.dirname, '..');
const { values: opts } = parseArgs({
  options: {
    lang: { type: 'string' },
    model: { type: 'string', default: 'deepseek/deepseek-v4.1-flash' },
    parallel: { type: 'string', default: '2' },
    check: { type: 'boolean', default: false },
  },
});

type Table = Record<string, string>;

/** An object literal of string keys and values, as the tables are written: comments and spreads allowed. */
function literal(file: string, opening: string): Table {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const i = s.indexOf(opening);
  if (i < 0 || s.startsWith('};', i + opening.length)) return {};
  const j = s.indexOf('\n};', i);
  const body = s
    .slice(i + opening.length, j)
    .split('\n')
    .filter((l) => !/^\s*\.\.\.\w+,\s*$/.test(l))
    .join('\n');
  return vm.runInNewContext(`({${body}\n})`, Object.create(null), { timeout: 2000 }) as Table;
}

const coreZh: Table = { ...catastropheZh, ...sharedZh };

/** A front end's own words: its table less what it takes unchanged from the engine's. */
function own(file: string): Table {
  const all = literal(file, 'export const zh: Record<string, string> = {');
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => coreZh[k] !== v));
}

const SURFACES = [
  { id: 'core', dir: 'packages/core/src/locales', zh: coreZh, what: "the engine's words, shown in both the window and the terminal" },
  { id: 'web', dir: 'packages/web/src/locales', zh: own('packages/web/src/lib/i18n.ts'), what: 'the window' },
  { id: 'cli', dir: 'packages/cli/src/tui/locales', zh: own('packages/cli/src/tui/i18n.ts'), what: 'the terminal' },
];

const OPENING = 'const words: Record<string, string> = {';
const target = (dir: string, lang: Language) => path.join(dir, `${lang}.ts`);

function write(dir: string, lang: Language, source: Table, words: Table): void {
  const lines = Object.keys(source)
    .filter((k) => words[k] !== undefined)
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(words[k])},`);
  const text = [
    `// ${LANGUAGE_NAMES[lang]}, by the English text. Filled from the Chinese by scripts/translate-ui.mts, which keeps`,
    '// what is here: a line corrected by hand stays.',
    OPENING,
    ...lines,
    '};',
    'export default words;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, target(dir, lang)), text);
}

// ---------------------------------------------------------------------------------------------- the model

const STYLE: Record<Language, string> = {
  en: '',
  'zh-CN': '',
  'zh-TW':
    'Traditional Chinese as written in Taiwan, with Taiwan’s own software words: 檔案, 資料夾, 設定, 程式, 伺服器, 預設, 網路, 訊息, 視窗, 介面, 連結, 搜尋, 登入, 帳號, 執行, 儲存, 複製, 貼上, 顯示, 選取, 回覆. Keep in English what the Simplified Chinese keeps in English (Agent, Prompt, Preset, Skills, token, commit, diff, fork, shell, MCP, API, CLI), with a space between an English word and Chinese. No full-width semicolon and no bracketed aside, as in the Simplified Chinese.',
  ja: 'Japanese as in well-localized software (macOS, Windows, VS Code): です・ます for sentences, short noun phrases for buttons and labels. Katakana for the terms Japanese developers write in katakana (エージェント, セッション, モデル, フォルダー, プロバイダー, トークン, コミット); keep MCP, API, CLI, Skills in English.',
  ko: 'Korean as in well-localized software: 합니다/하세요 for sentences, short noun phrases for buttons and labels. Use the words Korean developers use (에이전트, 세션, 모델, 폴더, 토큰, 커밋); keep MCP, API, CLI, Skills in English.',
  es: 'Spanish for all Spanish speakers, as in well-localized software: tú, sentence case, short labels. Use the words Spanish-speaking developers use (agente, sesión, modelo, carpeta, proveedor, token, commit).',
  'pt-BR': 'Brazilian Portuguese as in well-localized software: você, sentence case, short labels. Use the words Brazilian developers use (agente, sessão, modelo, pasta, provedor, token, commit).',
  fr: 'French as in well-localized software: vous, sentence case, short labels, French typography (a space before : ; ? ! and inside « »). Use the words French developers use (agent, session, modèle, dossier, fournisseur, jeton or token as the context needs, commit).',
  de: 'German as in well-localized software: Sie, nouns capitalized, compact labels. Use the words German developers use (Agent, Sitzung, Modell, Ordner, Anbieter, Token, Commit).',
  ru: 'Russian as in well-localized software: вы in lower case, short labels, «ёлочки» quotes. Use the words Russian developers use (агент, сеанс, модель, папка, провайдер, токен, коммит). For counts write a form that reads right with any number, such as «Файлов: {n}».',
};

function system(lang: Language, glossary: Table): string {
  const terms = Object.entries(glossary);
  return [
    `You translate the interface of Favilla, a desktop and terminal app in which an AI agent works on a user's code and files, into ${LANGUAGE_NAMES[lang]} (${lang}).`,
    '',
    'Each item has the English (the source: what the text says) and the Simplified Chinese already shipped (what it means where it is shown; follow its sense where the English alone could mean two things, but translate from the English).',
    '',
    'How to write:',
    '- Plain, standard software wording that anyone reads at a glance, as the operating system and well-known apps say it in this language. No crafted turn of phrase, no marketing tone, no exclamation marks.',
    '- As short as the English allows: buttons, tabs, menu items and labels stay short.',
    `- ${STYLE[lang]}`,
    '- Never translate names: Favilla, SillyTavern, ChatGPT, Codex, Gmail, Chrome, Edge, GitHub, Windows, the names of models and providers, the effort levels (off, minimal, low, medium, high, xhigh, max, ultra), the themes (Drafting, Night shift, Kiln, Kiln at night, Porcelain, Plain), shadow tests.',
    '- Keep exactly as written: every {placeholder}, commands and flags (/preset, --global), file names and paths, keys and shortcuts (Ctrl+K, Shift+Tab, enter, esc), symbols (· → ↵ …) and anything in backticks. A placeholder may move to where the sentence needs it.',
    '- Words in capitals that stand for something the user types (FILE, NAME) may be translated, as the Chinese does.',
    '- When the English comes as a pair for one and for many ("{n} file", "{n} files"), translate each so it reads right.',
    ...(terms.length
      ? ['', 'These labels are already translated. Use the same words for the same things:', ...terms.map(([en, t]) => `${en} => ${t}`)]
      : []),
    '',
    'Answer with one JSON object and nothing else: each item id mapped to its translation.',
  ].join('\n');
}

const cfg = loadConfig();
const catalog = new Catalog(cfg);
const model = catalog.resolve(opts.model);
const provider = catalog.provider(opts.model!.split('/')[0]);

async function ask(sys: string, items: { id: string; en: string; zh: string; note?: string }[]): Promise<Record<string, unknown>> {
  const call = {
    model,
    provider,
    system: sys,
    tools: [],
    messages: [{ id: randomUUID(), role: 'user' as const, origin: 'user' as const, time: Date.now(), parts: [{ type: 'text' as const, text: JSON.stringify(items, null, 1) }] }],
    effort: fitEffort(model, 'off'),
    maxOutputTokens: 24_000,
    sessionId: 'translate-ui',
    turnId: randomUUID(),
    turnStart: 0,
    signal: AbortSignal.timeout(15 * 60_000),
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await adapterFor(provider.api).stream(call, () => {});
      const text = res.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      const a = text.indexOf('{');
      const b = text.lastIndexOf('}');
      if (a < 0 || b < a) throw new Error(`no JSON in the answer (${res.stop})`);
      return JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error(`  retrying after: ${(e as Error).message.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------------------------- one language

const words = (en: string) => en.split(/\s+/).filter(Boolean).length;
const isLabel = (en: string) => words(en) <= 4 && !/[.:?]$/.test(en);

async function language(lang: Language): Promise<void> {
  const have = SURFACES.map((s) => {
    const file = path.join(ROOT, target(s.dir, lang));
    const old = fs.existsSync(file) ? literal(target(s.dir, lang), OPENING) : {};
    const kept = Object.fromEntries(Object.entries(old).filter(([k]) => s.zh[k] !== undefined));
    const stale = Object.keys(old).length - Object.keys(kept).length;
    return { ...s, words: kept, stale };
  });
  // One translation per English text, whichever tables hold it; each table keeps its own Chinese as the hint.
  const todo = new Map<string, Set<string>>();
  for (const s of have) for (const [en, zh] of Object.entries(s.zh)) if (s.words[en] === undefined) (todo.get(en) ?? todo.set(en, new Set()).get(en)!).add(zh);
  const save = () => {
    for (const s of have) write(s.dir, lang, s.zh, s.words);
  };
  const missing = todo.size;
  console.log(`${lang}: ${missing} to translate, ${have.reduce((n, s) => n + s.stale, 0)} stale dropped`);
  if (opts.check || !missing) return save();

  const done = new Map<string, string>();
  const glossary: Table = {};
  for (const s of have) for (const [en, t] of Object.entries(s.words)) if (isLabel(en)) glossary[en] = t;
  const entries = [...todo.entries()].map(([en, zh], i) => ({ id: String(i + 1), en, zh: [...zh].join(' / ') }));
  const labels = entries.filter((e) => isLabel(e.en));
  const sentences = entries.filter((e) => !isLabel(e.en));

  async function batch(items: typeof entries, gloss: Table): Promise<typeof entries> {
    const answer = await ask(system(lang, gloss), items);
    const failed: (typeof entries[number] & { note?: string })[] = [];
    for (const it of items) {
      const why = problem(lang, it.en, answer[it.id]);
      if (why) failed.push({ ...it, note: why });
      else done.set(it.en, String(answer[it.id]).trim());
    }
    for (const s of have) for (const en of Object.keys(s.zh)) if (s.words[en] === undefined && done.has(en)) s.words[en] = done.get(en)!;
    save();
    return failed;
  }

  const failed: typeof entries = [];
  const chunks = (list: typeof entries, n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
  for (const c of chunks(labels, 120)) failed.push(...(await batch(c, glossary)));
  for (const en of labels.map((l) => l.en)) if (done.has(en)) glossary[en] = done.get(en)!;
  for (const c of chunks(sentences, 70)) failed.push(...(await batch(c, glossary)));
  const left: typeof entries = [];
  for (const c of chunks(failed, 30)) left.push(...(await batch(c, glossary)));
  console.log(`${lang}: ${done.size} translated, ${left.length} left in English`);
  for (const l of left.slice(0, 12)) console.log(`  ${lang} left: ${(l as { note?: string }).note} :: ${l.en.slice(0, 80)}`);
}

const langs = (opts.lang ? opts.lang.split(',') : LANGUAGES.filter((l) => l !== 'en' && l !== 'zh-CN')) as Language[];
for (const l of langs) if (!LANGUAGES.includes(l) || l === 'en' || l === 'zh-CN') throw new Error(`Not a language to fill: ${l}`);
console.log(`sources: ${SURFACES.map((s) => `${s.id} ${Object.keys(s.zh).length}`).join(', ')}; model ${opts.model}`);
const queue = [...langs];
await Promise.all(
  Array.from({ length: Math.max(1, Number(opts.parallel)) }, async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      try {
        await language(l);
      } catch (e) {
        console.error(`${l}: stopped: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }),
);
