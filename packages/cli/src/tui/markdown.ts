import { createRequire } from 'node:module';
import { marked, type Token, type Tokens } from 'marked';
import wrapAnsi from 'wrap-ansi';
import { bold, dim, ground, italic, link, paint, strike, underline, type Hue } from './theme';
import { clip, cols } from './text';
import { t as tr } from './i18n';

type Hljs = typeof import('highlight.js/lib/common').default;
let hljsInstance: Hljs | null = null;
const localRequire = createRequire(import.meta.url);
function getHljs(): Hljs {
  if (!hljsInstance) {
    const mod = localRequire('highlight.js/lib/common') as Hljs | { default: Hljs };
    hljsInstance = 'highlight' in mod ? mod : mod.default;
  }
  return hljsInstance;
}

// Code is read for its names and values: keywords step back a grey and none of it is bold. Bold white keywords put
// the heaviest ink on `const` and `return`, and a diff or a code block read as a wall of them.
const CLASS_HUES: [RegExp, Hue][] = [
  [/hljs-(keyword|built_in|selector-tag|literal|type)/, 'muted'],
  [/hljs-(string|regexp|addition|attribute|symbol|bullet)/, 'green'],
  [/hljs-(number|meta|variable|template-variable)/, 'ink'],
  [/hljs-(title|section|name|selector-id|selector-class)/, 'ink'],
  [/hljs-(comment|quote|deletion)/, 'faint'],
];

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

/** highlight.js HTML → ANSI colours. */
export function highlight(code: string, lang?: string): string {
  let html: string;
  try {
    const hljs = getHljs();
    html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : hljs.highlightAuto(code).value;
  } catch {
    return paint('code', code);
  }
  const stack: Hue[] = [];
  let out = '';
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) stack.push(CLASS_HUES.find(([r]) => r.test(m![1]))?.[1] ?? stack[stack.length - 1] ?? 'code');
    else if (m[0] === '</span>') stack.pop();
    else if (m[2]) out += paint(stack[stack.length - 1] ?? 'code', decodeEntities(m[2]));
  }
  return out;
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'strong':
          return bold(inline((t as Tokens.Strong).tokens));
        case 'em':
          return italic(inline((t as Tokens.Em).tokens));
        case 'del':
          return strike(inline((t as Tokens.Del).tokens));
        case 'codespan':
          // Code in a sentence on a ground of its own, as a page sets it, rather than in a colour.
          return ground('code', paint('ink', decodeEntities((t as Tokens.Codespan).text)));
        case 'link': {
          const l = t as Tokens.Link;
          const label = inline(l.tokens);
          return label === l.href ? link(l.href, underline(paint('blue', l.href))) : `${link(l.href, underline(paint('blue', label)))}${dim(` (${l.href})`)}`;
        }
        case 'image': {
          // A terminal draws no pictures: the picture's words, and the file when it is one (a pic: name is the app's).
          const im = t as Tokens.Image;
          return dim(`[${tr('Image')}: ${im.text || im.href}${/^pic:/i.test(im.href) ? '' : ` ${im.href}`}]`);
        }
        case 'br':
          return '\n';
        case 'text':
          return (t as Tokens.Text).tokens ? inline((t as Tokens.Text).tokens) : decodeEntities((t as Tokens.Text).text);
        case 'escape':
          return (t as Tokens.Escape).text;
        default:
          return decodeEntities((t as { raw?: string }).raw ?? '');
      }
    })
    .join('');
}

function fitTableWidths(natural: number[], maxWidth: number): number[] {
  if (!natural.length) return natural;
  const separators = (natural.length - 1) * 3;
  const budget = Math.max(natural.length * 4, maxWidth - separators);
  const widths = [...natural];
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 4) break;
    widths[widest]--;
    total--;
  }
  return widths;
}

function block(t: Token, width: number, depth = 0): string {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      return bold(paint(h.depth <= 2 ? 'blue' : 'ink', inline(h.tokens)));
    }
    case 'paragraph':
      return inline((t as Tokens.Paragraph).tokens);
    case 'code': {
      const c = t as Tokens.Code;
      const body = highlight(c.text.replace(/\n$/, ''), c.lang?.split(/\s/)[0]);
      // A drafting-sheet frame: the language on the top rule, a gutter down the side.
      const top = paint('faint', `╭─${c.lang ? ` ${c.lang} ` : ''}`);
      return [top, ...body.split('\n').map((l) => `${paint('faint', '│ ')}${l}`), paint('faint', '╰─')].join('\n');
    }
    case 'blockquote':
      return (t as Tokens.Blockquote).tokens.map((x) => block(x, width, depth)).join('\n').split('\n').map((l) => `${paint('faint', '┃ ')}${italic(l)}`).join('\n');
    case 'list': {
      const l = t as Tokens.List;
      return l.items
        .map((item, i) => {
          const marker = item.task ? (item.checked ? paint('green', '☑') : paint('faint', '☐')) : l.ordered ? paint('muted', `${Number(l.start || 1) + i}.`) : paint('muted', depth % 2 ? '◦' : '•');
          const lead = `${'  '.repeat(depth)}${marker} `;
          const hang = ' '.repeat(cols(lead));
          const body = item.tokens
            .filter((x) => x.type !== 'checkbox')
            .map((x) =>
              x.type === 'text' || x.type === 'paragraph'
                ? wrapAnsi(inline((x as Tokens.Text).tokens ?? [x]), Math.max(10, width - hang.length), { hard: true })
                : block(x, width - hang.length, depth + 1),
            )
            .join('\n');
          return `${lead}${body.split('\n').join(`\n${hang}`)}`;
        })
        .join('\n');
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const rows = [tb.header.map((c) => inline(c.tokens)), ...tb.rows.map((r) => r.map((c) => inline(c.tokens)))];
      // Columns by display width: a Chinese character takes two, scaled cleanly on narrow terminals.
      const natural = rows[0].map((_, i) => Math.min(40, Math.max(1, ...rows.map((r) => cols(r[i] ?? '')))));
      const widths = fitTableWidths(natural, width);
      const fmt = (r: string[]) =>
        r
          .map((c, i) => {
            const cell = cols(c) > widths[i] ? clip(c, widths[i]) : c;
            return cell + ' '.repeat(Math.max(0, widths[i] - cols(cell)));
          })
          .join(paint('faint', ' │ '));
      return [bold(fmt(rows[0])), paint('faint', widths.map((w) => '─'.repeat(w)).join('─┼─')), ...rows.slice(1).map(fmt)].join('\n');
    }
    case 'hr':
      return paint('faint', '─'.repeat(Math.min(width, 60)));
    case 'space':
      return '';
    case 'html':
      return dim((t as Tokens.HTML).text.trim());
    default:
      return (t as { raw?: string }).raw ?? '';
  }
}

/** Markdown → ANSI text for the terminal. */
export function renderMarkdown(text: string, width = 100): string {
  const tokens = marked.lexer(text, { gfm: true });
  const parts: string[] = [];
  for (const t of tokens) {
    const s = block(t, width);
    if (t.type === 'space') continue;
    parts.push(s);
  }
  return parts.join('\n\n');
}
