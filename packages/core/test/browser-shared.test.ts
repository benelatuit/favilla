import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserSession, findBrowser, openFavillaBrowser, runningEndpoint } from '../src/tools/browser';
import { killChild } from '../src/util/proc';

const exe = findBrowser();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shared-profile-'));
afterAll(() => setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500));

/** Every page open in the browser on the profile, whichever session opened it. */
async function pages(): Promise<string[]> {
  const port = new URL((await runningEndpoint(profile))!).port;
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; title: string }[];
  return list.filter((t) => t.type === 'page').map((t) => t.title);
}

describe.skipIf(!exe)("Favilla's browser, shared", () => {
  it('a session on a profile already open attaches to it in a tab of its own, and closes only that tab', async () => {
    // The browser the user would have open on Favilla's profile (headless here, so nothing shows).
    const owner = new BrowserSession(exe!, false, { profileDir: profile });
    await owner.start();
    try {
      expect(await runningEndpoint(profile)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
      await owner.open('data:text/html,<title>mine</title>');
      const agent = new BrowserSession(exe!, false, { profileDir: profile });
      await agent.start();
      await agent.open('data:text/html,<title>agent</title>');
      expect(await pages()).toEqual(expect.arrayContaining(['mine', 'agent']));
      // The agent sees only its own tab.
      expect((await agent.tabList()).join(' | ')).not.toContain('mine');
      agent.close();
      await new Promise((r) => setTimeout(r, 800));
      // The user's browser and tab are still there; the agent's tab is gone.
      expect(await pages()).toContain('mine');
      expect(await pages()).not.toContain('agent');
      await owner.open('data:text/html,<title>still</title>');
      expect((await owner.tabList()).join(' | ')).toContain('still');
      // A headless browser on the profile is an agent's: no window for the user goes into it.
      expect(await openFavillaBrowser(exe!, profile)).toBe('busy');
      expect(await pages()).toHaveLength(1);
    } finally {
      owner.close();
    }
  }, 60_000);

  it('a closed session removes its temporary profile once Chrome has let go of it', async () => {
    const s = new BrowserSession(exe!, false);
    await s.start();
    const dir = (s as unknown as { dir: string }).dir;
    expect(fs.existsSync(dir)).toBe(true);
    s.close();
    for (let i = 0; i < 60 && fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(dir)).toBe(false);
  }, 60_000);

  it('a command still waiting when the connection drops fails at once instead of hanging', async () => {
    const s = new BrowserSession(exe!, false);
    await s.start();
    await s.open('data:text/html,<title>wait</title>');
    // A script that never finishes, then the connection goes.
    const waiting = s.evaluate('new Promise(() => {})').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 300));
    (s as unknown as { ws: WebSocket }).ws.close();
    const started = Date.now();
    expect(await waiting).toMatch(/closed/);
    expect(Date.now() - started).toBeLessThan(5000);
    s.close();
  }, 60_000);

  it('does not tell pages it is automated, which Google answers by refusing sign-in', async () => {
    const s = new BrowserSession(exe!, false);
    await s.start();
    try {
      await s.open('data:text/html,<title>wd</title>');
      expect(await s.evaluate('navigator.webdriver')).toBe(false);
    } finally {
      s.close();
    }
  }, 60_000);

  it('says so when the browser on the profile is one an earlier Favilla started, which still does', async () => {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-old-profile-'));
    const child = spawn(exe!, ['--headless=new', '--no-first-run', `--user-data-dir=${old}`, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    try {
      for (let i = 0; i < 40 && !(await runningEndpoint(old)); i++) await new Promise((r) => setTimeout(r, 250));
      const s = new BrowserSession(exe!, false, { visible: true, profileDir: old });
      await s.start();
      expect(s.takeEvents().join(' ')).toMatch(/earlier version of Favilla.*close all of its windows/);
      s.close();
    } finally {
      const gone = new Promise((r) => child.once('exit', r));
      killChild(child);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
      setTimeout(() => fs.rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 500);
    }
  }, 60_000);

  it('finds no browser on a profile nothing runs on', async () => {
    expect(await runningEndpoint(fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-empty-profile-')))).toBeNull();
  });
});
