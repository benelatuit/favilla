import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo } from '../catalog/catalog';
import type { FavillaConfig } from '../config/config';
import { DEFAULTS } from '../config/config';
import type { ShellInfo } from '../tools/shell';
import { appPath, assetsDir, projectSlug } from '../util/paths';
import { environmentSection, isCodeProject } from './env';
import { loadInstructions } from './instructions';
import { skillsSection, type Skill } from './skills';
import { readGlobalMemory, readMemory } from '../tools/memory';
import { scratchRules, sweepScratch } from '../store/scratch';
import { debug } from '../util/log';

const cache = new Map<string, string>();

export function promptAsset(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = fs.readFileSync(path.join(assetsDir(), 'prompts', `${name}.md`), 'utf8').trim();
    cache.set(name, text);
  }
  return text;
}

/** prompts/<name>.md, or null when there is none or the name could reach outside its folder. */
function optionalAsset(name: string): string | null {
  if (!/^[\w-]+(?:\/[\w-]+)?$/.test(name)) return null;
  try {
    return promptAsset(name);
  } catch {
    return null;
  }
}

/**
 * How Favilla writes to the user, the same for every model: the voice the user chose (prompts/voices/<voice>.md,
 * 'favilla' when unset or unknown), then what one family of models still gets wrong under it (prompts/style-<family>.md),
 * when that was measured.
 */
export function answerRules(family: string, voice?: string, format?: 'structured' | 'plain'): string {
  // The layout is a setting of its own, the same words and tone in either.
  const chosen = fill((voice && optionalAsset(`voices/${voice}`)) || promptAsset('voices/favilla'), { format: promptAsset(format === 'plain' ? 'answer-plain' : 'answer-structured') });
  const own = optionalAsset(`style-${family}`);
  return own ? `${chosen}\n\n${own}` : chosen;
}

const UI_PACKAGES =/"(react|react-dom|vue|svelte|solid-js|preact|lit|@angular\/core|next|nuxt|astro|@sveltejs\/kit|tailwindcss|electron|react-native|expo)"\s*:/;

/** The project has an interface: a front-end framework in package.json, or HTML at its root. */
export function hasInterface(cwd: string): boolean {
  try {
    if (UI_PACKAGES.test(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))) return true;
  } catch {
    /* no package.json */
  }
  try {
    return fs.readdirSync(cwd).some((f) => /\.(html|vue|svelte)$/i.test(f));
  } catch {
    return false;
  }
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

interface Direction {
  id: string;
  name: string;
  idea: string;
  composition: string;
  typography: string;
  colour: string;
  pitfalls: string;
  paletteTags: string[];
  typeClasses: string[];
}
interface Palette {
  id: string;
  name: string;
  tags: string[];
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  note?: string;
}
interface Faces {
  id: string;
  class: string;
  display: { family: string; source?: string; settings: string; css?: string };
  text: { family: string; settings: string };
}

const designLibrary = <T>(name: string): T[] => JSON.parse(fs.readFileSync(path.join(assetsDir(), 'design', `${name}.json`), 'utf8'));

/** The ground a model reaches for by itself: light, warm and hardly coloured. */
function isCream(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r > 225 && g > 215 && b > 190 && r >= g && g >= b && r - b > 6 && r - b < 45;
}

const HUE_FAMILIES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'pink', 'neutral'];

/** The family of a colour's hue, or neutral when it is hardly coloured. */
function hueFamily(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return 'neutral';
  let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  return h < 15 || h >= 345 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 195 ? 'cyan' : h < 250 ? 'blue' : 'pink';
}

/**
 * One art direction for new visual work, drawn at random from the library in assets/design, with a palette and faces. Told what not to do,
 * a model still lands on its one stock page; given a composition alone it came back cream and serif; offered three, it took the safest. So
 * nothing is left to choose. The palette's hue family is drawn first and evenly, because a quarter of the library's accents are green, and
 * the faces are Google Fonts ones, which load wherever the page is opened, where the library's rarer faces looked like a mistake.
 *
 * The palette comes from the kinds the direction names. Drawn from the whole library, a one-shape direction got a palette whose note
 * asked for sky and sand sections with white cards, the model built both, and left the measure's bars unmet "because the art direction
 * calls for these" (2026-11-08). The many-coloured palettes and the directions that are bands or boxes by construction left the library
 * on 2026-11-11: in a model's hands they were the clashing, striped, boxed pages a user named.
 */
