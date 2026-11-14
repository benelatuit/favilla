/**
 * A file's outline: the lines that define things (functions, classes, types, methods, headings), with
 * their numbers. Pattern-based and language-aware enough to map a large file in a few hundred tokens, so
 * the next read can take just the range that matters.
 */

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'await', 'new', 'typeof', 'super', 'this']);

type Rule = RegExp | ((line: string) => boolean);

const JS: Rule[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace|module)\s+[A-Za-z_$]/,
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^(?:export\s+)(?:const|let|var)\s+[A-Za-z_$]/,
  // Methods in a class body: an indented name, its parameters and a body or a type.
  (l) => {
    const m = /^\s{2,4}(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::[^{;]+)?(?:\{\s*\}?)?\s*$/.exec(l);
    return !!m && !KEYWORDS.has(m[1]);
  },
];

const RULES: Record<string, Rule[]> = {
  js: JS,
  py: [/^\s*(?:async\s+)?def\s+\w+/, /^\s*class\s+\w+/],
  go: [/^func\s+/, /^type\s+\w+/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static|macro_rules!)\s*[\w<]/],
  java: [
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|override|virtual|async|partial|open|data)\s+)*(?:class|interface|enum|record|struct|object|fun)\s+\w+/,
    (l) => {
      const m = /^\s+(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.?\s]+?\s+(\w+)\s*\([^;]*$/.exec(l);
      return !!m && !KEYWORDS.has(m[1]);
    },
  ],
  rb: [/^\s*(?:class|module|def)\s+/],
  php: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait|enum)\s+\w+/],
  c: [/^(?:[A-Za-z_][\w\s*&<>:,]*?)\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, /^\s*(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+\w+/],
  md: [/^#{1,6}\s+\S/],
  css: [/^[^\s@][^{]*\{\s*$/, /^@media\b/],
};

const BY_EXT: Record<string, string> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', scala: 'java', swift: 'java', dart: 'java',
  rb: 'rb',
  php: 'php',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  md: 'md', mdx: 'md',
  css: 'css', scss: 'css', less: 'css',
};

const MAX_ENTRIES = 300;

/** The 0-based numbers of a file's lines that start a definition, or null when its language has no rules. */
export function definitionLines(text: string, ext: string): number[] | null {
  const rules = RULES[BY_EXT[ext.replace(/^\./, '').toLowerCase()] ?? ''];
  if (!rules) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || !line.trim() || /^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    if (rules.some((r) => (typeof r === 'function' ? r(line) : r.test(line)))) out.push(i);
  }
  return out;
}

/** The outline of a file's text, or null when its language has no rules. */
export function outline(text: string, ext: string): string | null {
  const rules = RULES[BY_EXT[ext.replace(/^\./, '').toLowerCase()] ?? ''];
  if (!rules) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length && out.length < MAX_ENTRIES; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || !line.trim() || /^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    if (!rules.some((r) => (typeof r === 'function' ? r(line) : r.test(line)))) continue;
    const shown = line.replace(/\s*\{\s*$/, '').replace(/\t/g, '  ').trimEnd();
    out.push(`${String(i + 1).padStart(6)}  ${shown.length > 140 ? `${shown.slice(0, 140)}…` : shown}`);
  }
  if (out.length >= MAX_ENTRIES) out.push(`        … more definitions; read a range to see the rest`);
  return out.join('\n');
}
