import type { ToolProfileName } from '../config/config';
import type { Question, Todo } from '../types';
import { readTool, writeTool, editTool, patchTool } from './fs-tools';
import { shellTool, jobTool } from './shell-tools';
import { grepTool, globTool } from './search-tools';
import { todoTool, taskTool, askTool, planTool , attemptsTool } from './agent-tools';
import { goalTool } from './goal';
import { checkTool, type CheckName } from './check';
import { paintTool } from './paint';
import { watchTool } from './watch';
import { musicTool } from './music';
import { filmTool } from './film';
import { reviewTool } from './review';
import { briefTool } from './brief';
import { loadToolsTool } from './load';
import { rememberTool } from './memory';
import { recallTool } from './recall';
import { webFetchTool } from './web';
import { webSearchTool } from './websearch';
import { DESKTOP_ACTIONS, desktopTool } from './desktop';
import { symbolsTool } from './symbols';
import { ACTION_KEYS, browserTool } from './browser';
import { readManyTool, searchTool } from './favilla-tools';
import { notebookEditTool } from './notebook';
import { MAIL_ACTIONS, mailTool } from './mail';
import type { ShellInfo } from './shell';
import { bool, num, str, ToolInputError, type ToolBinding } from './types';
import { withExtensionTools } from '../extensions/registry';

/**
 * Three tool surfaces over shared implementations: Favilla's own (the default for every family), Claude-style
 * (Read/Edit/Bash/Grep/TodoWrite, which tools: 'auto' gives Claude, DeepSeek, GLM and open models) and Codex-style
 * (shell_command, a freeform apply_patch, update_plan; 'auto' gives GPT).
 */
export interface ProfileContext {
  shell: ShellInfo;
  cwd: string;
  timeoutMs: number;
  vision: boolean;
  /** main: full set; explore: read-only research sub-agent; general: sub-agent that may edit. */
  role: 'main' | 'explore' | 'general';
  /** hosted: the provider searches (no tool here); client: Favilla's own search tool; off: none. */
  search: 'hosted' | 'client' | 'off';
  /** A headless browser was found (the browser and paint tools need one). */
  screenshot: boolean;
  /** The folder is in a git repository: attempts works in worktrees and is offered only then. */
  git?: boolean;
  /** The folder holds code (a project marker or code files): symbols is offered only then. */
  code?: boolean;
  /** The project has Jupyter notebooks: only then is the notebook tool offered. */
  notebooks?: boolean;
  /** The user turned computer control on (main agent only). */
  computer?: boolean;
  /** The user's mail accounts (addresses), when any is set up: then the mail tool is offered. */
  mail?: string[];
}

/**
 * The file a favilla-surface edit or write is for: path, file_path from the Claude habit, or paths with one entry from
 * read's habit. 7 of the 10 edits without a path in the evals sent paths, and were told file_path was missing, a key
 * the schema does not have (2026-11-06).
 */
function targetPath(a: Record<string, unknown>): string {
  const p = str(a, 'path', false) ?? str(a, 'file_path', false);
  if (p) return p;
  if (Array.isArray(a.paths) && a.paths.length === 1 && typeof a.paths[0] === 'string' && a.paths[0]) return a.paths[0];
  throw new ToolInputError('Missing required parameter "path".');
}

const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

/** Four numbers or nothing: an image region. */
const nums = (v: unknown): number[] | undefined => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(String(x))) ? v.map(Number) : undefined);
/** Search and fetch parameters, the same on every surface. */
const SEARCH_PROPS = {
  query: { type: 'string' },
  allowed_domains: { type: 'array', items: { type: 'string' } },
  blocked_domains: { type: 'array', items: { type: 'string' } },
  read: { type: 'number', description: 'How many top results to open, quoting what each says on the query (0-5, default 3; 0 for links only).' },
  recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from the last day, week, month or year.' },
};
const searchArgs = (a: Record<string, unknown>) => {
  const recency = str(a, 'recency', false);
  return { query: str(a, 'query')!, allowed: strs(a.allowed_domains), blocked: strs(a.blocked_domains), read: num(a, 'read'), recency: recency === 'day' || recency === 'week' || recency === 'month' || recency === 'year' ? recency : undefined };
};
const FETCH_PROPS = {
  url: { type: 'string' },
  prompt: { type: 'string', description: 'What to find on the page: only that comes back.' },
  start: { type: 'number', description: "Character offset to read from: a long page's later part, or a section its outline lists." },
};
const fetchArgs = (a: Record<string, unknown>) => ({ url: str(a, 'url')!, prompt: str(a, 'prompt', false), start: num(a, 'start') });
/** A sub-agent's model and effort, the same on every surface: the user may ask for a cheaper or stronger one. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * The models by provider, every provider named: a flat list cut at the first dozen showed only the first two
 * providers' models, and an agent asked for DeepSeek guessed a provider name that does not exist. A name that matches
 * no model gets this list back (Session.subagentModel), so it is not in every request: there it was 1k characters,
 * with a thousand more of one provider cut off (2026-11-07).
 */
export function modelsByProvider(refs: string[], perProvider = 8): string {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const cut = ref.indexOf('/');
    if (cut <= 0) continue;
    const p = ref.slice(0, cut);
    groups.set(p, [...(groups.get(p) ?? []), ref.slice(cut + 1)]);
  }
  return [...groups]
    .map(([p, ids]) => `${ids.slice(0, perProvider).map((id) => `${p}/${id}`).join(', ')}${ids.length > perProvider ? ` (+${ids.length - perProvider} more of ${p})` : ''}`)
    .join('; ');
}

function agentProps(): Record<string, unknown> {
  return {
    model: { type: 'string', description: "Only when the user asks for a particular model, or for a cheaper or stronger one for this job: provider/model, or the model's id; a name no provider has returns the models there are. Default: the session's sub-agent model." },
    effort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort for this sub-agent, when the user asks for one or the job clearly needs more or less thought.' },
    background: {
      type: 'boolean',
      description:
        'Run it in the background and go on with other work: the call returns at once and its report arrives as a message when it is done. For a part your next steps do not need. A general one in the background must name its files, which stay its own until it reports; do not do the same work yourself meanwhile.',
    },
  };
}
const agentChoice = (a: Record<string, unknown>) => {
  const effort = str(a, 'effort', false);
  return { model: str(a, 'model', false), effort: effort && EFFORTS.includes(effort) ? effort : undefined, background: a.background === true || a.background === 'true' ? true : undefined };
};
const DESCRIBE = { type: 'string', description: 'What the command does in a few words, in the language the user writes in; shown to the user beside the command.' };
/** Goal criteria a run proves. The session reads them from the call itself and marks them met only if the run passes. */
const PLAN_STEPS = { type: 'array', items: { type: 'string' }, description: 'The pieces of work in order, each something that can be seen to be done. On approval they become the progress the user follows.' };
const MEETS = { type: 'array', items: { type: 'integer' }, description: 'Numbers of your criteria this run proves; they are marked met if it passes and stay open if it fails.' };
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : typeof v === 'string' && v.trim() ? [v] : undefined);

/** One cell of a Jupyter notebook: Claude Code's names and parameters on the claude surface, plain ones elsewhere. */
function notebookBinding(style: 'claude' | 'plain'): ToolBinding {
  const k = style === 'claude' ? { path: 'notebook_path', cell: 'cell_id', source: 'new_source', mode: 'edit_mode' } : { path: 'path', cell: 'cell', source: 'source', mode: 'mode' };
  return {
    def: notebookEditTool,
    spec: {
      name: style === 'claude' ? 'NotebookEdit' : 'notebook_edit',
      description: `Edits one cell of a Jupyter notebook (.ipynb): replace its source, insert a new cell after it (first when no cell is given), or delete it. A replaced code cell loses its old outputs. ${k.cell} is the cell's id or the number shown when the notebook is read.`,
      parameters: obj(
        {
          [k.path]: { type: 'string' },
          [k.cell]: { type: 'string', description: 'Cell id or 1-based number.' },
          [k.source]: { type: 'string', description: 'The new source of the cell.' },
          cell_type: { type: 'string', enum: ['code', 'markdown'] },
          [k.mode]: { type: 'string', enum: ['replace', 'insert', 'delete'] },
        },
        [k.path],
      ),
    },
    normalize: (a) => {
      const mode = str(a, k.mode, false) ?? str(a, 'mode', false);
      const type = str(a, 'cell_type', false);
      const cell = a[k.cell] ?? a.cell ?? a.cell_id;
      const source = a[k.source] ?? a.source ?? a.new_source;
      return {
        path: str(a, k.path, false) ?? str(a, 'path', false) ?? str(a, 'notebook_path'),
        cell: cell === undefined || cell === null ? undefined : String(cell),
        source: typeof source === 'string' ? source : '',
        cellType: type === 'markdown' ? 'markdown' : type === 'code' ? 'code' : undefined,
        mode: mode === 'insert' || mode === 'delete' ? mode : 'replace',
      };
    },
  };
}

