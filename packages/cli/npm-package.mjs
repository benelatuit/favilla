// Stages the favilla package for npm in packages/cli/npm-package: the bundle and assets from build.mjs, the launcher,
// the README and LICENSE, and a package.json whose only dependencies are the native helpers the bundle leaves out
// (esbuild and ripgrep, which install the binary for each platform).
//
//   node build.mjs && node npm-package.mjs
//   cd npm-package && npm publish
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'npm-package');
const cli = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(here, 'dist', 'favilla.mjs'))) throw new Error('Run node build.mjs first.');

const native = ['esbuild', '@vscode/ripgrep'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const dir of ['bin', 'dist']) fs.cpSync(path.join(here, dir), path.join(out, dir), { recursive: true });
for (const file of ['README.md', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(out, file));
const pkg = {
  name: 'favilla',
  version: cli.version,
  description: 'A general-purpose AI agent for the terminal and the desktop.',
  type: 'module',
  bin: cli.bin,
  files: ['bin', 'dist'],
  engines: { node: '>=22' },
  dependencies: Object.fromEntries(native.map((n) => [n, cli.dependencies[n]])),
  keywords: ['ai', 'ai-agent', 'agent', 'cli', 'llm', 'terminal'],
  homepage: 'https://favilla.melodybounce.com',
  repository: { type: 'git', url: 'git+https://github.com/benelatuit/favilla.git' },
  bugs: 'https://github.com/benelatuit/favilla/issues',
  author: cli.author,
  license: cli.license,
  // A machine may point npm at a mirror; a release always goes to the public registry.
  publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
};
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`staged favilla ${pkg.version} in ${path.relative(root, out)}`);
