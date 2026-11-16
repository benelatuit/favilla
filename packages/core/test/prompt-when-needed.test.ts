import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Text that every request carried though only some sessions need it now comes when they do (2026-11-07): the mail
// tool with a message about mail, the rule on judging pictures for a model that sees them, the documents section in a
// folder of code with a request or a file of that kind, the engineering standards with a source file written.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-when-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const code = path.join(home, 'code');
const docs = path.join(home, 'docs');
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(code, 'main.go'), 'package main\n\nfunc main() {}\n');
fs.writeFileSync(path.join(code, 'budget.csv'), 'item,amount\nrent,1200\n');
fs.writeFileSync(path.join(docs, 'notes.md'), '# 会议记录\n- 下周交报告\n');

type Reply = { text?: string; call?: { name: string; args: unknown } };
let plan: Reply[] = [];
const bodies: { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string; description: string } }[] }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ data: [{ id: 'seeing' }, { id: 'blind' }] }));
    }
    bodies.push(JSON.parse(body));
    const r = plan.shift() ?? { text: 'Done.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    chunk({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as AddressInfo).port;
  fs.mkdirSync(process.env.FAVILLA_HOME!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({
      model: 'fake/seeing',
      tools: 'favilla',
      languageServers: false,
      mail: { accounts: [{ address: 'someone@example.com', imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port: 1, secure: false } }] },
      providers: { fake: { name: 'Fake', api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', local: true, models: { seeing: { contextWindow: 200000, vision: true }, blind: { contextWindow: 200000, vision: false } } } },
    }),
  );
});

