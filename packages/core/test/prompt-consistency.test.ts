import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forTools } from '../src/prompt/system';
import { findBrowser } from '../src/tools/browser';

// A prompt that names a tool the session does not have, or says something twice, or carries a line cut mid-word,
// fails here instead of reaching sessions: with no browser found the prompt still sent pages to the browser and
// pictures to paint, attempts was offered outside git, and every system prompt carried cut first sentences such as
// "a textur e for each );" (2026-11-06).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-consistency-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const docs = path.join(home, 'docs');
const code = path.join(home, 'code');
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'notes.md'), '# Notes\n');
fs.mkdirSync(path.join(code, 'src'), { recursive: true });
fs.writeFileSync(path.join(code, 'package.json'), '{"name":"demo"}\n');
fs.writeFileSync(path.join(code, 'src', 'index.ts'), 'export const x = 1;\n');
execFileSync('git', ['init', '-q'], { cwd: code });

/** The messages of each chat request, in order; every reply is "ok". */
const asked: { role: string; content: unknown }[][] = [];
const fake = http.createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    asked.push(JSON.parse(body).messages);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 1 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  port = (fake.address() as AddressInfo).port;
});

afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A session's system prompt and tool list for one surface, folder and browser. */
async function built(tools: string, cwd: string, browser: boolean) {
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  const models = { m: { contextWindow: 128000, family: 'deepseek', vision: true } };
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m', tools, skills: false, ...(browser ? {} : { browserPath: path.join(home, 'no-browser.exe') }), providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models } } }),
  );
  const rt = createRuntime(cwd, { interactive: false });
  try {
    const s = await rt.start({ cwd, model: 'fake/m' });
    return { system: s.systemPrompt, specs: s.toolSpecs };
  } finally {
    rt.dispose();
  }
}

/** The tools that a line of the prompt may send the model to only when the session has them. */
const PRESENT_ONLY = ['browser', 'paint', 'attempts', 'symbols', 'check', 'AskUserQuestion', 'request_user_input', 'music', 'film', 'mail', 'computer', 'load_tools'];

describe('the prompt and the tools a session has', () => {
  it('keeps a line for a tool only when the tool is there, and its negation only when it is not', () => {
    const text = 'a\n[paint] use paint\n[!paint] use a script\n[browser] open it\nb';
    expect(forTools(text, ['paint'])).toBe('a\nuse paint\nb');
    expect(forTools(text, ['browser'])).toBe('a\nuse a script\nopen it\nb');
    expect(forTools(text)).toBe('a\nuse paint\nopen it\nb');
  });

  for (const surface of ['favilla', 'claude', 'codex']) {
    for (const [where, cwd] of [['a folder of documents', docs], ['a code project in git', code]] as const) {
      for (const browser of [true, false]) {
        it.skipIf(browser && !findBrowser())(`names only tools it has: ${surface} surface, ${where}, ${browser ? 'with' : 'without'} a browser`, async () => {
          const { system, specs } = await built(surface, cwd, browser);
          const names = specs.map((s) => s.name);
          expect(system).not.toMatch(/\{\{\w+\}\}/);
          // "write its criteria with criteria", "ask with ask": a placeholder filled with a tool name the words around it say.
          const named = names.filter((n) => /^\w+$/.test(n)).join('|');
          expect(system.match(new RegExp(`\\b(${named}) with (?:the )?\\1\\b`, 'g'))).toBeNull();
          // The section that sends the model to tools; elsewhere "the browser" or "their mail" are things, not tools.
          const section = /^# Tools\n[\s\S]*?(?=^# )/m.exec(system)?.[0] ?? '';
          expect(section).not.toBe('');
          for (const tool of PRESENT_ONLY.filter((t) => !names.includes(t))) {
            const lines = section
              .split('\n')
              .filter((l) => new RegExp(`\\b${tool}\\b`).test(l) && !/^- No browser was found/.test(l) && !(tool === 'check' && /\bwant to check\b/.test(l)));
            expect(lines, `${tool} is not in the tool list`).toEqual([]);
          }
          expect(names.includes('attempts')).toBe(cwd === code);
          expect(names.includes('symbols')).toBe(cwd === code);
          expect(names.includes('check')).toBe(cwd === code);
          expect(names.includes('browser')).toBe(browser);
          // Every held-back tool's line is whole: a sentence or a word ended with an ellipsis, never cut mid-word.
          for (const s of specs.filter((x) => x.description.endsWith('Listed in short: load_tools gives its full instructions.'))) {
            const brief = s.description.replace(' Listed in short: load_tools gives its full instructions.', '');
            expect(brief, s.name).toMatch(/[.…]$/);
            expect(brief, s.name).not.toMatch(/\);|\(\w*$/);
          }
        });
      }
    }
  }

  // A provider caches a prompt up to its first difference: with the scratch path among the rules, a new session of
  // another project found only the first 3.2k tokens cached, and with the folder at the end of the system prompt
  // DeepSeek still found only the rules, not the tools it puts after them (2026-11-08).
  it('is the same text and the same tools in two code projects, the machine last', async () => {
    const other = path.join(home, 'other');
    fs.mkdirSync(path.join(other, 'cmd'), { recursive: true });
    fs.writeFileSync(path.join(other, 'go.mod'), 'module other\n\ngo 1.22\n');
    fs.writeFileSync(path.join(other, 'cmd', 'main.go'), 'package main\n');
    execFileSync('git', ['init', '-q'], { cwd: other });
    const [a, b] = [await built('favilla', code, false), await built('favilla', other, false)];
    expect(a.system.length).toBeGreaterThan(10_000);
    expect(a.system).toBe(b.system);
    expect(JSON.stringify(a.specs)).toBe(JSON.stringify(b.specs));
    expect(a.system.slice(a.system.lastIndexOf('\n# ') + 1)).toMatch(/^# Environment\nPlatform: .+\nDate: .+\nModel: /);
    expect(a.system).not.toContain('Working directory');
  });

  it("gives the folder's facts with the first message only", async () => {
    await built('favilla', code, false);
    const rt = createRuntime(code, { interactive: false });
    try {
      asked.length = 0;
      const s = await rt.start({ cwd: code, model: 'fake/m' });
      await s.send('Say ok.');
      await s.send('Once more.');
      const said = asked.map((m) => m.filter((x) => x.role === 'user').map((x) => String(x.content)));
      const forward = code.replace(/\\/g, '/');
      expect(said[0][0].startsWith(`<harness-note>Working directory: ${forward}\nScratch folder: `)).toBe(true);
      expect(said[0][0]).toMatch(/\nGit: repository at .+\n[\s\S]*\nTop-level entries: \.git\/, src\/, package\.json\n/);
      expect(said[0][0].endsWith('Say ok.')).toBe(true);
      // The second request sends the first message as it was, and the new one without them.
      expect(said[1][0]).toBe(said[0][0]);
      expect(said[1][1]).not.toContain('Working directory');
    } finally {
      rt.dispose();
    }
  });
});
