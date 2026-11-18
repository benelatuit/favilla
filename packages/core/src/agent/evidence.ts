import path from 'node:path';
import type { FileVersion, Message, ReadEvidence, ToolEvidence, ToolResultPart } from '../types';
import { fileDigest, type FileTracker } from '../tools/filestate';
import { displayPath, normalizeForCompare } from '../util/paths';
import { cleanTerminal, oneLine } from '../util/text';
import { PIPE_CLOSED } from '../tools/shell';
import { isCheckCommand, isCode, printsFailure, ranNoTests, runsSomething } from './turn-checks';

type Outcome = Pick<ToolResultPart, 'content' | 'isError' | 'display'>;

export function snapshotVersions(files: string[]): FileVersion[] {
  return [...new Set(files)].slice(-32).map((p) => ({ path: p, digest: fileDigest(p) }));
}

/** Facts supplied by the tool, not an interpretation of the model's reasoning or of a defect's root cause. */
export function observeOutcome(kind: string, input: Record<string, unknown>, out: Outcome, cwd: string, inputs: FileVersion[]): ToolEvidence {
  const evidence: ToolEvidence = {};
  const d = out.display;
  const text = cleanTerminal(d?.kind === 'terminal' ? d.output : d?.kind === 'checks' ? [out.content, ...d.results.flatMap((r) => [r.summary ?? '', ...r.problems])].join('\n') : out.content);
  const diagnostic = oneLine(text.trim().split(/\r?\n/).find((l) => /error|fail|not found|no such|cannot|expected|stopped|interrupt/i.test(l)) ?? text.trim(), 280);
  const command = d?.kind === 'terminal' ? d.command : d?.kind === 'checks' ? d.results.map((r) => r.command).join('; ') : '';
  // `find | head` ends this way and nothing went wrong; a test run cut short the same way gave no verdict.
  const pipeClosed = d?.kind === 'terminal' && d.exitCode === PIPE_CLOSED;
  const interrupted = d?.kind === 'terminal' ? !!(d.timedOut || d.stoppedFor || (d.background && kind !== 'job') || d.exitCode === null || (pipeClosed && isCheckCommand(d.command))) :
    d?.kind === 'checks' ? !!d.incomplete || d.results.some((r) => r.timedOut || r.problems.some((p) => /^Stopped by \w+:/.test(p))) : /Interrupted by the user/.test(text);
  const failed = !pipeClosed && (!!out.isError || (d?.kind === 'terminal' && d.exitCode !== null && (d.exitCode !== 0 || printsFailure(d.command, text))) || (d?.kind === 'checks' && d.results.some((r) => !r.ok)));
  if (failed || interrupted) {
    const category = /\bcommand not found\b|is not recognized as an internal|spawn \S+ ENOENT/.test(text) || (d?.kind === 'terminal' && d.exitCode === 127) ? 'environment' :
      interrupted ? 'interrupted' :
      (kind === 'read' || kind === 'edit' || kind === 'patch' || /Invalid arguments:|Missing required parameter|valid JSON arguments|Plan mode is on|did not allow this command/.test(text)) ? 'input' :
      /\[build failed\]|SyntaxError|error TS\d+|cannot find package|Cannot find module|ModuleNotFoundError|ImportError/.test(text) ? 'build' :
      /AssertionError|assertion.*failed|expected.*(?:got|received)|FAIL\s|--- FAIL:|[×✗✖]/i.test(text) ? 'assertion' : 'other';
    evidence.failure = {
      kind: category, scope: oneLine(command || String(input.path ?? JSON.stringify(input)), 220), diagnostic,
    };
  }
  if (d?.kind === 'checks' && d.results.length || d?.kind === 'terminal' && runsSomething(d.command)) {
    const empty = ranNoTests(text);
    const sensitivity = d?.kind === 'checks' ? [
      d.verdict ? `tests on before-code: ${d.verdict.kind} (${d.verdict.files.slice(0, 2).join(', ')})` : '',
      d.probe ? `partial-revert sample: ${d.probe.results.map((r) => `${r.path}:${r.line} ${r.outcome}`).join('; ')}${d.probe.skipped ? `; ${d.probe.skipped}` : ''}` : '',
    ].filter(Boolean).join('; ') : '';
    evidence.run = {
      command: oneLine(command, 300), cwd: d?.kind === 'terminal' ? d.cwd : path.resolve(cwd, String(input.path ?? '.')),
      outcome: interrupted || evidence.failure?.kind === 'environment' ? 'unknown' : failed ? 'failed' : empty ? 'unknown' : 'passed',
      before: input.before === true || (d?.kind === 'checks' && d.before) || undefined,
      diagnostic: oneLine([failed || interrupted ? diagnostic : '', empty ? 'ran no tests' : '', sensitivity].filter(Boolean).join('; '), 400) || undefined,
      logPath: d?.kind === 'terminal' ? d.logPath : d?.kind === 'checks' ? (d.results.find((r) => !r.ok) ?? d.results[0]).logPath : undefined,
      inputs,
    };
  }
  if (!out.isError && d?.kind === 'diff') {
    const allWritten = d.files.map((f) => path.resolve(cwd, f.path));
    evidence.writes = allWritten.filter(isCode);
    evidence.writtenFiles = snapshotVersions(allWritten);
  }
  return evidence;
}

