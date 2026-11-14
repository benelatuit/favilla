import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, reversePatch, structuredPatch } from 'diff';
import type { ProbeReport } from '../types';
import { observeOutcome } from '../agent/evidence';
import { isCode } from '../agent/turn-checks';
import { displayPath } from '../util/paths';
import { copyTree, isTestFile } from './before';
import { agentEnv, runShell } from './shell';
import type { ToolContext } from './types';

interface Revert {
  path: string;
  line: number;
  current: string;
  content: string;
}

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** Undo one source hunk while retaining the other changes and all current tests. No speculative mutation rules. */
export function partialReverts(cwd: string, originals: Map<string, Buffer | null>, signal?: AbortSignal): Revert[] {
  const variants: Revert[] = [];
  const deadline = Date.now() + 250;
  let read = 0;
  for (const [file, before] of originals) {
    if (signal?.aborted || Date.now() >= deadline || read >= 16) break;
    if (!before || !inside(cwd, file) || !isCode(file) || isTestFile(path.relative(cwd, file)) || before.length > 256_000) continue;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 256_000) continue;
      read++;
      const current = fs.readFileSync(file, 'utf8');
      const patch = structuredPatch(file, file, before.toString('utf8'), current, '', '', { context: 0, timeout: 30 });
      if (!patch) continue;
      for (const hunk of patch.hunks.slice(0, 8)) {
        const content = applyPatch(current, reversePatch({ ...patch, hunks: [hunk] }), { autoConvertLineEndings: false });
        if (typeof content === 'string' && content !== current) variants.push({ path: file, line: Math.max(1, hunk.newStart), current, content });
      }
    } catch {
      // Deleted, unreadable and non-text sources offer no safe partial reversion.
    }
  }
  // A single hunk would only repeat the all-old-code check. Prefer two different files when possible.
  if (variants.length < 2) return [];
  return [variants[0], variants.find((v) => v.path !== variants[0].path) ?? variants[1]];
}

/** Up to two extra runs, only on explicit request. Each uses a fresh source copy and is removed in finally. */
export async function probeChanges(ctx: ToolContext, root: string, command: string): Promise<ProbeReport> {
  const report: ProbeReport = { results: [] };
  if (!inside(ctx.cwd, root)) return { ...report, skipped: 'Probes work only inside the working directory.' };
  if (ctx.signal.aborted) return { ...report, skipped: 'Probe interrupted.' };
  const variants = partialReverts(ctx.cwd, ctx.checkpoints.originals(), ctx.signal);
  if (!variants.length) return { ...report, skipped: 'No two independent source hunks to sample; use before for a single change.' };
  for (const [index, v] of variants.entries()) {
    if (ctx.signal.aborted) { report.skipped = 'Probe interrupted.'; break; }
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'favilla-probe-'));
    try {
      const made = copyTree(ctx.cwd, copy, ctx.signal);
      if ('error' in made) { report.skipped = made.error; break; }
      const target = path.join(copy, path.relative(ctx.cwd, v.path));
      // Dependencies can be links into the real project. Never patch through one.
      if (!fs.existsSync(target) || !inside(fs.realpathSync(copy), fs.realpathSync(target))) {
        report.skipped = 'A sampled source resolves outside the isolated source copy.';
        continue;
      }
      if (fs.readFileSync(target, 'utf8') !== v.current) { report.skipped = 'Source changed while preparing the probe; rerun the current tests.'; break; }
      fs.writeFileSync(target, v.content);
      const runRoot = path.join(copy, path.relative(ctx.cwd, root));
      if (!inside(fs.realpathSync(copy), fs.realpathSync(runRoot))) { report.skipped = 'The check folder resolves outside the source copy.'; break; }
      const logPath = path.join(ctx.outputDir, `${ctx.callId}-probe-${index + 1}.log`);
      ctx.progress(`$ ${command}   (probe ${index + 1}: partial revert of ${displayPath(ctx.cwd, v.path)}:${v.line})\n`);
      if (ctx.signal.aborted) { report.skipped = 'Probe interrupted.'; break; }
      const run = await runShell(ctx.shell, command, {
        cwd: runRoot, signal: ctx.signal, timeoutMs: Math.min(30_000, ctx.config.bashTimeoutMs ?? 30_000),
        env: agentEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }), logFile: logPath, memoryGuard: ctx.config.memoryGuard !== false,
      });
      if (!run.logPath) {
        fs.mkdirSync(ctx.outputDir, { recursive: true });
        fs.writeFileSync(logPath, run.output);
      }
      const observed = observeOutcome('shell', {}, {
        content: run.output, isError: run.exitCode !== 0,
        display: { kind: 'terminal', command, cwd: runRoot, output: run.output, exitCode: run.exitCode, durationMs: run.durationMs, timedOut: run.timedOut, stoppedFor: run.stoppedFor || (ctx.signal.aborted ? 'interrupted' : undefined) },
      }, ctx.cwd, []);
      const complete = !ctx.signal.aborted && !run.timedOut && !run.stoppedFor;
      const outcome = complete && run.exitCode === 0 ? 'survived' : complete && observed.failure?.kind === 'assertion' ? 'detected' : 'inconclusive';
      report.results.push({ path: displayPath(ctx.cwd, v.path), line: v.line, outcome, logPath: run.logPath ?? logPath });
    } catch (e) {
      report.skipped = `Probe could not run: ${(e as Error).message}`;
      break;
    } finally {
      fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  return report;
}

export function describeProbe(report: ProbeReport): string {
  return [
    'Test sensitivity (sampled partial reversions, not full coverage):',
    ...report.results.map((r) => `- ${r.path}:${r.line}: ${r.outcome}${r.logPath ? ` (log ${r.logPath})` : ''}`),
    ...(report.skipped ? [report.skipped] : []),
    'Detected means an assertion failed. A survivor means this command did not detect that reversion; it is not proof of a defect or a redundant change. Build failures and interrupted runs are inconclusive.',
  ].join('\n');
}
