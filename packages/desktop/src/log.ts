import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of Favilla's app data on this machine, as the engine has it (util/paths.ts appHome). */
export function resolveHome(): string {
  return process.env.FAVILLA_HOME || path.join(os.homedir(), '.favilla');
}

/** The desktop log, ~/.favilla/logs/desktop.log: the app and its engine both write to it. */
const logFile = path.join(resolveHome(), 'logs', 'desktop.log');

export function log(msg: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging is best effort */
  }
}

/** Hold-ups of a thread at least this long are logged (FAVILLA_LAG_MS, for measuring smaller ones). */
export const LAG_MS = Number(process.env.FAVILLA_LAG_MS) || 1000;
