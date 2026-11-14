import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import React from 'react';
import { render } from 'ink';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeStdin, FakeStdout, KEYS, sleep, until } from './terminal';

// The terminal UI end to end, against a model server of our own: keys in, the screen as a person sees it out.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-tui-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'readme.md'), '# demo\n');

type Reply = { text?: string; call?: { name: string; args: unknown }; delay?: number; chunk?: number };
let mainPlan: Reply[] = [];
let childPlan: Reply[] = [];
const bodies: { messages: { role: string; content: unknown }[] }[] = [];

const reply = async (res: http.ServerResponse, r: Reply) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (r.delay) await sleep(r.delay);
  if (r.call) {
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const text = r.text ?? 'ok';
    const size = r.chunk ?? text.length;
    for (let i = 0; i < text.length; i += size) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(i, i + size) } }] });
      if (r.chunk) await sleep(4);
    }
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  chunk({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 9 } });
  res.end('data: [DONE]\n\n');
};

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const json = JSON.parse(body);
    const system = String(json.messages?.[0]?.content ?? '');
    if (system.includes('sub-agent of Favilla') || body.includes('You are a fork of the conversation above')) return reply(res, childPlan.shift() ?? { text: 'Report: nothing to add.' });
    bodies.push(json);
    return reply(res, mainPlan.shift() ?? { text: 'Done.' });
  });
});

const { createRuntime } = await import('@favilla/core');
const { App } = await import('../src/tui/app');
const { setLanguage } = await import('../src/tui/i18n');

let rt: ReturnType<typeof createRuntime>;
let ink: ReturnType<typeof render> | undefined;
let screen: FakeStdout | undefined;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'fake/m1',
      language: 'zh-CN',
      tools: 'favilla',
      languageServers: false,
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { m1: { contextWindow: 64000, family: 'gpt', vision: true } } } },
    }),
  );
  setLanguage('zh-CN');
});

afterEach((ctx) => {
  // FAVILLA_TUI_SCREENS=dir keeps each test's screen, to look at the layout.
  const dir = process.env.FAVILLA_TUI_SCREENS;
  if (dir && screen) fs.writeFileSync(path.join(dir, `${ctx.task.name.slice(0, 40).replace(/[^\w]+/g, '-')}.txt`), screen.text());
  ink?.unmount();
  ink = undefined;
  rt?.dispose();
});