export function dealDirections(seed: string): string {
  const pick = <T>(list: T[], key: string): T => list[parseInt(crypto.createHash('sha1').update(`${seed}:${key}`).digest('hex').slice(0, 8), 16) % list.length];
  const directions = designLibrary<Direction>('directions');
  const d = pick(directions, 'direction');
  const all = designLibrary<Palette>('palettes').filter((p) => !isCream(p.bg));
  const suited = all.filter((p) => p.tags.some((t) => d.paletteTags.includes(t)));
  const palettes = suited.length ? suited : all;
  const family = pick(HUE_FAMILIES, 'hue');
  const inFamily = palettes.filter((p) => hueFamily(p.accent) === family);
  const p = pick(inFamily.length ? inFamily : palettes, 'palette');
  const google = designLibrary<Faces>('type').filter((f) => f.display.source === 'google');
  const fitting = google.filter((f) => d.typeClasses.includes(f.class));
  const f = pick(fitting.length ? fitting : google, 'faces');
  const sheet = [
    `## ${d.name}`,
    `Composition: ${d.composition}`,
    `Type: ${d.typography}`,
    `Colour: ${d.colour}`,
    `Palette "${p.name}": ground ${p.bg}, surface ${p.surface}, ink ${p.ink}, muted ${p.muted}, accent ${p.accent} with ${p.accentInk} on it. ${p.note ?? ''}`.trim(),
    `Faces: ${f.display.family} (${f.display.settings}) for display, ${f.text.family} (${f.text.settings}) for text, from Google Fonts when network access is on; offline, put installed/system fallbacks of the same kind first without external <link> tags.`,
  ].join('\n');
  return fill(promptAsset('directions'), { directions: sheet });
}

interface AppStyle {
  id: string;
  name: string;
  theme: string;
  idea: string;
  colourBudget: string;
  signature: string;
  tokens: Record<string, unknown>;
  avoid: string[];
}

/**
 * Two styles for a screen people work in, drawn from the app library in assets/design. Left alone, a model builds one dashboard: a greeting,
 * icon tiles, a pulsing "online" dot. A style with its tokens (ground, ink, accent, sizes) gives it something exact to build instead.
 */
export function dealAppStyles(seed: string): string {
  const rank = (id: string) => crypto.createHash('sha1').update(`${seed}:${id}`).digest('hex');
  const drawn = [...designLibrary<AppStyle>('app')].sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, 2);
  const sheets = drawn.map((s) => {
    const { pills: _pills, ...cleanTokens } = s.tokens;
    return [`## ${s.name} (${s.theme})`, s.idea, `Signature: ${s.signature}`, `Tokens: ${JSON.stringify(cleanTokens)}`, `Avoid: ${s.avoid.slice(0, 4).join('; ')}`].join('\n');
  });
  return fill(promptAsset('app-styles'), { styles: sheets.join('\n\n') });
}

/**
 * The guide for work people look at; `shot` is the screenshot tool's name when there is one. A model that cannot see is
 * told to check by the browser's numbers: told to look, DeepSeek started Chrome by hand into a profile in the project and
 * cropped screenshots it could not see until its time ran out (2026-11-05).
 */
export function designGuide(shot?: string, vision = true): string {
  // With a browser there is the paint tool too. It is one means among several: a user's choice or a diagram's needs come first.
  const paint = shot
    ? ' Match each visual to its medium (user requests come first): UI icons use the project\'s icon set or crisp inline SVG, never paint and never emoji; charts, diagrams, logos and editable/animated graphics use CSS, SVG or canvas; photos use real project assets (never guessed URLs or painted stand-ins); asked-for illustrations, scenes, characters and repeating surface tiles (tile: true) use paint; background removal/cutouts use paint with cut in one call.'
    : '';
  const look = shot ? `with ${shot}` : 'in a browser';
  // Both widths in one call: told to look a screen at a time, models spent twenty requests a page on looking.
  const whole = shot ? ' in one dual-width pass (check_widths: true checks 1280×800 and 390×844 together; use full_page only when inspecting below-fold sections)' : ' at 1280×800 and 390×844';
  // The measuring is the browser tool's: without one the sentence would send the model to a tool it does not have.
  const measure = shot ? promptAsset('design-measure') : '';
  return fill(promptAsset('design'), { check: fill(promptAsset(vision ? 'design-look' : 'design-look-blind'), { look, whole, measure }), paint });
}

