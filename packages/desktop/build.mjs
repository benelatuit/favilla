// Builds the desktop app into ./app (bundled main process, engine process, preload, the favilla command, web UI,
// prompts, two native helpers) and, with --dist, packs it into Windows installers under ./release.
//   node build.mjs          build ./app
//   node build.mjs --run    build and start it
//   node build.mjs --dist   build and package (NSIS installer + portable exe)
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extensionsPlugin } from '../core/scripts/extensions.mjs';
import { requireRunAsNode } from './electron-fuses.mjs';
import { buildDefines, buildDefinesNote } from '../core/scripts/build-defines.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { build } = createRequire(path.join(root, 'packages/core/package.json'))('esbuild');
const app = path.join(here, 'app');
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const mirrors = {
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const step = (msg) => console.log(`\x1b[36m›\x1b[0m ${msg}`);

// The engine and the web UI reach @favilla/core through their node_modules link. In a worktree whose node_modules
// came from another one, that link still points at the other tree's core, and the app is built from its code under
// this tree's version number (1.2.12 of 2026-11-11 went out with an engine eleven commits old).
const ownCore = fs.realpathSync(path.join(root, 'packages/core'));
for (const p of ['desktop', 'web']) {
  const link = path.join(root, 'packages', p, 'node_modules/@favilla/core');
  const linked = fs.realpathSync(link);
  if (linked !== ownCore) throw new Error(`${link} points at ${linked}, not at ${ownCore}. Run pnpm install in ${root} before building.`);
}

step('web UI');
execSync('pnpm --filter @favilla/web build', { cwd: root, stdio: 'inherit' });

fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });

step(`main process, engine, the command and preload, with ${buildDefinesNote()}`);
const externals = ['electron', 'esbuild', '@vscode/ripgrep', '@vscode/ripgrep-*'];
// The window's process and the engine's (engine.ts, an Electron utility process that holds @favilla/core) build alike.
for (const [entry, out] of [['main.ts', 'main.mjs'], ['engine.ts', 'engine.mjs']]) await build({
  entryPoints: [path.join(here, 'src', entry)],
  outfile: path.join(app, out),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  mainFields: ['module', 'main'],
  define: buildDefines(),
  external: externals,
  plugins: [extensionsPlugin()],
  banner: { js: "import { createRequire as __favillaRequire } from 'node:module'; const require = __favillaRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
// The favilla and fav commands come with the app: cli-bin/*.cmd run Favilla.exe as Node on this bundle.
const { cliBuildOptions } = await import('../cli/build.mjs');
await build({ ...cliBuildOptions(), entryPoints: [path.join(here, 'src/cli.ts')], outfile: path.join(app, 'cli.mjs') });
await build({
  entryPoints: [path.join(here, 'src/preload.ts')],
  outfile: path.join(app, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});

step('assets');
fs.cpSync(path.join(root, 'packages/core/assets'), path.join(app, 'assets'), { recursive: true });
fs.cpSync(path.join(root, 'packages/web/dist'), path.join(app, 'web'), { recursive: true });
fs.copyFileSync(path.join(here, 'icon.png'), path.join(app, 'icon.png'));
fs.mkdirSync(path.join(here, 'build'), { recursive: true });
fs.copyFileSync(path.join(here, 'icon.png'), path.join(here, 'build/icon.png'));
fs.copyFileSync(path.join(here, 'icon.ico'), path.join(here, 'build/icon.ico'));
for (const f of ['installer.nsh', 'user-path.ps1']) fs.copyFileSync(path.join(here, 'installer', f), path.join(here, 'build', f));

step('native helpers (esbuild for syntax checks, ripgrep for search)');
const coreRequire = createRequire(path.join(root, 'packages/core/package.json'));
/** Package folder of `name` as seen from `req`, even when its exports map hides package.json. */
const pkgDir = (req, name, probe) => {
  let file;
  try {
    file = req.resolve(`${name}/package.json`);
  } catch {
    file = req.resolve(probe ?? name);
  }
  let dir = path.dirname(file);
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) return fs.realpathSync(dir);
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`package folder of ${name} not found`);
    dir = up;
  }
};
const copyPkg = (fromRequire, name, probe) => {
  const src = pkgDir(fromRequire, name, probe);
  fs.cpSync(src, path.join(app, 'node_modules', name), { recursive: true, dereference: true });
  return createRequire(path.join(src, 'package.json'));
};
// electron-builder packs only the node_modules packages its own dependency walk finds, and that walk drops the
// platform packages holding the binaries. So the binaries travel as plain app files: rg in bin/ (also put on the
// agent's PATH), esbuild in native/ (read through ESBUILD_BINARY_PATH); main.ts points the engine at both.
const exe = process.platform === 'win32' ? '.exe' : '';
const copyBin = (fromRequire, name, file, dest) => {
  const src = path.join(pkgDir(fromRequire, name, `${name}/${file}`), file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};
const esbuildReq = copyPkg(coreRequire, 'esbuild');
copyBin(esbuildReq, `@esbuild/${process.platform}-${process.arch}`, process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild', path.join(app, 'native', `esbuild${exe}`));
const rgReq = createRequire(path.join(pkgDir(coreRequire, '@vscode/ripgrep', '@vscode/ripgrep'), 'package.json'));
copyBin(rgReq, `@vscode/ripgrep-${process.platform}-${process.arch}`, `bin/rg${exe}`, path.join(app, 'bin', `rg${exe}`));

fs.writeFileSync(
  path.join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'favilla',
      productName: 'Favilla',
      version: pkg.version,
      description: 'A general-purpose AI agent for the terminal and the desktop.',
      author: 'Bene Latuit',
      license: 'MIT',
      main: 'main.mjs',
    },
    null,
    2,
  ),
);
step(`app ready in ${path.relative(root, app)}`);

if (args.has('--run')) {
  const electron = createRequire(path.join(here, 'package.json'))('electron');
  spawn(electron, [app], { stdio: 'inherit', env: { ...process.env, ...mirrors } });
}

if (args.has('--dist')) {
  step('packaging');
  Object.assign(process.env, mirrors);
  const builder = await import('electron-builder');
  const electronVersion = JSON.parse(fs.readFileSync(createRequire(path.join(here, 'package.json')).resolve('electron/package.json'), 'utf8')).version;
  const out = await builder.build({
    targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable'], builder.Arch.x64),
    projectDir: here,
    config: {
      appId: 'io.github.benelatuit.favilla',
      productName: 'Favilla',
      copyright: 'Copyright © 2026 Bene Latuit',
      electronVersion,
      // FAVILLA_RELEASE_DIR packs elsewhere, e.g. while a build in ./release is running and its files are locked.
      directories: { app: 'app', output: process.env.FAVILLA_RELEASE_DIR || 'release', buildResources: 'build' },
      files: ['**/*'],
      // resources\bin holds only the commands, since it goes on the user's Path (installer/installer.nsh).
      extraResources: [{ from: 'cli-bin', to: 'bin' }],
      asar: true,
      asarUnpack: ['node_modules/esbuild/**', 'bin/**', 'native/**'],
      afterPack: ({ appOutDir, packager }) => requireRunAsNode(path.join(appOutDir, `${packager.appInfo.productFilename}.exe`), packager.config.electronFuses?.runAsNode),
      npmRebuild: false,
      nodeGypRebuild: false,
      electronDownload: { mirror: mirrors.ELECTRON_MIRROR },
      win: { target: ['nsis', 'portable'], icon: 'build/icon.ico' },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        shortcutName: 'Favilla',
        include: 'build/installer.nsh',
        artifactName: 'Favilla-Setup-${version}.${ext}',
      },
      portable: { artifactName: 'Favilla-${version}-portable.${ext}' },
    },
  });
  for (const f of out) step(path.relative(root, f));
  // Each build adds about 250 MB of installers: this one and the one before are kept (to go back to), older ones go.
  // Every release has a git tag to build it again from; on 2026-11-04 fifteen versions held 3.7 GB here.
  // resolve, not join: FAVILLA_RELEASE_DIR may be absolute.
  const dir = path.resolve(here, process.env.FAVILLA_RELEASE_DIR || 'release');
  const versionOf = (name) => /^Favilla-(?:Setup-)?(\d+\.\d+\.\d+)(?:-portable)?\.exe(?:\.blockmap)?$/.exec(name)?.[1];
  const byNumber = (a, b) => a.split('.').map(Number).reduce((d, n, i) => d || n - Number(b.split('.')[i]), 0);
  const versions = [...new Set(fs.readdirSync(dir).map(versionOf).filter(Boolean))].sort(byNumber);
  const keep = new Set(versions.slice(-2));
  const gone = fs.readdirSync(dir).filter((n) => versionOf(n) && !keep.has(versionOf(n)));
  for (const n of gone) fs.rmSync(path.join(dir, n), { force: true });
  if (gone.length) step(`removed the installers of ${versions.filter((v) => !keep.has(v)).join(', ')}; kept ${[...keep].join(', ')}`);
}
