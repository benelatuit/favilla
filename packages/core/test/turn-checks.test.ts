import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { browserTool } from '../src/tools/browser';
import { isCheckCommand, isCode, languageOf, looksLikePlan, namesCode, printsFailure, runsSomething, statesStandingRule } from '../src/agent/turn-checks';
import { readMemory } from '../src/tools/memory';
import { findBrowser } from '../src/tools/browser';
const findBrowserForTest = () => !!findBrowser();

describe('turn checks, the parts', () => {
  it('read a failure from what a test run printed', () => {
    for (const out of ['--- FAIL: TestX (0.00s)\nFAIL', '    --- FAIL: TestX/sub (0.00s)', 'FAIL\tgithub.com/x/y\t0.1s', '=== 2 failed, 3 passed in 0.12s ===', '2 failed, 3 passed in 0.12s', 'FAILED tests/test_x.py::test_y - assert 1 == 2', 'FAILED (failures=1)', 'Tests:       1 failed, 2 passed, 3 total', ' Tests  1 failed | 2 passed (3)', '  1 failing', 'test result: FAILED. 1 passed; 1 failed'])
      expect(printsFailure('go test ./...', out)).toBe(true);
    for (const out of ['ok  \tgithub.com/x/y\t0.1s', '3 passed in 0.12s', 'Tests:       3 passed, 3 total', 'test result: ok. 3 passed; 0 failed', 'the FAIL case is covered'])
      expect(printsFailure('go test ./...', out)).toBe(false);
    expect(printsFailure('cat notes.txt', 'FAIL')).toBe(false);
  });

  it('recognizes Python tracebacks without mistaking explicit negative tests or log reads for failed runs', () => {
    const traceback = 'Traceback (most recent call last):\n  File "script.py", line 1, in <module>\nValueError: invalid';
    expect(printsFailure('python script.py; git diff', traceback)).toBe(true);
    expect(printsFailure('python script.py || true', traceback)).toBe(true);
    expect(printsFailure('node invokes-python.js; echo done', traceback)).toBe(true);
    expect(printsFailure('! python rejects-invalid.py', traceback)).toBe(false);
    expect(printsFailure('cat failures.log', traceback)).toBe(false);
    expect(printsFailure('python handles-invalid.py', 'Caught the expected ValueError')).toBe(false);
  });

  it('tell a request that names code from one that does not', () => {
    for (const t of ['Fix `load`', 'ParseTimeout returns 0', 'the parseTimeout helper', 'see settings.py', 'calling run() twice', 'the app_timeout key']) expect(namesCode(t)).toBe(true);
    for (const t of ['Make the page nicer.', 'What do you think about this plan?', '这个怎么修']) expect(namesCode(t)).toBe(false);
  });

  it('tell a plan from an answer', () => {
    expect(looksLikePlan('The plan, in order of risk, is short enough to fit on one page and leaves the public interface as it is today, which keeps every caller working.\n\n1. Add the parser in src/a.ts.\n2. Update the caller in src/b.ts.\n3. Add a test in test/a.test.ts.')).toBe(true);
    expect(looksLikePlan('## Plan: rename calcTotal\n\nThe function moves and every caller follows it, and the old name stays as a deprecated alias for one release so that nothing breaks while people move.\n\n- src/invoice.js\n- src/index.js\n- test/invoice.test.js')).toBe(true);
    expect(looksLikePlan('Each step of the load overrides the last, so changing the environment has no effect: this approach gives the file the final word, and the fix would be a small change to the order.\n\n1. defaults\n2. environment\n3. settings file')).toBe(false);
    expect(looksLikePlan('It reads the settings file last, so the file wins over the environment.')).toBe(false);
    expect(looksLikePlan('The config loads in three layers, and each one overrides what the layer before it set for the keys it names, which is why the value you saw came from the settings file.\n\n- defaults\n- environment\n- settings file')).toBe(false);
  });

  it('tell code from documents and runs from looking around', () => {
    expect(isCode('src/app.ts')).toBe(true);
    expect(isCode('lib/x.py')).toBe(true);
    expect(isCode('README.md')).toBe(false);
    expect(isCode('notes.txt')).toBe(false);
    expect(runsSomething('npm test')).toBe(true);
    expect(runsSomething('python -m pytest -q')).toBe(true);
    expect(runsSomething('go test ./...')).toBe(true);
    expect(runsSomething('git status')).toBe(false);
    expect(runsSomething('ls -la src')).toBe(false);
  });

  it('tell the language a message is written in, with code, links and quotes left out', () => {
    expect(languageOf('Fix the bug in `load` so the timeout is read from the settings file.')).toBe('English');
    expect(languageOf('这个报错是什么意思？\nError: ENOENT: no such file or directory, open config.json at Object.openSync')).toBe('Chinese');
    expect(languageOf('继续')).toBe('Chinese');
    expect(languageOf('Translate "你好" into English for the greeting.')).toBe('English');
    expect(languageOf('この関数は何をしますか')).toBe('Japanese');
    expect(languageOf('이 함수는 무엇을 하나요')).toBe('Korean');
    expect(languageOf('continue')).toBeNull();
    // Every language a user may write in, so the model is told which: Spanish and Russian came with none before.
    expect(languageOf('¿Por qué este código no funciona cuando cambio la configuración?')).toBe('Spanish');
    expect(languageOf('Hola, ¿puedes ayudarme?')).toBe('Spanish');
    expect(languageOf('Por que esse código não funciona quando eu mudo a configuração?')).toBe('Portuguese');
    expect(languageOf('Pourquoi ce code ne fonctionne pas quand je change la configuration ?')).toBe('French');
    expect(languageOf('Warum funktioniert der Code nicht, wenn ich die Einstellung ändere?')).toBe('German');
    expect(languageOf('Perché questo codice non funziona quando cambio la configurazione?')).toBe('Italian');
    expect(languageOf('Bu kod neden çalışmıyor, ayarı değiştirdiğimde hata veriyor')).toBe('Turkish');
    expect(languageOf('Tại sao đoạn mã này không chạy được khi tôi đổi cấu hình?')).toBe('Vietnamese');
    expect(languageOf('Почему этот код не работает, когда я меняю настройки?')).toBe('Russian');
    expect(languageOf('Чому цей код не працює, коли я змінюю налаштування?')).toBe('Ukrainian');
    expect(languageOf('لماذا لا يعمل هذا الكود عندما أغير الإعدادات؟')).toBe('Arabic');
    expect(languageOf('जब मैं सेटिंग बदलता हूँ तो यह कोड क्यों नहीं चलता?')).toBe('Hindi');
    // The user's own line over a pasted log, either way round.
    expect(languageOf('¿Por qué falla esto?\nError: ENOENT: no such file or directory, open config.json')).toBe('Spanish');
    expect(languageOf('Why does this fail?\nError: no se puede abrir el archivo de configuración')).toBe('English');
    expect(languageOf('Fix the bug where « le fichier » is read twice.')).toBe('English');
    expect(languageOf('```\npanic: runtime error: index out of range\n```')).toBeNull();
    // What sits between the user's first and last lines is often pasted.
    const issue = "Fix this issue from the project's tracker.\n\n# Archive decompression lacks output-size limits\n\n- [x] I have read the documentation.\n我已经阅读了文档。\n- [x] I'm sure there are no duplicate issues.\n我确定没有重复的问题。\n\nExtracting a small archive fills the disk.\n\nWork offline and fetch nothing.";
    expect(languageOf(issue)).toBe('English');
    expect(languageOf(`修一下这个问题：\n\n${issue}`)).toBe('Chinese');
    expect(languageOf('Error: ENOENT: no such file or directory\n    at Object.openSync (node:fs:573:18)\n这是什么意思')).toBe('Chinese');
    expect(languageOf('fix 一下这个 bug')).toBe('Chinese');
  });
});