const CHECKS = ['types', 'lint', 'test', 'build'];

/** The project's own checks in one call, on every surface (no model was trained on a tool like it). */
function checkBinding(): ToolBinding {
  return {
    def: checkTool,
    spec: {
      name: 'check',
      description:
        "Runs the project's own type check, lint and tests (build when asked) from package.json, pyproject.toml, go.mod, Cargo.toml or a Makefile; returns failures as file:line messages and failing tests. only: some checks; path: a package of a monorepo; filter: tests by name; related: only the tests the files changed in this session can affect (fast). before: run on the code as it was before this session's changes, with your test files as they are now: a test for a fix fails there. probe: optional test-sensitivity sample after passing tests, at most two extra runs with individual source hunks reverted in temporary copies; replaces the automatic old-code run. Build failures are inconclusive. meets: the criteria these checks prove.",
      parameters: obj({ only: { type: 'array', items: { type: 'string', enum: CHECKS } }, path: { type: 'string' }, filter: { type: 'string' }, related: { type: 'boolean' }, before: { type: 'boolean' }, probe: { type: 'boolean' }, meets: MEETS }, []),
    },
    normalize: (a) => {
      const only = (strs(a.only) ?? []).filter((x): x is CheckName => CHECKS.includes(x));
      return { only: only.length ? only : undefined, path: str(a, 'path', false), filter: str(a, 'filter', false), related: bool(a, 'related'), before: bool(a, 'before'), probe: bool(a, 'probe') };
    },
  };
}

/** Arguments of the job tools (job, background_job): output, input, wait and kill. */
function jobArgs(a: Record<string, unknown>) {
  const action = str(a, 'action', false);
  return {
    id: str(a, 'id'),
    action: action === 'kill' ? 'kill' : action === 'input' ? 'input' : action === 'wait' ? 'wait' : 'output',
    filter: str(a, 'filter', false),
    input: str(a, 'text', false) ?? str(a, 'input', false),
    until: str(a, 'until', false),
    timeoutMs: num(a, 'timeout_ms'),
  };
}

const JOB_PARAMS = obj(
  { id: { type: 'string' }, action: { type: 'string', enum: ['output', 'input', 'wait', 'kill'] }, text: { type: 'string' }, filter: { type: 'string' }, until: { type: 'string' }, timeout_ms: { type: 'integer' } },
  ['id', 'action'],
);

/** The session's history beyond what compaction kept: a tool output in full, a message by #N, or words found anywhere. */
function recallBinding(): ToolBinding {
  return {
    def: recallTool,
    spec: {
      name: 'recall',
      description:
        'Brings back exact details from earlier in this session, including what compaction summarized or cut: call_id returns that tool output in full (with query, the matching section or lines inside it); message returns message #N in full (supports from and query); query alone (words or a regex) finds matches across everything said and returned. Use it instead of guessing an error, a path or what the user said.',
      parameters: obj({ call_id: { type: 'string' }, message: { type: 'integer', description: '0-based message index (#N from search hits or cut-message notices) to read in full.' }, query: { type: 'string' }, from: { type: 'number' } }, []),
    },
    normalize: (a) => {
      const rawMsg = a.message;
      const message =
        typeof rawMsg === 'number' && Number.isFinite(rawMsg)
          ? Math.trunc(rawMsg)
          : typeof rawMsg === 'string' && /^\s*#?\d+\s*$/.test(rawMsg)
            ? Number(rawMsg.trim().replace(/^#/, ''))
            : undefined;
      return {
        callId: str(a, 'call_id', false) ?? str(a, 'callId', false),
        message,
        query: str(a, 'query', false),
        from: typeof a.from === 'number' ? a.from : undefined,
      };
    },
  };
}

/** Notes on the project that start every later session's prompt. */
function rememberBinding(): ToolBinding {
  return {
    def: rememberTool,
    spec: {
      name: 'remember',
      description:
        "Saves a one-sentence note that starts every later session. scope project (the default): true of this codebase or folder, what a later session here would have to find out again (how to build, run or test it, a convention, a pitfall, a decision made here, a step you had to discover before something worked unless you wrote it into the project), and a rule the user states for this project or repository (\"这个项目别再用 lodash\", \"提交信息一律用中文\"). scope global: true of the user wherever they work (how they want you to work and write, their name or sign-off, their machine and tools), above all a preference or correction they state for good (\"以后都……\", \"always…\", \"别再……\"). One message can hold both kinds. Not notes: an instruction for this task only, what the code or git history already shows, a key or password, a tool or command that failed (it may work next time, and the note would keep every later session from trying it). replaces: the exact text of a saved note, of either scope, that this one corrects or makes outdated.",
      parameters: obj({ note: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] }, replaces: { type: 'string' } }, ['note']),
    },
    normalize: (a) => ({ note: str(a, 'note'), scope: str(a, 'scope', false) === 'global' ? 'global' : 'project', replaces: str(a, 'replaces', false) }),
  };
}

/** The tool that loads the ones the main session holds back until it needs them. */
export function loadToolsBinding(): ToolBinding {
  return {
    def: loadToolsTool,
    spec: {
      name: 'load_tools',
      description: 'Gives the full instructions of tools your tool list has in short (the system prompt names them): what each does and its parameters, described. names: the tools.',
      parameters: obj({ names: { type: 'array', items: { type: 'string' } } }, ['names']),
    },
    normalize: (a) => ({ names: strs(a.names) ?? [] }),
  };
}

/** A fresh read-only sub-agent reviews the session's net change against the request and the criteria. */
function reviewBinding(): ToolBinding {
  return {
    def: reviewTool,
    spec: {
      name: 'review',
      description:
        'A fresh sub-agent reviews this session\'s net diff against the request and criteria for bugs (path:line), missed edge cases, and missing tests. Takes a minute or more: use only for large, risky multi-file logic changes, not for UI pages or small fixes already verified with check or browser. focus: what to examine most.',
      parameters: obj({ focus: { type: 'string' } }, []),
    },
    normalize: (a) => ({ focus: str(a, 'focus', false) }),
  };
}

function briefBinding(): ToolBinding {
  return {
    def: briefTool,
    spec: {
      name: 'brief',
      description:
        'A fresh agent finds out what a request for something new needs before you make it: it opens real examples of the kind, weighs three directions, chooses one and writes the bar, which becomes your criteria; when you finish, a reviewer checks the result against that bar. For a request of a few words for a whole thing people will look at, watch, read or play (a site, a film, a poster, a deck, a game), when neither the request nor the project settles what a good one has. It takes several minutes. Not for a change to something that exists, a fix, or code with a spec. note: what the user said elsewhere that the agent must keep.',
      parameters: obj({ note: { type: 'string' } }, []),
    },
    normalize: (a) => ({ note: str(a, 'note', false) }),
  };
}

/** Watching a rendered video as a viewer would: motion over time, freezes, jumps, fast moves, hits against a cut list. */
function watchBinding(): ToolBinding {
  return {
    def: watchTool,
    spec: {
      name: 'watch',
      description:
        'Watches a rendered video the way a viewer sees it, which frames on a contact sheet do not show: every frame is compared with the one before. Reports freezes, stretches where nothing moves, jumps and pops, moves too fast to read without motion blur, slow moves that advance in hops, long or lifeless shots, loudness and, with a cut list, cuts that do not cut and sound that misses its hits. Attaches a motion timeline and 12 frames in a row at full size where it matters. path: the video; cuts: the cut list file (YAML or JSON: fps, size, shots [start times], hits [{at, what}], holds [[from, to]]); at: seconds, for 12 frames from there too. Needs ffmpeg.',
      parameters: obj({ path: { type: 'string' }, cuts: { type: 'string' }, at: { type: 'number' } }, ['path']),
    },
    normalize: (a) => ({ path: str(a, 'path'), cuts: str(a, 'cuts', false), at: typeof a.at === 'number' ? a.at : undefined }),
  };
}

