import fs from 'node:fs';
import type { AgentEvent, Effort, ImagePart, Mode, Runtime, Session } from '@favilla/core';
import { displayPath } from '@favilla/core';

interface HeadlessOptions {
  prompt: string;
  images?: ImagePart[];
  cwd: string;
  model?: string;
  effort?: Effort;
  mode?: Mode;
  output: 'text' | 'json' | 'stream-json';
  resume?: string;
  quiet?: boolean;
  /** Write the JSON summary here when the run ends. */
  summaryFile?: string;
  /**
   * Keep running after the turn, for at most this many minutes, while background commands the agent started run, and
   * carry on in a new turn when one ends (--wait-jobs). Nothing is asked of the model while it waits.
   */
  waitJobsMinutes?: number;
  tokenLimit?: number;
}

const tty = process.stderr.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s);
const accent = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);
// The terminal paints in greys only: a warning is bold like a step's title, and its "!" or "✗" sets it apart.
const warn = (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s);

/** Run one prompt to completion without a person in the loop. Text streams live; the summary comes last. */
export async function runHeadless(rt: Runtime, o: HeadlessOptions): Promise<number> {
  let session: Session;
  if (o.resume) {
    session = await rt.get(o.resume, { autonomous: true, interactive: false, model: o.model });
    if (o.effort) session.setEffort(o.effort);
  } else {
    session = await rt.start({ cwd: o.cwd, model: o.model, effort: o.effort, mode: o.mode, interactive: false, autonomous: true });
  }
  const started = Date.now();
  const usageAtStart = { ...session.usage };
  if (o.waitJobsMinutes) session.waitForJobs(started + o.waitJobsMinutes * 60_000);
  let failure: string | undefined;
  let endReason = 'done';
  let compactions = 0;
  let pruned = 0;
  let streamedText = false;
  let atLineStart = true;
  let reasoningOpen = false;
  const live = o.output === 'text' && !o.quiet;
  const out = (s: string) => {
    process.stdout.write(s);
    atLineStart = s.endsWith('\n');
  };
  if (live) process.stderr.write(dim(`favilla · ${session.meta.provider}/${session.meta.model} · effort ${session.meta.effort} · ${session.meta.cwd}\n\n`));

  const off = session.on((e: AgentEvent) => {
    if (e.type === 'usage' && o.tokenLimit !== undefined && e.usage.totalInput + e.usage.totalOutput > o.tokenLimit)
      session.abort();
    if (e.type === 'turn.end') {
      // A run that waits for its background commands can have several turns: the last one says how it ended.
      endReason = e.reason;
      failure = e.reason === 'error' ? e.error : undefined;
    }
    if (e.type === 'compaction' && e.phase === 'end') compactions++;
    if (e.type === 'compaction' && e.phase === 'pruned') pruned++;
    if (o.output === 'stream-json') {
      process.stdout.write(`${JSON.stringify(e)}\n`);
      return;
    }
    if (!live) return;
    switch (e.type) {
      case 'stream.reasoning':
        if (!reasoningOpen) {
          if (!atLineStart) out('\n');
          process.stderr.write(dim('  thinking: '));
          reasoningOpen = true;
        }
        process.stderr.write(dim(e.delta.replace(/\n+/g, ' ')));
        break;
      case 'stream.text':
        if (reasoningOpen) {
          process.stderr.write('\n');
          reasoningOpen = false;
        }
        out(e.delta);
        streamedText = true;
        break;
      case 'stream.end':
      case 'stream.discard':
        if (reasoningOpen) {
          process.stderr.write('\n');
          reasoningOpen = false;
        }
        if (!atLineStart) out('\n');
        break;
      case 'tool.start':
        process.stderr.write(accent(`  ▸ ${e.title}\n`));
        break;
      case 'tool.end': {
        const first = e.result.content.split('\n')[0].slice(0, 150);
        process.stderr.write(e.result.isError ? warn(`    ✗ ${first}\n`) : dim(`    ✓ ${first}\n`));
        break;
      }
      case 'notice':
        process.stderr.write(warn(`  ! ${e.text}\n`));
        break;
      case 'compaction':
        if (e.phase === 'start') process.stderr.write(dim(`  ~ compacting context (${e.before} tokens)…\n`));
        if (e.phase === 'end') process.stderr.write(dim(`  ~ context now ${e.after} tokens\n`));
        break;
      case 'subagent':
        if (e.event.type === 'tool.start') process.stderr.write(dim(`      · ${e.event.title}\n`));
        break;
    }
  });
  // Background commands still running when a waiting run reached its limit: they are stopped as the run ends.
  let jobsLeft: string[] = [];
  const summarize = () => {
    return {
      session: session.id,
      cwd: displayPath(process.cwd(), session.meta.cwd),
      model: `${session.meta.provider}/${session.meta.model}`,
      effort: session.meta.effort,
      vision: session.modelInfo.vision,
      reason: endReason,
      error: failure,
      steps: session.steps,
      // Replayed copies after a compaction are the same calls again.
      toolCalls: session.messages.reduce((n, m) => n + (m.replay ? 0 : m.parts.filter((p) => p.type === 'tool_call').length), 0),
      compactions,
      pruned,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      usageAtStart,
      usage: session.usage,
      answer: session.answer,
      ...(jobsLeft.length ? { jobsLeft } : {}),
    };
  };
  // If the process ends before the turn does, the summary still says so.
  const onExit = () => {
    if (o.summaryFile) fs.writeFileSync(o.summaryFile, JSON.stringify({ ...summarize(), reason: 'exited', error: failure ?? 'The process exited before the turn ended.' }, null, 2));
  };
  process.on('exit', onExit);
  // Ctrl+C stops the turn cleanly (its calls answered, so the session can go on later) and the run ends as stopped;
  // a second one leaves at once.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return void process.exit(130);
    interrupted = true;
    void session.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await session.send(o.prompt, o.images);
    await session.settled();
    if (o.waitJobsMinutes && !interrupted) {
      jobsLeft = session.jobs.list().map((j) => `${j.id}: ${j.command.length > 120 ? `${j.command.slice(0, 119)}…` : j.command}`);
      if (jobsLeft.length && !o.quiet) process.stderr.write(warn(`  ! Stopped waiting after ${o.waitJobsMinutes} min; still running and stopped now: ${jobsLeft.join('; ')}
`));
    }
  } finally {
    off();
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const summary = summarize();
  const answer = summary.answer;
  if (o.summaryFile) fs.writeFileSync(o.summaryFile, JSON.stringify(summary, null, 2));
  // Quiet prints only the answer, so a run that failed would say nothing at all: why goes to stderr.
  if (o.output === 'text' && o.quiet && failure) process.stderr.write(`${failure}\n`);
  if (o.output === 'json') process.stdout.write(`${JSON.stringify(summary)}\n`);
  else if (o.output === 'text') {
    if (!streamedText || o.quiet) process.stdout.write(`${answer}\n`);
    if (!o.quiet) {
      const u = session.usage;
      process.stderr.write(
        dim(`\n[${summary.reason} · ${summary.model} · ${summary.steps} ${summary.steps === 1 ? 'step' : 'steps'} · ${summary.seconds}s · in ${u.totalInput} (cached ${u.cacheRead}) · out ${u.totalOutput}${u.cost ? ` · $${u.cost.toFixed(4)}` : ''} · session ${session.id}]\n`),
      );
    }
  }
  return endReason === 'done' ? 0 : 1;
}
