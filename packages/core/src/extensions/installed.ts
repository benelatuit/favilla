import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Extension } from './types';

/**
 * The extensions beside Favilla's code: every folder of packages/core/extensions that has an index.ts, imported as it
 * is (tsx, the tests). A bundle has this file replaced by static imports of the same folders
 * (scripts/extensions.mjs), so a build without a folder holds nothing of it.
 */
export async function installedExtensions(): Promise<Extension[]> {
  const dir = fileURLToPath(new URL('../../extensions/', import.meta.url));
  if (!fs.existsSync(dir)) return [];
  const found: Extension[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'index.ts');
    if (fs.existsSync(file)) found.push((await import(pathToFileURL(file).href)).default as Extension);
  }
  return found;
}
