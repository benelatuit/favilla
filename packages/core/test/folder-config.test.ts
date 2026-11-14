import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The app runs one engine for every folder: a project's .favilla/config.json had applied to none of its sessions there,
// and `favilla web` had applied the one of the folder it started in to every folder (2026-11-06).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-folder-config-'));
process.env.FAVILLA_HOME = path.join(home, 'favilla');
const plain = path.join(home, 'plain');
const repo = path.join(home, 'repo');
for (const d of [process.env.FAVILLA_HOME, plain, path.join(repo, '.favilla')]) fs.mkdirSync(d, { recursive: true });
const settle = (o: unknown) => fs.writeFileSync(path.join(repo, '.favilla', 'config.json'), JSON.stringify(o));
settle({ systemAppend: 'Run the tests with make check.', context: { limit: 20000 } });

const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
});

const { createRuntime } = await import('../src/runtime');
let rt: ReturnType<typeof createRuntime>;

beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  fs.writeFileSync(
    path.join(process.env.FAVILLA_HOME!, 'config.json'),
    JSON.stringify({ model: 'fake/m1', providers: { fake: { api: 'openai-chat', baseUrl: base, auth: 'none', local: true, models: { m1: { contextWindow: 64000 } } } } }),
  );
  rt = createRuntime(plain, { interactive: false });
});

afterAll(async () => {
  rt.dispose();
  fake.close();
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a folder's own settings", () => {
  it('apply to the sessions in that folder and no other, opened again and after a reload too', async () => {
    const inRepo = await rt.start({ cwd: repo, model: 'fake/m1' });
    const elsewhere = await rt.start({ cwd: plain, model: 'fake/m1' });
    expect(inRepo.systemPrompt).toContain('make check');
    expect(inRepo.usage.contextWindow).toBe(20000);
    expect(elsewhere.systemPrompt).not.toContain('make check');
    expect(elsewhere.usage.contextWindow).toBe(64000);
    // Opened again from disk, a session reads its own folder's settings again.
    rt.close(inRepo.id);
    expect((await rt.get(inRepo.id)).usage.contextWindow).toBe(20000);
    // A reload reaches the folder's sessions too, open ones included.
    settle({ systemAppend: 'Run the tests with make verify.', context: { limit: 30000 } });
    rt.reload();
    expect((await rt.get(inRepo.id)).usage.contextWindow).toBe(30000);
    expect((await rt.start({ cwd: repo, model: 'fake/m1' })).systemPrompt).toContain('make verify');
  });
});