afterAll(async () => {
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
const system = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n');
const said = (b: (typeof bodies)[number]) => b.messages.filter((m) => m.role !== 'system').map((m) => text(m.content)).join('\n');

async function session(cwd: string, model = 'fake/seeing') {
  const { createRuntime } = await import('../src/runtime');
  const rt = createRuntime(cwd, { interactive: true });
  return { rt, s: await rt.start({ cwd, model, interactive: true }) };
}

describe('text that comes when it is needed', () => {
  it('holds the mail tool back, names no address in every request, and loads it with a message about mail', async () => {
    const { rt, s } = await session(code);
    try {
      const before = bodies.length;
      await s.send('Tidy up main.go.');
      const first = bodies[before];
      const mail = first.tools?.find((t) => t.function.name === 'mail')?.function;
      expect(mail?.description).toMatch(/^Searches, reads and sorts the user's email.*Listed in short/);
      expect(JSON.stringify(first)).not.toContain('someone@example.com');
      expect(system(first)).toMatch(/In short now: [^.]*mail/);
      const next = bodies.length;
      await s.send('看看收件箱里有没有要回的邮件');
      expect(said(bodies[next])).toContain('Loaded for this request, no load_tools call needed: the full instructions of mail');
      expect(said(bodies[next])).toContain('someone@example.com');
    } finally {
      rt.close(s.id);
    }
  });

  it('gives the rule on judging pictures only to a model that sees them', async () => {
    for (const [model, sees] of [['fake/seeing', true], ['fake/blind', false]] as const) {
      const { rt, s } = await session(docs, model);
      try {
        const before = bodies.length;
        await s.send('Say OK.');
        expect(system(bodies[before]).includes('When you judge a picture'), model).toBe(sees);
        expect(system(bodies[before])).not.toContain('[vision]');
      } finally {
        rt.close(s.id);
      }
    }
  });

  it('keeps the documents section in a folder of documents, and gives standalone document rules only when asked or written', async () => {
    const inDocs = await session(docs);
    try {
      const before = bodies.length;
      await inDocs.s.send('Say OK.');
      const firstSys = system(bodies[before]);
      expect(firstSys).toContain('# Documents, data and pictures');
      expect(firstSys).not.toContain('# Standalone documents and reports');
      expect(said(bodies[before])).not.toContain('# Standalone documents and reports');
      const docAsk = bodies.length;
      await inDocs.s.send('写一份事故复盘报告');
      expect(system(bodies[docAsk])).toBe(firstSys);
      expect(said(bodies[docAsk])).toContain('# Standalone documents and reports');
      const docNext = bodies.length;
      await inDocs.s.send('再补一段背景');
      expect(said(bodies[docNext]).split('# Standalone documents and reports').length - 1).toBe(1);
    } finally {
      inDocs.rt.close(inDocs.s.id);
    }
    const asked = await session(code);
    try {
      const before = bodies.length;
      await asked.s.send('Say OK.');
      expect(system(bodies[before])).not.toContain('# Documents, data and pictures');
      expect(said(bodies[before])).not.toContain('# Documents, data and pictures');
      expect(system(bodies[before])).not.toContain('# Standalone documents and reports');
      expect(said(bodies[before])).not.toContain('# Standalone documents and reports');
      const next = bodies.length;
      await asked.s.send('把 budget.csv 做成一个 Excel 表格，合计用公式');
      expect(said(bodies[next])).toContain('# Documents, data and pictures');
      expect(said(bodies[next])).not.toContain('# Standalone documents and reports');
      const again = bodies.length;
      await asked.s.send('再加一张图表');
      expect(said(bodies[again]).split('# Documents, data and pictures').length - 1).toBe(1);
      const docTurn = bodies.length;
      await asked.s.send('给这个项目写一份 README.md');
      expect(said(bodies[docTurn])).toContain('# Standalone documents and reports');
      const docAgain = bodies.length;
      await asked.s.send('再补一份发布说明 RELEASE-NOTES.md');
      expect(said(bodies[docAgain]).split('# Standalone documents and reports').length - 1).toBe(1);
    } finally {
      asked.rt.close(asked.s.id);
    }
    const read = await session(code);
    try {
      plan = [{ call: { name: 'read', args: { paths: ['budget.csv'] } } }, { text: 'Done.' }];
      const before = bodies.length;
      await read.s.send('What is the rent?');
      expect(said(bodies[before])).not.toContain('# Documents, data and pictures');
      expect(said(bodies[before + 1])).toContain('# Documents, data and pictures');
    } finally {
      read.rt.close(read.s.id);
    }
  });

  it('gives the engineering standards in a folder of documents with a source file written, not with a note or a scratch script', async () => {
    const { scratchDir } = await import('../src/prompt/system');
    const { rt, s } = await session(docs);
    try {
      const scratch = path.join(scratchDir(docs), 'tally.py').replace(/\\/g, '/');
      plan = [
        { call: { name: 'write', args: { path: 'todo.md', content: '- reply to Ana\n' } } },
        { call: { name: 'write', args: { path: scratch, content: 'print(1)\n' } } },
        { call: { name: 'write', args: { path: 'tools/tally.py', content: 'print(2)\n' } } },
        { text: 'Done.' },
      ];
      const before = bodies.length;
      await s.send('Write the todo list, then a script that tallies it.');
      const turn = bodies.slice(before);
      expect(turn).toHaveLength(4);
      expect(system(turn[0])).not.toContain('# Engineering standards');
      expect(said(turn[1])).not.toContain('# Engineering standards');
      expect(said(turn[2])).not.toContain('# Engineering standards');
      expect(said(turn[3])).toContain('# Engineering standards');
    } finally {
      rt.close(s.id);
    }
  });

  it('keeps # Interfaces and full browser docs out of UI repos until needed, and injects them before Request 1 across page/style/screenshot prompts, .tsx/.css/.html files, and pasted screenshots', async () => {
    const { designGuide } = await import('../src/prompt/system');
    const { findBrowser } = await import('../src/tools/browser');
    const hasBrowser = !!findBrowser();
    const expectedGuide = designGuide(hasBrowser ? 'browser' : undefined, true);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const uiRepo = path.join(home, 'ui-repo');
    fs.mkdirSync(path.join(uiRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(uiRepo, 'package.json'), JSON.stringify({ name: 'ui-demo', dependencies: { react: '^19.0.0' } }));
    fs.writeFileSync(path.join(uiRepo, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>\n');
    fs.writeFileSync(path.join(uiRepo, 'src', 'store.ts'), 'export function countItems(xs: string[]) { return xs.length - 1; }\n');
    fs.writeFileSync(path.join(uiRepo, 'src', 'PricingCard.tsx'), 'export function PricingCard() { return <section>Plan</section>; }\n');
    fs.writeFileSync(path.join(uiRepo, 'src', 'styles.css'), '.card { padding: 12px; }\n');

    // 1. Backend fix in a React + HTML repo: neither # Interfaces nor full browser docs appear in system or Request 1.
    {
      const { rt, s } = await session(uiRepo);
      try {
        const before = bodies.length;
        await s.send('Fix the off-by-one bug in src/store.ts.');
        expect(system(bodies[before])).not.toContain('# Interfaces');
        expect(said(bodies[before])).not.toContain('# Interfaces');
        expect(said(bodies[before])).not.toContain('the full instructions of browser');
      } finally {
        rt.close(s.id);
      }
    }

    // 2. Prompts mentioning page, styles, or screenshot (including repair prompts) inject before Request 1, with unchanged content.
    for (const prompt of [
      'Update the landing page styles and mobile layout at 390px.',
      '修复移动端页面的样式错位',
      'Check the screenshot alignment and fix the border-radius.',
    ]) {
      const { rt, s } = await session(uiRepo);
      try {
        const before = bodies.length;
        await s.send(prompt);
        const sys = system(bodies[before]);
        expect(sys, prompt).not.toContain('# Interfaces');
        expect(said(bodies[before]), prompt).toContain(expectedGuide);
        expect(s.messages.flatMap((m) => m.parts).some((p) => p.type === 'text' && (p as { text: string }).text === `<harness-note>${expectedGuide}</harness-note>`), prompt).toBe(true);
        if (hasBrowser) expect(said(bodies[before]), prompt).toContain('Loaded for this request, no load_tools call needed: the full instructions of browser');
      } finally {
        rt.close(s.id);
      }
    }

    // 3. Naming .tsx, .css, or .html (for read or write), or matching a .tsx symbol via lookAhead, injects before Request 1.
    for (const prompt of [
      'Read src/PricingCard.tsx and explain what it renders.',
      'Write a tighter padding rule in src/styles.css.',
      'Update the document title in index.html.',
      'Check why PricingCard truncates long plan names.',
    ]) {
      const { rt, s } = await session(uiRepo);
      try {
        const before = bodies.length;
        await s.send(prompt);
        expect(system(bodies[before]), prompt).not.toContain('# Interfaces');
        expect(said(bodies[before]), prompt).toContain('# Interfaces');
        if (hasBrowser) expect(said(bodies[before]), prompt).toContain('the full instructions of browser');
      } finally {
        rt.close(s.id);
      }
    }

    // 4. Mid-turn read or write of .tsx/.css/.html when the prompt itself named none injects once on the next step without mutating system.
    {
      const { rt, s } = await session(uiRepo);
      try {
        plan = [
          { call: { name: 'read', args: { paths: ['src/styles.css'] } } },
          { call: { name: 'write', args: { path: 'public.html', content: '<!doctype html><title>Hi</title>\n' } } },
          { text: 'Done.' },
        ];
        const before = bodies.length;
        await s.send('Inspect the files in this folder.');
        const turn = bodies.slice(before);
        expect(turn).toHaveLength(3);
        const sys0 = system(turn[0]);
        expect(sys0).not.toContain('# Interfaces');
        expect(said(turn[0])).not.toContain('# Interfaces');
        expect(system(turn[1])).toBe(sys0);
        expect(said(turn[1])).toContain('# Interfaces');
        expect(said(turn[2]).split('# Interfaces').length - 1).toBe(1);
      } finally {
        rt.close(s.id);
      }
    }

    // 5. User-pasted/attached screenshot injects before Request 1.
    {
      const { rt, s } = await session(uiRepo);
      try {
        const before = bodies.length;
        await s.send('Fix this.', [{ type: 'image', mediaType: 'image/png', data: png, name: 'paste.png' }]);
        expect(system(bodies[before])).not.toContain('# Interfaces');
        expect(said(bodies[before])).toContain('# Interfaces');
        if (hasBrowser) expect(said(bodies[before])).toContain('the full instructions of browser');
      } finally {
        rt.close(s.id);
      }
    }
  });
});
