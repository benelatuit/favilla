import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeUnusedServers, LanguageServers, runningServers } from '../src/tools/lsp';

// Inside the repository, so the project finds the workspace's TypeScript 7 server above it. Ones an earlier run could
// not remove (a server still held them) go first.
for (const old of fs.readdirSync(path.join(__dirname, '..')).filter((n) => n.startsWith('.lsp-shared-'))) fs.rmSync(path.join(__dirname, '..', old), { recursive: true, force: true });
const proj = fs.mkdtempSync(path.join(__dirname, '..', '.lsp-shared-'));
fs.writeFileSync(path.join(proj, 'package.json'), '{ "name": "shared-lsp-test", "private": true }\n');
fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "noEmit": true } }\n');
const file = path.join(proj, 'a.ts');
fs.writeFileSync(file, 'export const a: number = 1;\n');
afterAll(async () => {
  // The shared server stays a minute after its last session, in this folder: stop it before removing the folder.
  closeUnusedServers();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe.skipIf(!new LanguageServers(proj).covers(file))('language servers across sessions', () => {
  it('two sessions on one project share one server, which outlives the first to close', async () => {
    const before = runningServers();
    const a = new LanguageServers(proj);
    const b = new LanguageServers(proj);
    try {
      expect((await a.errors(file, 30_000))?.diagnostics).toEqual([]);
      fs.writeFileSync(file, 'export const a: number = "one";\n');
      const seen = await b.errors(file, 30_000);
      expect(seen?.server).toBe('TypeScript');
      expect(seen?.diagnostics.length).toBe(1);
      expect(runningServers()).toBe(before + 1);
      a.close();
      fs.writeFileSync(file, 'export const a: number = 2;\n');
      expect((await b.errors(file, 30_000))?.diagnostics).toEqual([]);
      expect(runningServers()).toBe(before + 1);
    } finally {
      a.close();
      b.close();
    }
  }, 90_000);
});
