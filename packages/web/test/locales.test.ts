import { describe, expect, it } from 'vitest';
import { catastropheZh } from '@favilla/core/guard/i18n';
import { LANGUAGES, languageForLocale, sharedZh, type Language } from '@favilla/core/i18n';
import { translationProblem } from '@favilla/core/i18n-check';
import { loadLanguage, translate, zh as web } from '../src/lib/i18n';
import { zh as terminal } from '../../cli/src/tui/i18n';

type Words = Record<string, string>;
const glob = <T,>(m: Record<string, T>) => m;
const tables = {
  core: { zh: { ...catastropheZh, ...sharedZh } as Words, files: glob(import.meta.glob<Words>('../../core/src/locales/*.ts', { eager: true, import: 'default' })) },
  web: { zh: web, files: glob(import.meta.glob<Words>('../src/locales/*.ts', { eager: true, import: 'default' })) },
  terminal: { zh: terminal, files: glob(import.meta.glob<Words>('../../cli/src/tui/locales/*.ts', { eager: true, import: 'default' })) },
};
const filled = LANGUAGES.filter((l): l is Exclude<Language, 'en' | 'zh-CN'> => l !== 'en' && l !== 'zh-CN');

describe('the interface in every language', () => {
  for (const lang of filled) {
    it(`${lang}: each line keeps what it must, and none is left over from text the interface no longer has`, () => {
      const problems: string[] = [];
      for (const [name, { zh, files }] of Object.entries(tables)) {
        const file = Object.entries(files).find(([f]) => f.endsWith(`/${lang}.ts`))?.[1];
        expect(file, `${name} has a file for ${lang}`).toBeDefined();
        for (const [en, text] of Object.entries(file!)) {
          if (!(en in zh)) problems.push(`${name}: no longer in the interface: ${en}`);
          const why = translationProblem(lang, en, text);
          if (why) problems.push(`${name}: ${why}: ${en}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('takes the language from the system’s locale, Traditional for Taiwan, Hong Kong and Macau', () => {
    expect(languageForLocale('zh-CN')).toBe('zh-CN');
    expect(languageForLocale('zh')).toBe('zh-CN');
    expect(languageForLocale('zh-Hans-SG')).toBe('zh-CN');
    expect(languageForLocale('zh-TW')).toBe('zh-TW');
    expect(languageForLocale('zh-HK')).toBe('zh-TW');
    expect(languageForLocale('zh-Hant')).toBe('zh-TW');
    expect(languageForLocale('ja_JP.UTF-8')).toBe('ja');
    expect(languageForLocale('pt-PT')).toBe('pt-BR');
    expect(languageForLocale('de-AT')).toBe('de');
    expect(languageForLocale('en-GB')).toBe('en');
    expect(languageForLocale('nl-NL')).toBeNull();
    expect(languageForLocale('C')).toBeNull();
    expect(languageForLocale(undefined)).toBeNull();
  });

  it('shows a language’s words once its table is here, English until then, and Simplified where Traditional has none', async () => {
    const key = 'New session';
    expect(translate('en', key)).toBe(key);
    expect(translate('zh-CN', key)).toBe(web[key]);
    await loadLanguage('de');
    expect(translate('de', key)).toBe(tables.web.files['../src/locales/de.ts'][key] ?? key);
    // A word Traditional Chinese lacks is looked for in Simplified before English.
    await loadLanguage('zh-TW');
    const missing = Object.keys(web).find((k) => tables.web.files['../src/locales/zh-TW.ts'][k] === undefined && !(k in tables.core.zh));
    if (missing) expect(translate('zh-TW', missing)).toBe(web[missing]);
  });
});
