/**
 * A session's name, made on this computer from the user's first message: the sentence that says what the work is,
 * without the greeting and the "can you" before it, with paths cut to the file's name, short enough for the sidebar.
 * No model is asked. The name has to be there the moment the message goes, and asking a provider for it would cost
 * a request, wait on a relay and send the user's words to one more place.
 */
import { attachedPart, takePasted, typedPart } from '../prompt/attached';

/** Room for a name, in Latin letters: a CJK character or an emoji takes two. About what the title bar shows. */
const ROOM = 48;

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-｠￠-￦\p{Extended_Pictographic}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** The last part of a path, without what ends the sentence around it. */
function fileName(p: string): string {
  const bare = p.replace(/^["'<(]+|["'>),.;:!?]+$/g, '');
  return bare.split(/[\\/]/).filter(Boolean).pop() ?? bare;
}

/** A link as the thing it points at: the repository, the page or the issue, else the site. */
function linkName(raw: string): string {
  const url = raw.replace(/[),.;:!?'"]+$/, '');
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const last = parts.at(-1);
    if (last && /^\d+$/.test(last) && parts.length >= 3) return `${parts.at(-3)}#${last}`;
    if (last && !/^(?:index\.\w+|blob|tree|main|master)$/i.test(last)) return last.replace(/\.html?$/i, '');
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The words as they read: no code, no markup, links and paths as names. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/<(pasted|file|folder|element)\b[^>]*>[\s\S]*?<\/\1>/g, '\n')
    .replace(/https?:\/\/\S+/g, linkName)
    .replace(/(^|\s)@("[^"]+"|\S+)/g, (_, pre: string, p: string) => pre + fileName(p))
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/]{1,120}){2,}[\\/]?|(?<![\w.-])(?:[\w.-]{1,80}[\\/]){1,12}[\w-]{1,80}\.\w{1,8}/g, fileName)
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^[ \t]*(?:#+|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\/[a-z][\w-]*[ \t]+/i, '');
}

// What people say before the request and after it. Chinese has no spaces to mark a word, so a prefix that also
// begins ordinary words (请求, 给我们, 现在的) is cut only where those words cannot follow.
const LEAD = [
  // A greeting only with its comma or stop after it, so "OK button", "Hello world" and "Next.js" stay as they are.
  /^(?:hi|hello|hey|yo|ok(?:ay)?|alright|well|first|next|quickly)(?:\s*[,!]+\s*|\.\s+|\s*$)/i,
  /^(?:please|pls|kindly|so|now|then|and|also)(?:[\s,!]+|\.\s+|$)/i,
  /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:help\s+(?:me\s+)?(?:to\s+)?)?/i,
  /^(?:i(?:'d| would) like|i want|i need|i'd love)\s+(?:you\s+)?to\s+/i,
  /^(?:i(?:'d| would) like|i want|i need)\s+/i,
  /^(?:help\s+me\s+(?:to\s+)?|let'?s\s+|let us\s+|go ahead and\s+|try to\s+)/i,
  /^(?:你好|您好|嗨|哈喽|在吗|早上好|下午好|晚上好|好的|好吧|嗯|哦|那就|然后|接下来|另外|此外|顺便|请你|请(?![求教])|麻烦你|麻烦(?!的)|你帮我|帮我|帮忙|能不能|能否|可不可以|你能不能|你能|你可以|可以|我想让你|我想要|我想|我需要|我希望|给我(?!们)|替我|你来|看看|看一下|瞧瞧)[\s，,。！!、:：~～]*/,
  /^(?:现在|那|好|再)[，,、\s]+/,
];
const TAIL = /[\s，,。.!！?？~～]*(?:谢谢(?:你|啦|了)?|多谢|thanks?(?: you)?|thx|please|pls|吧|呢|吗|呀|啊|哈)?[\s，,。.;；:：!！?？~～、-]*$/i;

function trimFiller(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  for (let before = ''; before !== out; ) {
    before = out;
    for (const lead of LEAD) out = out.replace(lead, '');
    out = out.replace(TAIL, '').replace(/^[\s，,。.;；:：!！?？、-]+/, '').trim();
  }
  return out;
}

const GENERIC_EN = new Set(
  "a an the this that these those it its it's here there me my you your we our i please pls fix check look see help continue go on do does did again keep going find out figure make sure try run into error errors issue issues bug bugs problem problems thing things stuff what what's whats why how wrong is are was be with at in on of to for and or about".split(' '),
);
const GENERIC_ZH = /这个|那个|这些|那些|这里|那里|这|那|它|上面|下面|一下|问题|报错|错误|东西|看看|继续|怎么|为什么|什么|回事|修复|修改|修|改|弄|处理|帮|项目|代码|文件|的|了|吗|呢|吧|是|有|个|一|把|给|在|下|再|还/g;

/** Says nothing of what the work is about: "fix it", "继续", "看看这个报错". */
export function isVague(s: string): boolean {
  const words = (s.match(/[A-Za-z][\w'.#-]*/g) ?? []).filter((w) => !GENERIC_EN.has(w.toLowerCase()));
  const han = s.replace(GENERIC_ZH, '').match(CJK) ?? [];
  return words.length === 0 && han.length < 2 && !/\d{2,}/.test(s);
}

/** The first sentence that says what the work is; before a colon, only the part before it when that says it. */
function pick(typed: string): string {
  let first = '';
  for (const raw of plain(typed).split(/\n+|(?<=[。！？!?；;])|(?<=\.)\s+/)) {
    let s = trimFiller(raw ?? '');
    if (!s) continue;
    const colon = s.search(/[:：]/);
    if (colon > 0) {
      // A short head is a label ("Bug: …", "TypeError: …"), and the name needs what follows it.
      const head = trimFiller(s.slice(0, colon));
      if (head && !isVague(head) && (head.split(' ').length >= 3 || (head.match(CJK) ?? []).length >= 4)) s = head;
    }
    first ||= s;
    if (!isVague(s)) return s;
  }
  return first;
}

/** The line of a paste that names it: the error a log or a traceback ends in, or its first line. */
function headline(paste: string): string {
  const lines = paste
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const failure = /^(?:[\w$.]*(?:Error|Exception|Panic)\b|error(?:\[[\w-]+\])?\s*:|fatal\s*:|panic\s*:|FAIL\b)/;
  if (/^Traceback\b/.test(lines[0] ?? '')) {
    const last = lines.findLast((l) => failure.test(l));
    if (last) return last.slice(0, 400);
  }
  return (lines.find((l) => failure.test(l)) ?? lines[0] ?? '').slice(0, 400);
}

/**
 * Cut to the room. Where a clause ends inside it (a comma, a 、) the name stops there, whole; otherwise at the last
 * space, or between CJK characters, with an ellipsis for what is left out.
 */
function fit(s: string, room = ROOM): string {
  if (width(s) <= room) return s;
  const chars = [...s];
  let w = 0;
  let end = 0;
  let soft = 0;
  let clause = 0;
  for (; end < chars.length; end++) {
    const cw = WIDE.test(chars[end]) ? 2 : 1;
    if (w + cw > room - 1) break;
    w += cw;
    if (/[，、,;；]/.test(chars[end]) && !isVague(chars.slice(0, end).join(''))) clause = end;
    if (chars[end] === ' ') soft = end;
    else if (WIDE.test(chars[end])) soft = end + 1;
  }
  const trim = (n: number) => chars.slice(0, n).join('').replace(/[\s，,、;；:：-]+$/, '');
  if (clause && width(trim(clause)) >= room / 3) return trim(clause);
  return `${trim(soft > end / 2 ? soft : end)}…`;
}

// A sentence's first word takes a capital; a name the tools write in lower case (npm, git, vite) keeps it.
const STARTS = new Set(
  'a an the this that my our your it i we why how what when where which who can could does do did is are was should will add allow avoid build change check clean convert create debug delete explain find fix get give handle implement improve keep let list load make merge move optimize port remove rename replace review rewrite run save search send set show sort speed split stop support switch test tidy translate try turn undo update upgrade use write continue look go tell describe summarize draft plan design draw compare measure profile deploy install configure generate read open format port wire'.split(' '),
);

function finish(s: string, room = ROOM): string {
  const one = fit(s.replace(/\s+/g, ' ').trim(), room);
  return one.replace(/^([a-z][a-z']*)(?=[\s,]|$)/, (w) => (STARTS.has(w) ? w[0].toUpperCase() + w.slice(1) : w));
}

/** A name with the thing it is about after it, the name cut so that the thing still shows: "继续 · parse.ts". */
function withName(title: string, name: string): string {
  const tail = fit(name, 24);
  return `${finish(title.replace(/…$/, ''), Math.max(12, ROOM - width(tail) - 3))} · ${tail}`;
}

// Words that point at something outside the sentence: "How is this built? <link>".
const POINTS = /\b(?:this|that|these|those|it|here)\b|这|那|它/i;

/**
 * The name for a session whose first message is `text`. `vague` says the name tells little of the work, so the end
 * of the first turn may add the file it changed.
 */
export function sessionTitle(text: string): { title: string; vague: boolean } {
  // The name comes from the start of the message: a long one is read no further than this.
  const head = typedPart(text).slice(0, 4000);
  const typed = pick(head);
  const rest = attachedPart(text);
  const pastes = takePasted(text).pastes;
  const files = [...rest.matchAll(/<(?:file|folder) path="([^"]+)"/g)].map((m) => fileName(m[1]));
  if (typed && !isVague(typed)) {
    // A sentence that points at a link it does not name gets the link's name after it.
    const url = head.match(/https?:\/\/\S+/)?.[0];
    const link = url && linkName(url);
    if (link && !typed.includes(link) && POINTS.test(typed)) return { title: withName(typed, link), vague: false };
    return { title: finish(typed), vague: false };
  }
  const paste = pastes.map(headline).find(Boolean);
  if (paste) return { title: finish(trimFiller(plain(paste)) || paste), vague: false };
  if (files.length && typed) return { title: withName(typed, files[0]), vague: false };
  if (files.length) return { title: finish(files[0]), vague: false };
  // A message with neither words nor attachments, an image alone: the next message names the session.
  return { title: typed ? finish(typed) : '', vague: !!typed };
}

/** A vague name with the file the first turn changed after it: "继续 · parse.ts". */
export function titleWithFile(title: string, file: string): string {
  return withName(title, fileName(file));
}
