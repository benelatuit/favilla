// Puts a built release into an update feed folder: copies its installers there and writes latest.json, which names
// them with their size and SHA-256 (packages/core/src/update/feed.ts reads it). Older installers in the folder go.
//
//   node feed.mjs <feed folder> [--from <release folder>] [--version 1.2.19] [--notes "..."] [--base https://.../]
//
// The release folder defaults to ./release (or FAVILLA_RELEASE_DIR) and the version to this package's. Urls in the
// feed are relative unless --base names where the folder is served, so a folder on this computer and the same folder
// on the website both work. Nothing here uploads anything: putting the folder on the website is a step of its own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const from = path.resolve(here, flag('from') ?? process.env.FAVILLA_RELEASE_DIR ?? 'release');
const version = flag('version') ?? JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const notes = flag('notes');
const base = flag('base');
const target = args[0];
if (!target || !/^\d+\.\d+\.\d+$/.test(version) || (base && !/^https:\/\/.+\/$/.test(base))) {
  console.error('usage: node feed.mjs <feed folder> [--from <release folder>] [--version x.y.z] [--notes "..."] [--base https://host/path/]');
  process.exit(2);
}
const dir = path.resolve(target);
fs.mkdirSync(dir, { recursive: true });

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

const windows = {};
for (const [kind, name] of [
  ['setup', `Favilla-Setup-${version}.exe`],
  ['portable', `Favilla-${version}-portable.exe`],
]) {
  const src = path.join(from, name);
  if (!fs.existsSync(src)) {
    if (kind === 'setup') {
      console.error(`no ${name} in ${from}`);
      process.exit(1);
    }
    continue;
  }
  const dest = path.join(dir, name);
  if (path.resolve(src) !== dest) fs.copyFileSync(src, dest);
  const { size } = fs.statSync(dest);
  const sum = await sha256(dest);
  // The copy is what the feed names: checked against the original before it is published.
  if (sum !== (await sha256(src))) throw new Error(`${name} changed while it was copied`);
  windows[kind] = { url: base ? base + name : name, size, sha256: sum };
}

const feed = { version, date: new Date().toISOString().slice(0, 10), ...(notes ? { notes } : {}), windows };
const tmp = path.join(dir, 'latest.json.tmp');
fs.writeFileSync(tmp, JSON.stringify(feed, null, 2) + '\n');
fs.renameSync(tmp, path.join(dir, 'latest.json'));

const ours = /^Favilla-(?:Setup-)?(\d+\.\d+\.\d+)(?:-portable)?\.exe$/;
const gone = fs.readdirSync(dir).filter((n) => ours.test(n) && ours.exec(n)[1] !== version);
for (const n of gone) fs.rmSync(path.join(dir, n), { force: true });
console.log(`feed ${path.join(dir, 'latest.json')}: ${version}, ${Object.keys(windows).join(' and ')}${gone.length ? `; removed ${gone.join(', ')}` : ''}`);
