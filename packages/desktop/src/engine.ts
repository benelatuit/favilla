import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { preloadDataKeys } from '@favilla/core/store/seal';
import { LAG_MS, log } from './log';

/**
 * The agent engine of the desktop app, in a process of its own (an Electron utility process): the runtime and the
 * server the window loads its page from. A step of the engine that holds its thread (a long session read, an output
 * stored) slows a request; the window goes on answering, since it runs elsewhere. What only the app can do (a folder
 * dialog, opening a link, how long the computer has been idle, keeping it awake) is asked of it by message (main.ts).
 */
export type ToEngine = { type: 'picked'; id: number; path: string | null } | { type: 'idle'; seconds: number } | { type: 'shutdown' };
export type FromEngine =
  | { type: 'ready'; url: string; token: string; port: number }
  | { type: 'pick-folder'; id: number }
  | { type: 'open-external'; url: string }
  | { type: 'awake'; want: boolean }
  | { type: 'closed' };

const parent = process.parentPort;
const send = (m: FromEngine) => parent.postMessage(m);
process.on('uncaughtException', (e) => log(`engine uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`engine unhandled: ${(e as Error)?.stack ?? e}`));

/** The computer's idle time as the app last reported it (every few seconds). */
let idle = { seconds: 0, at: Date.now() };
const picks = new Map<number, (folder: string | null) => void>();
let picksMade = 0;
let close: (() => Promise<void>) | null = null;

parent.on('message', (e) => {
  const m = e.data as ToEngine;
  if (m.type === 'picked') {
    picks.get(m.id)?.(m.path);
    picks.delete(m.id);
  } else if (m.type === 'idle') idle = { seconds: m.seconds, at: Date.now() };
  else if (m.type === 'shutdown') {
    void (close ?? (async () => {}))()
      .then(() => log('engine closed its sessions and server'))
      .catch((err) => log(`engine shutdown: ${err}`))
      .finally(() => {
        send({ type: 'closed' });
        process.exit(0);
      });
  }
});

async function main(): Promise<void> {
  preloadDataKeys();
  const core = await import('@favilla/core');
  // A hold-up of two seconds or more names itself when it ends: the functions that took the time, from a profile of
  // this thread taken meanwhile (the timed steps below name only what was wrapped in advance). FAVILLA_BLOCK_MS sets
  // the threshold, for measuring shorter ones.
  core.watchStalls((s) => log(`engine held up ${s.ms} ms in ${s.busiest.join(', ') || 'nothing sampled'}${s.path.length ? `; by way of ${s.path.join(' > ')}` : ''}`), {
    afterMs: Number(process.env.FAVILLA_BLOCK_MS) || 2000,
    onError: (e) => log(`engine stall watch off: ${e}`),
  });
  const rt = core.createRuntime(os.homedir(), { interactive: true });
  const pickFolder = () =>
    new Promise<string | null>((resolve) => {
      const id = ++picksMade;
      picks.set(id, resolve);
      send({ type: 'pick-folder', id });
    });
  const preferred = Number(process.env.FAVILLA_PORT ?? 0);
  const serve = (port: number) =>
    core.startServer({
      runtime: rt,
      webDir: process.env.FAVILLA_WEB_DIR!,
      pickFolder,
      openExternal: (url) => send({ type: 'open-external', url }),
      version: process.env.FAVILLA_VERSION ?? '',
      // Someone at the computer sees its own notifications: the phones are left in peace. Between the app's reports
      // the idle time grows as if nobody touched anything, a few seconds' error at most.
      idleSeconds: () => idle.seconds + (Date.now() - idle.at) / 1000,
      // The app holds the token, so an engine started again keeps the page's sign-in.
      token: process.env.FAVILLA_TOKEN || undefined,
      port,
    });
  const server = await serve(preferred).catch((e) => {
    log(`port ${preferred} is not free (${e}); taking another`);
    return serve(0);
  });
  // The window reaches sessions only through the server, so idle ones can leave memory.
  rt.housekeeping({ evictAfterMs: 15 * 60_000 });
  close = async () => {
    await server.close();
    await rt.shutdown();
  };

  // A hold-up here delays requests (the window stays live). Each one over a second is logged with what the sessions
  // were running (tool names only) and the slowest of Favilla's own steps meanwhile, so the next one names its cause.
  const lag = monitorEventLoopDelay({ resolution: 50 });
  lag.enable();
  let window0 = Date.now();
  setInterval(() => {
    const worst = Math.round(lag.max / 1e6);
    lag.reset();
    const since = window0;
    window0 = Date.now();
    if (worst < LAG_MS) return;
    const running = [...rt.live.values()].flatMap((s) => s.stepsSoFar().filter((x) => !x.ended).map((x) => x.name));
    const slow = core.slowSince(since).map((x) => `${x.label} ${x.ms} ms`);
    log(`engine held up ${worst} ms; ${rt.live.size} sessions open; tools running: ${running.join(', ') || 'none'}${slow.length ? `; slowest steps: ${slow.join(', ')}` : ''}`);
  }, 5000).unref();

  // A phone reaches this computer only while it is awake: with remote control on, it stays awake while work runs or
  // waits for an answer, and the whole time with remote.awake. The app holds the power blocker; this says when.
  let awake = false;
  const stayAwake = () => {
    const r = rt.config.remote;
    const want = !!r?.enabled && (!!r.awake || [...rt.live.values()].some((s) => s.inUse()));
    if (want === awake) return;
    awake = want;
    send({ type: 'awake', want });
  };
  rt.subscribe((e) => {
    if (e.type === 'status' || e.type === 'turn.end' || e.type === 'background') stayAwake();
  });
  // Settings changes and jobs that end without an event of their own.
  setInterval(stayAwake, 30_000).unref();

  send({ type: 'ready', url: server.url, token: server.token, port: server.port });
}

main().catch((e) => {
  log(`engine failed: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});
