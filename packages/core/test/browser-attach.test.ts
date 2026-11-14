import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserSession, runningEndpoint } from '../src/tools/browser';
import { killChild } from '../src/util/proc';

// A browser the user has open with remote debugging on, played by a headless Edge on a profile of its own (never
// the user's): the agent attaches, works in a tab of its own, and leaves the browser as it found it.
const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-attach-edge-'));
let browser: ChildProcess | null = null;
afterAll(async () => {
  if (browser && browser.exitCode === null) {
    const gone = new Promise((r) => browser!.once('exit', r));
    killChild(browser);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
  }
  // Under load Edge's helpers can hold the folder a while longer; a temporary folder left behind does no harm.
  await new Promise((r) => setTimeout(r, 1000));
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* left for the temp folder's own clean-up */
  }
}, 30_000);

describe.skipIf(process.platform !== 'win32' || !edge)("the user's own browser", () => {
  it('without remote debugging on, says how to turn it on', async () => {
    const s = new BrowserSession(edge!, false, { attachDir: userData });
    await expect(s.start()).rejects.toThrow(/edge:\/\/inspect\/#remote-debugging/);
    s.close();
  });

  it('attaches, works in a tab of its own, and leaves the browser and its tabs as they were', async () => {
    browser = spawn(edge!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userData}`, '--no-first-run', '--no-default-browser-check', 'data:text/html,<title>yours</title>'], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 40 && !(await runningEndpoint(userData)); i++) await new Promise((r) => setTimeout(r, 250));
    const port = new URL((await runningEndpoint(userData))!).port;
    const pages = async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; title: string }[]).filter((t) => t.type === 'page').map((t) => t.title);
    for (let i = 0; i < 20 && !(await pages()).includes('yours'); i++) await new Promise((r) => setTimeout(r, 250));

    const s = new BrowserSession(edge!, false, { attachDir: userData, downloadDir: path.join(userData, 'agent-downloads') });
    await s.start();
    await s.open('data:text/html,<title>agent</title>');
    expect(await pages()).toEqual(expect.arrayContaining(['yours', 'agent']));
    expect((await s.tabList()).join(' | ')).not.toContain('yours');
    s.close();
    await new Promise((r) => setTimeout(r, 800));
    expect(await pages()).toContain('yours');
    expect(await pages()).not.toContain('agent');
    // Still running, and nothing of the agent's was set on it.
    expect(await runningEndpoint(userData)).not.toBeNull();
    expect(fs.existsSync(path.join(userData, 'agent-downloads'))).toBe(false);
  }, 60_000);
});
