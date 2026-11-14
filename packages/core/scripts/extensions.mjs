// The extensions in packages/core/extensions, bundled in. Run as Favilla's own code, src/extensions/installed.ts finds
// them at start; a bundle cannot look into folders, so this esbuild plugin puts static imports of the same folders in
// that file's place. A folder that is gone leaves nothing of itself in the bundle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.join(core, 'src', 'extensions', 'installed.ts');

/** The index.ts of every extension folder, in name order. */
export function extensionEntries() {
  const dir = path.join(core, 'extensions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => path.join(dir, name, 'index.ts'))
    .filter((f) => fs.existsSync(f));
}

export function extensionsPlugin() {
  return {
    name: 'favilla-extensions',
    setup(build) {
      build.onLoad({ filter: /[\\/]extensions[\\/]installed\.ts$/ }, (args) => {
        if (path.resolve(args.path) !== installed) return undefined;
        const entries = extensionEntries();
        const imports = entries.map((f, i) => `import e${i} from ${JSON.stringify(f.replaceAll('\\', '/'))};`).join('\n');
        return {
          loader: 'ts',
          resolveDir: path.dirname(installed),
          contents: `${imports}\nexport async function installedExtensions() { return [${entries.map((_, i) => `e${i}`).join(', ')}]; }\n`,
        };
      });
    },
  };
}