// Whole turns against a scripted model server: what the agent answers, step by step, and what the checker says.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-checks-'));
process.env.FAVILLA_HOME = home;
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'check-fixture.cjs'), [
  "const which = process.argv[2];",
  "if (which === 'empty') console.log('ok example 0.1s [no tests to run]');",
  "if (which === 'pass') console.log('3 passed in 0.12s');",
  "if (which === 'printed-failure') console.log('--- FAIL: TestX');",
  "if (which === 'background') setTimeout(() => {}, 200);",
  "if (which === 'failed') process.exitCode = 1;",
].join('\n'));
fs.writeFileSync(path.join(project, 'check-pipe.sh'), 'exec yes\n');
const checkFixture = (which: string) => `node check-fixture.cjs ${which}`;

type Reply = { text?: string; call?: { name: string; args: Record<string, unknown> }; calls?: { name: string; args: Record<string, unknown> }[] };
let script: Reply[] = [];
let checker = 'VERDICT: COMPLETE';
/** What the design reviewer says, and for each review whether it was sent pictures. */
let designReply = 'No changes needed.';
const designSeen: boolean[] = [];
const seen: string[] = [];
/** The reasoning effort each request to the agent's model asked for. */
const efforts: (string | undefined)[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    const json = JSON.parse(body);
    const isChecker = JSON.stringify(json.messages?.[0] ?? '').includes('final answer covers every request');
    const isDesign = JSON.stringify(json.messages?.[0] ?? '').includes('senior product designer reviewing a page');
    const last = json.messages.at(-1);
    if (!isChecker) efforts.push(json.reasoning_effort);
    seen.push(isChecker ? 'checker' : typeof last.content === 'string' ? last.content.slice(0, 160) : JSON.stringify(last).slice(0, 160));
    if (isDesign) designSeen.push(JSON.stringify(json.messages?.[1] ?? '').includes('image_url'));
    const r: Reply = isChecker ? { text: checker } : isDesign ? { text: designReply } : (script.shift() ?? { text: 'Done.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const calls = r.calls ?? (r.call ? [r.call] : []);
    if (calls.length) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((c, k) => ({ index: k, id: `call_${seen.length}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt', efforts: ['low', 'medium', 'high'] }, eye: { contextWindow: 64000, family: 'gpt', vision: true }, ds: { contextWindow: 64000, family: 'deepseek', efforts: ['low', 'medium', 'high'] } } } } }),
  );
  rt = createRuntime(project, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('does not urge finishing after an empty test run following a source change', async () => {
  script = [
    { call: { name: 'write', args: { path: 'empty-run.ts', content: 'export const answer = 42;\n' } } },
    { call: { name: 'shell', args: { command: checkFixture('empty') } } },
    { text: 'The command ran no tests.' },
  ];
  const s = await rt.start({ cwd: project, model: 'fake/m1' });
  await s.send('Update the source and check it.');
  expect(JSON.stringify(s.messages)).not.toContain('That run passed after your change');
  expect(s.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result' && p.evidence?.run)?.type).toBe('tool_result');
  expect(s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result').some((p) => p.type === 'tool_result' && p.evidence?.run?.outcome === 'unknown')).toBe(true);
});

it('urges finishing after a passing run that follows a change to the project', async () => {
  script = [
    { call: { name: 'write', args: { path: 'finish-note.ts', content: 'export const answer = 42;\n' } } },
    { call: { name: 'shell', args: { command: checkFixture('pass') } } },
    { text: 'Changed and tested.' },
  ];
  const s = await rt.start({ cwd: project, model: 'fake/m1' });
  await s.send('Update the source and check it.');
  expect(JSON.stringify(s.messages)).toContain('That run passed after your change');
});

it('does not call a probe script in the scratch folder a change that passed', async () => {
  const { scratchDir } = await import('../src/prompt/system');
  script = [
    { call: { name: 'write', args: { path: path.join(scratchDir(project), 'repro.py').replace(/\\/g, '/'), content: 'print(1)\n' } } },
    { call: { name: 'shell', args: { command: checkFixture('pass') } } },
    { text: 'The tests pass as they are; nothing is fixed yet.' },
  ];
  const s = await rt.start({ cwd: project, model: 'fake/m1' });
  await s.send('Find out why the total is wrong.');
  expect(s.messages.flatMap((m) => m.parts).some((p) => p.type === 'tool_result' && p.evidence?.run?.outcome === 'passed')).toBe(true);
  expect(JSON.stringify(s.messages)).not.toContain('That run passed after your change');
});

const notes = (ms: { origin?: string; parts: { type: string; text?: string }[] }[]) => ms.filter((m) => m.origin === 'harness').map((m) => m.parts.map((p) => p.text ?? '').join(''));

describe('failed runs', () => {
  it('a missing executable keeps the set effort and gets an environment-specific next step', async () => {
    efforts.length = 0;
    script = [
      { call: { name: 'shell', args: { command: 'PATH=/__favilla_no_tools__ npm test' } } },
      { call: { name: 'shell', args: { command: 'PATH=/__favilla_no_tools__ npm test' } } },
      { text: 'The test runner was unavailable.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Run this command twice and report its outcome.');
    expect(efforts.every((e) => e === 'medium')).toBe(true);
    expect(JSON.stringify(s.messages)).toContain('executable and working directory');
  });

  it('a repeated failed text match changes nothing', async () => {
    efforts.length = 0;
    fs.writeFileSync(path.join(project, 'match.txt'), 'actual text\n');
    script = [
      { call: { name: 'read', args: { paths: ['match.txt'] } } },
      { call: { name: 'edit', args: { path: 'match.txt', old_string: 'missing text', new_string: 'replacement' } } },
      { call: { name: 'edit', args: { path: 'match.txt', old_string: 'missing text', new_string: 'replacement' } } },
      { text: 'The text did not match; nothing was changed.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Try these two replacements and report their outcome.');
    expect(efforts.every((e) => e === 'medium')).toBe(true);
    expect(fs.readFileSync(path.join(project, 'match.txt'), 'utf8')).toBe('actual text\n');
  });

  it('two failed runs in a row keep the set effort: a level changed mid-turn costs the whole prompt cache', async () => {
    efforts.length = 0;
    script = [
      { call: { name: 'shell', args: { command: 'node -e "process.exit(1)"' } } },
      { call: { name: 'shell', args: { command: 'node -e "process.exit(1)"' } } },
      { call: { name: 'shell', args: { command: 'node -e "process.exit(1)"' } } },
      { text: 'Every run fails; the script exits with 1 on purpose.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Run the script three times and tell me what it does.');
    expect(efforts).toEqual(['medium', 'medium', 'medium', 'medium']);
  });
});

describe('working evidence through real session transitions', () => {
  it('keeps scoped reads and runs through reopen and compaction, without side requests or rewriting history', async () => {
    const file = path.join(project, 'proof.ts');
    fs.writeFileSync(file, 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    script = [
      { call: { name: 'read', args: { paths: ['proof.ts:2-3'] } } },
      { call: { name: 'shell', args: { command: 'node -e "console.log(4)"' } } },
      { text: 'Read the two requested lines and ran the command.' },
    ];
    seen.length = 0;
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Read these lines and run the command.');
    expect(seen).toHaveLength(3);
    const original = structuredClone(s.messages);
    const historyFile = `${rt.store.dataDir(s.meta)}.jsonl`;
    const originalDisk = fs.readFileSync(historyFile, 'utf8');
    rt.store.flushIndex();
    rt.close(s.id);
    const reopened = await rt.get(s.id);
    expect(reopened.messages).toEqual(original);
    expect(fs.readFileSync(historyFile, 'utf8')).toBe(originalDisk);
    expect(reopened.files.coverage()).toEqual([{ path: file, total: 3, ranges: [[2, 3]] }]);
    expect(reopened.files.checkEditable(file)).toContain('not been read');
    script = [{ text: '<summary>Read two lines and ran the command.</summary>' }];
    expect(await reopened.compact('manual')).toBe(true);
    expect(seen).toHaveLength(4); // Only the requested compaction, no evidence-analysis request.
    const summary = reopened.messages.findLast((m) => m.origin === 'compaction')!;
    const text = summary.parts.map((p) => p.type === 'text' ? p.text : '').join('\n');
    expect(text).toContain('proof.ts: lines 2-3 of 3 (not read: 1)');
    expect(text).toContain('passed: node -e');
    expect(text).toContain('tracked inputs unchanged');
    expect(text).toContain('[.; tracked inputs unchanged');
    expect(fs.readFileSync(historyFile, 'utf8').startsWith(originalDisk)).toBe(true);
    expect(reopened.messages.slice(0, s.messages.length)).toEqual(s.messages);
    rt.close(reopened.id);
    expect((await rt.get(s.id)).files.coverage()).toEqual([{ path: file, total: 3, ranges: [[2, 3]] }]);
  });

  it('appends a stale-evidence note on resume and restores only reads before a fork point', async () => {
    const a = path.join(project, 'fork-a.ts');
    const b = path.join(project, 'fork-b.ts');
    fs.writeFileSync(a, 'export const a = 1;\n');
    fs.writeFileSync(b, 'export const b = 1;\n');
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    script = [{ call: { name: 'read', args: { paths: ['fork-a.ts'] } } }, { text: 'Read a.' }];
    await s.send('Read a.');
    const cut = s.messages.find((m) => m.origin === 'user')!.id;
    script = [
      { call: { name: 'read', args: { paths: ['fork-b.ts'] } } },
      { call: { name: 'shell', args: { command: 'node -e "console.log(1)"' } } },
      { text: 'Read b and ran the command.' },
    ];
    await s.send('Read b and run the command.');
    const branch = await rt.fork(s, cut, 'after');
    expect(branch.files.coverage().map((c) => c.path)).toEqual([a]);
    const history = structuredClone(s.messages);
    fs.writeFileSync(b, 'export const b = 2;\n');
    rt.store.flushIndex();
    rt.close(s.id);
    const resumed = await rt.get(s.id);
    expect(resumed.messages).toEqual(history);
    expect(resumed.files.coverage().map((c) => c.path)).toEqual([a]);
    script = [{ text: 'The old result predates the changed source.' }];
    await resumed.send('What was checked?');
    expect(resumed.messages.slice(0, history.length)).toEqual(history);
    const appended = JSON.stringify(resumed.messages.slice(history.length));
    expect(appended).toContain('Stored reads are stale');
    expect(appended).toContain('STALE after source changes');
  });

  it('does not mark a goal verified when check found no command', async () => {
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    s.setUserGoal('Verify the change', ['Run the project tests']);
    script = [
      { call: { name: 'check', args: { only: ['test'], meets: [1] } } },
      { text: 'No project test command is configured.' },
      { text: 'The criterion stays open because this project has no test command.' },
    ];
    await s.send('Run the project tests.');
    expect(s.meta.goal?.criteria[0].done).toBe(false);
  });

  it('does not mark a goal verified when before has no checkpoint to run', async () => {
    const root = path.join(project, 'empty-before');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    s.setUserGoal('Check the baseline', ['Run on the old source']);
    script = [
      { call: { name: 'check', args: { path: 'empty-before', only: ['test'], before: true, meets: [1] } } },
      { text: 'No checkpoint exists, so the old-source check did not run.' },
      { text: 'The criterion stays open.' },
    ];
    await s.send('Run on the old source.');
    expect(s.meta.goal?.criteria[0].done).toBe(false);
  });
});

describe('the code a request names', () => {
  it('is looked up ahead of the first request', async () => {
    const dir = fs.mkdtempSync(path.join(home, 'lookup-'));
    fs.writeFileSync(path.join(dir, 'config.go'), 'package config\n\n// ParseTimeout reads the timeout setting.\nfunc ParseTimeout(s string) int {\n\treturn 0\n}\n');
    script = [{ text: 'Found it.' }, { text: 'Hello.' }];
    const s = await rt.start({ cwd: dir, model: 'fake/m1', effort: 'medium' });
    await s.send('Why does `ParseTimeout` return zero?');
    expect(JSON.stringify(s.messages[0].parts)).toMatch(/config\.go:\d+ +func ParseTimeout/);
    await s.send('Thanks, that helps.');
    expect(JSON.stringify(s.messages.at(-2)!.parts)).not.toContain('word search');
  }, 30_000);
});

describe('something said for good', () => {
  it('keeps the complete report when the notes follow-up answers in text, without rewriting history', async () => {
    const report = 'The parser is fixed. Existing fixtures pass, and the changed file is parser.ts.';
    const followup = 'Those instructions applied only to this task, so I did not save a lasting note.';
    script = [{ text: report }, { text: followup }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Always keep the parser fixtures. Fix the parser.');
    expect(s.answer).toBe(`${report}\n\n${followup}`);
    const answers = s.messages.filter((m) => m.role === 'assistant');
    expect(answers).toHaveLength(2);
    expect(answers[0].parts).toContainEqual(expect.objectContaining({ type: 'text', text: report }));
    expect(answers[1]).toMatchObject({ supplementTo: answers[0].id });
    expect(answers[1].parts).toContainEqual(expect.objectContaining({ type: 'text', text: followup }));
    script = [{ text: 'The next answer.' }];
    await s.send('Explain the result.');
    expect(s.answer).toBe('The next answer.');
  });

  it('keeps the report after saving a note, but uses a new answer if the follow-up does actual work', async () => {
    const report = 'The parser is fixed and its fixtures pass.';
    script = [{ text: report }, { call: { name: 'remember', args: { note: 'Keep the parser fixtures.', scope: 'project' } } }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Always keep the parser fixtures. Fix the parser.');
    expect(s.answer).toBe(report);
    expect(script).toHaveLength(0);
    script = [{ text: report }, { call: { name: 'shell', args: { command: 'echo checked' } } }, { text: 'A new report after checking.' }];
    const t = await rt.start({ cwd: project, model: 'fake/m1' });
    await t.send('Always keep the parser fixtures. Fix the parser.');
    expect(t.answer).toBe('A new report after checking.');
  });

  it('does not hide a failed notes save behind an earlier completion report', async () => {
    const report = 'The parser is fixed; its fixtures pass. I have noted your preference.';
    const qualification = 'The note could not be saved, so that preference is not persisted.';
    script = [{ text: report }, { call: { name: 'remember', args: { note: '' } } }, { text: qualification }];
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Always keep the parser fixtures. Fix the parser.');
    expect(s.answer).toBe(`${report}\n\n${qualification}`);
    expect(s.messages.flatMap((m) => m.parts).some((p) => p.type === 'tool_result' && p.name === 'remember' && p.isError)).toBe(true);
  });

  it('is asked to be kept when the answer says it is noted and no note was saved, and not when one was', async () => {
    script = [{ text: '好的，以后都用中文回你，记下了。' }, { text: '已经存好了。' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('以后都用中文回我，英文看着累。');
    const asked = (x: typeof s) => JSON.stringify(x.messages).includes('no note was saved this turn');
    expect(asked(s)).toBe(true);
    script = [{ call: { name: 'remember', args: { note: 'The user wants answers in Chinese.', scope: 'global' } } }, { text: '记下了。' }];
    const t = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await t.send('以后都用中文回我。');
    expect(asked(t)).toBe(false);
  }, 30_000);
});

describe('a lasting rule', () => {
  it('is told from "after" in the middle of a sentence', () => {
    for (const m of ['以后都用中文回我', '好的。以后别再这样了', '对了，今后提交信息用英文']) expect(statesStandingRule(m)).toBe(true);
    for (const m of ['为什么手机充电到 80% 以后，就充得特别慢？', '改完以后跑一下测试', '吃完饭以后再说']) expect(statesStandingRule(m)).toBe(false);
  });

  it('is told from "always" and "never" as an order, from the user\'s own projects, and not from code', () => {
    for (const m of ['Always use pnpm in this repo.', 'Thanks. Never commit to master directly.', 'From now on, reply in Chinese.', 'Use tabs in all my projects.', 'Remember that the staging database is read-only.', "House rules for this project from now on, I won't repeat them:"])
      expect(statesStandingRule(m), m).toBe(true);
    for (const m of ['The first column is always the order date.', 'When a parse fails, the log should always show the line it failed on.', 'The seat number is always between 1 and the number of seats.', 'It works, but the check is repeated in every project.', 'Never mind, it works now.', 'Why does the linter fail on this?\n\n```yaml\nrules:\n  always-return: error\n```'])
      expect(statesStandingRule(m), m).toBe(false);
  });
});

describe('a turn of work that stops to ask leave', () => {
  const told = (x: { messages: unknown[] }) => JSON.stringify(x.messages).split('asks whether to go on').length - 1;
  it('is told once to go on, and an answer with no work is left to the user', async () => {
    script = [{ call: { name: 'shell', args: { command: 'echo one' } } }, { text: '第一部分改好了，要我继续改第二部分吗？' }, { text: '两部分都改好了。' }];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('把这两部分都改一下。');
    expect(told(s)).toBe(1);
    expect(JSON.stringify(s.messages.at(-1)!.parts)).toContain('两部分都改好了');
    // Once a turn: asking again ends it.
    script = [{ call: { name: 'shell', args: { command: 'echo two' } } }, { text: 'Next, I will update the docs.' }, { text: 'Shall I go on with the docs?' }];
    const t = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await t.send('Update the code and the docs.');
    expect(told(t)).toBe(1);
    script = [{ text: '这样改更稳。要我动手改吗？' }];
    const u = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await u.send('这个函数怎么改比较好？');
    expect(told(u)).toBe(0);
  }, 30_000);
});

describe('the language of each message', () => {
  it('is named beside the message for every model, since the answer rules all models share have Chinese examples', async () => {
    script = [{ text: 'Done.' }, { text: '好了。' }, { text: 'Done.' }];
    const s = await rt.start({ cwd: project, model: 'fake/ds', effort: 'medium' });
    await s.send('What does the timeout setting do?');
    expect(JSON.stringify(s.messages.at(-2)!.parts)).toContain('The user writes in English');
    await s.send('那这个设置在哪里改？');
    expect(JSON.stringify(s.messages.at(-2)!.parts)).toContain('The user writes in Chinese');
    const g = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await g.send('What does the timeout setting do?');
    expect(JSON.stringify(g.messages.at(-2)!.parts)).toContain('The user writes in English');
  }, 30_000);
});

describe('the word at the first passing run', () => {
  it('comes once, after a change, and costs no request', async () => {
    const dir = fs.mkdtempSync(path.join(home, 'finish-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const run = { call: { name: 'shell', args: { command: 'npm test' } } };
    script = [run, { call: { name: 'write', args: { path: 'a.js', content: 'module.exports = 1;\n' } } }, run, run, { text: 'Done.' }];
    const s = await rt.start({ cwd: dir, model: 'fake/m1', effort: 'medium' });
    await s.send('Add a.js.');
    const said = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'text' && p.text.includes('finish now'));
    expect(said).toHaveLength(1);
    expect(s.messages.filter((m) => m.origin === 'harness')).toHaveLength(0);
    // Outside a repository it lists the session's own files, and says whose the scratch folder is.
    expect(said[0].type === 'text' && said[0].text).toContain('Files you changed:\na.js\n');
    expect(said[0].type === 'text' && said[0].text).toContain('What is in the scratch folder can stay');
  }, 30_000);

  it('carries what git counts as changed, and comes again when a later run passes with more changed', async () => {
    const dir = fs.mkdtempSync(path.join(home, 'finish-git-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
    const run = { call: { name: 'shell', args: { command: 'npm test' } } };
    const write = (file: string) => ({ call: { name: 'write', args: { path: file, content: 'module.exports = 1;\n' } } });
    script = [write('a.js'), run, run, write('b.js'), run, run, { text: 'Done.' }];
    const s = await rt.start({ cwd: dir, model: 'fake/m1', effort: 'medium' });
    await s.send('Add a.js, then b.js.');
    const said = s.messages.flatMap((m) => m.parts).flatMap((p) => (p.type === 'text' && p.text.includes('finish now') ? [p.text] : []));
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('That run passed after your change.\nChanged in the folder now (git status --short):\n?? a.js\n');
    expect(said[1]).toContain('That run passed after your later changes.\nChanged in the folder now (git status --short):\n?? a.js\n?? b.js\n');
    expect(said[1]).not.toContain('scratch folder');
  }, 30_000);
});

describe('commands that check the work', () => {
  it('tell a command that checks from one that runs or looks', () => {
    expect(isCheckCommand('go test ./...')).toBe(true);
    expect(isCheckCommand('pnpm typecheck')).toBe(true);
    expect(isCheckCommand('python -m pytest -q')).toBe(true);
    expect(isCheckCommand('ls -la src')).toBe(false);
  });

  it('distinguishes check invocations from paths, comments, and quoted data', () => {
    for (const command of [
      'ls test', 'cat tests/a.py', 'mkdir tests', 'grep -rn foo test/', 'cd test && ls',
      'Get-Content -LiteralPath "test/slow.test.ts"; ls', 'git diff -- tests/test.sh',
      'echo "npm test; vitest run"', 'echo ok # go test; vitest run',
      'cat >script.sh <<EOF\ncd project && npm test\nEOF',
      'node app.js --test', 'python src/main.py tests/config.json', 'npm run serve -- --test',
      'python -c "print(\'pytest\')"', 'cat <<EOF\nassert 2 == 1\nEOF', 'test -d tests',
    ]) expect(isCheckCommand(command), command).toBe(false);
    expect(printsFailure('cat tests/output.log', '--- FAIL: TestX')).toBe(false);
    expect(printsFailure('cat tests/output.log', 'Traceback (most recent call last):\nValueError: old failure')).toBe(false);
    expect(runsSomething('ls test')).toBe(false);

    for (const command of [
      'npm test', 'node --test', 'python -m unittest', './test.sh', 'bash scripts/test.sh', 'make test',
      'bun test', 'deno test', 'swift test', 'mix test', 'rake test', 'zig build test', 'php artisan test',
      'cd x && npm test', 'PYTHONPATH=. python3 tests/test_suite.py', 'pnpm --filter web exec vitest run',
      'npm --prefix ./src run test:unit', 'npx --yes eslint src', 'go vet ./...', 'cargo check',
      'dotnet build', './gradlew check', './mvnw verify', 'go test ./... | tee test.log',
      'mvn package', 'make unitTests', './gradlew integrationTest', 'cargo +stable check', 'pnpm -r run typecheck',
      'python -m compileall -q src', 'node --check main.js', 'git diff --check', 'cmp -s before after',
      'python - <<\'PY\'\nassert check(2) == 3\nPY', "@'\nassert check(2) == 3\n'@ | python -",
      "$probe = @'\nassert check(2) == 3\n'@\n$probe | python -",
      'wsl.exe -d Ubuntu -e bash -lc \'cd app && timeout 30 ./suite-linux -test.run TestExample\'',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'cd app; node --test "test/*.test.ts"\'',
    ]) expect(isCheckCommand(command), command).toBe(true);
  });
});

describe('the goal kept without extra requests', () => {
  it('a run that printed failures, was cut short or went to the background marks nothing', async () => {
    script = [
      { call: { name: 'criteria', args: { objective: 'Make the tests pass', criteria: ['The unit tests pass'] } } },
      { call: { name: 'shell', args: { command: checkFixture('printed-failure'), meets: [1] } } },
      { call: { name: 'shell', args: { command: 'bash check-pipe.sh | head -n 1', meets: [1] } } },
      { call: { name: 'shell', args: { command: checkFixture('background'), background: true, meets: [1] } } },
      { text: 'Stopping here.' },
      { text: 'Stopping here.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Make the tests pass.');
    const results = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'shell') as { content: string; evidence?: { run?: { outcome: string } } }[];
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.content).toContain('stay open');
    expect(results[0].evidence?.run?.outcome).toBe('failed');
    expect(s.meta.goal!.criteria[0].done).toBe(false);
  }, 30_000);

  it('a run marks the criteria it names in meets when it passes, and leaves them open when it fails', async () => {
    script = [
      { call: { name: 'criteria', args: { objective: 'Make the tests pass', criteria: ['The unit tests pass', 'The linter is clean'] } } },
      { call: { name: 'shell', args: { command: checkFixture('failed'), meets: [1] } } },
      { call: { name: 'shell', args: { command: checkFixture('pass'), meets: [1, 2] } } },
      { text: 'Both pass.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium' });
    await s.send('Make the tests pass.');
    const results = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'shell') as { content: string }[];
    expect(results[0].content).toContain('(Goal criteria 1 stay open: this did not pass.)');
    expect(results[1].content).toContain('(Goal: marked 1, 2 met. Every criterion is met.)');
    expect(s.meta.goal!.criteria.map((c) => c.done)).toEqual([true, true]);
    expect(s.meta.goal!.criteria[0].evidence).toBe(`${checkFixture('pass')} exited 0`);
    // Nothing was left open, so no reminder about the goal.
    expect(notes(s.messages as never).some((n) => n.includes('still have open items'))).toBe(false);
  });

  // The goal note comes only on a run of its own: these sessions are autonomous.
  it('asked only to tick the goal, a reply that just ticks it ends the turn on the answer already given', async () => {
    seen.length = 0;
    script = [
      { call: { name: 'criteria', args: { objective: 'Explain the cache', criteria: ['Say where the cache lives'] } } },
      { text: 'The cache lives in ~/.cache/app.' },
      { call: { name: 'criteria', args: { done: [1], evidence: 'read src/cache.ts' } } },
      { text: 'Criterion 1 is met: the cache lives in ~/.cache/app.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium', autonomous: true });
    await s.send('Where does the cache live?');
    expect(notes(s.messages as never).filter((n) => n.includes('still have open items'))).toHaveLength(1);
    // Three requests: the goal, the answer, the tick. The answer is not asked for again.
    expect(seen.filter((x) => x !== 'checker')).toHaveLength(3);
    expect(script).toHaveLength(1);
    const last = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'))!;
    expect(last.parts.map((p) => (p as { text?: string }).text ?? '').join('')).toBe('The cache lives in ~/.cache/app.');
    expect(s.meta.goal!.criteria[0].done).toBe(true);
  });

  it('a reply to that note that does more than bookkeeping gets its own answer as before', async () => {
    seen.length = 0;
    script = [
      { call: { name: 'criteria', args: { objective: 'Explain the cache', criteria: ['Say where the cache lives'] } } },
      { text: 'The cache lives somewhere under the home folder.' },
      { call: { name: 'shell', args: { command: 'node -e "console.log(1)"' } } },
      { call: { name: 'criteria', args: { done: [1], evidence: 'ran it' } } },
      { text: 'It lives in ~/.cache/app.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium', autonomous: true });
    await s.send('Where does the cache live?');
    expect(seen.filter((x) => x !== 'checker')).toHaveLength(5);
    expect(s.messages.at(-1)!.parts.map((p) => (p as { text?: string }).text ?? '').join('')).toBe('It lives in ~/.cache/app.');
  });
});

describe('the goal kept without extra requests, when the reply plans more', () => {
  it('a reply to the goal note that sets new criteria is asked for its answer again', async () => {
    seen.length = 0;
    script = [
      { call: { name: 'criteria', args: { objective: 'Explain the cache', criteria: ['Say where the cache lives'] } } },
      { text: 'The cache lives in ~/.cache/app.' },
      { call: { name: 'criteria', args: { objective: 'Explain the cache', criteria: ['Say where the cache lives', 'Say when it is cleared'] } } },
      { call: { name: 'criteria', args: { done: [1, 2], evidence: 'read src/cache.ts' } } },
      { text: 'It lives in ~/.cache/app and is cleared on upgrade.' },
    ];
    const s = await rt.start({ cwd: project, model: 'fake/m1', effort: 'medium', autonomous: true });
    await s.send('Where does the cache live?');
    expect(seen.filter((x) => x !== 'checker')).toHaveLength(5);
    expect(s.messages.at(-1)!.parts.map((p) => (p as { text?: string }).text ?? '').join('')).toContain('cleared on upgrade');
  });
});

describe('the design guide for work people look at', () => {
  it('tells a request for a page, motion or a game from code work', async () => {
    const { asksForInterface } = await import('../src/agent/turn-checks');
    for (const yes of ['Make a snake game in this folder', 'Build a landing page for our coffee subscription', 'Add a fade-in animation to the cards', 'The dashboard looks cramped on phones', 'Polish the UI of the settings screen', '做一个打砖块小游戏', '这个页面在手机上布局乱了', '首页的动效太生硬了'])
      expect(asksForInterface(yes), yes).toBe(true);
    for (const no of ['Fix the parser so it accepts a Unicode minus', 'Add a Close method to the Store interface', 'The state transitions of the order machine are wrong', 'Speed up the HTML tokenizer', 'Rename the ui package import in main.go', '修一下解析器的边界情况'])
      expect(asksForInterface(no), no).toBe(false);
  });

  it('reads a request without what it rules out, so a line forbidding web pages asks for none', async () => {
    const { asksForInterface, withoutProhibitions } = await import('../src/agent/turn-checks');
    const offline = 'Fix the off-by-one in the tokenizer.\n\nWork offline. Fetch nothing from the internet (no curl, wget, outside APIs or web pages), and do not look for published fixes.';
    expect(asksForInterface(offline)).toBe(true);
    expect(asksForInterface(withoutProhibitions(offline))).toBe(false);
    for (const yes of ['Build a landing page, no frameworks', '做一个网页，不要用框架', '帮我做个不要太花哨的官网'])
      expect(asksForInterface(withoutProhibitions(yes)), yes).toBe(true);
    expect(asksForInterface(withoutProhibitions('修一下排序的 bug，不要改页面'))).toBe(false);
  });

  it('comes with the message, once, when the folder has no interface yet', async () => {
    const empty = fs.mkdtempSync(path.join(home, 'empty-'));
    script = [{ text: 'Here is the plan for the game.' }, { text: 'Added a second level.' }];
    const s = await rt.start({ cwd: empty, model: 'fake/m1', effort: 'medium' });
    await s.send('Make a breakout game here.');
    await s.send('Add a second level to the game.');
    const guides = s.messages.flatMap((m) => m.parts).filter((p) => p.type === 'text' && (p as { text: string }).text.includes('# Interfaces'));
    expect(guides).toHaveLength(1);
    expect((guides[0] as { text: string }).text).toContain('requestAnimationFrame');
  });

  it('is not added to code work', async () => {
    const empty = fs.mkdtempSync(path.join(home, 'empty-'));
    script = [{ text: 'Fixed.' }];
    const s = await rt.start({ cwd: empty, model: 'fake/m1', effort: 'medium' });
    await s.send('Fix the off-by-one in the pager.');
    expect(s.messages.flatMap((m) => m.parts).some((p) => p.type === 'text' && (p as { text: string }).text.includes('# Interfaces'))).toBe(false);
  });

  it('tells a page named from a game or a button that a program may only model', async () => {
    const { asksForInterface, namesInterface } = await import('../src/agent/turn-checks');
    for (const t of ['Score a curling game.', 'Work out who won a game of checkers.', 'The machine dispenses a drink when the button is pressed.']) {
      expect(asksForInterface(t), t).toBe(true);
      expect(namesInterface(t), t).toBe(false);
    }
    for (const t of ['Build a landing page for our coffee subscription', 'Polish the UI of the settings screen', '这个页面在手机上布局乱了']) expect(namesInterface(t), t).toBe(true);
  });

  it('is not added for a game a module of code scores', async () => {
    const module = fs.mkdtempSync(path.join(home, 'module-'));
    fs.writeFileSync(path.join(module, 'go.mod'), 'module curling\n\ngo 1.22\n');
    fs.writeFileSync(path.join(module, 'curling.go'), 'package curling\n');
    script = [{ text: 'Done.' }];
    const s = await rt.start({ cwd: module, model: 'fake/m1', effort: 'medium' });
    await s.send('Score a curling game. Implement this in curling.go.');
    expect(s.messages.flatMap((m) => m.parts).some((p) => p.type === 'text' && (p as { text: string }).text.includes('# Interfaces'))).toBe(false);
  });
});

describe('the documents section and the music tool', () => {
  it('come with documents to make, not with code that translates or charts', async () => {
    const { asksForDocuments, asksForWrittenDoc, withoutProhibitions } = await import('../src/agent/turn-checks');
    for (const yes of ['Make a chart of sales.csv', '把这份文档翻译成英文', 'Batch rename the photos in photos/ by the date taken', 'translate README.md into Chinese', 'Put the totals in a spreadsheet'])
      expect(asksForDocuments(yes), yes).toBe(true);
    for (const no of ['Translate flag signals into letters. Implement this in semaphore.go', 'Your task is to translate text from English into pirate speak. Implement this in pirate_speak.py', 'Batch the writes in store.ts so a flush sends one request'])
      expect(asksForDocuments(no), no).toBe(false);

    for (const yes of [
      'Write a README.md for this repository',
      '给这个仓库写一份完整的 README.md',
      'Read logs/ and write a standalone incident postmortem in incident-report.md',
      '根据故障日志写一份事故复盘报告 postmortem.md',
      'Draft a migration proposal in proposal.md for moving sessions to Redis',
      '写一份会话存储迁移方案，保存到 proposal.md',
      'Write release notes for v0.6.0 in RELEASE-NOTES.md',
      '整理一份发布说明 RELEASE-NOTES.md',
    ]) expect(asksForWrittenDoc(withoutProhibitions(yes)), yes).toBe(true);

    for (const no of [
      'Fix the off-by-one bug in parser.ts',
      'Read README.md and implement the missing CLI flag in src/cli.ts',
      '按照 README.md 里的要求修一下 src/cli.ts 的参数解析',
      'Fix the CSV report exporter in src/report.py',
      'Write a report generator in src/report.py',
      '修一下 src/report.py 里导出报告时报空指针的问题',
      'Fix the bug in store.ts, do not write any README or documentation',
    ]) expect(asksForWrittenDoc(withoutProhibitions(no)), no).toBe(false);
  });

  it('comes with music to be made, not with lyrics, a player or music theory', async () => {
    const { asksForMusic } = await import('../src/agent/brief');
    for (const yes of ["Write a song for my sister's birthday", 'compose background music for the trailer', 'Make a short melody for the game over screen', 'Add a jingle when the timer ends', '给这个视频配乐', '写一首歌', '做一段轻快的背景音乐'])
      expect(asksForMusic(yes), yes).toBe(true);
    for (const no of ["Generate the lyrics of the song 'I Know an Old Lady Who Swallowed a Fly'", 'Write a prototype of the music player application.', 'Write the music player', 'Scales in Western music are based on the chromatic scale.', 'Given a tonic, generate the musical scale.', '写一个音乐播放器', '做一个音乐网站'])
      expect(asksForMusic(no), no).toBe(false);
  });
});

describe('the final check and the review run at the same time', () => {
  it('finishes one browser call before another changes the shared page', async () => {
    const order: string[] = [];
    let width = 0;
    const execute = vi.spyOn(browserTool, 'execute').mockImplementation(async (input) => {
      width = input.width!;
      order.push(`start ${width}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end ${width}`);
      return { content: `width ${width}` };
    });
    try {
      const s = await rt.start({ cwd: project, model: 'fake/eye' });
      script = [{ calls: [{ name: 'browser', args: { width: 1280 } }, { name: 'browser', args: { width: 390 } }] }, { text: 'Both widths checked.' }];
      await s.send('Check the page at two widths.');
      expect(order).toEqual(['start 1280', 'end 1280', 'start 390', 'end 390']);
    } finally {
      execute.mockRestore();
    }
  });

  it('a check and a read in one response start together', async () => {
    const dir = fs.mkdtempSync(path.join(home, 'par-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(() => {}, 1500)"' } }));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    script = [{ calls: [{ name: 'check', args: { only: ['test'] } }, { name: 'read', args: { paths: ['a.txt'] } }] }, { text: 'Both done.' }];
    const s = await rt.start({ cwd: dir, model: 'fake/m1', effort: 'medium' });
    const order: string[] = [];
    s.on((e) => {
      if (e.type === 'tool.start') order.push('start ' + e.name);
      if (e.type === 'tool.end') order.push('end');
    });
    await s.send('Run the tests and read a.txt.');
    // Both start before either ends: they ran side by side.
    expect(order.slice(0, 2).sort()).toEqual(['start check', 'start read']);
  }, 30_000);
});

describe('written document prose check', () => {
  it('preserves empty chunks, long sources and the first-write boundary across repeated checks', async () => {
    const dir = fs.mkdtempSync(path.join(home, 'corpus-'));
    const s = await rt.start({ cwd: dir, model: 'fake/m1' });
    const corpus = (file = 'a.md') => s['docSourceCorpus'](path.join(dir, file));
    const call = (id: string, name: string) => s.messages.push({ id, time: 0, role: 'assistant', parts: [{ type: 'tool_call', id, name, input: { path: 'a.md' } }] });
    const result = (callId: string, content: string) => s.messages.push({ id: callId, time: 0, role: 'user', origin: 'tool', parts: [{ type: 'tool_result', callId, name: 'read', content }] });
    expect(corpus()).toBe('');
    result('empty', '');
    call('before', 'read');
    const long = '文'.repeat(40_000);
    result('before', long);
    expect(corpus()).toBe('\n' + long);
    call('write', 'write');
    result('write', 'own words');
    result('later', 'other result');
    expect(corpus()).toBe('\n' + long + '\nother result');
    call('later', 'read');
    expect(corpus()).toBe('\n' + long);
    expect(corpus('b.md')).toBe('\n' + long + '\nown words\nother result');
    expect(corpus()).toBe('\n' + long);
  });

  it('flags defensive meta-phrases, jargon, verdicts and contrasts while skipping code blocks, quotes and native input words', async () => {
    const { checkDocumentProse } = await import('../src/agent/turn-checks');
    const md = [
      '# 事故复盘',
      '',
      '主库连接耗尽导致 503。日志里未见完成记录，需要平台组确认。',
      '',
      '> 本次复盘材料仅统计网关日志，落地时间待定。',
      '',
      '```txt',
      'not recorded in these logs; 口径 = 5m',
      '```',
      '',
      '回滚后错误归零，说明连接池缺少隔离。这套改动用 `口径` 变量名计算窗口，先在预发落地。',
      '',
      'Whether any message hit the dead-letter queue is not recorded in these logs. It guards one queue, not the delivery mechanism, but the retry loop.',
      '',
      'The new flag fails at the first call rather than silently opening a store in another mode. We checked the parser rather than guessing its limits.',
    ].join('\n');

    // Without native corpus, prose sentences hit while blockquote, fenced code and inline backtick `口径` are skipped.
    const hits = checkDocumentProse(md, '');
    expect(hits).toEqual([
      '日志里未见完成记录，需要平台组确认。',
      '回滚后错误归零，说明连接池缺少隔离。',
      '这套改动用 `口径` 变量名计算窗口，先在预发落地。',
      'Whether any message hit the dead-letter queue is not recorded in these logs.',
      'It guards one queue, not the delivery mechanism, but the retry loop.',
      'We checked the parser rather than guessing its limits.',
    ]);

    // Ordinary words that share a flagged one: 落地页 is a landing page, and a plain "X rather than Y" states a behavior.
    expect(checkDocumentProse('新的落地页加了价格表。落地窗那一侧的机柜温度高 3 度。')).toEqual([]);

    // Words already present in the task prompt or read input files ("落地") do not count as hits.
    const withNative = checkDocumentProse('第一阶段先落地超时配置。\n\n## 数据说明\n\n正常正文，参数说明见下表。', '历史工单备注：第一阶段先落地超时配置');
    expect(withNative).toEqual([]);

    // Semicolons, dashes, parenthetical glosses, Chinese bracketed notes and comma-less contrasts are caught while Markdown links and verbatim official names from input pass.
    const punctAndContrasts = [
      '这不是配置失误而是并发缺失。',
      '发布 2.0 版本（王强）。',
      '签约主体为星海科技（深圳）。',
      'The journal is the source of truth; the index is rebuilt on startup.',
      'Writes append to disk — reads consult the hash map (i.e. one pread per lookup).',
      'See [storage guide](https://example.com/a-b;c=1) for setup.',
    ].join('\n\n');
    expect(checkDocumentProse(punctAndContrasts, 'const x = 1; 合作方：星海科技（深圳）')).toEqual([
      '这不是配置失误而是并发缺失。',
      '发布 2.0 版本（王强）。',
      'The journal is the source of truth; the index is rebuilt on startup.',
      'Writes append to disk — reads consult the hash map (i.e. one pread per lookup).',
    ]);
  });

  it('caps quoted sentences at eight and nudges at most twice per document file in a turn', async () => {
    const { checkDocumentProse } = await import('../src/agent/turn-checks');
    const tenBad = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 项改造本周落地。`).join('\n\n');
    expect(checkDocumentProse(tenBad).length).toBe(8);

    const dir = fs.mkdtempSync(path.join(home, 'doccheck-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'input note with 闭环 in original text\n');
    script = [
      { call: { name: 'read', args: { paths: ['notes.txt'] } } },
      // Round 1 write: "闭环" came from notes.txt (ignored), "日志里没写" is agent-introduced (flagged -> round 1)
      { call: { name: 'write', args: { path: 'report.md', content: '# 报告\n\n原记录提到闭环管理。具体负责人日志里没写，后续再补齐。\n'.repeat(4) } } },
      // Round 2 write: still keeps "落地" -> flagged (round 2)
      { call: { name: 'write', args: { path: 'report.md', content: '# 报告\n\n原记录提到闭环管理。第一阶段本周落地，平台组负责跟进。\n'.repeat(4) } } },
      // Round 3 write: still keeps "落地" -> NOT flagged a third time (capped at 2 rounds per file)
      { call: { name: 'write', args: { path: 'report.md', content: '# 报告\n\n原记录提到闭环管理。第二阶段下周落地，平台组负责跟进。\n'.repeat(4) } } },
      { text: '报告已写入 report.md。' },
    ];
    const s = await rt.start({ cwd: dir, model: 'fake/m1', effort: 'medium' });
    await s.send('根据 notes.txt 写一份报告保存到 report.md');
    const checkNotes = s.messages
      .flatMap((m) => m.parts)
      .filter((p): p is { type: 'text'; text: string; synthetic?: boolean } => p.type === 'text' && !!p.synthetic && p.text.includes('Document style check on report.md'));
    expect(checkNotes.length).toBe(2);
    expect(checkNotes[0].text).toContain('具体负责人日志里没写');
    expect(checkNotes[0].text).not.toContain('原记录提到闭环管理');
  });
});
