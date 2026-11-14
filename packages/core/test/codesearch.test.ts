import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forgetCodeIndexes, forgetIdleCodeIndexes, searchCode, splitIdentifiers } from '../src/tools/codesearch';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-codesearch-'));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write(
  'src/upload.ts',
  `import { sleep } from './time';

/** Sends one file to the bucket. */
export async function putObject(key: string, body: Buffer) {
  return fetch(\`https://bucket/\${key}\`, { method: 'PUT', body });
}

/** Tries a failed upload again, waiting longer each time (backoff). */
export async function retryUpload(key: string, body: Buffer, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await putObject(key, body);
    } catch {
      await sleep(2 ** attempt * 100);
    }
  }
  throw new Error('upload failed');
}
`,
);
write('src/config.py', 'import json\n\n\ndef load_config_file(path):\n    """Reads the JSON settings file."""\n    with open(path) as f:\n        return json.load(f)\n');
write('README.md', '# Uploader\n\nUploads files to the bucket.\n');
write('dist/bundle.min.js', `${'var a=1;'.repeat(2000)}\n`);
fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');

describe('code search by what it does', () => {
  it('splits identifiers into words and keeps the name', () => {
    expect(splitIdentifiers('retryUpload load_config_file HTTPServer')).toBe('retryUpload retry Upload load_config_file load config file HTTPServer HTTP Server');
  });

  it('finds the definition that does what the query says, with its doc comment', async () => {
    forgetCodeIndexes();
    const signal = new AbortController().signal;
    const r = await searchCode(root, 'retry a failed upload with backoff', { limit: 3, signal });
    expect(r.hits[0]).toMatchObject({ file: 'src/upload.ts', start: 8, head: 'export async function retryUpload(key: string, body: Buffer, attempts = 5) {' });
    expect(r.hits[0].lines.map((l) => l.n)).toContain(8);
    const py = await searchCode(root, 'read the settings file', { limit: 1, signal });
    expect(py.hits[0]).toMatchObject({ file: 'src/config.py', head: 'def load_config_file(path):' });
    // Ignored and minified files are not read.
    expect(r.files).toBe(3);
  });

  it('reads a file again when it changes', async () => {
    const signal = new AbortController().signal;
    write('src/upload.ts', 'export function deleteObject(key: string) {\n  return fetch(key, { method: "DELETE" });\n}\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'src/upload.ts'), later, later);
    const r = await searchCode(root, 'retry a failed upload', { limit: 3, signal });
    expect(r.hits.some((h) => h.head.includes('retryUpload'))).toBe(false);
    const del = await searchCode(root, 'delete an object', { limit: 1, signal });
    expect(del.hits[0].head).toContain('deleteObject');
  });

  it('lets the thread go while a big folder is read, stops at its limit, and goes on from there next time', async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-codesearch-big-'));
    for (let i = 0; i < 1500; i++) {
      const body = Array.from({ length: 40 }, (_, k) => `export function step${i}x${k}(value: number): number {\n  return value * ${k} + ${i};\n}\n`).join('\n');
      fs.mkdirSync(path.join(big, `m${i % 30}`), { recursive: true });
      fs.writeFileSync(path.join(big, `m${i % 30}`, `f${i}.ts`), body);
    }
    forgetCodeIndexes();
    // The longest the thread went without a tick of this timer, while the folder was read.
    let longest = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      longest = Math.max(longest, performance.now() - last);
      last = performance.now();
    }, 5);
    const t0 = performance.now();
    const cut = await searchCode(big, 'step 7 value', { limit: 3, signal: AbortSignal.timeout(150) });
    const cutMs = performance.now() - t0;
    const whole = await searchCode(big, 'step 7 value', { limit: 3, signal: new AbortController().signal });
    clearInterval(tick);
    fs.rmSync(big, { recursive: true, force: true });
    expect(longest).toBeLessThan(150);
    expect(cut.files).toBeLessThan(1500);
    expect(cutMs).toBeLessThan(1000);
    expect(whole.files).toBe(1500);
  }, 60_000);

  it('lets go of an index no search has used for a while, and builds it again when one comes', async () => {
    forgetCodeIndexes();
    const signal = new AbortController().signal;
    await searchCode(root, 'delete an object', { limit: 1, signal });
    expect(forgetIdleCodeIndexes(60_000)).toBe(0);
    expect(forgetIdleCodeIndexes(60_000, Date.now() + 61_000)).toBe(1);
    expect(forgetIdleCodeIndexes(60_000, Date.now() + 61_000)).toBe(0);
    const again = await searchCode(root, 'delete an object', { limit: 1, signal });
    expect(again.hits[0].head).toContain('deleteObject');
  });
});
