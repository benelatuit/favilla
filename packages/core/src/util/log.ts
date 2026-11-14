import fs from 'node:fs';
import path from 'node:path';
import { appPath } from './paths';

const enabled = !!process.env.FAVILLA_DEBUG;
let file: string | null = null;

/** Whether the debug log is on: for details that cost work to gather. */
export const debugging = (): boolean => enabled;

/** Debug log, written to ~/.favilla/logs/debug.log only when FAVILLA_DEBUG is set. */
export function debug(scope: string, message: string, data?: unknown): void {
  if (!enabled) return;
  try {
    if (!file) {
      file = appPath('logs', 'debug.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const line = `${new Date().toISOString()} [${scope}] ${message}${data === undefined ? '' : ` ${safe(data)}`}\n`;
    fs.appendFileSync(file, line);
  } catch {
    /* logging must never break the agent */
  }
}

function safe(data: unknown): string {
  try {
    const s = JSON.stringify(data);
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
  } catch {
    return String(data);
  }
}