/** A film rendered from an animation page frame by frame, where a browser is found. */
function filmBinding(): ToolBinding {
  return {
    def: filmTool,
    spec: {
      name: 'film',
      description:
        'Renders a film from an animation page you write (an .html file of the project): the page sets window.duration (seconds) and window.seek = (t) => { draw the frame for time t }, every value a function of t (canvas, SVG or the DOM; painted pictures from the paint tool as layers; may return a promise; window.ready may be a promise for loading). Every frame is drawn in the browser at the delivery size and rate and encoded with its sound. The project is served to the page, so it can load its pictures, fonts and the beats file; the paint engine is at /__favilla/paint.js. page: the page; sound: the WAV under it; size [w, h] and fps (else the cut list beside the page, else 1920x1080 at 24); from, to: a part, in seconds; preview: true for twelve frames on a sheet instead of a video; blur: sub-frames per frame for motion blur (2-4); out: the video. Read the motion skill first.',
      parameters: obj({ page: { type: 'string' }, sound: { type: 'string' }, out: { type: 'string' }, seconds: { type: 'number' }, fps: { type: 'number' }, size: { type: 'array', items: { type: 'number' } }, from: { type: 'number' }, to: { type: 'number' }, preview: { type: 'boolean' }, blur: { type: 'integer' } }, ['page']),
    },
    normalize: (a) => ({ page: str(a, 'page'), sound: str(a, 'sound', false), out: str(a, 'out', false), seconds: typeof a.seconds === 'number' ? a.seconds : undefined, fps: typeof a.fps === 'number' ? a.fps : undefined, size: Array.isArray(a.size) && a.size.length === 2 ? (a.size.map(Number) as [number, number]) : undefined, from: typeof a.from === 'number' ? a.from : undefined, to: typeof a.to === 'number' ? a.to : undefined, preview: a.preview === true, blur: typeof a.blur === 'number' ? a.blur : undefined }),
  };
}

/**
 * Music from a score in bars, rendered from recorded instruments where a browser is found. The description carries the
 * score's grammar, since skills are off in some runs.
 */
function musicBinding(): ToolBinding {
  return {
    def: musicTool,
    spec: {
      name: 'music',
      description: [
        'Writes and renders music from a score you write in bars (a .music.yaml file in the project): chords, a tune, its answer, a texture for each other part, dynamics, and the moments of a film pinned to bars. Favilla solves the tempo so pinned moments land to the millisecond, voices the chords under the tune, plays it like a person on recorded instruments (CC0 and public domain, fetched once), mixes it with the tune in front and sets the loudness. It returns the WAV, a beats file (bar times and frames, for timing pictures), a report in musical words bar by bar and a piano roll. You cannot hear it: read every line of the report. Read the music skill first.',
        'path: the score file; doc: its text, written first; plan: true for the timing only; out: where the WAV goes.',
        'Score: cue; length (s); fps; key (D major, F# minor); meter (4/4, 3/4, 6/8); tempo; palette (chamber: piano harp glockenspiel strings pizzicato bass timpani cymbal | mallets: marimba vibraphone glockenspiel kalimba bass frame drum bass drum cymbal | keys: piano strings bass timpani cymbal); room (dry, studio, salon, hall, church); loudness (film -14 LUFS, game -17, quiet, bed, or a number); cuts: the cut list file of the film.',
        'sync: [{at: seconds, bar, beat, name, hit: arrive | accent | swell | button | none}] (a moment without a bar is placed on the nearest 16th and reported). parts: {tune: piano, answer: glockenspiel, pulse: {instrument: harp, arp: "0 2 1 3", unit: 0.5, bars: "1-8 10-16"}, pad: {instrument: strings, pad: true}, bass: {instrument: pizzicato, beats: "1 3"}, comp: {instrument: piano, strike: "1 2.5"}} (arp indexes the voiced chord, 0 = bass; level: dB against the defaults; octave; under loudness: bed, tune may be omitted so chords and textures stay low under speech).',
        'chords: "Dmaj9 | Gmaj9/D | A7sus4:2 A7:2 | ..." (one bar each, :beats inside a bar). cells: {hook: 1.5 .5 1 1}. tune and answer: "4: hook(A5 F#5 E5 F#5) | B5:3 r:1 | ..." (N: starts at bar N; PITCH:BEATS; r rests; the final bar pads any trailing rest automatically; a cell name takes its rhythm). dynamics: "1: p | 4: mp | 8: mf< | 12: f". end: {ring: true, fade: 0.8}.',
      ].join(' '),
      parameters: obj({ path: { type: 'string' }, doc: { type: 'string' }, plan: { type: 'boolean' }, out: { type: 'string' } }, ['path']),
    },
    normalize: (a) => ({ path: str(a, 'path'), doc: typeof a.doc === 'string' ? a.doc : undefined, plan: a.plan === true, out: str(a, 'out', false) }),
  };
}

/**
 * Painting by hand-drawn means on every surface where a browser is found: Favilla's own tool and document, so the
 * description carries what the document can say (skills are off in some runs).
 */
function paintBinding(): ToolBinding {
  return {
    def: paintTool,
    spec: {
      name: 'paint',
      description: [
        'Paints and retouches pictures by hand, and cuts a picture out of its ground in one call (cut: file, out: file, size: [w, h]). Each result comes back with a check sheet (a grid every 50 px). For illustrations, characters, scenes and textures with form, for retouching pictures, and for cutting a picture out of its ground, resized when size is given. Not for interface icons (the icon set the project uses, or one SVG icon library), charts, diagrams, logos or anything that moves or must stay editable: those are code. Read the paint skill before the first call.',
        'A canvas is kept by Favilla between calls, by name, outside the project, so no document file is needed and nothing is sent twice. doc starts a canvas with a whole document; afterwards send only the change: layer + items (mode add or replace), remove (layer names or "#n"), set (size, paper, background, adjust, symbols), undo. out: where the picture goes, kept for later calls; look [x, y, w, h]: that part enlarged. cut: a picture file to cut out of its ground in one call, written to out (key: auto by default, or the ground colour; tolerance, soft, flood: false for holes inside; trim: crop to what is left; size [w, h]: fit it into that box, as for an icon or a favicon); no script of your own for this, and no intermediate files in the project. For headings, captions or labels on painted art, never hand-stroke letters or parse font files: paint the art without words into the scratch folder, lay real HTML/CSS type over it in a scratch HTML file, and export the final PNG with browser(url, width, height, out).',
        'Document: size [w, h]; seed; tile; paper {type: none | smooth | hot-press | cold-press | rough | canvas | kraft | newsprint, color, grain}; background; adjust; shapes {name: path} (then path: "@name" anywhere: one outline for a mass, its shading and shadow); symbols {name: [items]}; layers: [{name, blend, opacity, clip: LAYER, adjust, items}]. Blends: normal, multiply, screen, overlay, soft-light, darken, lighten, color-burn, color-dodge.',
        'Geometry anywhere: path "M.. C.. Q.. A.. Z" (SVG), or points [[x, y, pressure]], or ellipse [cx, cy, rx, ry, deg], circle [cx, cy, r], rect [x, y, w, h, radius]. {group: [items], at, rotate, scale, origin} draws in its own frame; {use: SYMBOL, at, rotate, scale, color} places a symbol.',
        'Items: {stroke: pencil | graphite | ink | pen | brushpen | marker | highlighter | watercolor | gouache | oil | pastel | chalk | charcoal | crayon | airbrush | soft | eraser, color, size, path or points, pressure (number or list along the stroke), taper, tremor, opacity, blend, closed}; {fill: hatch | crosshatch | scribble | stipple | splatter | wash | flat, region, brush, color, size, spacing, angle, density, pressure; wash: to, direction, strength; flat: rough, grain}; {image: file, box, fit, crop, opacity, blend, key, tolerance, soft, flood}: key "auto" or a colour cuts the ground of the picture away (what reaches the border, flood false: everywhere) with a soft, un-mixed edge; with paper none and no background the output is the cutout itself.',
        'Marks in numbers, the way to detail: {strands: hair | fur | grass | lines, along: path or region, count, length [min, max], size, colors, curl, jitter, spread, side, direction, brush}; {scatter: leaf | petal | stone | dot | star | dash | blade | drop, region or along, count or density, size [min, max], rotate, colors, light, outline}; {shade: true, region or ellipse, form: sphere | cylinder | cone | plane | fold, light, axis, color, strength, core, reflect, highlight, method: soft | hatch}; {cast: true, region, light, ground, squash, blur, strength}; {texture: wood | stone | marble | bark | cloth | clouds | water | grain, region, color, color2, scale, angle, strength, blend}.',
        'adjust: levels {black, white, gamma}, contrast, saturation, lightness, hue, warmth, blur, sharpen, grain, vignette, posterize.',
      ].join(' '),
      parameters: obj(
        {
          canvas: { type: 'string' },
          doc: { type: 'string' },
          layer: { type: 'string' },
          items: { type: 'string' },
          mode: { type: 'string', enum: ['add', 'replace'] },
          blend: { type: 'string' },
          opacity: { type: 'number' },
          clip: { type: 'string' },
          set: { type: 'string' },
          remove: { type: 'array', items: { type: 'string' } },
          undo: { type: 'integer' },
          out: { type: 'string' },
          look: { type: 'array', items: { type: 'number' } },
          path: { type: 'string' },
          cut: { type: 'string' },
          key: { type: 'string' },
          tolerance: { type: 'number' },
          soft: { type: 'number' },
          flood: { type: 'boolean' },
          trim: { type: 'boolean' },
          size: { type: 'array', items: { type: 'number' } },
        },
        [],
      ),
    },
    normalize: (a) => ({
      canvas: str(a, 'canvas', false),
      doc: typeof a.doc === 'string' && a.doc.trim() ? a.doc : a.doc && typeof a.doc === 'object' ? JSON.stringify(a.doc) : undefined,
      layer: str(a, 'layer', false),
      items: typeof a.items === 'string' || Array.isArray(a.items) ? (a.items as string | unknown[]) : undefined,
      mode: a.mode === 'replace' ? 'replace' : a.mode === 'add' ? 'add' : undefined,
      blend: str(a, 'blend', false),
      opacity: typeof a.opacity === 'number' ? a.opacity : undefined,
      clip: str(a, 'clip', false),
      set: typeof a.set === 'string' || (a.set && typeof a.set === 'object') ? (a.set as string | Record<string, unknown>) : undefined,
      remove: strs(a.remove),
      undo: typeof a.undo === 'number' ? a.undo : undefined,
      out: str(a, 'out', false),
      look: Array.isArray(a.look) ? a.look.map(Number) : undefined,
      path: str(a, 'path', false),
      cut: str(a, 'cut', false),
      key: str(a, 'key', false),
      tolerance: typeof a.tolerance === 'number' ? a.tolerance : undefined,
      soft: typeof a.soft === 'number' ? a.soft : undefined,
      flood: typeof a.flood === 'boolean' ? a.flood : undefined,
      trim: a.trim === true ? true : undefined,
      size: Array.isArray(a.size) ? a.size.map(Number) : undefined,
    }),
  };
}

