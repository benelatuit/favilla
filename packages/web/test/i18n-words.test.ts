import { describe, expect, it } from 'vitest';
import { zh as web } from '../src/lib/i18n';
import { zh as terminal } from '../../cli/src/tui/i18n';

// The words of the /goal loop are being taken out on another branch and are not held to the rule here.
const LEAVING = /\/goal|goal|Goal|condition holds|until this holds|checks the condition|met after|Met$|Needs you|Last check|Round \{n\}|checklist/;

describe('the Chinese of both front ends', () => {
  for (const [name, table] of [
    ['page', web],
    ['terminal', terminal],
  ] as const) {
    const entries = Object.entries(table).filter(([k]) => !LEAVING.test(k));

    // 预设 and 提示词 are what the Chinese community of presets and prompts says (2026-11-06): they are
    // Chinese here, as the words no one says in Chinese stay English.
    it(`keeps the words developers say in English (${name})`, () => {
      const over = entries.filter(([, v]) => /智能体|子代理|主代理|分叉|技能/.test(v));
      expect(over).toEqual([]);
    });

    it(`has no full-width semicolon or bracketed aside (${name})`, () => {
      expect(entries.filter(([, v]) => /[；（）]/.test(v))).toEqual([]);
    });

    it(`sets an English word apart from the Chinese beside it (${name})`, () => {
      const tight = entries.filter(([, v]) => /[一-鿿](Agent|Prompt|Preset|Skills|MCP|API|CLI)|(Agent|Prompt|Preset|Skills|MCP|API|CLI)[一-鿿]/.test(v));
      expect(tight).toEqual([]);
    });
  }
});
