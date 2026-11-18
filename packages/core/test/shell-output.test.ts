import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { shellTool } from '../src/tools/shell-tools';
import { detectShell } from '../src/tools/shell';
import type { ToolContext } from '../src/tools/types';

it('folds only adjacent identical foreground output and keeps the full log', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-shell-output-'));
  try {
    const repeated = 'worker waiting\n'.repeat(600);
    const middle = '12:00:01 INFO tick\n12:00:02 INFO tick\nFAIL invoice_round_trip: 17 != 13';
    const original = repeated + middle + '\n' + repeated;
    fs.writeFileSync(path.join(cwd, 'run.txt'), original);
    const ctx = { cwd, callId: 'c', outputDir: cwd, outputChars: 4000, signal: new AbortController().signal, shell: detectShell(), config: {} } as ToolContext;
    const r = await shellTool.execute({ command: `node -e "process.stdout.write(require('fs').readFileSync('run.txt'));process.exitCode=1"` }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(middle);
    expect(r.content.match(/600 consecutive identical lines/g)).toHaveLength(2);
    expect(r.content).toContain('Exit code 1');
    expect(fs.readFileSync(path.join(cwd, 'c.log'), 'utf8')).toBe(original);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
