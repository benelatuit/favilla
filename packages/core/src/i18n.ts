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
  [settingsWords.start]: '{file} 第 {line} 行的 JSON 无效。修好之前，Favilla 使用默认设置。',
  [settingsWords.reload]: '{file} 第 {line} 行的 JSON 无效。Favilla 继续使用上次的设置。',
  [settingsWords.save]: '{file} 第 {line} 行的 JSON 无效。请修好后再保存。',
  [settingsWords.value]: '{file} 的 {key} 值无效。',
  [settingsWords.duplicate]: '{file} 中的 {key} 重复了。',
  [settingsWords.unreadable]: '无法读取 {file}。文件已保留。',
  [settingsWords.busy]: '无法保存 {file}。另一个进程正在保存，请重试。',
  [settingsWords.conflict]: '编辑期间，{file} 中的设置已更改。请加载文件中的值后继续。',
  [settingsWords.library]: '{file} 第 {line} 行的 JSON 无效。',
  [settingsWords.libraryValue]: '{file} 第 {line} 行的条目无效。',
  'Load file values': '加载文件中的值',
  'Open /settings again to load the file’s values.': '请重新打开 /settings，加载文件中的值。',
  [settingsWords.model]: '{file} 中的默认模型不可用。请选择其他模型。',
  'No persona': '不用人设',
  'No preset': '不用预设',
  'This model does not continue from a prefill; it is asked to begin with that text instead.': '这个模型不支持预填充，已改成要求它以这段文字开头。',
  'This provider takes no system messages inside a conversation; the preset\'s go as user messages.': '这个服务不接受对话中间的 system 消息，预设里的这些改用 user 发送。',
  'A reviewer checks the result against the brief ({n} of 2).': '正在对照需求简报检查成品，第 {n} 次，共 2 次',
  'Stopped: the model kept falling into repeating the same text.': '已停止：模型一再陷入重复输出。',
  'The background sub-agent "{n}" is done.': '后台子 Agent"{n}"已完成。',
  'Done in the background: {n}': '后台完成：{n}',
  'Background job {n} ended.': '后台任务 {n} 已结束。',
  'The model began repeating the same text over and over; that reply was stopped and dropped.': '模型开始反复输出同一段内容。这条回复已中止并丢弃。',
  'The connection kept dropping in the middle of the reply; what arrived is kept above. Send a message to go on.': '连接在回复中途反复断开，已收到的部分留在上面。发一条消息就能接着做。',
  'This model does not take effort {n}; switched to the nearest level it takes.': '这个模型不支持 {n} 档，已换成它支持的最近一档。',
  'This model takes no effort setting; sending without one.': '这个模型不能设置思考强度，已改为不带这个参数发送。',
  'The request was too large for this provider; older pictures stay out of its requests from now on.': '请求太大，这个服务商不收。之后发给它的请求会少带旧图片。',
  'The request was too large for this provider; compacting.': '请求太大，这个服务商不收。正在压缩对话。',
  '{n} writes shadow tests of this request from the request alone.': '{n} 正在根据需求编写 shadow tests。',
  'The shadow tests are still being written: they run on the change when they are ready.': 'shadow tests 还在编写，完成后会在改动上运行。',
  'The shadow tests failed on the change: the work goes on.': 'shadow tests 没有通过，继续修改。',
  'Compaction failed: {n}': '压缩失败：{n}',
  'Compacting context': '正在压缩上下文',
  Retrying: '正在重试',
  'Lost the connection to the provider; trying again ({n}).': '和供应商的连接断了，正在重试 {n}。',
  'The reply stopped coming; trying again ({n}).': '回复中断了，正在重试 {n}。',
  'The provider is limiting requests; trying again ({n}).': '供应商在限制请求频率，正在重试 {n}。',
  'The provider is busy or failing; trying again ({n}).': '供应商忙或出了故障，正在重试 {n}。',
  'The provider has no route to this model just now; trying again ({n}).': '供应商暂时连不上这个模型，正在重试 {n}。',
  'Thinking; this model does not show its thoughts': '正在思考，这个模型不显示思考过程',
  'Running the shadow tests another model wrote from the request': '正在运行另一个模型根据需求写的 shadow tests',
  'Waiting for you': '等你回复',
  Working: '工作中',
  'What should change? Nothing is touched until you approve the plan.': '想改什么？批准方案之前，项目不会有任何改动。',
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
