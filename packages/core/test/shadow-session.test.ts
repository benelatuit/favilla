import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// With shadow tests on, a fix in a Go module gets tests from a model of another family, written in a copy from the
// request alone while the work goes on. When the work would end they run on it: one that fails sends it back once,
// and the test files leave the project when the turn ends.
const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shadow-s-'));
process.env.FAVILLA_HOME = home;
process.env.FAVILLA_FOLDER_SNAPSHOTS = '0';
process.env.FAVILLA_PREFETCH = '0';
process.env.FAVILLA_FINISH_NOTE = '0';
const project = path.join(home, 'project');

const SOURCE = `package num

import "strings"

func Sign(s string) int {
	switch {
	case strings.HasPrefix(s, "-"):
		return -1
	case strings.HasPrefix(s, "+"):
		return 1
	}
	return 0
}
`;
const SHADOW = `package num

import "testing"

func TestShadowFixUnicodeMinus(t *testing.T) {
	if Sign("\\u22125") != -1 {
		t.Fatal("a Unicode minus reads as positive")
	}
}

func TestShadowFixLeadingSpace(t *testing.T) {
	if Sign("  -5") != -1 {
		t.Fatal("a minus after spaces reads as positive")
	}
}
`;

type Body = { model: string; messages: { role: string; content?: unknown }[] };
const bodies: Body[] = [];
let script: (b: Body) => { text?: string; call?: { name: string; args: Record<string, unknown> }; wait?: Promise<unknown> } = () => ({ text: 'OK.' });
let callNo = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }, { id: 's1' }] }));
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    const r = script(body);
    if (r.wait) await r.wait;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.call) {
      callNo++;
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${callNo}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text ?? 'OK.' } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});

let createRuntime: typeof import('../src/runtime').createRuntime;
beforeAll(async () => {
  fs.mkdirSync(path.join(project, 'num'), { recursive: true });
  fs.writeFileSync(path.join(project, 'go.mod'), 'module example.com/shadow\n\ngo 1.21\n');
  fs.writeFileSync(path.join(project, 'num', 'num.go'), SOURCE);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore', windowsHide: true });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'start');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ model: 'fake/m1', tools: 'favilla', modelRegistry: false, languageServers: false, skills: false, shadowTests: { model: 'fake/s1' }, providers: { openai: { enabled: false }, fake: { api: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'none', models: { m1: { contextWindow: 200_000, family: 'gpt' }, s1: { contextWindow: 200_000, family: 'deepseek' } } } } }),
  );
  ({ createRuntime } = await import('../src/runtime'));
}, 120_000);
afterAll(async () => {
  server.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(!hasGo)('shadow tests in a turn', () => {
  // The project as it was, for each case.
  const reset = () => {
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: project, windowsHide: true });
    fs.rmSync(path.join(project, 'num', 'shadow_test.go'), { force: true });
    bodies.length = 0;
  };
  /** A tester that writes the two tests, and a fixer that fixes the Unicode minus first and the spaces when told. */
  const play = (o: { holdSecond?: Promise<unknown> }) => {
    let tester = 0;
    let main = 0;
    let testerDone!: () => void;
    const written = new Promise<void>((r) => (testerDone = r));
    script = (b) => {
      if (b.model === 's1') {
        tester++;
        // The tester sees the request and its own brief, nothing of the fix.
        if (tester === 1) return { call: { name: 'write', args: { path: 'num/shadow_test.go', content: SHADOW } } };
        testerDone();
        return { text: 'TestShadowFixUnicodeMinus: a Unicode minus. TestShadowFixLeadingSpace: spaces before the sign.' };
      }
      main++;
      if (main === 1) return { call: { name: 'edit', args: { path: 'num/num.go', old_string: 'case strings.HasPrefix(s, "-"):', new_string: 'case strings.HasPrefix(s, "-"), strings.HasPrefix(s, "\\u2212"):' } } };
      if (main === 2) return { text: 'Fixed: a Unicode minus now reads as negative.', wait: o.holdSecond };
      if (main === 3) return { call: { name: 'edit', args: { path: 'num/num.go', old_string: 'switch {', new_string: 's = strings.TrimSpace(s)\n\tswitch {' } } };
      return { text: 'Fixed both: spaces before the sign are trimmed too.' };
    };
    return written;
  };
  const expectSentBack = () => {
    const testerFirst = bodies.find((b) => b.model === 's1')!;
    expect(JSON.stringify(testerFirst.messages)).toContain('your job here is tests only');
    expect(JSON.stringify(testerFirst.messages)).toContain('Unicode minus returns 0');
    // The work came back once, with the failing test's own words, and ended after the second answer.
    const mains = bodies.filter((b) => b.model === 'm1');
    expect(mains).toHaveLength(4);
    const back = JSON.stringify(mains[2].messages.at(-1));
    expect(back).toContain('another model wrote tests of this request');
    expect(back).toContain('a minus after spaces reads as positive');
    expect(back).not.toContain('a Unicode minus reads as positive');
    // The project keeps the agent's change and none of the tester's files; the copy is gone.
    expect(fs.readFileSync(path.join(project, 'num', 'num.go'), 'utf8')).toContain('strings.TrimSpace(s)');
    expect(fs.existsSync(path.join(project, 'num', 'shadow_test.go'))).toBe(false);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: project, encoding: 'utf8', windowsHide: true }).trim().split('\n')).toHaveLength(1);
  };

  it('written after the work ended: they run then, and a failure wakes the session with what failed', async () => {
    reset();
    play({});
    const rt = createRuntime(project, { interactive: false });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Fix this bug: Sign("−5") with a Unicode minus returns 0 instead of -1.');
    // The turn ended without waiting; the tests ran when they were written and the agent was woken.
    await s.settled();
    expectSentBack();
    await rt.dispose();
  }, 300_000);

  it('written before the work ended: the same turn gets what failed', async () => {
    reset();
    // The fixer's answer waits until the tester has written and checked its tests on the copy.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const written = play({ holdSecond: held });
    void written.then(() => setTimeout(release, 20_000));
    const rt = createRuntime(project, { interactive: false });
    const s = await rt.start({ cwd: project, model: 'fake/m1' });
    await s.send('Fix this bug: Sign("−5") with a Unicode minus returns 0 instead of -1.');
    expectSentBack();
    // One turn: the note came with it, not as a turn of its own.
    expect(bodies.filter((b) => b.model === 'm1').every((b) => !JSON.stringify(b.messages).includes('background sub-agent'))).toBe(true);
    await rt.dispose();
  }, 300_000);
});
