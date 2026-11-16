import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inGitRepo, isCodeProject } from '../src/prompt/env';
import { buildTools, type ProfileContext } from '../src/tools/profiles';

// What kind of folder a session works in decides tools and standards: attempts needs git, symbols and the engineering
// standards need code, and a folder of documents that is a repository is still not code (2026-11-06).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-folder-kind-'));
const make = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('the kind of folder a session works in', () => {
  it('is code with a project marker or a source file, at the top or one folder down, and not for documents in git', () => {
    make('docs/notes.md');
    make('docs/report.docx');
    make('docs/tidy.sh');
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'docs') });
    expect(isCodeProject(path.join(root, 'docs'))).toBe(false);
    expect(inGitRepo(path.join(root, 'docs'))).toBe(true);
    make('one/main.go', 'package main\n');
    expect(isCodeProject(path.join(root, 'one'))).toBe(true);
    make('workspace/api/package.json', '{}');
    make('workspace/README.md');
    expect(isCodeProject(path.join(root, 'workspace'))).toBe(true);
    expect(inGitRepo(path.join(root, 'workspace'))).toBe(false);
  });

  it('offers attempts only in git, symbols and check only in code, ask only when interactive, and present_plan only in plan mode', () => {
    const pc = (git: boolean, code: boolean, extra: Partial<ProfileContext> = {}): ProfileContext => ({ shell: { label: 'bash' } as never, cwd: root, timeoutMs: 1000, vision: true, role: 'main', search: 'off', screenshot: false, git, code, ...extra });
    const names = (git: boolean, code: boolean, extra?: Partial<ProfileContext>) => buildTools('favilla', pc(git, code, extra)).map((b) => b.spec.name);
    expect(names(false, false)).not.toContain('attempts');
    expect(names(false, false)).not.toContain('symbols');
    expect(names(false, false)).not.toContain('check');
    expect(names(true, true)).toEqual(expect.arrayContaining(['attempts', 'symbols', 'check', 'ask', 'present_plan']));
    expect(names(true, true, { autonomous: true, plan: false })).not.toContain('ask');
    expect(names(true, true, { autonomous: true, plan: false })).not.toContain('present_plan');
  });

  it("takes an edit's file from path, file_path, or a paths of one, and names path when none is there", () => {
    const edit = buildTools('favilla', { shell: { label: 'bash' } as never, cwd: root, timeoutMs: 1000, vision: true, role: 'main', search: 'off', screenshot: false }).find((b) => b.spec.name === 'edit')!;
    const args = { old_string: 'a', new_string: 'b' };
    expect(edit.normalize({ ...args, path: 'x.ts' })).toMatchObject({ path: 'x.ts' });
    expect(edit.normalize({ ...args, file_path: 'y.ts' })).toMatchObject({ path: 'y.ts' });
    expect(edit.normalize({ ...args, paths: ['z.ts'] })).toMatchObject({ path: 'z.ts' });
    expect(() => edit.normalize({ ...args, paths: ['a.ts', 'b.ts'] })).toThrow('Missing required parameter "path".');
  });
});
