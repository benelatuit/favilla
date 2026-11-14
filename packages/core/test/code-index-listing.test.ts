import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { forgetCodeIndexes, searchCode } from '../src/tools/codesearch';
import { runRipgrep } from '../src/tools/ripgrep';

vi.mock('../src/tools/ripgrep', () => ({ runRipgrep: vi.fn() }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-code-listing-'));
fs.writeFileSync(path.join(root, 'first.ts'), 'export function firstToken() { return 1; }\n');
fs.writeFileSync(path.join(root, 'second.ts'), 'export function secondToken() { return 2; }\n');
afterAll(() => {
  forgetCodeIndexes();
  fs.rmSync(root, { recursive: true, force: true });
});

const complete = { code: 0, stdout: 'first.ts\nsecond.ts\n', stderr: '', truncated: false };
const listing = vi.mocked(runRipgrep);
const search = (signal = new AbortController().signal) => searchCode(root, 'second token', { signal });

describe('refreshing the code index', () => {
  it('keeps all indexed files if the listing is interrupted or fails', async () => {
    listing.mockResolvedValueOnce(complete);
    const before = await search();
    expect(before.files).toBe(2);
    expect(before.hits[0]?.file).toBe('second.ts');

    const controller = new AbortController();
    listing.mockImplementationOnce(async (_args, _cwd, signal) => {
      expect(signal.aborted).toBe(false);
      await Promise.resolve();
      controller.abort();
      return { ...complete, code: null, stdout: 'first.ts\n' };
    });
    expect(await search(controller.signal)).toEqual(before);

    listing.mockResolvedValueOnce({ ...complete, code: 2, stdout: 'first.ts\n', stderr: 'listing failed' });
    expect(await search()).toEqual(before);
    listing.mockResolvedValueOnce({ ...complete, timedOut: true, stdout: 'first.ts\n' });
    expect(await search()).toEqual(before);
    listing.mockResolvedValueOnce({ ...complete, truncated: true, stdout: 'first.ts\n' });
    expect(await search()).toEqual(before);

    fs.rmSync(path.join(root, 'second.ts'));
    listing.mockResolvedValueOnce({ ...complete, code: 2, stdout: 'first.ts\n', stderr: 'listing failed' });
    const missing = await search();
    expect(missing.files).toBe(2);
    expect(missing.hits.some((h) => h.file === 'second.ts')).toBe(false);

    // Exit 1 is ripgrep's successful empty listing. It still removes files.
    listing.mockResolvedValueOnce({ ...complete, code: 1, stdout: '' });
    expect(await search()).toEqual({ hits: [], pieces: 0, files: 0 });
  });
});