export function recoveryNote(previous: ToolEvidence[], current: ToolEvidence): string {
  const f = current.failure;
  if (!f || previous.slice(-8).filter((e) => e.failure?.kind === f.kind && e.failure.scope === f.scope && e.failure.diagnostic === f.diagnostic).length !== 1) return '';
  const next = {
    input: 'Read or locate the exact current file and check the arguments before trying again.',
    environment: 'Verify the executable and working directory with the project configuration; another source edit will not establish that the runner is available.',
    assertion: 'Trace the failing input through its actual caller and compare the expected value with the contract. Choose a small test that distinguishes the competing explanations before another edit.',
    build: 'Use the diagnostic to check the referenced symbol, import and build target before changing the implementation again.',
    interrupted: 'The run did not complete. Narrow its scope or resolve the resource limit; do not count this as a test verdict.',
    other: 'Read the saved output and identify one fact that would distinguish a wrong assumption from an incomplete fix; repeating the same command alone adds no evidence.',
  }[f.kind];
  return `Repeated ${f.kind} failure: ${f.diagnostic || f.scope}. ${next}`;
}

export function recordedEvidence(messages: Message[]): { callId: string; evidence: ToolEvidence }[] {
  return messages.filter((m) => !m.replay).flatMap((m) => m.parts.flatMap((p) => p.type === 'tool_result' && p.evidence ? [{ callId: p.callId, evidence: p.evidence }] : []));
}

/** Only history before a fork point is passed here. The latest version of each file supersedes its older reads. */
export function restoreReads(files: FileTracker, messages: Message[]): string[] {
  const latestRead = new Map<string, ReadEvidence>();
  const latestWrite = new Map<string, FileVersion>();
  for (const { evidence } of recordedEvidence(messages)) {
    for (const r of evidence.reads ?? []) {
      const key = normalizeForCompare(r.path);
      const old = latestRead.get(key);
      latestRead.delete(key);
      latestWrite.delete(key);
      latestRead.set(key, { ...r, ranges: old?.digest === r.digest ? [...old.ranges, ...r.ranges] : r.ranges });
      if (latestRead.size > 100) latestRead.delete(latestRead.keys().next().value!);
    }
    const written: FileVersion[] = evidence.writtenFiles ?? (evidence.writes ?? []).map((p) => ({ path: p }));
    for (const w of written) {
      const key = normalizeForCompare(w.path);
      // Mirror live `FileTracker.recordWrite`: the agent's own edit supersedes its earlier pre-edit read rather than
      // flagging the file as externally modified on `-p -c` reload.
      latestRead.delete(key);
      latestWrite.delete(key);
      if (w.digest !== undefined) {
        latestWrite.set(key, w);
        if (latestWrite.size > 100) latestWrite.delete(latestWrite.keys().next().value!);
      }
    }
  }
  const stale = [...latestRead.values()].filter((r) => !files.restore(r)).map((r) => r.path);
  for (const w of latestWrite.values()) {
    const current = fileDigest(w.path);
    if (w.digest === null ? current !== null : current !== w.digest) stale.push(w.path);
  }
  return stale;
}

/** A bounded record survives compaction; unchanged tracked inputs never imply the whole workspace is verified. */
export function evidenceSummary(messages: Message[], cwd: string, staleOnly = false): string {
  const rows: string[] = [];
  const laterWrites = new Set<string>();
  const versions = new Map<string, string | null | undefined>();
  const latest = new Set<string>();
  for (const { callId, evidence: e } of recordedEvidence(messages).reverse()) {
    for (const p of e.writes ?? []) laterWrites.add(normalizeForCompare(p));
    const r = e.run;
    if (!r && !e.failure) continue;
    if (r) {
      const key = `${r.cwd}\0${r.command}\0${!!r.before}`;
      if (staleOnly && latest.has(key)) continue;
      latest.add(key);
      const tracked = new Set(r.inputs.map((v) => normalizeForCompare(v.path)));
      const stale = [...laterWrites].some((p) => !tracked.has(p)) || r.inputs.some((v) => {
        if (!versions.has(v.path)) versions.set(v.path, fileDigest(v.path));
        return v.digest !== undefined && versions.get(v.path) !== v.digest;
      });
      if (staleOnly && !stale) continue;
      const known = r.inputs.length > 0 && r.inputs.every((v) => v.digest !== undefined);
      const state = stale ? 'STALE after source changes' : known ? 'tracked inputs unchanged' : 'input coverage incomplete';
      rows.push(`- ${r.before ? 'before-code ' : ''}${r.outcome}: ${r.command} [${displayPath(cwd, r.cwd)}; ${state}; call ${callId}]${r.diagnostic ? ` — ${r.diagnostic}` : ''}${r.logPath ? ` (log ${displayPath(cwd, r.logPath)})` : ''}`);
    } else if (!staleOnly) {
      rows.push(`- Historical ${e.failure!.kind} failure: ${e.failure!.scope} — ${e.failure!.diagnostic} [call ${callId}]`);
    }
    if (rows.length >= 6) break;
  }
  return rows.length ? `Recorded observations (scoped runs and known inputs only; other files and environment are not tracked):\n${rows.reverse().join('\n')}` : '';
}
