import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

export interface BinaryContent {
  bytes: number;
  sha256: string;
}
export type FileContent = string | BinaryContent | null;

export const isBinary = (data: Buffer) => data.includes(0) || !isUtf8(data);
export const binaryContent = (data: Buffer): BinaryContent => ({ bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
export function fileContent(data: Buffer | null): FileContent {
  if (!data) return null;
  return isBinary(data) ? binaryContent(data) : data.toString('utf8');
}

export const sameContent = (a: FileContent, b: FileContent) =>
  a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && a.bytes === b.bytes && a.sha256 === b.sha256);
