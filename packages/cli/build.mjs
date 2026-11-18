// Bundles the favilla command into dist/favilla.mjs with the prompts and the web UI next to it.
// Native helpers (esbuild for syntax checks, ripgrep for search) stay as dependencies.
// The desktop app carries the same command, built with cliBuildOptions (packages/desktop/build.mjs).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extensionsPlugin } from '../core/scripts/extensions.mjs';
import { buildDpapi } from '../core/scripts/build-dpapi.mjs';
import { buildDefines, buildDefinesNote } from '../core/scripts/build-defines.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

/** esbuild options for the command, without the entry point and the output file. */
export function cliBuildOptions() {
  return {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    mainFields: ['module', 'main'],
    jsx: 'automatic',
    define: buildDefines(),
    external: ['esbuild', '@vscode/ripgrep', '@vscode/ripgrep-*'],
    plugins: [
      {
        // Ink imports React DevTools for its debug mode; the command never uses it.
        name: 'no-devtools',
        setup(b) {
          b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'devtools', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { connectToDevTools() {} };', loader: 'js' }));
        },
      },
      extensionsPlugin(),
    ],
    banner: { js: "import { createRequire as __favillaRequire } from 'node:module'; const require = __favillaRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  };
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Keep chunks beside the entry: native dependencies, prompts and web assets resolve from that directory.
// The desktop build still asks cliBuildOptions for a single embedded file.
export function cliOutput(dist) {
  return { splitting: true, outdir: dist, entryNames: 'favilla', chunkNames: 'part-[hash]', outExtension: { '.js': '.mjs' } };
}

if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const { build } = createRequire(path.join(root, 'packages/core/package.json'))('esbuild');
  const dist = path.join(here, 'dist');
  execSync('pnpm --filter @favilla/web build', { cwd: root, stdio: 'inherit' });
  fs.rmSync(dist, { recursive: true, force: true });
  await build({ ...cliBuildOptions(), ...cliOutput(dist), entryPoints: [path.join(here, 'src/main.ts')] });
  buildDpapi(dist);
  fs.cpSync(path.join(root, 'packages/core/assets'), path.join(dist, 'assets'), { recursive: true });
  fs.cpSync(path.join(root, 'packages/web/dist'), path.join(dist, 'web'), { recursive: true });
  console.log(`built ${path.relative(root, path.join(dist, 'favilla.mjs'))}, ${buildDefinesNote()}`);
}
