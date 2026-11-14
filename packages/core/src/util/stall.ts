import { Worker } from 'node:worker_threads';

/**
 * What the thread was doing while it held up. A watchdog thread sees its heartbeat stop, profiles it through the
 * inspector until it beats again, and reports the functions that took the time: the names and files of the code,
 * never what the code held. The timed steps (slow.ts) name only what was wrapped in advance; a hold-up elsewhere
 * named nothing (27 s at the desktop app's first start of 1.2.0, no step over 200 ms, 2026-11-05).
 */
export interface Stall {
  ms: number;
  /** The functions that ran longest themselves, the longest first: "name file:line 1234 ms". */
  busiest: string[];
  /** The calls that led to the busiest one, outermost first. */
  path: string[];
}

// Plain JavaScript run in the watchdog thread: it cannot import this module's TypeScript.
const WATCHDOG = `
const { workerData, parentPort } = require('node:worker_threads');
const inspector = require('node:inspector');
const beat = new BigInt64Array(workerData.sab);
let session = null;
let began = 0;
const where = (f) => (f.functionName || '(anonymous)') + (f.url ? ' ' + f.url.split(/[\\\\/]/).pop() + ':' + (f.lineNumber + 1) : '');
function summary(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const self = new Map();
  (profile.samples || []).forEach((id, i) => self.set(id, (self.get(id) || 0) + ((profile.timeDeltas || [])[i] || 0)));
  const byName = new Map();
  let hottest = null;
  for (const [id, us] of self) {
    const n = nodes.get(id);
    if (!n || /^\\((idle|program|garbage collector|root)\\)$/.test(n.callFrame.functionName)) continue;
    const k = where(n.callFrame);
    byName.set(k, (byName.get(k) || 0) + us);
    if (!hottest || us > self.get(hottest)) hottest = id;
  }
  const busiest = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => k + ' ' + Math.round(us / 1000) + ' ms');
  const path = [];
  for (let id = hottest; id !== undefined && path.length < 8; id = parent.get(id)) {
    const n = nodes.get(id);
    if (!n || n.callFrame.functionName === '(root)') break;
    path.unshift(where(n.callFrame));
  }
  return { busiest, path };
}
setInterval(() => {
  const now = Date.now();
  const last = Number(Atomics.load(beat, 0));
  if (!session && now - last > workerData.afterMs) {
    try {
      session = new inspector.Session();
      session.connectToMainThread();
      began = last;
      session.post('Profiler.enable', () => session && session.post('Profiler.setSamplingInterval', { interval: 2000 }, () => session && session.post('Profiler.start')));
    } catch (e) {
      parentPort.postMessage({ error: String(e) });
      process.exit(0);
    }
  } else if (session && now - last < 500) {
    const s = session;
    const ms = last - began;
    session = null;
    s.post('Profiler.stop', (err, res) => {
      s.disconnect();
      if (!err && res) parentPort.postMessage({ ms, ...summary(res.profile) });
    });
  }
}, 250);
`;

/**
 * Starts watching this thread: a hold-up of `afterMs` or more is reported when it ends. Returns the stop. A runtime
 * without the inspector (or worker threads) reports nothing, and says so once through `onError`.
 */
export function watchStalls(onStall: (s: Stall) => void, opts: { afterMs?: number; onError?: (e: string) => void } = {}): () => void {
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const tick = () => Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const heart = setInterval(tick, 100);
  heart.unref();
  let worker: Worker | null = null;
  try {
    worker = new Worker(WATCHDOG, { eval: true, workerData: { sab, afterMs: opts.afterMs ?? 2000 } });
    worker.unref();
    worker.on('message', (m: Stall & { error?: string }) => (m.error ? opts.onError?.(m.error) : onStall({ ms: m.ms, busiest: m.busiest, path: m.path })));
    worker.on('error', (e) => opts.onError?.(String(e)));
  } catch (e) {
    opts.onError?.(String(e));
  }
  return () => {
    clearInterval(heart);
    void worker?.terminate();
  };
}
