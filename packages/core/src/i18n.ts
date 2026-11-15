import { catastropheZh } from './guard/i18n';
import de from './locales/de';
import es from './locales/es';
import fr from './locales/fr';
import ja from './locales/ja';
import ko from './locales/ko';
import ptBR from './locales/pt-BR';
import ru from './locales/ru';
import zhTW from './locales/zh-TW';

export const settingsWords = {
  start: '{file} has invalid JSON on line {line}. Favilla is using the default settings until it is fixed.',
  reload: '{file} has invalid JSON on line {line}. The previous settings stay in use.',
  save: '{file} has invalid JSON on line {line}. Fix it before saving.',
  value: '{file} has an invalid value for {key}.',
  duplicate: 'The key {key} appears twice in {file}.',
  unreadable: 'Could not read {file}. It was kept.',
  busy: 'Could not save {file}. Another process is saving it. Try again.',
  conflict: 'The settings in {file} changed while you were editing. Load the file’s values to continue.',
  library: '{file} has invalid JSON on line {line}.',
  libraryValue: '{file} has an invalid entry on line {line}.',
  model: 'The default model in {file} is unavailable. Choose another model.',
} as const;

export interface SettingsMessage {
  key: string;
  vars: Record<string, string | number>;
}

export interface SettingsNotice extends SettingsMessage {
  id: string;
}

export function settingText({ key, vars }: SettingsMessage, translate: (key: string) => string = (key) => key): string {
  return translate(key).replace(/\{(\w+)\}/g, (whole, name: string) => Object.hasOwn(vars, name) ? String(vars[name]) : whole);
}

/** Words the terminal and the page use alike. Each keeps its own words where they differ. */
export const sharedZh: Record<string, string> = {
  [settingsWords.start]: '{file} 第 {line} 行的 JSON 无效，修好前先使用默认设置。',
  [settingsWords.reload]: '{file} 第 {line} 行的 JSON 无效，继续使用原有设置。',
  [settingsWords.save]: '{file} 第 {line} 行的 JSON 无效，请修复后再保存。',
  [settingsWords.value]: '{file} 中的 {key} 值无效。',
  [settingsWords.duplicate]: '{file} 中的键 {key} 重复。',
  [settingsWords.unreadable]: '无法读取 {file}，原文件已保留。',
  [settingsWords.busy]: '无法保存 {file}，另一进程正在写入，请重试。',
  [settingsWords.conflict]: '编辑期间 {file} 已被修改，请重新加载文件内容后继续。',
  [settingsWords.library]: '{file} 第 {line} 行的 JSON 无效。',
  [settingsWords.libraryValue]: '{file} 第 {line} 行的条目无效。',
  'Load file values': '重新加载文件',
  'Open /settings again to load the file’s values.': '请重新打开 /settings 以加载最新设置。',
  [settingsWords.model]: '{file} 中的默认模型不可用，请选择其他模型。',
  'No persona': '不使用人设',
  'No preset': '不使用预设',
  'This model does not continue from a prefill; it is asked to begin with that text instead.': '当前模型不支持预填充，已改为要求以该段文字开头。',
  'This provider takes no system messages inside a conversation; the preset\'s go as user messages.': '当前供应商不支持对话内插入 system 消息，预设中的条目已改用 user 消息发送。',
  'A reviewer checks the result against the brief ({n} of 2).': '正在对照需求简报验收结果 · 第 {n}/2 次',
  'Stopped: the model kept falling into repeating the same text.': '已停止：模型持续重复输出同一内容。',
  'The background sub-agent "{n}" is done.': '后台 Sub-agent「{n}」已完成。',
  'Done in the background: {n}': '后台已完成：{n}',
  'Background job {n} ended.': '后台任务 {n} 已结束。',
  'The model began repeating the same text over and over; that reply was stopped and dropped.': '模型反复输出同一内容，已中止并丢弃该条回复。',
  'The connection kept dropping in the middle of the reply; what arrived is kept above. Send a message to go on.': '回复中途连接多次中断，已收到的内容保留在上方。发送消息即可继续。',
  'This model does not take effort {n}; switched to the nearest level it takes.': '当前模型不支持 {n} 思考强度，已切换至最接近的档位。',
  'This model takes no effort setting; sending without one.': '当前模型不支持设置思考强度，已忽略该参数。',
  'The request was too large for this provider; older pictures stay out of its requests from now on.': '请求超出供应商大小限制，后续请求不再附带较早的图片。',
  'The request was too large for this provider; compacting.': '请求超出供应商大小限制，正在压缩上下文。',
  '{n} writes shadow tests of this request from the request alone.': '{n} 正在根据需求独立编写 shadow tests。',
  'The shadow tests are still being written: they run on the change when they are ready.': 'shadow tests 还在编写，写好后会在本次改动上运行。',
  'The shadow tests failed on the change: the work goes on.': 'shadow tests 未通过，继续修复。',
  'Compaction failed: {n}': '压缩失败：{n}',
  'Compacting context': '正在压缩上下文',
  Retrying: '正在重试',
  'Lost the connection to the provider; trying again ({n}).': '与供应商连接中断，正在重试 · {n}',
  'The reply stopped coming; trying again ({n}).': '回复中断，正在重试 · {n}',
  'The provider is limiting requests; trying again ({n}).': '触发供应商限流，正在重试 · {n}',
  'The provider is busy or failing; trying again ({n}).': '供应商繁忙或故障，正在重试 · {n}',
  'The provider has no route to this model just now; trying again ({n}).': '供应商暂时无法连接该模型，正在重试 · {n}',
  'Thinking; this model does not show its thoughts': '正在思考 · 当前模型不返回思考过程',
  'Running the shadow tests another model wrote from the request': '正在运行另一模型编写的 shadow tests',
  'Waiting for you': '等待确认',
  Working: '运行中',
  'What should change? Nothing is touched until you approve the plan.': '请描述需求。批准规划前不会改动任何文件。',
  '{n} lines': '{n} 行',
  '{n} steps': '{n} 步',
  Settings: '设置',
  none: '无',
  Commands: '命令',
  Rules: '规则',
  Brief: '调研',
  'Reasoning effort': '思考强度',
  'Signed in': '已登录',
  '{n} requests': '{n} 次请求',
  'Stopped: {n}': '已停止：{n}',
  image: '图片',
  '{n} results': '{n} 条结果',
  '{n} passed': '{n} 项通过',
  '{n} files': '{n} 个文件',
  Context: '上下文',
};