/**
 * The agent's own criteria for done, the same tool on every surface: it is Favilla's own, so no surface has a trained
 * name for it. Called goal until 2026-11-05, Codex's and Claude Code's word for a condition the user sets.
 */
function goalBinding(): ToolBinding {
  return {
    def: goalTool,
    spec: {
      name: 'criteria',
      description:
        'Your criteria for done on large or long-running work: objective (one sentence) and criteria (checkable statements of done; on long work, milestones in order, with active: the one you are on). A localized fix needs none just because it has read, edit and test steps. Set or update them alongside useful tool calls, never in a response of their own. A criterion a check or command proves is marked by that run: give its number in meets there, without another criteria call. Use done (numbers, evidence) only for criteria verified some other way. It survives compaction and is checked before you stop. clear: the user moved on.',
      parameters: obj(
        { objective: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } }, done: { type: 'array', items: { type: 'integer' } }, evidence: { type: 'string' }, active: { type: 'integer' }, clear: { type: 'boolean' } },
        [],
      ),
    },
    normalize: (a) => ({
      objective: str(a, 'objective', false),
      criteria: strs(a.criteria),
      done: Array.isArray(a.done) ? a.done.map(Number).filter(Number.isInteger) : typeof a.done === 'number' ? [a.done] : undefined,
      evidence: str(a, 'evidence', false),
      active: num(a, 'active'),
      clear: bool(a, 'clear'),
    }),
  };
}


/** A symbol's definition or references from the language server: offered in folders of code only. */
function symbolsBinding(): ToolBinding {
  return {
    def: symbolsTool,
    spec: {
      name: 'symbols',
      description:
        "Where a symbol is defined, or every place that uses it, from the project's language server (TypeScript 7, pyright, gopls or rust-analyzer when present): exact where search only matches text. path and line point at a use of the symbol, symbol names it on that line. find: definition or references. For refactors and for following code across files.",
      parameters: obj(
        {
          path: { type: 'string' },
          line: { type: 'integer' },
          symbol: { type: 'string' },
          column: { type: 'integer' },
          find: { type: 'string', enum: ['definition', 'references'] },
        },
        ['path', 'line', 'find'],
      ),
    },
    normalize: (a) => ({ path: str(a, 'path'), line: num(a, 'line') ?? 1, symbol: str(a, 'symbol', false), column: num(a, 'column'), find: str(a, 'find', false) === 'references' ? 'references' : 'definition' }),
  };
}

function mailBinding(accounts: string[]): ToolBinding {
  return {
    def: mailTool,
    spec: {
      name: 'mail',
      description: `The user's email (${accounts.join(', ')}). action search: query in Gmail's search syntax (from:, to:, subject:, is:unread, is:starred, has:attachment, after:2026/10/01, before:, label:, "exact words"; other servers understand the same), folder, limit (default 20); newest first, each with an id (4521@INBOX) and the start of its text. read: id; save_to: a folder for its attachments. draft / send: to, cc, bcc, subject, body (plain text), attachments (file paths), reply_to (an id: the reply joins its thread and goes to its sender), reply_all. send shows the user the whole email and sends only if they approve; draft saves it in Drafts. mark: ids with read, starred, archive, move (a folder), label / unlabel (Gmail). account: which mailbox (default: the default one). accounts: the mailboxes.`,
      parameters: obj(
        {
          action: { type: 'string', enum: [...MAIL_ACTIONS] },
          account: { type: 'string' },
          query: { type: 'string' },
          folder: { type: 'string' },
          limit: { type: 'number' },
          id: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
          save_to: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          attachments: { type: 'array', items: { type: 'string' } },
          reply_to: { type: 'string' },
          reply_all: { type: 'boolean' },
          read: { type: 'boolean' },
          starred: { type: 'boolean' },
          archive: { type: 'boolean' },
          move: { type: 'string' },
          label: { type: 'string' },
          unlabel: { type: 'string' },
        },
        ['action'],
      ),
    },
    normalize: (a) => {
      const action = str(a, 'action') as (typeof MAIL_ACTIONS)[number];
      if (!MAIL_ACTIONS.includes(action)) throw new ToolInputError(`action is one of ${MAIL_ACTIONS.join(', ')}.`);
      return {
        action,
        account: str(a, 'account', false),
        query: str(a, 'query', false),
        folder: str(a, 'folder', false),
        limit: num(a, 'limit'),
        id: str(a, 'id', false),
        ids: strs(a.ids),
        saveTo: str(a, 'save_to', false),
        to: strs(a.to),
        cc: strs(a.cc),
        bcc: strs(a.bcc),
        subject: str(a, 'subject', false),
        body: str(a, 'body', false),
        attachments: strs(a.attachments),
        replyTo: str(a, 'reply_to', false),
        replyAll: bool(a, 'reply_all'),
        read: bool(a, 'read'),
        starred: bool(a, 'starred'),
        archive: bool(a, 'archive'),
        move: str(a, 'move', false),
        label: str(a, 'label', false),
        unlabel: str(a, 'unlabel', false),
      };
    },
  };
}

function attemptsBinding(): ToolBinding {
  return {
    def: attemptsTool,
    spec: {
      name: 'attempts',
      description:
        "Solves one task several ways at once and keeps the best: each attempt is a sub-agent in its own copy of the repository (a git worktree); every copy is scored by the project's checks (or the command in check), a judge picks among the best, and the chosen change is applied to the working tree. For hard or risky changes that a first try often gets wrong (a tricky bug, an algorithm, a change after two failed tries), when the result can be checked by tests. Costs count times the tokens. task is the complete brief: the attempts see nothing of this conversation. count: 2 to 5 (3).",
      parameters: obj({ task: { type: 'string' }, count: { type: 'integer' }, check: { type: 'string' } }, ['task']),
    },
    normalize: (a) => ({ task: str(a, 'task'), count: num(a, 'count'), check: str(a, 'check', false) }),
  };
}

function computerBinding(): ToolBinding {
  return {
    def: desktopTool,
    spec: {
      name: 'computer',
      description:
        'Sees and uses this computer\'s desktop, for desktop apps that files, commands and the browser tool cannot reach. Without actions it returns a screenshot; window brings a window to the front (part of its title) and later screenshots show only it; list: true lists the open windows. Actions run in order, then a new screenshot comes back: {click: [x, y], button?, double?}, {move: [x, y]}, {drag: [[x1, y1], [x2, y2]]}, {scroll: lines (positive is down), at?: [x, y]}, {type: "text"}, {key: "ctrl+s"} (several chords separated by spaces), {wait: ms}, {focus: "title"}, {zoom: [x, y, width, height]} for that part at the full resolution of the screen. Points are read off the latest screenshot. If the user moves the mouse to the top-left corner of the screen, stop using the desktop.',
      parameters: obj(
        {
          window: { type: 'string' },
          actions: { type: 'array', items: { type: 'object' } },
          list: { type: 'boolean' },
        },
        [],
      ),
    },
    normalize: (a) => {
      const actions = Array.isArray(a.actions) ? a.actions : [];
      for (const [i, x] of actions.entries()) {
        if (!x || typeof x !== 'object' || !Object.keys(x).some((k) => DESKTOP_ACTIONS.includes(k))) throw new ToolInputError(`Action ${i + 1} needs one of ${DESKTOP_ACTIONS.join(', ')}.`);
      }
      return { window: str(a, 'window', false), actions, list: bool(a, 'list') };
    },
  };
}

