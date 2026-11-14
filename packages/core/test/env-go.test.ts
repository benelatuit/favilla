import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { goToolchain } from '../src/prompt/env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-go-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a Go module and the go installed', () => {
  it('says when the module asks for a newer Go, and says nothing otherwise', () => {
    expect(goToolchain(dir, '1.24.5')).toEqual([]);
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n\ngo 1.27.0\n');
    expect(goToolchain(dir, '1.24.5')[0]).toContain('leave GOTOOLCHAIN unset');
    expect(goToolchain(dir, '1.27.0')).toEqual([]);
    expect(goToolchain(dir, '1.28')).toEqual([]);
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n\ngo 1.22\n\ntoolchain go1.26.1\n');
    expect(goToolchain(dir, '1.24.5')[0]).toContain('Go 1.26.1');
  });
});