const NAMES = {
  claude: { ask: 'AskUserQuestion', todo: 'TodoWrite', exit_plan: 'ExitPlanMode', task: 'Task', read: 'Read', fetch: 'WebFetch', search: 'WebSearch', shot: 'browser', goal: 'criteria', check: 'check', review: 'review', brief: 'brief', remember: 'remember', recall: 'recall' },
  codex: { ask: 'request_user_input', todo: 'update_plan', exit_plan: 'exit_plan_mode', task: 'run_subagent', read: 'read_file', fetch: 'web_fetch', search: 'web_search', shot: 'browser', goal: 'criteria', check: 'check', review: 'review', brief: 'brief', remember: 'remember', recall: 'recall' },
  favilla: { ask: 'ask', todo: 'plan', exit_plan: 'present_plan', task: 'agent', read: 'read', fetch: 'web_fetch', search: 'web_search', shot: 'browser', goal: 'criteria', check: 'check', review: 'review', brief: 'brief', remember: 'remember', recall: 'recall' },
};

/**
 * A prompt's lines that hold only with a tool there or not: "[paint] …" when the session has paint, "[!browser] …"
 * when it has no browser. With no browser found the prompt still sent pages to the browser and pictures to paint, and
 * attempts, which needs git, was offered in every folder (2026-11-06). Without a tool list every line holds but the
 * negated ones.
 */
export function forTools(text: string, tools?: string[]): string {
  return text
    .split('\n')
    .flatMap((line) => {
      const m = /^\[(!?)([\w-]+)\] /.exec(line);
      if (!m) return [line];
      const has = !tools || tools.includes(m[2]);
      return (m[1] ? !has : has) ? [line.slice(m[0].length)] : [];
    })
    .join('\n');
}

/**
 * A prompt's lines that hold only for a model that sees pictures ("[vision] …"). A model without vision gets every
 * picture a tool returns left out, with a line saying so, so a rule on how to judge one is nothing to it.
 */
export function forVision(text: string, vision: boolean): string {
  return text
    .split('\n')
    .flatMap((line) => (line.startsWith('[vision] ') ? (vision ? [line.slice('[vision] '.length)] : []) : [line]))
    .join('\n');
}

export interface SystemPromptOptions {
  cwd: string;
  model: ModelInfo;
  shell: ShellInfo;
  config: FavillaConfig;
  role: 'main' | 'explore' | 'general';
  autonomous: boolean;
  /** hosted: the provider's own web_search tool; client: Favilla's search tool; off: none. */
  search?: 'hosted' | 'client' | 'off';
  screenshot?: boolean;
  /** Tools the session lists in short until load_tools, with a line on each. */
  deferred?: { name: string; line: string }[];
  /** The names of the session's tools, for lines that hold only when a tool is there ([paint] in tools-*.md). */
  tools?: string[];
  skills?: Skill[];
  /** The system prompts of the session's preset, rendered. */
  preset?: { name: string; text: string };
  /** Who the user wants the agent to be (prompt/persona.ts). */
  persona?: { name: string; text: string };
}

/**
 * Built once per session and then frozen: an unchanged prefix keeps provider caches warm
 * (and keeps Claude's thinking signatures valid). Everything that changes later is appended
 * to the conversation instead.
 */
/**
 * Project files a note names (in backticks, or a bare path with a folder and an extension) that are not there now.
 * Only paths inside the project are judged; commands, URLs and names without a folder are left alone.
 */