/** The browser on every surface: a page used like a person would, the screenshot tool grown up. */
function browserBinding(): ToolBinding {
  return {
    def: browserTool,
    spec: {
      name: 'browser',
      description:
        'Uses web pages like a person: local dev servers, HTML files, and web sites. url opens a page; actions run in order. Each result lists interactive elements with refs ([e7] button "Save"); act by ref, CSS selector, or "text=Label": {click: "e7"} (double, button: "right", hold: true keeps pressed), {hover}, {fill: "e3", value}, {type: text, into?}, {select: "e5", option}, {check} / {uncheck}, {upload: "e9", files}, {press: "Enter" or "ctrl+a"}, {wait: ms, ref or "load"}, {scroll: px or ref}, {back}, {forward}, {reload}, {tab: "new" (url?) / "close" / "list" / number}, {js: expression}, {read: true} for page text, {zoom: [x, y, width, height]} for a sharp close-up, {measure: true} for design-bar defects. check_widths: true verifies 1280×800 and 390×844 in one call (two 1× viewport screenshots + overflow, contrast, <32px mobile tap targets, and design defects); prefer it over separate full_page calls when checking UI work, and use full_page: true only when you need every below-fold screen (up to 8). out: saves an exact 1× width×height PNG (for compositing HTML/CSS type over painted art). show: true opens a visible window.',
      parameters: obj(
        {
          url: { type: 'string' },
          actions: { type: 'array', items: { type: 'object' } },
          width: { type: 'integer' },
          height: { type: 'integer' },
          check_widths: { type: 'boolean' },
          full_page: { type: 'boolean' },
          show: { type: 'boolean' },
          out: { type: 'string' },
        },
        [],
      ),
    },
    normalize: (a) => {
      const actions = Array.isArray(a.actions) ? a.actions : [];
      for (const [i, x] of actions.entries()) {
        if (!x || typeof x !== 'object' || !Object.keys(x).some((k) => ACTION_KEYS.includes(k))) throw new ToolInputError(`Action ${i + 1} needs one of ${ACTION_KEYS.join(', ')}.`);
      }
      return { url: str(a, 'url', false) ?? str(a, 'target', false), actions, width: num(a, 'width'), height: num(a, 'height'), checkWidths: bool(a, 'check_widths'), fullPage: bool(a, 'full_page'), show: bool(a, 'show'), out: str(a, 'out', false) };
    },
  };
}


function todos(raw: unknown, textKey: 'content' | 'step'): Todo[] {
  if (!Array.isArray(raw)) throw new ToolInputError('Expected an array of items.');
  return raw.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const content = String(o[textKey] ?? o.content ?? o.step ?? '').trim();
    if (!content) throw new ToolInputError(`Item ${i + 1} has no ${textKey}.`);
    const s = String(o.status ?? 'pending').toLowerCase().replace(/[\s-]/g, '_');
    const status = s === 'in_progress' || s === 'completed' ? s : s === 'done' || s === 'complete' ? 'completed' : 'pending';
    return { content, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined } as Todo;
  });
}

function questions(raw: unknown): Question[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!list.length) throw new ToolInputError('Provide at least one question.');
  return list.slice(0, 4).map((q) => {
    const o = (q ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(o.options) ? o.options : []).map((x) => (typeof x === 'string' ? { label: x } : { label: String((x as Record<string, unknown>).label ?? ''), description: (x as Record<string, unknown>).description as string | undefined }));
    return { question: String(o.question ?? ''), header: typeof o.header === 'string' ? o.header : undefined, options: options.filter((x) => x.label), multiSelect: !!(o.multiSelect ?? o.multi_select) };
  });
}

const questionSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 4,
  items: obj(
    {
      question: { type: 'string' },
      header: { type: 'string', description: 'At most 12 characters.' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: obj({ label: { type: 'string' }, description: { type: 'string', description: 'What choosing this means.' } }, ['label']),
      },
      multiSelect: { type: 'boolean' },
    },
    ['question', 'options'],
  ),
};

function scriptGuidance(shell: ShellInfo): string {
  const input = shell.kind === 'bash' || shell.kind === 'zsh' || shell.kind === 'sh'
    ? "pass it on stdin with a quoted heredoc (python - <<'PY'\n...\nPY)"
    : shell.kind === 'pwsh' || shell.kind === 'powershell'
      ? "pass it on stdin with a literal here-string (@'\n...\n'@ | python -)"
      : 'write it to a script file in the scratch folder and run that file';
  return `For multi-line scripts or nested quotes, ${input}, or run a script file. Avoid packing them into python -c with escaped newlines.`;
}

function webFetchBinding(name: string, description: string): ToolBinding {
  return { def: webFetchTool, spec: { name, description, parameters: obj(FETCH_PROPS, ['url']) }, normalize: fetchArgs };
}

function webSearchBinding(name: string, description: string): ToolBinding {
  return { def: webSearchTool, spec: { name, description, parameters: obj(SEARCH_PROPS, ['query']) }, normalize: searchArgs };
}

function askBinding(name: string, description: string): ToolBinding {
  return {
    def: askTool,
    spec: { name, description, parameters: obj({ questions: questionSchema }, ['questions']) },
    normalize: (a) => ({ questions: questions(a.questions ?? a) }),
  };
}

function taskBinding(name: string, agentType: 'subagent_type' | 'agent_type' | 'type', description: string): ToolBinding {
  return {
    def: taskTool,
    spec: {
      name,
      description,
      parameters: obj(
        {
          description: { type: 'string', description: agentType === 'type' ? '3-5 words' : '3-5 words.' },
          prompt: { type: 'string', ...(agentType === 'subagent_type' ? { description: 'The complete brief.' } : {}) },
          [agentType]: { type: 'string', enum: ['explore', 'general'] },
          files: { type: 'array', items: { type: 'string' }, description: 'general: the files it may change (paths, folders or globs). Others are refused. Agents whose files could overlap run one after another.' },
          ...agentProps(),
        },
        ['description', 'prompt'],
      ),
    },
    normalize: (a) => ({ description: str(a, 'description'), prompt: str(a, 'prompt'), agent: str(a, agentType, false) === 'general' ? 'general' : 'explore', files: strs(a.files), ...agentChoice(a) }),
  };
}

function addProjectTools(tools: ToolBinding[], pc: ProfileContext): void {
  if (pc.screenshot) tools.push(browserBinding(), paintBinding(), musicBinding(), filmBinding());
  if (pc.computer && pc.role === 'main') tools.push(computerBinding());
  if (pc.role === 'main' && pc.git !== false) tools.push(attemptsBinding());
  if (pc.mail?.length && pc.role === 'main') tools.push(mailBinding(pc.mail));
  if (pc.code !== false) tools.push(symbolsBinding());
  tools.push(watchBinding());
}

