// Values a build fixes in the code it bundles, read from the environment the build runs in. Every bundle of the
// engine takes them (packages/cli/build.mjs, packages/desktop/build.mjs), so the command and the app agree.
//
//   FAVILLA_DEFAULT_RELAY  the relay remote control uses when the settings name none. A build without it has none:
//                          remote control then waits for an address of the user's own (a copy of packages/relay).
//   FAVILLA_UPDATE_FEED    the update feed (src/update/feed.ts) the app and the command ask for newer versions: a
//                          https url, or a path on this computer for a build kept on it. A build without it never
//                          checks. The public release names https://favilla.melodybounce.com/latest.json.

/** esbuild `define` entries. Each is set even when empty, so a bundle never reads it from the user's environment. */
export function buildDefines() {
  return {
    'process.env.FAVILLA_DEFAULT_RELAY': JSON.stringify(process.env.FAVILLA_DEFAULT_RELAY ?? ''),
    'process.env.FAVILLA_UPDATE_FEED': JSON.stringify(process.env.FAVILLA_UPDATE_FEED ?? ''),
  };
}

/** One line for the build's log, so it is plain which relay and which update feed went in. */
export function buildDefinesNote() {
  const relay = process.env.FAVILLA_DEFAULT_RELAY;
  const feed = process.env.FAVILLA_UPDATE_FEED;
  return [
    relay ? `default relay ${relay}` : 'no default relay (set FAVILLA_DEFAULT_RELAY to build one in)',
    feed ? `update feed ${feed}` : 'no update feed (set FAVILLA_UPDATE_FEED to build one in)',
  ].join(', ');
}
