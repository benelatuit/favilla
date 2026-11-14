import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Words made for other people (an email, a page, a document) that belong to the user alone: talk of being an AI or of
 * following instructions, Favilla's notes and ids, paths on this machine, the request's own sentences and the names of
 * what Favilla drew for the work (an art direction). Facts for the model; the user may have asked for any of them.
 */

/** What this session holds private: the user's words of this turn and the internal names Favilla gave the work. */
interface Private {
  asked: string[];
  names: string[];
}
const privateOf = new WeakMap<object, Private>();

export function keepPrivate(cp: object | undefined, add: { asked?: string; names?: string[] }): void {
  if (!cp) return;
  const p = privateOf.get(cp) ?? { asked: [], names: [] };
  if (add.asked?.trim()) p.asked = [add.asked];
  if (add.names) p.names = [...new Set([...p.names, ...add.names.filter((n) => n.trim().length >= 4)])];
  privateOf.set(cp, p);
}

const AI_SELF = /\b(?:as an AI|I am an AI|I'm an AI|an AI (?:language )?model|a (?:large )?language model|AI assistant|(?:generated|written) (?:by|with) (?:an )?(?:AI|ChatGPT|GPT|Favilla))\b|作为(?:一个|一名)?\s*(?:AI|人工智能)|我是(?:一个)?\s*(?:AI|人工智能)|AI\s*助手|人工智能助手|由\s*AI\s*(?:生成|撰写|编写)/i;
const ORDERS = /\b(?:as you requested|as requested by the user|per your (?:request|instructions)|the user (?:asked|wants|requested)|my instructions|(?:the|this|your) prompt)\b|根据(?:您|你)的(?:要求|指示)|按照(?:您|你)的(?:要求|指示)|用户(?:要求|希望|让我|的要求)|提示词/i;
const FAVILLA = /<\/?harness-note>|\b[st]0[a-z0-9]{18,}\b|\/undo\b/;
const MACHINE = /\b[A-Z]:\\(?:Users|Projects)\\|\/home\/[a-z_][\w-]*\//;

/** Words that tell the writer what to do: in a made thing they are the request showing through, where facts belong. */
const ASKING = /帮我|给我|替我|写|做|别|不要|要求|提示|风格|语气|口吻|\b(?:write|make|don't|do not|please|tone|style|sound like|keep it|mention|say that|tell (?:them|him|her))\b/i;

/** A stretch of `asked` that `text` repeats, 16 characters of CJK or eight words in a row, with an instruction in it. */
function copied(text: string, asked: string): string | null {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const t = flat(text).toLowerCase();
  const a = flat(asked);
  const pieces: string[] = [];
  if (/[㐀-鿿]/.test(a)) for (let i = 0; i + 16 <= a.length; i += 4) pieces.push(a.slice(i, i + 16));
  else {
    const words = a.split(' ');
    for (let i = 0; i + 8 <= words.length; i += 2) pieces.push(words.slice(i, i + 8).join(' '));
  }
  return pieces.find((p) => p.length >= 16 && ASKING.test(p) && t.includes(p.toLowerCase())) ?? null;
}

/** The private words in `text`, each as a short description with the words found. */
export function outboundLeaks(text: string, cp?: object, machinePaths = true): string[] {
  const out: string[] = [];
  const quote = (m: RegExpExecArray | null) => (m ? `"${m[0].slice(0, 60)}"` : '');
  const ai = AI_SELF.exec(text);
  if (ai) out.push(`talk of being an AI ${quote(ai)}`);
  const orders = ORDERS.exec(text);
  if (orders) out.push(`talk of the request or instructions ${quote(orders)}`);
  const favilla = FAVILLA.exec(text);
  if (favilla) out.push(`Favilla's own notes or ids ${quote(favilla)}`);
  const machine = machinePaths ? MACHINE.exec(text) : null;
  if (machine) out.push(`a path on this machine ${quote(machine)}`);
  const p = cp ? privateOf.get(cp) : undefined;
  for (const name of p?.names ?? []) if (text.toLowerCase().includes(name.toLowerCase())) out.push(`the internal name "${name}"`);
  for (const asked of p?.asked ?? []) {
    const piece = copied(text, asked);
    if (piece) out.push(`the request's own words "${piece}"`);
  }
  return out;
}

/** The words a page shows: no tags, scripts, styles or comments. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

const DOCS = new Set(['.html', '.htm', '.md', '.markdown', '.txt', '.eml']);

/** The line after writing a document made for readers, when it carries private words; '' otherwise. */
export function documentNote(file: string, content: string, cp?: object): string {
  const ext = path.extname(file).toLowerCase();
  if (!DOCS.has(ext)) return '';
  const html = ext === '.html' || ext === '.htm';
  // Notes and readmes of a code project may name its own paths; pages and letters never should.
  const found = outboundLeaks(html ? visibleText(content) : content, cp, html || ext === '.eml');
  return found.length ? `\n\nThis document is for its readers, and it carries words meant for the user alone: ${found.join('; ')}. Write those parts as the reader should see them, unless the user asked for these words.` : '';
}

const warned = new WeakMap<object, Set<string>>();

/** Before an email is saved or sent: what in it belongs to the user alone, once per draft. A draft sent again unchanged goes. */
export function mailHold(subject: string, body: string, cp?: object): string | null {
  const found = outboundLeaks(`${subject}\n${body}`, cp);
  if (!found.length) return null;
  const key = crypto.createHash('sha1').update(`${subject}\n${body}`).digest('hex');
  const seen = cp ? (warned.get(cp) ?? new Set<string>()) : new Set<string>();
  if (cp) warned.set(cp, seen);
  if (seen.has(key)) return null;
  seen.add(key);
  return `Not saved or sent yet: this email goes to other people, and it carries words meant for the user alone: ${found.join('; ')}. Write it as the user would, to its reader. If the user asked for exactly these words, send the same email again and it goes.`;
}
