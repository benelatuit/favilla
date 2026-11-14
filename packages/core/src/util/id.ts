import { createHash, randomBytes } from 'node:crypto';

let lastTime = 0;
let seq = 0;

/** Time-sortable id: base36 millis + sequence + random tail. */
export function newId(prefix = ''): string {
  const now = Date.now();
  seq = now === lastTime ? seq + 1 : 0;
  lastTime = now;
  const time = now.toString(36).padStart(9, '0');
  const s = seq.toString(36).padStart(2, '0');
  const rand = randomBytes(5).toString('hex');
  return `${prefix}${time}${s}${rand}`;
}

export function shortHash(text: string, length = 12): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
