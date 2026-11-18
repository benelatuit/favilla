import crypto from 'node:crypto';
import fs from 'node:fs';
import { fill, promptAsset } from '../prompt/system';
import { confinedSkills, discoverSkills } from '../prompt/skills';
import type { Goal } from '../types';
import { asksForInterface } from './turn-checks';

/**
 * A brief for something that is made (a page, a picture, a film, a document, a game), and the review of the result
 * against it. Left to the prompt alone the model planned from what the words suggested, skipped the paint tool, ticked
 * its own criteria and stopped after minutes (2026-11-02). So a fresh agent finds out first what the request needs and
 * what good ones have, from real examples it looked at, and writes the bar; the maker builds to it; and only a second
 * fresh agent, judging the result alone, marks a criterion met. This was wish mode until 2026-11-11: the mode went, and
 * the maker now asks for the brief with a tool when a request needs one.
 */

export type Check = 'look' | 'run' | 'measure';

export interface Brief {
  /** The whole brief as written, for the maker. */
  text: string;
  objective: string;
  criteria: { text: string; check: Check }[];
  skills: string[];
  first?: string;
}

/** Reviews a brief gets before the report says what is still open. */
export const BRIEF_REVIEWS = 2;

/** Asks for a picture, a page, a film or another made thing a person looks at, where a look of its own matters. */
const PICTURES = /视频|动画|动图|短片|影片|宣传片|手书|海报|插画|插图|绘本|漫画|封面|图标|壁纸|贴纸|画|\bMV\b|\b(?:video|animation|animated|film|movie|clip|music video|poster|illustration|picture|painting|drawing|cover art|logo|icons?|wallpaper|comic|sticker|artwork)\b/i;

export function visualAsk(text: string): boolean {
  return PICTURES.test(text) || asksForInterface(text);
}

/**
 * Artwork to be painted, by its words: a poster, an illustration, a cover, a texture, a logo. Not a chart, and not
 * every interface: replayed on the first messages of 1,305 eval sessions, the picture words with every interface
 * request loaded paint 93 times for 21 uses; this rule, 55 for 24, missing none (2026-11-06).
 */
const ART = /海报|插画|插图|绘本|漫画|封面|壁纸|贴纸|纹理|贴图|配图|头图|缩略图|横幅|抠图|抠除|去背景|去底|透明底|画(?!布|面)|\b(?:posters?|illustrations?|pictures?|paintings?|drawings?|draw|sketch(?:es)?|cover(?: image| art)?|logos?|wallpapers?|comics?|stickers?|artwork|textures?|banners?|thumbnails?|header image|hero (?:image|art)|favicons?|app icons?)\b/i;
const CHART = /\b(?:charts?|graphs?|plots?|diagrams?)\b|图表|折线|柱状|饼图|流程图/i;
/** Words about a video's text (its description, title, subtitles), not the video: 17 of 17 such requests loaded film, watch and music for nothing. */
const VIDEO_TEXT = /\b(?:descriptions?|titles?|captions?|subtitles?|scripts?|comments?|summary|transcript)\b|简介|标题|字幕|文案|评论|脚本|总结/i;

export function asksForArt(text: string): boolean {
  return ART.test(text) && !CHART.test(text);
}

export function aboutVideoText(text: string): boolean {
  return VIDEO_TEXT.test(text);
}

/** Asks for something that moves: a film, an animation, a clip. */
const MOVING = /视频|动画|动图|短片|影片|宣传片|手书|片头|\bMV\b|\b(?:video|animation|animated|film|movie|clip|music video|trailer|title sequence|motion graphics?)\b/i;

export function asksForFilm(text: string): boolean {
  return MOVING.test(text);
}

/**
 * Asks for music: a score, a song, a soundtrack, a jingle, a game loop. Music, a song or a melody counts when it is
 * what is to be made ("write a song", "做一段旋律"), not when it is only the subject: a song's lyrics to print, a music
 * player or streaming app, music theory. Each of those loaded the music tool (5 of 30 coding tasks in one test, 2026-11-08).
 */
