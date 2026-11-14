import zlib from 'node:zlib';

/**
 * The text of a Word document, a spreadsheet or a deck, for read: headings, lists and tables of a .docx as markdown,
 * each sheet of an .xlsx as a grid with its formulas and dates, each slide of a .pptx. Before this a model had to
 * unzip them in a script of its own: on the general suite every .docx cost two python calls, and one memo run spent
 * 23 calls looking for a way to see its own file (2026-11-06).
 */
export const OFFICE_TYPES = new Set(['.docx', '.xlsx', '.pptx']);

/** The files in a zip, by name: stored or deflated entries, which is all Office writes. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const skip = nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + skip;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, zlib.inflateRawSync(data));
  }
  return files;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (m, hex, dec, name) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : (ENTITIES[name] ?? m)));
const cell = (s: string): string => s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
/** An attribute of an element's attribute text, wherever it stands among the others. */
const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function grid(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** A .docx body in order: headings as #, list items as -, tables as markdown. */
function docx(files: Map<string, Buffer>): string {
  const xml = files.get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('no word/document.xml');
  // Style ids are localized (a Chinese Word names Heading 1 "1"): their names say what they are.
  const names = new Map<string, string>();
  for (const m of (files.get('word/styles.xml')?.toString('utf8') ?? '').matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="([^"]+)"/g)) names.set(m[1], m[2].toLowerCase());
  const text = (x: string) => decode([...x.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\/>/g)].map((m) => (m[2] === 'tab' ? '\t' : m[2] === 'br' ? '\n' : m[1])).join(''));
  const paragraph = (p: string): string => {
    const t = text(p).trim();
    if (!t) return '';
    const id = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const style = names.get(id) ?? id.toLowerCase();
    const level = /^(?:heading|标题)\s*(\d)/.exec(style)?.[1] ?? (style === 'title' ? '1' : null);
    if (level) return `${'#'.repeat(Number(level))} ${t}`;
    return /<w:numPr>/.test(p) || /list/.test(style) ? `- ${t}` : t;
  };
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const out: string[] = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith('<w:tbl>')) {
      const rows = [...m[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((p) => text(p[0]).trim()).filter(Boolean).join(' / ')));
      if (rows.length) out.push(grid(rows));
    } else {
      const p = paragraph(m[0]);
      if (p) out.push(p);
    }
  }
  return out.join('\n\n');
}

/** A sheet column's letters as a number from 1. */
const column = (ref: string): number => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const letters = (n: number): string => (n > 26 ? letters(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26));

/** Each sheet of an .xlsx as a grid with row numbers and column letters; a formula with its last value, a date as a date. */
function xlsx(files: Map<string, Buffer>): string {
  const read = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const strings = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  // A number shown as a date: a built-in date format, or one of the workbook's own with d, m or y outside quotes.
  const styles = read('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\b([^>]*)>/g)].map((m) => [Number(attr(m[1], 'numFmtId')), decode(attr(m[1], 'formatCode') ?? '')]));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dated = [...xfs.matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].map((m) => {
    const id = Number(m[1]);
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmy]/i.test(code);
  });
  const asDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000)).toISOString().replace(/T00:00:00\.000Z$/, '').replace(/:00\.000Z$/, '').replace('T', ' ');
  // Attributes come in any order: openpyxl writes a relationship's Target before its Id.
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)>/g)].map((m) => [attr(m[1], 'Id'), (attr(m[1], 'Target') ?? '').replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/')]));
  const out: string[] = [];
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)>/g)) {
    const s = ['', attr(m[1], 'name') ?? '', attr(m[1], 'r:id') ?? ''];
    const sheet = read(rels.get(s[2]) ?? '');
    const rows: string[][] = [];
    let width = 0;
    let shown = 0;
    const all = [...sheet.matchAll(/<row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];
    for (const r of all.slice(0, 200)) {
      const line: string[] = [r[1]];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1] ?? letters(line.length);
        const type = /t="(\w+)"/.exec(c[1])?.[1];
        const style = Number(/s="(\d+)"/.exec(c[1])?.[1] ?? -1);
        const inner = c[2] ?? '';
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        const f = /<f(?:\s[^>]*)?>([^<]*)<\/f>/.exec(inner)?.[1];
        let value = v === undefined ? '' : type === 's' ? (strings[Number(v)] ?? '') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decode(v);
        if (type === 'inlineStr') value = decode([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(''));
        if (!type && v !== undefined && dated[style] && !Number.isNaN(Number(v))) value = asDate(Number(v));
        const col = column(ref);
        line[col] = f !== undefined ? `=${decode(f)}${value ? ` → ${value}` : ''}` : value;
        width = Math.max(width, col);
      }
      rows.push(line);
      shown++;
    }
    const head = ['', ...Array.from({ length: width }, (_, i) => letters(i + 1))];
    out.push(`## Sheet: ${decode(s[1])}${all.length > shown ? ` (first ${shown} of ${all.length} rows)` : ''}\n\n${rows.length ? grid([head, ...rows.map((r) => Array.from({ length: width + 1 }, (_, i) => r[i] ?? ''))]) : '(empty)'}`);
  }
  return out.join('\n\n');
}

/** Each slide's text in order. */
function pptx(files: Map<string, Buffer>): string {
  const slides = [...files.keys()].map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => Number(a[1]) - Number(b[1]));
  return slides
    .map((m) => {
      const xml = files.get(m[0])!.toString('utf8');
      const lines = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => decode([...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''))).filter((l) => l.trim());
      return `--- slide ${m[1]} of ${slides.length} ---\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

/** The text of an Office file, by its extension. */
export function officeText(buf: Buffer, ext: string): string {
  const files = unzip(buf);
  return ext === '.docx' ? docx(files) : ext === '.xlsx' ? xlsx(files) : pptx(files);
}
