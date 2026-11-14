import hljs from 'highlight.js/lib/common';
import { marked, type Token, type Tokens } from 'marked';
import wrapAnsi from 'wrap-ansi';
import { bold, dim, ground, italic, link, paint, strike, underline, type Hue } from './theme';
import { cols } from './text';
import { t as tr } from './i18n';

const CLASS_HUES: [RegExp, Hue][] = [
  [/hljs-(keyword|built_in|selector-tag|literal|type)/, 'blue'],
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
          // The item's text is wrapped here, as the terminal would (by words, long runs broken), so that its later lines
          // hang under its text: wrapped by the terminal they ran back under the marker, and an item of two or three
          // lines ran into the next.
          const hang = ' '.repeat(cols(lead));
          // A task's own box is the marker drawn in front; marked also hands it over as a token of its own, which was
          // printed as "[x]" on a line of its own above the task.
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
      // Columns by display width: a Chinese character takes two.
      const widths = rows[0].map((_, i) => Math.min(40, Math.max(...rows.map((r) => cols(r[i] ?? '')))));
      const fmt = (r: string[]) => r.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - cols(c)))).join(paint('faint', ' │ '));
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