/** The interface languages, English first. Each is offered under its own name. */
export const LANGUAGES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'pt-BR', 'fr', 'de', 'ru'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
};

/** "Switch to X" written in X, for someone who may not read the language the interface is in now. */
export const SWITCH_TO: Record<Language, string> = {
  en: 'Switch to English',
  'zh-CN': '切换到简体中文',
  'zh-TW': '切換到繁體中文',
  ja: '日本語に切り替える',
  ko: '한국어로 전환',
  es: 'Cambiar a español',
  'pt-BR': 'Mudar para português',
  fr: 'Passer en français',
  de: 'Auf Deutsch umstellen',
  ru: 'Переключить на русский',
};

export function isLanguage(v: unknown): v is Language {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

/**
 * The interface language for a system locale (zh-Hant-HK, ja_JP.UTF-8, pt-PT), or null when none is offered for it.
 * Chinese marked Hant or written in Taiwan, Hong Kong or Macau is Traditional; every Portuguese gets Brazil's.
 */
export function languageForLocale(locale: string | undefined): Language | null {
  const tags = (locale ?? '').split(/[.@]/)[0].replace(/_/g, '-').toLowerCase().split('-');
  switch (tags[0]) {
    case 'en':
      return 'en';
    case 'zh':
      return tags.some((tag) => ['hant', 'tw', 'hk', 'mo'].includes(tag)) ? 'zh-TW' : 'zh-CN';
    case 'pt':
      return 'pt-BR';
    case 'ja':
    case 'ko':
    case 'es':
    case 'fr':
    case 'de':
    case 'ru':
      return tags[0];
    default:
      return null;
  }
}

/** Where a word missing from a language is looked for next, before English: Traditional readers read Simplified. */
export const FALLBACK: Partial<Record<Language, Language>> = { 'zh-TW': 'zh-CN' };

/** The engine's words (settings notices, the backstop's reasons) in every language, for each front end to merge. */
export const coreWords: Partial<Record<Language, Record<string, string>>> = {
  'zh-CN': { ...catastropheZh, ...sharedZh },
  'zh-TW': zhTW,
  ja,
  ko,
  es,
  'pt-BR': ptBR,
  fr,
  de,
  ru,
};