const MUSIC_NAMES = /配乐|作曲|编曲|背景乐|背景音乐|片头曲|片尾曲|主题曲|铃声|\bBGM\b|\b(?:soundtracks?|jingles?)\b/i;
const MUSIC_MADE = /\b(?:compose|write|make|create|generate|produce|record|render)\b(?:\s+[\w'-]+){0,3}?\s+(?:music|songs?|melod(?:y|ies))\b(?!\s+(?:player|streaming|app|application|theory|library|store|service|company|lyrics|title|list|playlist|database|catalog|metadata|search))|(?:写|做|作|谱|创作|生成|来)[一个首段支点]{0,3}(?:歌|曲子|音乐|旋律)(?!播放|软件|平台|网站|app|App|APP|列表|库|服务)/i;

export function asksForMusic(text: string): boolean {
  return MUSIC_NAMES.test(text) || MUSIC_MADE.test(text);
}

/**
 * Looks for a request for something people look at, from its own world. Left alone, a brief took the model's one look (painted, often
 * the same for every sample of a request); a look dealt from a fixed library was taken about half the time whether it
 * belonged or not: woodblock for a cyberpunk city, 剪纸皮影 for an AI's view of the world, and the library's
 * East Asian crafts made results look 老中. So a quick call lists eight looks from the subject's own world, marked by
 * how often makers land on each, and one of the rarer ones is drawn at random for the brief (2026-11-03: looks from
 * the subject 58% → 97%, distinct samples of one request 2.45 → 2.91 of 3).
 */
export interface Looks {
  /** What the request fixes, in its words. */
  fixed: string;
  looks: { look: string; from: string; often: boolean }[];
}

export function looksPrompt(request: string): string {
  return fill(promptAsset('brief-looks'), { request });
}

/** The looks call's reply: marks in English or Chinese, bold or not. */
export function parseLooks(text: string): Looks {
  const plain = text.replace(/\*+/g, '');
  const fixed = /^\s*FIXED:\s*(.*)$/m.exec(plain)?.[1]?.trim() ?? '';
  const looks = [...plain.matchAll(/^\s*\d+[.)、]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([^|\n]*?)\s*$/gm)].map((m) => ({ look: m[1], from: m[2], often: /often|常见|经常|常常|普遍/i.test(m[3]) }));
  return { fixed, looks };
}

/** One look drawn from the seed among those makers do not often land on, or among all when every one is common. */
export function drawLook(seed: string, looks: Looks['looks']): Looks['looks'][number] | null {
  const pool = looks.some((l) => !l.often) ? looks.filter((l) => !l.often) : looks;
  if (!pool.length) return null;
  return pool[parseInt(crypto.createHash('sha1').update(`${seed}:look`).digest('hex').slice(0, 8), 16) % pool.length];
}

/** The drawn look as the brief gets it, with what the request fixes before it. */
export function lookNote(fixed: string, l: { look: string; from: string }): string {
  return `The request fixes: ${fixed || 'nothing'}. Every direction keeps that. One of the three uses this look, drawn at random from eight that come from the request's own world, so that results do not all come out alike:\n${l.look} (from ${l.from})`;
}

/** The brief agent's task. */
export function briefPrompt(request: string, o: { cwd: string; files: string[]; look?: string | null; confine?: boolean }): string {
  const all = discoverSkills(o.cwd);
  const skills = (o.confine ? confinedSkills(all, o.cwd) : all).map((s) => `${s.name} (${s.description.slice(0, 160)})`);
  return fill(promptAsset('brief'), {
    request,
    project: o.files.length ? `${o.files.length} files, among them: ${o.files.slice(0, 30).join(', ')}` : 'empty',
    look: o.look ?? '',
    skills: skills.length ? skills.join('; ') : 'none',
  });
}

const field = (text: string, name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(text)?.[1]?.trim();

/** The brief in its fixed form, or null when it does not have one. */
export function parseBrief(text: string): Brief | null {
  const bar = /^BAR:\s*$([\s\S]*?)(?=^[A-Z][A-Z ]+:|$(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const criteria = [...bar.matchAll(/^\s*-\s*\[(look|run|measure)\]\s*(.+?)\s*$/gim)].map((m) => ({ check: m[1].toLowerCase() as Check, text: m[2] })).slice(0, 10);
  const kind = field(text, 'KIND');
  if (criteria.length < 3 || !kind) return null;
  const chosen = field(text, 'CHOSEN');
  // Names as words in the line: a brief may explain them ("motion、paint（先 motion……）"), and splitting on
  // punctuation then glued the explanation to the name.
  const skills = [...new Set((field(text, 'SKILLS') ?? '').toLowerCase().match(/[a-z][a-z0-9_-]*/g) ?? [])].filter((s) => s !== 'none');
  return {
    text: text.trim(),
    objective: `${kind}${chosen ? ` (${chosen.split('|')[0].trim()})` : ''}`.slice(0, 300),
    criteria,
    skills,
    first: field(text, 'FIRST'),
  };
}

/** The skills the brief names, in full, for the maker: what the brief says to read is not left to the maker to open.
 *  A confined run gets only those it could open itself. */
export function skillTexts(cwd: string, names: string[], confine = false): string {
  const all = discoverSkills(cwd);
  const found = (confine ? confinedSkills(all, cwd) : all).filter((s) => names.includes(s.name.toLowerCase()));
  return found
    .map((s) => {
      try {
        return `# Skill: ${s.name}\n${fs.readFileSync(s.path, 'utf8').replace(/^---[\s\S]*?---\s*/, '')}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/** The reviewer's task. */
export function reviewPrompt(request: string, brief: string, goal: Goal, changed: string[], scratch: string): string {
  return fill(promptAsset('brief-review'), {
    request,
    brief,
    criteria: goal.criteria.map((c, i) => `${i + 1}. [${c.check ?? 'look'}] ${c.text}`).join('\n'),
    changed: changed.length ? changed.join(', ') : 'none recorded',
    scratch,
  });
}

/** The reviewer's verdict per criterion and its gaps; criteria it gave no line for keep their state. */
export function parseReview(text: string): { verdicts: Map<number, { pass: boolean; why: string }>; gaps: string } {
  const verdicts = new Map<number, { pass: boolean; why: string }>();
  for (const m of text.matchAll(/^\s*(\d+)\s*[:.]\s*(PASS|FAIL)\b\s*[|:—-]?\s*(.*)$/gim)) verdicts.set(Number(m[1]), { pass: m[2].toUpperCase() === 'PASS', why: m[3].trim().slice(0, 300) });
  const gaps = /^GAPS:\s*$([\s\S]*)/m.exec(text)?.[1]?.trim() ?? '';
  return { verdicts, gaps };
}
