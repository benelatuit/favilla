import type { Language } from './i18n';

/**
 * What is wrong with a translation of an interface text, or null. Used where the translations are made
 * (scripts/translate-ui.mts) and by each front end's tests, so the two never hold different rules.
 */

const HAN = /\p{Script=Han}/u;

/** Characters written only in Simplified Chinese and common in an interface: none may stand in Traditional. */
const SIMPLIFIED = /[们这个设话时间动开关门发么说读写页图选择输错误认证删复链网络应显隐历记录统计费项进运没务从对单级态还样连传实现变换协议账户请备热点简体后扩块]/u;

/** What a translation must keep as written: placeholders, flags, commands, file names and anything in backticks. */
export function keptTokens(s: string): string[] {
  return [
    ...(s.match(/\{\w+\}/g) ?? []),
    ...(s.match(/(?<![\w/])--[a-z][\w-]*/g) ?? []),
    ...(s.match(/(?<![\w/.])\/[a-z][\w-]*/g) ?? []),
    ...(s.match(/\b[\w-]+\.(?:json|jsonl|md|ts|toml|yaml|txt)\b/g) ?? []),
    ...(s.match(/`[^`]+`/g) ?? []),
  ].sort();
}

export function translationProblem(lang: Language, en: string, text: unknown): string | null {
  if (typeof text !== 'string' || (!text.trim() && en.trim())) return 'empty';
  const got = keptTokens(text);
  const missing = keptTokens(en).filter((t) => !got.includes(t));
  if (missing.length) return `keep ${missing.join(' ')} exactly as written`;
  if (lang !== 'ja' && lang !== 'zh-TW' && lang !== 'zh-CN' && HAN.test(text) && !HAN.test(en)) return 'has Chinese characters';
  if (lang === 'zh-TW' && SIMPLIFIED.test(text)) return `uses the Simplified form ${text.match(SIMPLIFIED)![0]}`;
  return null;
}
