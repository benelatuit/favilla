import os from 'node:os';

/**
 * Commands that run the computer out of memory: a test suite that loads everything at once, a test binary that
 * allocates without end. One of those (a Go test in an eval) grew to 26 GB and left a 47 GB machine with nothing
 * free, which stalls everything else the person has open. While Favilla's commands run, free memory is read every
 * few seconds; when it falls below the floor, the commands that started while there was plenty are stopped and
 * told why. Reading free memory costs nothing, and nothing else about other programs is looked at.
 */
interface Watched {
  started: number;
  freeAtStart: number;
  stop: (why: string) => void;
}

/** Where free memory is read from; tests put their own numbers here. */
export const memoryProbe = {
  free: () => os.freemem(),
  total: () => os.totalmem(),
  everyMs: 2000,
  /** A command younger than this is left alone: it cannot have caused the drop. */
  minRunMs: 3000,
};

const watched = new Set<Watched>();
let timer: NodeJS.Timeout | undefined;

/** Free memory under which the computer starts paging itself to a crawl. */
export function memoryFloor(total = memoryProbe.total()): number {
  return Math.min(1.5 * 1024 ** 3, total * 0.04);
}

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/**
 * Watch free memory while a command runs; `stop` is called once, with the reason, if the computer runs short.
 * Returns the function that ends the watch. macOS counts its file cache as used memory, so free memory says
 * little there and nothing is watched.
 */
export function watchMemory(stop: (why: string) => void): () => void {
  if (process.platform === 'darwin') return () => {};
  const w: Watched = { started: Date.now(), freeAtStart: memoryProbe.free(), stop };
  watched.add(w);
  timer ??= setInterval(tick, memoryProbe.everyMs);
  timer.unref?.();
  return () => {
    watched.delete(w);
    if (!watched.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function tick(): void {
  const free = memoryProbe.free();
  const floor = memoryFloor();
  if (free >= floor) return;
  for (const w of [...watched]) {
    // Started when memory was already short, or only just started: the drop is someone else's doing.
    if (Date.now() - w.started < memoryProbe.minRunMs || w.freeAtStart < floor * 2) continue;
    watched.delete(w);
    w.stop(`the computer was running out of memory (${gb(free)} GB free of ${gb(memoryProbe.total())} GB) while it ran`);
  }
}