function claudeProfile(pc: ProfileContext): ToolBinding[] {
  const shellLine = `Commands run in ${pc.shell.label}.`;
  const tools: ToolBinding[] = [
    {
      def: readTool,
      spec: {
        name: 'Read',
        description: `Reads a file. file_path may be absolute or relative to the working directory.
- Returns up to 2000 lines from the start by default; for long files pass offset (1-based line number) and limit.
- Output is in \`cat -n\` format: line number, a tab, then the line. The number and tab are not part of the file.${pc.vision ? '\n- Image files (png, jpg, gif, webp) are attached so you can see them.' : ''}
- PDFs are read as text, page by page; offset and limit then count pages. Notebooks show their cells.
- .docx, .xlsx and .pptx files are read as their text: headings, lists and tables, each sheet with its formulas and dates, each slide.
- Reading a directory lists its entries. Read several files in one response by calling this tool several times.`,
        parameters: obj(
          {
            file_path: { type: 'string', description: 'Path of the file to read.' },
            offset: { type: 'integer', description: 'Line number to start from (1-based).' },
            limit: { type: 'integer', description: 'Number of lines to read.' },
            ...(pc.vision ? { region: { type: 'array', items: { type: 'number' }, description: 'For one image: [x, y, width, height] in its pixels; that part comes back enlarged.' } } : {}),
          },
          ['file_path'],
        ),
      },
      normalize: (a) => ({ path: str(a, 'file_path', false) ?? str(a, 'path'), offset: num(a, 'offset'), limit: num(a, 'limit'), region: nums(a.region) }),
    },
    {
      def: writeTool,
      spec: {
        name: 'Write',
        description: 'Writes a file, creating parent folders as needed. Use it for new files and complete rewrites; use Edit for changes to existing files. Overwriting an existing file requires reading it first in this session.',
        parameters: obj({ file_path: { type: 'string' }, content: { type: 'string', description: 'The complete file content.' } }, ['file_path', 'content']),
      },
      normalize: (a) => ({ path: str(a, 'file_path', false) ?? str(a, 'path'), content: typeof a.content === 'string' ? a.content : (str(a, 'content') ?? '') }),
    },
    {
      def: editTool,
      spec: {
        name: 'Edit',
        description: `Replaces text in a file. Read the file first.
- old_string must match the file exactly, including indentation, and must be unique unless replace_all is true. Copy it from the Read output without the line-number prefix (only what follows the tab).
- Include enough surrounding lines to make old_string unique; keep it short otherwise.
- replace_all renames or replaces every occurrence.
- Several edits to one file: call Edit several times, top to bottom.`,
        parameters: obj(
          {
            file_path: { type: 'string' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text (must differ from old_string).' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
          },
          ['file_path', 'old_string', 'new_string'],
        ),
      },
      normalize: (a) => ({
        path: str(a, 'file_path', false) ?? str(a, 'path'),
        old: typeof a.old_string === 'string' ? a.old_string : (str(a, 'old_string') ?? ''),
        new: typeof a.new_string === 'string' ? a.new_string : '',
        all: bool(a, 'replace_all'),
        requireRead: true,
      }),
    },
    ...(pc.notebooks ? [notebookBinding('claude')] : []),
    {
      def: shellTool,
      spec: {
        name: 'Bash',
        description: `Runs a shell command and returns its combined output and exit code. ${shellLine} ${scriptGuidance(pc.shell)}
- Every call starts in the working directory; chain with \`cd dir && …\` to work elsewhere. stdin is closed, so use non-interactive flags (--yes, -y, --no-input).
- Default timeout ${Math.round(pc.timeoutMs / 1000)} s, up to 600000 ms via timeout. Start dev servers and watchers with run_in_background, then use BashOutput and KillShell.
- Prefer Read, Grep and Glob over cat, grep and find. Use Bash for builds, tests, git, package managers and scripts.
- Independent commands can run as separate calls in one response; dependent ones belong in one command joined with &&.
- Long output is cut in the middle and saved to a file you can Read.`,
        parameters: obj(
          {
            command: { type: 'string' },
            timeout: { type: 'integer', description: 'Timeout in milliseconds (max 600000).' },
            description: DESCRIBE,
            run_in_background: { type: 'boolean', description: 'Run without waiting (servers, watchers).' },
          },
          ['command'],
        ),
      },
      normalize: (a) => ({ command: str(a, 'command'), timeoutMs: num(a, 'timeout'), description: str(a, 'description', false), background: bool(a, 'run_in_background'), format: 'claude' }),
    },
    {
      def: jobTool,
      spec: {
        name: 'BashOutput',
        description:
          'Returns new output from a background command started with run_in_background, and whether it is still running. filter keeps only lines matching a regex. input is sent to the command first (end lines with \\n), for programs that ask questions or REPLs: start those in the background, then answer here.',
        parameters: obj({ bash_id: { type: 'string' }, filter: { type: 'string' }, input: { type: 'string', description: "Text for the command's standard input." } }, ['bash_id']),
      },
      normalize: (a) => ({ id: str(a, 'bash_id', false) ?? str(a, 'id'), action: 'output', filter: str(a, 'filter', false), input: str(a, 'input', false) }),
    },
    {
      def: jobTool,
      spec: { name: 'KillShell', description: 'Stops a background command.', parameters: obj({ shell_id: { type: 'string' } }, ['shell_id']) },
      normalize: (a) => ({ id: str(a, 'shell_id', false) ?? str(a, 'bash_id', false) ?? str(a, 'id'), action: 'kill' }),
    },
    {
      def: grepTool,
      spec: {
        name: 'Grep',
        description: `Searches file contents with ripgrep (regex). Respects .gitignore and skips .git and node_modules.
- output_mode: "files_with_matches" (default; newest first), "content" (matching lines with numbers; -A/-B/-C add context), "count".
- Narrow with glob (e.g. "*.ts", "src/**/*.{ts,tsx}") or type (e.g. "py", "rust").
- Escape regex characters for literal text (e.g. "foo\\(" ). multiline lets . and patterns span lines.`,
        parameters: obj(
          {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'File or folder to search (default: working directory).' },
            glob: { type: 'string' },
            type: { type: 'string' },
            output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
            '-i': { type: 'boolean', description: 'Case-insensitive.' },
            '-n': { type: 'boolean', description: 'Line numbers in content mode (default true).' },
            '-A': { type: 'integer' },
            '-B': { type: 'integer' },
            '-C': { type: 'integer' },
            head_limit: { type: 'integer', description: 'Return only the first N results.' },
            multiline: { type: 'boolean' },
          },
          ['pattern'],
        ),
      },
      normalize: (a) => {
        const m = str(a, 'output_mode', false);
        return {
          pattern: str(a, 'pattern'),
          path: str(a, 'path', false),
          glob: str(a, 'glob', false),
          type: str(a, 'type', false),
          mode: m === 'content' ? 'content' : m === 'count' ? 'count' : 'files',
          ignoreCase: bool(a, '-i'),
          lineNumbers: bool(a, '-n'),
          after: num(a, '-A'),
          before: num(a, '-B'),
          context: num(a, '-C'),
          limit: num(a, 'head_limit'),
          multiline: bool(a, 'multiline'),
        };
      },
    },
    {
      def: globTool,
      spec: {
        name: 'Glob',
        description: 'Finds files by name pattern, newest first, e.g. "**/*.test.ts" or "src/**/index.*". Use it to locate files; use Grep to search inside them.',
        parameters: obj({ pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search (default: working directory).' } }, ['pattern']),
      },
      normalize: (a) => ({ pattern: str(a, 'pattern'), path: str(a, 'path', false) }),
    },
    webFetchBinding(
      'WebFetch',
      "Reads a web page as markdown: its main text with absolute links, a PDF's text, GitHub files, issues and pull requests, Stack Overflow questions with their answers, package pages. Pages that need JavaScript are read through a browser. A long page comes in parts with an outline; start reads from an offset. With prompt, only what the prompt asks for comes back, which saves context.",
    ),
  ];

  tools.push(checkBinding());
  if (pc.search === 'client') {
    tools.push(webSearchBinding(
      'WebSearch',
      'Searches the web with several engines at once and opens the top results, quoting what each page says on the query; copy sites are left out. Use it for anything current or uncertain: facts, prices, schedules, news, documentation, error messages you do not recognise; WebFetch reads a result in full. allowed_domains keeps only those sites; blocked_domains drops them; recency keeps recent pages.',
    ));
  }
  addProjectTools(tools, pc);

  if (pc.role === 'explore') return tools.filter((t) => ['Read', 'Bash', 'BashOutput', 'KillShell', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'browser', 'symbols', 'watch'].includes(t.spec.name));
  if (pc.role === 'general') return tools;

  tools.push(
    {
      def: todoTool,
      spec: {
        name: 'TodoWrite',
        description: `Creates and updates the task list for the current work. Use it for work with three or more steps or when the user lists several things: write the list before starting, keep exactly one item in_progress, and mark each item completed the moment it is done. Skip it for a single simple request.`,
        parameters: obj(
          {
            todos: {
              type: 'array',
              items: obj(
                {
                  content: { type: 'string', description: 'Imperative form, e.g. "Run the tests".' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                  activeForm: { type: 'string', description: 'Present continuous form, e.g. "Running the tests".' },
                },
                ['content', 'status'],
              ),
            },
          },
          ['todos'],
        ),
      },
      normalize: (a) => ({ todos: todos(a.todos, 'content') }),
    },
    taskBinding(
      'Task', 'subagent_type',
      `Starts a sub-agent with its own context window for a self-contained job; only its final report comes back, which keeps your context small.
- "explore": read-only research across many files (where something is implemented, how a subsystem works, all usages of an API).
- "general": a self-contained multi-step job that may also edit files.
The sub-agent sees nothing of this conversation: give a complete brief with the goal, what you already know, where to look, and what the report must contain; for "general", list the files it may change. Start several in one response to run them in parallel. Its report ends with the files it changed and the commands it ran, as Favilla recorded them: look at those changes before you build on them. The user does not see the report; pass on what matters.`,
    ),
    askBinding(
      'AskUserQuestion',
      'Asks the user up to four multiple-choice questions and waits for the answers. Use it only when a choice would materially change the work and neither the request nor the files settle it, never to confirm routine steps. Offer 2-4 concrete options; the user may also write their own answer.',
    ),
    {
      def: planTool,
      spec: {
        name: 'ExitPlanMode',
        description: 'In plan mode, presents your finished implementation plan (markdown) to the user for approval. Use it only in plan mode, once the plan is complete.',
        parameters: obj({ plan: { type: 'string' }, steps: PLAN_STEPS }, ['plan']),
      },
      normalize: (a) => ({ plan: str(a, 'plan'), steps: strs(a.steps) }),
    },
  );
  return tools;
}

function codexProfile(pc: ProfileContext): ToolBinding[] {
  const tools: ToolBinding[] = [
    {
      def: shellTool,
      spec: {
        name: 'shell_command',
        description: `Runs a shell command (${pc.shell.label}) and returns its output. Commands start in the working directory unless workdir is set; stdin is closed, so use non-interactive flags. ${scriptGuidance(pc.shell)}
- Search with \`rg\` / \`rg --files\`; read file ranges with \`sed -n '120,200p' path\` or read_file.
- timeout_ms defaults to ${pc.timeoutMs} (max 600000). Start servers and watchers with run_in_background and manage them with background_job.
- Long output is cut in the middle and saved to a file.`,
        parameters: obj(
          {
            command: { type: 'string' },
            description: DESCRIBE,
            workdir: { type: 'string', description: 'Directory to run in (default: working directory).' },
            timeout_ms: { type: 'integer' },
            run_in_background: { type: 'boolean' },
          },
          ['command'],
        ),
      },
      normalize: (a) => {
        const c = a.command;
        const command = Array.isArray(c) ? (c.length >= 3 && /^(bash|sh|zsh)$/.test(String(c[0])) && c[1] === '-lc' ? String(c[2]) : c.map(String).join(' ')) : str(a, 'command');
        return { command, description: str(a, 'description', false), workdir: str(a, 'workdir', false), timeoutMs: num(a, 'timeout_ms'), background: bool(a, 'run_in_background'), format: 'codex' };
      },
    },
    {
      def: patchTool,
      spec: {
        name: 'apply_patch',
        description: `Edits files. This is a FREEFORM tool: send the patch text itself, not JSON.
*** Begin Patch
*** Update File: path/to/file.py
@@ def example():
-    pass
+    return 123
*** End Patch
Sections: "*** Add File: <path>" (every line prefixed with +), "*** Delete File: <path>", "*** Update File: <path>" (optionally followed by "*** Move to: <new path>") with hunks. A hunk starts with @@, optionally followed by a line from the file (a function or class header) that locates it; then lines prefixed " " (context), "-" (remove) or "+" (add). Show 3 lines of context around each change and add @@ headers when that is not unique. Paths are relative to the working directory.`,
        parameters: obj({ input: { type: 'string', description: 'The full patch text.' } }, ['input']),
        freeform: { syntax: 'lark', definition: APPLY_PATCH_GRAMMAR },
      },
      normalize: (a) => ({ patch: typeof a.input === 'string' ? a.input : (str(a, 'patch', false) ?? str(a, 'input')) }),
    },
    ...(pc.notebooks ? [notebookBinding('plain')] : []),
    {
      def: readTool,
      spec: {
        name: 'read_file',
        description: `Reads a file with line numbers (up to 2000 lines; use offset and limit for more).${pc.vision ? ' Image files are attached so you can see them.' : ''} PDFs are read as text page by page (offset and limit count pages); .docx, .xlsx and .pptx files as their text, headings, tables, sheets with formulas, and slides; notebooks show their cells.`,
        parameters: obj({ path: { type: 'string' }, offset: { type: 'integer', description: '1-based start line.' }, limit: { type: 'integer' } }, ['path']),
      },
      normalize: (a) => ({ path: str(a, 'path', false) ?? str(a, 'file_path'), offset: num(a, 'offset'), limit: num(a, 'limit') }),
    },
    {
      def: jobTool,
      spec: {
        name: 'background_job',
        description:
          'Reads new output from a background command (action "output", optional regex filter), sends text to its standard input and then reads (action "input" with text; end lines with \\n), waits until its output matches the regex until or it ends (action "wait", at most timeout_ms, default 30 s), or stops it (action "kill"). Run programs that ask questions, and REPLs, in the background and answer them here.',
        parameters: JOB_PARAMS,
      },
      normalize: jobArgs,
    },
    webFetchBinding(
      'web_fetch',
      "Reads a web page as markdown (main text, PDFs, GitHub files and issues, Stack Overflow answers; JavaScript pages through a browser). A long page comes in parts with an outline; start reads from an offset. With prompt, only what the prompt asks for.",
    ),
  ];
  if (pc.vision) {
    tools.push({
      def: readTool,
      spec: {
        name: 'view_image',
        description: 'Attaches a local image file (by path) to the conversation so you can see it; it says the image\'s size. region [x, y, width, height] (in its pixels) shows that part enlarged, to read small text and check details.',
        parameters: obj({ path: { type: 'string' }, region: { type: 'array', items: { type: 'number' }, description: 'For one image: [x, y, width, height] in its pixels; that part comes back enlarged.' } }, ['path']),
      },
      normalize: (a) => ({ path: str(a, 'path'), region: nums(a.region) }),
    });
  }
  tools.push(checkBinding());
  if (pc.search === 'client') {
    tools.push(webSearchBinding(
      'web_search',
      'Searches the web with several engines and quotes what the top pages say on the query. For anything current or uncertain: facts, prices, schedules, news, documentation, unfamiliar errors; web_fetch reads a result in full.',
    ));
  }
  addProjectTools(tools, pc);
  if (pc.role === 'explore') return tools.filter((t) => ['shell_command', 'read_file', 'background_job', 'web_fetch', 'view_image', 'web_search', 'browser', 'symbols', 'watch'].includes(t.spec.name));
  if (pc.role === 'general') return tools;
  tools.push(
    {
      def: todoTool,
      spec: {
        name: 'update_plan',
        description: 'Updates the task plan. Provide an optional explanation and the full list of steps with their status; at most one step is in_progress at a time. Use it for work with three or more distinct steps and keep it current; skip it for small, focused changes.',
        parameters: obj(
          {
            explanation: { type: 'string' },
            plan: { type: 'array', items: obj({ step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['step', 'status']) },
          },
          ['plan'],
        ),
      },
      normalize: (a) => ({ todos: todos(a.plan ?? a.todos, 'step'), explanation: str(a, 'explanation', false) }),
    },
    taskBinding(
      'run_subagent', 'agent_type',
      'Runs a sub-agent with its own context for a self-contained job and returns its final report. agent_type "explore" researches read-only; "general" may edit the files you list. The sub-agent sees nothing of this conversation, so the prompt must be a complete brief. Several calls in one response run in parallel. The report ends with the files it changed and the commands it ran, as recorded: look at those changes before you build on them.',
    ),
    askBinding(
      'request_user_input',
      'Asks the user up to four multiple-choice questions and waits for the answers. Only for choices that materially change the work and cannot be settled from the request or the code.',
    ),
    {
      def: planTool,
      spec: { name: 'exit_plan_mode', description: 'In plan mode, presents the finished plan (markdown) to the user for approval.', parameters: obj({ plan: { type: 'string' }, steps: PLAN_STEPS }, ['plan']) },
      normalize: (a) => ({ plan: str(a, 'plan'), steps: strs(a.steps) }),
    },
  );
  return tools;
}

/**
 * Favilla's own surface, the same for every model: fewer tools that each do more, described in as few
 * tokens as they need (the schemas are re-read on every step). One read for any number of files and line
 * ranges, one search for contents and names, edit for exact replacements (several per call, all or
 * nothing) next to apply_patch for changes across files, one job tool for background commands.
 */
function favillaProfile(pc: ProfileContext): ToolBinding[] {
  const tools: ToolBinding[] = [
    {
      def: shellTool,
      spec: {
        name: 'shell',
        description: `Runs a command in ${pc.shell.label}; returns its output, then the exit code and time. Each call starts in the working directory (or workdir); stdin is closed, so use non-interactive flags. ${scriptGuidance(pc.shell)} timeout_ms: default ${pc.timeoutMs}, max 600000. background=true starts servers, watchers and programs that ask questions; follow them with job. Long output is cut in the middle and saved to a file. before: run it on the code as it was before this session's changes (your test files kept), to compare what your change did. meets: the criteria a test or check command proves.`,
        parameters: obj({ command: { type: 'string' }, description: DESCRIBE, workdir: { type: 'string' }, timeout_ms: { type: 'integer' }, background: { type: 'boolean' }, before: { type: 'boolean' }, meets: MEETS }, ['command']),
      },
      normalize: (a) => ({
        command: str(a, 'command'),
        description: str(a, 'description', false),
        workdir: str(a, 'workdir', false),
        timeoutMs: num(a, 'timeout_ms') ?? num(a, 'timeout'),
        background: bool(a, 'background') ?? bool(a, 'run_in_background'),
        before: bool(a, 'before'),
        format: 'favilla',
      }),
    },
    {
      def: jobTool,
      spec: {
        name: 'job',
        description:
          'A command started with background=true. output: new output (filter: regex). input: send text to stdin (end lines with \\n), get the reply. wait: until output matches the regex until, or the job ends (timeout_ms, default 30 s). kill: stop it.',
        parameters: JOB_PARAMS,
      },
      normalize: jobArgs,
    },
    {
      def: readManyTool,
      spec: {
        name: 'read',
        description: `Reads files with line numbers (cat -n; the prefix is not part of the file). Pass all paths you need in one call (up to 40 files, folders or ranges) rather than splitting across turns, each under "==> path <=="; a path may carry a range, "src/app.ts:120-200" (up to 2000 lines). A file over 400 lines read without a range comes back as its first 80 lines and the lines where its definitions start; read the ranges you need from there. Folders list their entries, notebooks show their cells, PDFs are read as text by page (a range counts pages), and .docx, .xlsx and .pptx files as their text, headings and tables, each sheet with its formulas, each slide.${pc.vision ? ' Images are attached with their size; region [x, y, width, height] shows that part of each image enlarged.' : ''} outline: only the definitions (functions, classes, types, headings) with line numbers, to map a large file before reading a range.`,
        parameters: obj({ paths: { type: 'array', items: { type: 'string' } }, outline: { type: 'boolean' }, ...(pc.vision ? { region: { type: 'array', items: { type: 'number' }, description: '[x, y, width, height] in the pixels of the images read; that part of each comes back enlarged.' } } : {}) }, ['paths']),
      },
      normalize: (a) => {
        const paths = strs(a.paths) ?? strs(a.path) ?? strs(a.file_path);
        if (!paths) throw new ToolInputError('Give paths: the files to read.');
        return { paths, offset: num(a, 'offset'), limit: num(a, 'limit'), outline: bool(a, 'outline'), region: nums(a.region) };
      },
    },
    {
      def: searchTool,
      spec: {
        name: 'search',
        description:
          'ripgrep over the project (respects .gitignore). pattern: a regex over file contents; the matching lines come grouped under each file (mode "files": names only; "count": per file). glob: only files whose names match, e.g. "*.ts" or "src/**/*.{ts,tsx}"; alone, it lists them. context: lines around each match. limit: at most this many lines (300). query instead of pattern: what the code does in plain words ("where failed uploads are retried"); returns the definitions that match best, for when no exact word to grep is known.',
        parameters: obj(
          {
            pattern: { type: 'string' },
            query: { type: 'string' },
            glob: { type: 'string' },
            path: { type: 'string' },
            mode: { type: 'string', enum: ['content', 'files', 'count'] },
            context: { type: 'integer' },
            ignore_case: { type: 'boolean' },
            limit: { type: 'integer' },
          },
          [],
        ),
      },
      normalize: (a) => {
        const m = str(a, 'mode', false);
        return {
          pattern: str(a, 'pattern', false),
          query: str(a, 'query', false),
          glob: str(a, 'glob', false),
          path: str(a, 'path', false),
          mode: m === 'files' || m === 'files_with_matches' ? 'files' : m === 'count' ? 'count' : 'content',
          context: num(a, 'context'),
          ignoreCase: bool(a, 'ignore_case'),
          limit: num(a, 'limit'),
        };
      },
    },
    {
      def: editTool,
      spec: {
        name: 'edit',
        description:
          'Replaces exact text in a file. old_string must match the file exactly (copy it from read output without the line-number prefix) and be unique unless replace_all; add surrounding lines to make it unique. Several changes to one file: pass edits, applied in order; the ones that match are written and one that does not is named.',
        parameters: obj(
          {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
            edits: { type: 'array', items: obj({ old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['old_string', 'new_string']) },
          },
          ['path'],
        ),
      },
      normalize: (a) => {
        const edits = Array.isArray(a.edits)
          ? a.edits.map((e, i) => {
              const o = (e ?? {}) as Record<string, unknown>;
              if (typeof o.old_string !== 'string' || typeof o.new_string !== 'string') throw new ToolInputError(`Edit ${i + 1} needs old_string and new_string.`);
              return { old: o.old_string, new: o.new_string, all: o.replace_all === true };
            })
          : undefined;
        if (!edits?.length && typeof a.old_string !== 'string') throw new ToolInputError('Give old_string and new_string, or edits.');
        return {
          path: targetPath(a),
          old: typeof a.old_string === 'string' ? a.old_string : '',
          new: typeof a.new_string === 'string' ? a.new_string : '',
          all: bool(a, 'replace_all'),
          edits: edits?.length ? edits : undefined,
          requireRead: false,
        };
      },
    },
    {
      def: writeTool,
      spec: { name: 'write', description: 'Creates a file, or replaces the whole of one you have read.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
      normalize: (a) => ({ path: targetPath(a), content: typeof a.content === 'string' ? a.content : (str(a, 'content') ?? '') }),
    },
    {
      def: patchTool,
      spec: {
        name: 'apply_patch',
        description: `Changes several files in one call. FREEFORM: send the patch text, not JSON.
*** Begin Patch
*** Update File: src/app.py
@@ def example():
-    pass
+    return 123
*** Add File: src/new.py
+print("hi")
*** Delete File: src/old.py
*** End Patch
"*** Move to: <path>" after an Update header renames the file. Hunk lines start with " ", "-" or "+"; keep 3 lines of context; "@@ <line>" locates a hunk.`,
        parameters: obj({ input: { type: 'string' } }, ['input']),
        freeform: { syntax: 'lark', definition: APPLY_PATCH_GRAMMAR },
      },
      normalize: (a) => ({ patch: typeof a.input === 'string' ? a.input : (str(a, 'patch', false) ?? str(a, 'input')) }),
    },
    ...(pc.notebooks ? [notebookBinding('plain')] : []),
    webFetchBinding(
      'web_fetch',
      "A web page as markdown: main text, PDFs, GitHub files/issues/PRs, Stack Overflow answers, package pages; JavaScript pages through a browser. Long pages come in parts with an outline (start: offset). prompt: only what it asks for.",
    ),
  ];
  tools.push(checkBinding());
  if (pc.search === 'client') {
    tools.push(webSearchBinding(
      'web_search',
      'Searches the web (several engines, copy sites left out) and quotes what the top pages say on the query. For anything current or uncertain: facts, prices, schedules, news, docs, unfamiliar errors; web_fetch reads a result in full.',
    ));
  }
  addProjectTools(tools, pc);
  if (pc.role === 'explore') return tools.filter((t) => ['shell', 'job', 'read', 'search', 'web_fetch', 'web_search', 'browser', 'symbols', 'watch'].includes(t.spec.name));
  if (pc.role === 'general') return tools;
  // No plan tool of its own: the criteria are the checklist, milestones on long work (one list, not two).
  tools.push(
    taskBinding(
      'agent', 'type',
      `A sub-agent for a self-contained job; only its report comes back, ending with the files it changed and the commands it ran as Favilla recorded them. type explore: research that only looks; general: may also edit the files you list. It sees nothing of this conversation, so the prompt is its whole brief: the goal, what you know, where to look, what to report. Several calls run in parallel. Look at what it changed before you build on it.`,
    ),
    askBinding(
      'ask',
      'Asks the user up to four multiple-choice questions and waits. Only for choices that change the work and that neither the request nor the files settle.',
    ),
    {
      def: planTool,
      spec: { name: 'present_plan', description: 'In plan mode: shows your finished plan (markdown) to the user for approval.', parameters: obj({ plan: { type: 'string' }, steps: PLAN_STEPS }, ['plan']) },
      normalize: (a) => ({ plan: str(a, 'plan'), steps: strs(a.steps) }),
    },
  );
  return tools;
}

export function buildTools(profile: ToolProfileName, pc: ProfileContext): ToolBinding[] {
  const built = profile === 'favilla' ? favillaProfile(pc) : profile === 'codex' ? codexProfile(pc) : claudeProfile(pc);
  if (pc.role === 'main') built.push(goalBinding(), reviewBinding(), briefBinding(), rememberBinding(), recallBinding());
  // The main agent's tools from extensions, each where it asks to be (packages/core/extensions).
  const tools = pc.role === 'main' ? withExtensionTools(built) : built;
  // Benchmarks run offline: a task's fix sits on its project's GitHub page, one fetch away.
  const online = process.env.FAVILLA_WEB_FETCH === 'off' ? tools.filter((t) => t.def !== webFetchTool) : tools;
  // FAVILLA_GOAL=off, for benchmarks that measure what the criteria tool is worth: no criteria tool and no meets on runs.
  return process.env.FAVILLA_GOAL === 'off' ? withoutGoal(online) : online;
}

function withoutGoal(tools: ToolBinding[]): ToolBinding[] {
  return tools
    .filter((t) => t.def !== goalTool)
    .map((t) => {
      const props = (t.spec.parameters as { properties?: Record<string, unknown> }).properties;
      if (!props?.meets) return t;
      const { meets: _, ...rest } = props;
      return { ...t, spec: { ...t.spec, description: t.spec.description.replace(/ meets: [^.]*\./, ''), parameters: { ...t.spec.parameters, properties: rest } } };
    });
}
