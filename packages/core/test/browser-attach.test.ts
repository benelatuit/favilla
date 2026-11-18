import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession, runningEndpoint } from '../src/tools/browser';
import { killChild } from '../src/util/proc';

// Stand in for the user's running Chrome with a separate profile, never their real one.
const chrome = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
  .flatMap((dir) => dir ? [path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')] : [])
  .find((exe) => fs.existsSync(exe));

describe.skipIf(process.platform !== 'win32' || !chrome)("the user's own browser", () => {
  let userData: string;
  let browser: ChildProcess | undefined;
  beforeAll(() => { userData = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-attach-chrome-')); });
  afterAll(async () => {
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const gone = new Promise<void>((resolve) => browser!.once('exit', () => resolve()));
      killChild(browser);
      await gone;
    }
    await fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, 30_000);

  it('without remote debugging on, says how to turn it on', async () => {
    const s = new BrowserSession(chrome!, false, { attachDir: userData });
    await expect(s.start()).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
    s.close();
  });

  it('attaches, works in a tab of its own, and leaves the browser and its tabs as they were', async () => {
    browser = spawn(chrome!, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking', `--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', 'data:text/html,<title>yours</title>'], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 40 && !(await runningEndpoint(userData)); i++) await new Promise((r) => setTimeout(r, 250));
    const port = new URL((await runningEndpoint(userData))!).port;
    const pages = async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; title: string }[]).filter((t) => t.type === 'page').map((t) => t.title);
    for (let i = 0; i < 20 && !(await pages()).includes('yours'); i++) await new Promise((r) => setTimeout(r, 250));

    const s = new BrowserSession(chrome!, false, { attachDir: userData, downloadDir: path.join(userData, 'agent-downloads') });
    const originalTabs = await pages();
    try {
      await s.start();
      await s.open('data:text/html,<title>agent</title>');
      expect(await pages()).toEqual(expect.arrayContaining(['yours', 'agent']));
      expect((await s.tabList()).join(' | ')).not.toContain('yours');
    } finally {
      s.close();
    }
    await expect.poll(pages).toEqual(originalTabs);
    // Still running, and nothing of the agent's was set on it.
    expect(await runningEndpoint(userData)).not.toBeNull();
    expect(fs.existsSync(path.join(userData, 'agent-downloads'))).toBe(false);
  }, 60_000);
});
