import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Checkpoints } from '../src/agent/checkpoints';
import { BlobStore } from '../src/store/blobs';
import { reviewTool } from '../src/tools/review';
import type { ToolContext } from '../src/tools/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-review-test-'));

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('reviewTool compact diff assembly', () => {
  it('includes a changed-file manifest, keeps surgical diffs inline, and omits huge newly-added whole-file dumps', async () => {
    const smallFile = path.join(tmp, 'src', 'logic.ts');
    const newHtmlFile = path.join(tmp, 'index.html');
    const largeRewriteFile = path.join(tmp, 'src', 'styles.css');
    fs.mkdirSync(path.dirname(smallFile), { recursive: true });

    const beforeSmall = 'export function sum(a: number, b: number) {\n  return a - b;\n}\n';
    const afterSmall = 'export function sum(a: number, b: number) {\n  return a + b;\n}\n';
    const checkpoints = new Checkpoints(path.join(tmp, 'points'), new BlobStore(path.join(tmp, 'blobs')));
    fs.writeFileSync(smallFile, beforeSmall);
    checkpoints.capture('t1', smallFile);
    fs.writeFileSync(smallFile, afterSmall);
    checkpoints.capture('t1', newHtmlFile);
    const media = path.join(tmp, 'image.dat');
    checkpoints.capture('t1', media);
    fs.writeFileSync(media, Buffer.from([0xff, 0x41]));

    const htmlLines = Array.from({ length: 500 }, (_, i) => `  <div class="card" data-row="${i}">Card ${i}</div>`);
    fs.writeFileSync(newHtmlFile, `<!doctype html>\n<html>\n<body>\n${htmlLines.join('\n')}\n</body>\n</html>\n`);

    const beforeCss = Array.from({ length: 300 }, (_, i) => `.old-${i} { color: #111111; padding: ${i}px; }`).join('\n');
    const afterCss = Array.from({ length: 300 }, (_, i) => `.new-${i} { color: #222222; margin: ${i * 2}px; }`).join('\n');
    fs.writeFileSync(largeRewriteFile, beforeCss);
    checkpoints.capture('t1', largeRewriteFile);
    fs.writeFileSync(largeRewriteFile, afterCss);

    let capturedPrompt = '';
    let capturedAgent = '';
    const ctx = {
      cwd: tmp,
      turn: 't1',
      checkpoints,
      goal: () => null,
      history: () => [
        { id: 'u1', role: 'user', origin: 'user', turn: 't1', time: 1, parts: [{ type: 'text', text: 'Fix sum() and build the board UI.' }] },
      ],
      runSubagent: async (o: { description: string; prompt: string; agent: string }) => {
        capturedPrompt = o.prompt;
        capturedAgent = o.agent;
        return { text: 'No issues found.', steps: 2, tokens: 1200, sessionId: 's_child' };
      },
    } as unknown as ToolContext;

    const out = await reviewTool.execute({}, ctx);
    expect(out.isError).toBeFalsy();
    expect(capturedAgent).toBe('explore');
    expect(capturedPrompt).toContain('Changed files (4):');
    expect(capturedPrompt).toContain('- image.dat (add, +1 -0)');
    expect(capturedPrompt).toContain('--- image.dat');
    expect(capturedPrompt).toContain('+�A');
    expect(capturedPrompt).toContain('- src/logic.ts (update, +1 -1)');
    expect(capturedPrompt).toContain('- index.html (add, +505 -0)');
    expect(capturedPrompt).toContain('+  return a + b;');
    expect(capturedPrompt).toContain('[new file (505 lines) omitted from inline diff; read index.html directly to inspect with line numbers]');
    expect(capturedPrompt).not.toContain('data-row="450"');
    expect(capturedPrompt).toContain('chars omitted; read src/styles.css for the full file');
    expect(capturedPrompt.length).toBeLessThan(12_000);
  });
});
