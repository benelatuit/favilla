import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileTracker } from '../src/tools/filestate';
import { JobManager } from '../src/tools/jobs';
import { detectShell } from '../src/tools/shell';

// Several sessions in one folder, all in the desktop app's one engine (2026-11-06): a second session started the dev
// server the first was running, and an edit refused for a file changed since its read did not say who had changed it.
const top = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-one-folder-'));
const managers: JobManager[] = [];
afterAll(async () => {
  await Promise.all(managers.map((m) => m.disposeAll()));
  fs.rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a file another session changed', () => {
  it('is refused for an edit with the reason that another Favilla session changed it', async () => {
    const file = path.join(top, 'page.html');
    fs.writeFileSync(file, '<h1>one</h1>');
    const mine = new FileTracker();
    const theirs = new FileTracker();
    mine.recordRead(file);
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(file, '<h1>two</h1>');
    theirs.recordWrite(file);
    expect(mine.checkEditable(file)).toMatch(/Another Favilla session in this folder changed this file/);
    // A change by a command or the user says so as before.
    mine.recordRead(file);
    fs.writeFileSync(file, '<h1>three, from a formatter</h1>');
    expect(mine.checkEditable(file)).toMatch(/modified since it was last read/);
  });
});

describe('a dev server another session runs', () => {
  it('is found by the same command in the same folder, and only while it runs', async () => {
    const shell = detectShell();
    const [a, b] = [new JobManager(shell, path.join(top, 'logs-a')), new JobManager(shell, path.join(top, 'logs-b'))];
    managers.push(a, b);
    const server = `node -e "setInterval(() => {}, 1000)" --serve`;
    const job = a.start(server, top);
    expect(b.twin(server, top)?.id).toBe(job.id);
    expect(b.twin(`${server}  `, top)?.id).toBe(job.id);
    // Its own job is no twin, another folder's neither, and a one-off command never is.
    expect(a.twin(server, top)).toBeUndefined();
    expect(b.twin(server, path.join(top, 'other'))).toBeUndefined();
    expect(b.twin('node -e "1"', top)).toBeUndefined();
    await a.disposeAll();
    await new Promise((r) => setTimeout(r, 500));
    expect(b.twin(server, top)).toBeUndefined();
  }, 20_000);
});