export function missingFiles(note: string, cwd: string): string[] {
  const named = new Set<string>();
  for (const m of note.matchAll(/`([^`\s]+)`/g)) named.add(m[1]);
  for (const m of note.matchAll(/(?:^|[\s(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,6})(?=[\s),.;:]|$)/gi)) named.add(m[1]);
  return [...named].filter((p) => {
    if (/^[a-z]+:\/\//i.test(p) || !/\.[a-z0-9]{1,6}$/i.test(p) || !/[\\/]/.test(p) || path.isAbsolute(p)) return false;
    const abs = path.resolve(cwd, p);
    return abs.startsWith(path.resolve(cwd)) && !fs.existsSync(abs);
  });
}

/**
 * The project's scratch folder, outside it, for one-off scripts, probes, logs and downloads: the same path for
 * every session of the project (so the prompt stays the same). It is swept once a day in the background (see
 * `sweepScratch`), so copies of whole repositories left there do not pile up into gigabytes.
 */
export function scratchDir(cwd: string): string {
  const dir = appPath('projects', projectSlug(cwd), 'scratch');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = path.join(dir, '..', '.scratch-swept');
    let last = 0;
    try {
      last = fs.statSync(stamp).mtimeMs;
    } catch {
      /* never swept */
    }
    if (Date.now() - last > 24 * 3600_000) {
      fs.writeFileSync(stamp, String(Date.now()));
      void sweepScratch(dir, scratchRules()).catch((e) => debug('scratch', 'sweep failed', String(e)));
    }
  } catch {
    // A folder that cannot be made or cleaned is still the place to put scratch files.
  }
  return dir;
}

export async function buildSystemPrompt(o: SystemPromptOptions): Promise<string> {
  const names = NAMES[o.model.toolProfile];
  // Lines for the tools a session has only sometimes: web search and screenshots.
  const extra: string[] = [];
  if (o.search && o.search !== 'off') {
    const search = o.search === 'hosted' ? 'web_search' : names.search;
    // What to search for and how the results come back is the tool's own description; here only what holds for every
    // answer built on a search. Searches written from the model's training year found what was current a year before
    // (a user, 2026-11-02: "老是喜欢搜半年前一年前的问题，有些资料是需要新鲜度的").
    const read = o.search === 'hosted' ? 'read the best result before relying on it' : `read a page in full with ${names.fetch} when its quoted lines do not settle it`;
    extra.push(
      `- Search the web with ${search} for what may have changed since your training or what you are not sure of; ${read}. Prefer primary sources: the official or maker's site, the original document, the project's own repository and issues. Say where a looked-up fact comes from and its date, and link it when the user will want to check. Search what changes over time (versions, prices, releases, news, rankings, models) as of today's date: put the current year, or the month, in the query and prefer what was published in the last months; when the newest you find is old, say so.`,
    );
  }
  // Held-back tools are named here and loaded when a task needs them, so their long definitions are not in every request.
  // The tool list carries each one's line; here only the names, so nothing is said twice.
  if (o.deferred?.length) extra.push(`- Some tools in your list are in short: one line and the names of their parameters. Call one directly when you can fill its parameters from their names, and its full instructions come with its first result; otherwise read them first with load_tools. Tools whose instructions came with a message are loaded already. In short now: ${o.deferred.map((d) => d.name).join(', ')}.`);
  if (o.screenshot) extra.push(`- After you build or change a web page or interface, verify it with ${names.shot} (check_widths: true checks 1280×800 and 390×844 in one call), exercise its controls, fix all issues in one pass, and stop once clean.`);
  const tools = [fill(forTools(promptAsset(`tools-${o.model.toolProfile}`), o.tools), names), ...extra].join('\n');
  const sections: string[] = [];
  if (o.role === 'main') {
    // The engineering standards go to folders of code; elsewhere they come as a note with the first code file written
    // (Session), so a folder of documents does not carry 1.3k tokens of them in every request. How documents, sheets
    // and data are made goes the other way: a folder of code gets it as a note when a request or a file calls for it.
    const code = isCodeProject(o.cwd);
    const engineering = code ? promptAsset('engineering') : '';
    const documents = code ? '' : `${promptAsset('documents')}\n\n${promptAsset('writing-docs')}`;
    // The rule on judging pictures only for a model that sees them: others are told a picture was left out.
    const base = forVision(promptAsset('base'), o.model.vision);
    sections.push(fill(base, { ...names, tools, engineering, documents }).replace(/\n{3,}/g, '\n\n'));
  } else {
    sections.push(promptAsset(o.role === 'explore' ? 'agent-explore' : 'agent-general'));
    // Sub-agents do not delegate: the line on when a sub-agent pays is left out of theirs.
    sections.push(tools.replace(/^- You wait for (?:an agent|a Task sub-agent|a run_subagent).*$/m, '').replace(/\n{2,}/g, '\n'));
  }
  const small = o.model.contextWindow <= 65_536;
  if (small) sections.push(fill(promptAsset('family-open'), { window: o.model.contextWindow.toLocaleString('en-US') }));
  if (o.role !== 'explore' && hasInterface(o.cwd)) sections.push(designGuide(o.screenshot ? names.shot : undefined, o.model.vision));
  if (o.autonomous && o.role === 'main') sections.push(promptAsset('autonomous'));
  if (o.config.systemAppend?.trim()) sections.push(o.config.systemAppend.trim());
  if (o.skills?.length && o.role !== 'explore') {
    // Small windows get only the project's own skills: every listed skill is a line in every request.
    const skills = small ? o.skills.filter((s) => s.project) : o.skills;
    if (skills.length) sections.push(skillsSection(skills, names.read));
  }
  // How answers are written, after the defaults and as the user's own: DeepSeek kept to the same rules far better there
  // than among the defaults above (answers a third shorter, its columnist's tics and hedges mostly gone, 2026-11-04).
  // One voice for every model, so answers read alike whichever model writes them. The user's project files below win.
  if (o.role === 'main') sections.push(`# The user's instructions: how to write answers\nThe user wrote these and holds you to them. They take precedence over everything above. Only a project instruction file below that says otherwise wins.\n\n${answerRules(o.model.family, o.config.voice, o.config.answerFormat)}`);
  // Who to be, after how to write: the character's way of talking wins over the voice, and nothing about the work.
  if (o.role === 'main' && o.persona?.text)
    sections.push(
      `# Who you are: ${o.persona.name}\nThe user picked this character for you. Be ${o.persona.name} in how you talk and in your temper while you work. Where the character's way of talking differs from the rules on how to write answers above, the character's way wins. What you do with the user's files and tools, the truth of what you report, and the rules on safety and on when to ask stay as they are.\n\n${o.persona.text}`,
    );
  const maxChars = Math.min(60_000, Math.floor(o.model.contextWindow * 0.08 * 3.5));
  const files = loadInstructions(o.cwd, o.config.instructions ?? DEFAULTS.instructions, maxChars);
  if (files.length) {
    sections.push(
      `# Project instructions\nThe user's instruction files. They take precedence over the defaults above.\n\n${files.map((f) => `## ${f.path}\n${f.content}`).join('\n\n')}`,
    );
  }
  // What earlier sessions anywhere learnt about the user (their preferences, name, setup), saved with the remember
  // tool for every project.
  const about = o.role === 'explore' ? [] : readGlobalMemory();
  if (about.length) sections.push(`# Notes about the user, from earlier sessions in any project\nSaved with ${names.remember} (scope global); when one turns out wrong or outdated, replace it.\n${about.map((n) => `- ${n}`).join('\n')}`);
  // What earlier sessions here learnt about the project, saved with the remember tool; a note that names a file
  // which is gone says so, so it is checked before it is followed.
  const notes = o.role === 'explore' ? [] : readMemory(o.cwd);
  if (notes.length) {
    const lines = notes.map((n) => {
      const gone = missingFiles(n, o.cwd);
      return gone.length ? `- ${n} (Favilla: ${gone.map((g) => `\`${g}\``).join(', ')} no longer ${gone.length > 1 ? 'exist' : 'exists'}; check this note before relying on it.)` : `- ${n}`;
    });
    sections.push(`# Notes from earlier sessions in this project\nSaved with ${names.remember} (scope project); when one turns out wrong, replace it.\n${lines.join('\n')}`);
  }
  if (o.preset?.text) sections.push(`# Preset: ${o.preset.name}\nThe user's own prompts. They take precedence over the defaults above.\n\n${o.preset.text}`);
  // The machine's facts last, and the folder's (folder, scratch folder, git, files) not here but with the first message
  // (env.ts projectFacts), so the prompt is the same text in every session of a project and, but for the project's own
  // files and notes, in every project: a provider caches a prompt up to its first difference. With the scratch path
  // among the rules and the environment before the answer rules, a new session found 3.2k of about 11k tokens cached,
  // or none (38 and 22 of 60 runs on gpt-6-luna, 2026-11-08), where Codex keeps all of its instructions the same
  // in every session.
  sections.push(await environmentSection({ shell: o.shell, modelName: `${o.model.name} (${o.model.ref})`, contextWindow: o.model.contextWindow }));
  return sections.join('\n\n');
}