afterAll(() => {
  fake.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function open() {
  rt = createRuntime(project, { interactive: true });
  const session = await rt.start({ cwd: project, interactive: true });
  const stdout = new FakeStdout();
  screen = stdout;
  const stdin = new FakeStdin();
  ink = render(React.createElement(App, { rt, initial: session, opts: { cwd: project } }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
    maxFps: 60,
  });
  await until(() => stdout.text().includes('/help 查看按键和命令'), 'the banner');
  const idle = () => [...rt.live.values()].every((s) => s.status === 'idle');
  const type = async (text: string) => {
    stdin.send(text);
    await sleep(40);
  };
  const send = async (text: string) => {
    await type(text);
    await type(KEYS.enter);
  };
  return { session, stdout, stdin, idle, type, send };
}

const lastUser = (b: { messages: { role: string; content: unknown }[] }) => {
  const m = [...b.messages].reverse().find((x) => x.role === 'user')!;
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
};

describe('terminal UI', () => {
  it('prints a streamed reply block by block, each block once, in order', async () => {
    const t = await open();
    const reply = 'First paragraph alpha.\n\nSecond paragraph beta, which runs a little longer than the first.\n\n```js\nconst x = 1;\n```\n\nLast paragraph gamma.';
    mainPlan = [{ text: reply, chunk: 5 }];
    await t.send('hello there');
    await until(() => t.stdout.text().includes('Last paragraph gamma.') && t.idle(), 'the reply');
    await sleep(150);
    const screen = t.stdout.text();
    expect(t.stdout.count('First paragraph alpha.')).toBe(1);
    expect(t.stdout.count('Second paragraph beta')).toBe(1);
    expect(t.stdout.count('const x = 1;')).toBe(1);
    expect(t.stdout.count('Last paragraph gamma.')).toBe(1);
    expect(t.stdout.count('› hello there')).toBe(1);
    expect(screen.indexOf('First paragraph')).toBeLessThan(screen.indexOf('Second paragraph'));
    expect(screen.indexOf('const x = 1;')).toBeLessThan(screen.indexOf('Last paragraph gamma.'));
    // A quick plain answer gets no ledger line; a turn that changed files does (next test).
    expect(screen).not.toContain('✓');
  });

  it('shows a file change, says how to see it, and /diff opens every change in the reader', async () => {
    const t = await open();
    mainPlan = [{ call: { name: 'write', args: { path: 'notes.txt', content: 'one\ntwo\nthree\n' } } }, { text: 'Wrote notes.txt.' }];
    await t.send('make a notes file');
    await until(() => t.stdout.text().includes('Wrote notes.txt.') && t.idle(), 'the turn');
    expect(t.stdout.text()).toContain('这一轮改了 1 个文件');
    expect(t.stdout.text()).toMatch(/✓ \d+s · 2 次请求 · 1 个文件 \+3 −0/);
    expect(t.stdout.text()).toContain('+ two');
    await t.send('/diff');
    await until(() => t.stdout.text().includes('本会话的改动'), 'the diff reader');
    expect(t.stdout.text()).toMatch(/notes\.txt/);
    await t.type('q');
    await until(() => t.stdout.text().includes('提问或描述要做的修改'), 'the input back');
    // The conversation as markdown, where the user says.
    const out = path.join(home, 'export.md');
    await t.send(`/export ${out}`);
    await until(() => fs.existsSync(out), 'the export');
    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('## You\n\nmake a notes file');
    expect(md).toMatch(/- `write .*notes\.txt`/);
    expect(md).toContain('Wrote notes.txt.');
  });

  for (const how of ['in place', 'in a new branch'] as const) {
    it(`esc esc goes back to an earlier message: edited and sent again ${how}`, async () => {
      const t = await open();
      const old = t.session.id;
      mainPlan = [{ text: 'reply one' }];
      await t.send('first question');
      await until(() => t.stdout.text().includes('reply one') && t.idle(), 'the first reply');
      mainPlan = [{ text: 'reply two' }];
      await t.send('second question');
      await until(() => t.stdout.text().includes('reply two') && t.idle(), 'the second reply');

      await t.type(KEYS.esc);
      await sleep(80);
      await t.type(KEYS.esc);
      await until(() => t.stdout.text().includes('回到之前的消息'), 'the rewind list');
      await t.type(KEYS.enter);
      await until(() => t.stdout.text().includes('修改后重发'), 'the actions');
      // Sending again in place comes first; the new branch is the next choice.
      if (how === 'in a new branch') {
        await t.type(KEYS.down);
        await sleep(80);
      }
      await t.type(KEYS.enter);
      await until(() => t.stdout.text().includes('正在修改第 2 条消息'), 'the edit banner');

      mainPlan = [{ text: 'reply to the edit' }];
      const before = bodies.length;
      await t.send(' again');
      await until(() => t.stdout.text().includes('reply to the edit') && t.idle(), 'the reply to the edit');
      expect(t.stdout.text()).toContain(how === 'in place' ? '之后的对话已删除' : '分出新分支');
      const sent = bodies.slice(before);
      expect(sent).toHaveLength(1);
      expect(lastUser(sent[0])).toContain('second question again');
      // It starts before the edited message: the old second exchange is not in it.
      expect(JSON.stringify(sent[0].messages)).not.toContain('reply two');
      const listed = rt.store.list({ cwd: project });
      expect(listed.some((m) => m.id === old)).toBe(how === 'in a new branch');
      expect(listed.some((m) => m.branchOf?.id === old)).toBe(how === 'in a new branch');
    });
  }

  it('a message typed while the agent works waits in the queue, and ↑ takes it back to edit', async () => {
    const t = await open();
    mainPlan = [{ text: 'slow reply', delay: 1500 }];
    await t.send('start working');
    await until(() => !t.idle(), 'the turn to start');
    await t.send('a later thought');
    await until(() => t.stdout.text().includes('排队中'), 'the queued line');
    expect(t.session.queued.map((q) => q.text)).toEqual(['a later thought']);
    await t.type(KEYS.up);
    await until(() => t.session.queued.length === 0, 'the message to come back');
    await until(() => t.idle(), 'the turn to end');
    // It is in the input again, not sent.
    expect(bodies.some((b) => lastUser(b).includes('a later thought'))).toBe(false);
    await t.type(KEYS.enter);
    await until(() => bodies.some((b) => lastUser(b).includes('a later thought')), 'the message sent again');
  });

  it('an image file pasted in (as a dropped file is) goes with the message', async () => {
    const t = await open();
    const png = path.join(project, 'shot.png');
    // A 1x1 PNG.
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await t.type(KEYS.paste(`"${png}"`));
    await until(() => t.stdout.text().includes('[图片 #1]'), 'the image token');
    mainPlan = [{ text: 'I see a pixel.' }];
    const before = bodies.length;
    await t.send('what is this');
    await until(() => t.stdout.text().includes('I see a pixel.'), 'the reply');
    const sent = JSON.stringify(bodies[before].messages);
    expect(sent).toContain('image_url');
    expect(sent).toContain('what is this');
    expect(t.stdout.text()).toContain('[1 张图片]');
  });

  it('follows a sub-agent while it works, and /agents opens what it did', async () => {
    const t = await open();
    mainPlan = [{ call: { name: 'agent', args: { description: 'Survey the files', prompt: 'List the files.' } } }, { text: 'Main done.' }];
    childPlan = [{ text: 'Report: there is one readme.', delay: 900 }];
    await t.send('look around with a sub-agent');
    await until(() => /⎇ Survey the files/.test(t.stdout.text()), 'the sub-agent line');
    await until(() => t.stdout.text().includes('Main done.') && t.idle(), 'the turn');
    await t.send('/agents');
    await until(() => t.stdout.text().includes('子 Agent'), 'the list');
    await t.type(KEYS.enter);
    await until(() => t.stdout.text().includes('Report: there is one readme.'), 'its transcript');
    await t.type('q');
  });

  it('runs !command at once and hands its output to the agent with the next message', async () => {
    const t = await open();
    await t.send('!echo bang-output-42');
    await until(() => t.stdout.text().includes('输出会随你的下一条消息交给 Agent'), 'the run');
    expect(t.stdout.text()).toContain('bang-output-42');
    mainPlan = [{ text: 'Seen it.' }];
    const before = bodies.length;
    await t.send('what did it print');
    await until(() => t.stdout.text().includes('Seen it.'), 'the reply');
    expect(lastUser(bodies[before])).toContain('bang-output-42');
  });

  it('/model lists the models at once while a provider does not answer', async () => {
    // A relay asked for its models that never answers: the list waited on it, half a minute for a real one.
    const stuck = http.createServer(() => {});
    await new Promise<void>((r) => stuck.listen(0, '127.0.0.1', r));
    const file = path.join(process.env.FAVILLA_HOME!, 'config.json');
    const before = fs.readFileSync(file, 'utf8');
    const config = JSON.parse(before);
    config.providers.stuck = { name: 'Stuck', api: 'openai-chat', baseUrl: `http://127.0.0.1:${(stuck.address() as AddressInfo).port}/v1`, apiKey: 'k', proxy: false, discover: 'openai', models: { s1: { contextWindow: 32000, family: 'gpt' } } };
    fs.writeFileSync(file, JSON.stringify(config));
    try {
      const t = await open();
      const asked = Date.now();
      await t.send('/model');
      await until(() => t.stdout.text().includes('stuck/s1'), 'the model list', 5000);
      expect(Date.now() - asked).toBeLessThan(4000);
      expect(t.stdout.text()).toContain('fake/m1');
      await t.type(KEYS.esc);
    } finally {
      fs.writeFileSync(file, before);
      stuck.closeAllConnections();
      stuck.close();
    }
  });
});

describe('modes in the terminal', () => {
  it('shift+tab switches between build and plan, and /plan toggles the same modes', async () => {
    const t = await open();
    expect(t.session.meta.mode).toBe('build');
    await t.type(KEYS.shiftTab);
    await until(() => t.session.meta.mode === 'plan' && t.stdout.text().includes('规划模式'), 'plan mode on screen');
    await t.type(KEYS.shiftTab);
    await until(() => t.session.meta.mode === 'build', 'back to build');
    await t.send('/plan');
    await until(() => t.session.meta.mode === 'plan', 'plan by command');
    await t.send('/plan');
    await until(() => t.session.meta.mode === 'build', 'build by command');
  });

  it('refuses --mode wish before it starts a session', async () => {
    const cliHome = path.join(home, 'invalid-mode');
    fs.mkdirSync(cliHome);
    fs.copyFileSync(path.join(process.env.FAVILLA_HOME!, 'config.json'), path.join(cliHome, 'config.json'));
    const before = bodies.length;
    const args = ['--import', 'tsx', 'packages/cli/src/main.ts', '--cwd', project, '--mode', 'wish', '-p', 'Start a session.'];
    await expect(promisify(execFile)(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: { ...process.env, FAVILLA_HOME: cliHome },
      timeout: 10_000,
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/option '--mode <mode>'.*Allowed choices are build, plan/) });
    expect(bodies).toHaveLength(before);
    expect(fs.existsSync(path.join(cliHome, 'sessions', 'index.json'))).toBe(false);
  }, 15_000);
});
