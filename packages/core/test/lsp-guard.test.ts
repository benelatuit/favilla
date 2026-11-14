import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LanguageServers } from '../src/tools/lsp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-lsp-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('language servers', () => {
  it('leave the script files of a project in another language alone', () => {
    // A Go engine for JavaScript: its .js files are test data, not a TypeScript project to load.
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/engine\n');
    fs.mkdirSync(path.join(dir, 'testdata'));
    fs.writeFileSync(path.join(dir, 'testdata', 'case.js'), 'var x = 1;\n');
    const servers = new LanguageServers(dir);
    try {
      expect(servers.covers(path.join(dir, 'testdata', 'case.js'))).toBe(false);
    } finally {
      servers.close();
    }
  });
});
