import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Claims, claimsForTest } from '../src/agent/claims';

const { covers, overlaps } = claimsForTest;
const root = path.resolve('/work/app');

describe('sub-agent files', () => {
  it('a claim covers its files, folders and globs, nothing else', () => {
    expect(covers('src/a.ts', 'src/a.ts')).toBe(true);
    expect(covers('src', 'src/deep/b.ts')).toBe(true);
    expect(covers('src/**/*.test.ts', 'src/x/y.test.ts')).toBe(true);
    expect(covers('src/*.ts', 'src/x/y.ts')).toBe(false);
    expect(covers('src/a.ts', 'src/a.tsx')).toBe(false);
    expect(covers('lib', 'library/x.ts')).toBe(false);
  });

  it('claims overlap when they could touch the same file', () => {
    expect(overlaps(['src/a.ts'], ['src/b.ts'])).toBe(false);
    expect(overlaps(['src/a.ts'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src/**/*.ts'], ['src/a.ts'])).toBe(true);
    expect(overlaps(['src/**/*.ts'], ['docs/a.md'])).toBe(false);
    expect(overlaps(['web/*.css'], ['web/app.tsx'])).toBe(false);
    expect(overlaps(null, ['docs/a.md'])).toBe(true);
  });

  it('refuses changes outside the brief and queues agents whose files overlap', async () => {
    const claims = new Claims(root);
    expect(claims.check(['src/a.ts'], path.join(root, 'src/a.ts'))).toBeNull();
    expect(claims.check(['src/a.ts'], path.join(root, 'src/b.ts'))).toMatch(/only src\/a\.ts; src\/b\.ts is not among them/);
    expect(claims.check(null, path.join(root, 'anything.ts'))).toBeNull();

    const order: string[] = [];
    const signal = new AbortController().signal;
    await claims.acquire('one', 'parser', ['src/parse.ts'], () => order.push('never'), signal);
    // Separate files: no wait.
    await claims.acquire('two', 'docs', ['docs'], () => order.push('never'), signal);
    // The same file: waits until the first lets go.
    const third = claims.acquire('three', 'tests', ['src/parse.ts', 'test'], (holder) => order.push(`waits for ${holder}`), signal).then(() => order.push('three runs'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['waits for parser']);
    claims.release('one');
    await third;
    expect(order).toEqual(['waits for parser', 'three runs']);

    // A stop while waiting gives up the wait.
    const stop = new AbortController();
    const fourth = claims.acquire('four', 'everything', null, () => {}, stop.signal);
    stop.abort();
    await expect(fourth).rejects.toThrow(/Stopped while waiting/);
  });
});
