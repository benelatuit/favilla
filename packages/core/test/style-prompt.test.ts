import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerRules, designGuide, fill, promptAsset } from '../src/prompt/system';

// Every model writes to the user in one voice (prompts/voices), at the end of the main agent's system prompt as the
// user's instructions; a family whose own habits were measured gets a few lines more after the voice.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-style-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'AGENTS.md'), '# House rules\nKeep it short.\n');

const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'ds' }, { id: 'g' }, { id: 'z' }] }));
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  const models = { ds: { contextWindow: 128000, family: 'deepseek' }, g: { contextWindow: 128000, family: 'gpt' }, z: { contextWindow: 128000, family: 'minimax' } };
  fs.writeFileSync(path.join(process.env.FAVILLA_HOME!, 'config.json'), JSON.stringify({ model: 'fake/g', tools: 'favilla', providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models } } }));
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const HEAD = "# The user's instructions: how to write answers";
// The voice with the default layout filled in, as a session gets it.
const VOICE = fill(promptAsset('voices/favilla'), { format: promptAsset('answer-structured') });

describe('how answers are written', () => {
  it("is the chosen voice for every family, with a family's own lines after it when it has some", () => {
    expect(answerRules('gpt')).toBe(`${VOICE}

${promptAsset('style-gpt')}`);
    expect(answerRules('minimax')).toBe(VOICE);
    expect(answerRules('deepseek')).toBe(`${VOICE}

${promptAsset('style-deepseek')}`);
    expect(answerRules('glm', 'favilla')).toBe(`${VOICE}

${promptAsset('style-glm')}`);
    // A voice that is not there, or a name that would reach outside the folder, is the default.
    expect(answerRules('minimax', 'nope')).toBe(VOICE);
    expect(answerRules('minimax', '../base')).toBe(VOICE);
    expect(answerRules('../base')).toBe(VOICE);
  });

  it('lays answers out in parts, lists and tables by default, or in short paragraphs when the user sets plain', () => {
    expect(promptAsset('voices/favilla')).toContain('{{format}}');
    expect(VOICE).not.toContain('{{format}}');
    expect(VOICE).toContain('its parts open with bold labels');
    const plain = answerRules('minimax', undefined, 'plain');
    expect(plain).toBe(fill(promptAsset('voices/favilla'), { format: promptAsset('answer-plain') }));
    expect(plain).toContain('No tables, no headings, no bold labels.');
    expect(plain).not.toContain('a table, one row per thing');
    // Judgment, words and tone are the same in either layout.
    for (const kept of ['No dashes in anything you compose', 'Speak to the user as', 'Match your chat reply to the weight of the ask', 'cleaner alternative route']) {
      expect(VOICE).toContain(kept);
      expect(plain).toContain(kept);
    }
  });

  it('keeps persona overrides after the voice and layout rules in both structured and plain formats', async () => {
    const { buildSystemPrompt } = await import('../src/prompt/system');
    for (const answerFormat of ['structured', 'plain'] as const) {
      const sys = await buildSystemPrompt({
        cwd: project,
        model: { id: 'g', ref: 'fake/g', name: 'Fake G', provider: 'fake', family: 'gpt', contextWindow: 128000, maxOutput: 8192, vision: true, reasoning: true, toolProfile: 'favilla' } as never,
        shell: { name: 'pwsh', path: 'pwsh' } as never,
        config: { answerFormat } as never,
        role: 'main',
        autonomous: false,
        persona: { name: 'Ada', text: 'Name: Ada\n\nTemper and way of talking:\nDry and brisk.' },
      });
      const voiceAt = sys.indexOf(HEAD);
      const whoAt = sys.indexOf('# Who you are: Ada');
      const projAt = sys.indexOf('# Project instructions');
      expect(voiceAt).toBeGreaterThan(0);
      expect(whoAt).toBeGreaterThan(voiceAt);
      expect(projAt).toBeGreaterThan(whoAt);
      expect(sys).toContain("Where the character's way of talking differs from the rules on how to write answers above, the character's way wins.");
      expect(sys).toContain(answerFormat === 'plain' ? 'No tables, no headings, no bold labels.' : 'its parts open with bold labels');
    }
  });

  it("puts them after the defaults for every model, as the user's, with the project's files and then the environment after them", async () => {
    for (const model of ['fake/ds', 'fake/g', 'fake/z']) {
      const sys = (await rt.start({ cwd: project, model })).systemPrompt;
      const at = sys.indexOf(HEAD);
      expect(at, model).toBeGreaterThan(sys.indexOf('# Standards'));
      expect(sys.indexOf('# Project instructions'), model).toBeGreaterThan(at);
      expect(sys.indexOf('# Environment'), model).toBeGreaterThan(sys.indexOf('# Project instructions'));
      expect(sys.slice(at), model).toContain(VOICE);
      expect(sys.split(VOICE).length - 1, model).toBe(1);
    }
  });

  it("tells a model that cannot see to check pages by the browser's numbers, and one that can to look", () => {
    const blind = designGuide('browser', false);
    expect(blind).toContain('You cannot see pictures');
    expect(blind).toContain('open it with browser at 1280×800 and 390×844');
    expect(blind).not.toContain('Judge the pictures');
    const seeing = designGuide('browser', true);
    expect(seeing).toContain('verify with browser in one dual-width pass (check_widths: true');
    expect(seeing).not.toContain('You cannot see pictures');
    for (const g of [blind, seeing]) expect(g.match(/\{\{\w+\}\}/g) ?? []).toEqual([]);
  });

  it('leaves no placeholder unfilled, in the tools section either, on every tool surface', async () => {
    const file = path.join(process.env.FAVILLA_HOME!, 'config.json');
    const base = fs.readFileSync(file, 'utf8');
    try {
      for (const tools of ['favilla', 'claude', 'codex'] as const) {
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(base), tools }));
        const own = createRuntime(project, { interactive: false });
        try {
          const sys = (await own.start({ cwd: project, model: 'fake/g' })).systemPrompt;
          expect(sys.match(/\{\{\w+\}\}/g) ?? [], tools).toEqual([]);
          expect(sys, tools).toMatch(/Making or retouching a picture|Work on pictures with a script/);
        } finally {
          own.dispose();
        }
      }
    } finally {
      fs.writeFileSync(file, base);
    }
  });
});
