/**
 * Files an answer names, told apart from everything else with a dot in it: the name ends in a known source or text
 * extension, and outside code a folder comes before it (C:\work\app\main.go, src/store.ts:42, ./x.py), so that
 * `Session.fork`, a version or a domain stays as it is written. A line follows where the answer gives one: `:42`,
 * `:42-60`, `:42:7` (line and column) or `#L42-L60`.
 */
const EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|json5|md|mdx|py|pyi|ipynb|rs|go|java|kt|kts|scala|swift|mm|c|h|cc|cpp|cxx|hpp|hh|cs|fs|vb|rb|php|pl|lua|dart|ex|exs|erl|hs|ml|clj|jl|sql|graphql|gql|proto|html|htm|css|scss|sass|less|vue|svelte|astro|xml|yml|yaml|toml|ini|cfg|conf|properties|env|sh|bash|zsh|fish|ps1|psm1|bat|cmd|txt|log|csv|tsv|gradle|lock|tf|hcl|nix|zig|sol|wgsl|glsl|hlsl';

export interface FileRef {
  /** As the answer wrote it, without the line: relative to the session's project unless absolute. */
  path: string;
  line?: number;
  end?: number;
}

const LOCATION = String.raw`(?::(\d+)(?::\d+)?(?:\s?[-–]\s?(\d+))?|#L(\d+)(?:-L?(\d+))?)?`;
const ROOT = String.raw`(?:[A-Za-z]:[\\/]|\\\\|/|~[\\/]|\.{1,2}[\\/])`;
/**
 * The whole of an inline code span: a name with a known extension, folders optional. Spaces only in a Windows path
 * from its drive (C:\Program Files\…): a command such as `node dist/app.js` is no file.
 */
const IN_CODE = new RegExp(
  String.raw`^((?:[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*|${ROOT}?(?:[^\\/:*?"<>|\s]+[\\/])*)[^\\/:*?"<>|\s]*[\w)]\.(?:${EXTENSIONS}))${LOCATION}$`,
  'i',
);
/** A path in running text: at least one folder before the name, no spaces, not part of a longer word or URL. */
const IN_TEXT = new RegExp(String.raw`(?<![\w/\\.:@-])(${ROOT}?(?:[\w.@+()-]+[\\/])+[\w.@+()-]*\w\.(?:${EXTENSIONS}))${LOCATION}(?![\w/\\])`, 'gi');
/** A first folder that is a web address (github.com/…), not a folder on this computer. */
const DOMAIN = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|ai|co|cn|edu|gov|xyz|top|me|so|sh|page|site|cloud)[\\/]/i;

function located(path: string, m: RegExpExecArray, at: number): FileRef {
  const line = Number(m[at] ?? m[at + 2]) || undefined;
  const end = Number(m[at + 1] ?? m[at + 3]) || undefined;
  return { path, ...(line ? { line } : {}), ...(line && end && end > line ? { end } : {}) };
}

/** The file an inline code span names, if all of it is one: `src/store.ts:42`, `store.ts`, `C:\app\main.go`. */
export function fileInCode(text: string): FileRef | null {
  const m = IN_CODE.exec(text.trim());
  if (!m || DOMAIN.test(m[1]) || /^https?:/i.test(m[1])) return null;
  return located(m[1], m, 2);
}

/** Files written into running text, in order, with where each starts and ends in it. */
export function filesInText(text: string): (FileRef & { from: number; to: number })[] {
  const found: (FileRef & { from: number; to: number })[] = [];
  for (const m of text.matchAll(IN_TEXT)) {
    if (DOMAIN.test(m[1])) continue;
    // A path ending a sentence keeps the full stop outside it: the pattern stops before it already.
    found.push({ ...located(m[1], m as RegExpExecArray, 2), from: m.index!, to: m.index! + m[0].length });
  }
  return found;
}

/** The file a link points at when it is one on this computer: file:///…, a path, or a code file linkify took for a site. */
export function fileInLink(href: string, label: string): FileRef | null {
  let target = href.trim();
  if (/^file:/i.test(target)) {
    try {
      target = decodeURI(target.replace(/^file:\/\/\/?/i, ''));
    } catch {
      return null;
    }
    if (/^[a-z]:/i.test(target) === false && !target.startsWith('/')) target = `/${target}`;
  } else if (/^https?:\/\//i.test(target)) {
    // linkify reads "main.py" or "README.md" as a web address (.py and .md are countries): the label says otherwise.
    const bare = target.replace(/^https?:\/\//i, '');
    if (bare !== label.trim()) return null;
    target = bare;
  } else if (/^[a-z][\w+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;
  const hash = /#L(\d+)(?:-L?(\d+))?$/i.exec(target);
  const path = hash ? target.slice(0, hash.index) : target;
  const ref = fileInCode(path);
  if (!ref) return null;
  return hash ? { path: ref.path, line: Number(hash[1]), ...(hash[2] && Number(hash[2]) > Number(hash[1]) ? { end: Number(hash[2]) } : {}) } : ref;
}

/**
 * The path a link points at when it is a file on this computer of any other kind (a video, a picture, a PDF, a
 * spreadsheet): file:///…, a path from a drive, the root of a share or the home folder, or a relative path to a name
 * with an extension. A text file is a FileRef already (fileInLink). The page cannot follow such a link itself: it
 * read as a link and a click did nothing (2026-11-17, a link to an .mp4 the answer had just made).
 */
export function localTarget(href: string): string | null {
  let target = href.trim();
  if (/^file:/i.test(target)) {
    try {
      target = decodeURI(target.replace(/^file:\/\/\/?/i, ''));
    } catch {
      return null;
    }
    if (!/^[a-z]:/i.test(target) && !target.startsWith('/')) target = `/${target}`;
    return target.length > 1 ? target : null;
  }
  if (/^[a-z]:[\\/]/i.test(target) || /^\\\\[^\\]/.test(target) || /^~[\\/]/.test(target)) return target;
  // Anything else with a scheme, an address without one (//host), a place in the page, or one of the app's own.
  if (/^[a-z][\w+.-]*:/i.test(target) || /^(\/\/|#|\?|\/api\/)/.test(target)) return null;
  const path = target.replace(/[?#].*$/, '');
  if (DOMAIN.test(path) || !/[^\\/]\.[a-z0-9]{1,10}$/i.test(path)) return null;
  return path;
}

/** Files a click must not start: the folder they are in is shown instead. */
export const RUNS_WHEN_OPENED = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|cpl|hta|jar|lnk|url|reg|sh|app|command|desktop|appimage)$/i;
/** Pictures the server reads for the page (its /api/image). */
export const PICTURE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

/** The name a reference shows: the file's own, without its folders. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
