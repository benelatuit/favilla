import { envProxy } from '@favilla/core/net/http';
import { appPath } from '@favilla/core/util/paths';
import { BUILT_IN_FEED, installKind, Updater, type InstallKind } from '@favilla/core/update/updater';

const DAY = 24 * 3_600_000;

/**
 * Whether the update feed this build names has a newer version, for one line at the start of the terminal UI. It
 * reads the answer the desktop app or an earlier start kept, and asks the feed again only when that is a day old.
 * Never in a headless run, never in a build without a feed, and not with checking turned off.
 */
export async function newerVersion(version: string, config: { updates?: { check?: boolean }; proxy?: string | false }): Promise<{ version: string; install: InstallKind } | null> {
  if (!BUILT_IN_FEED || config.updates?.check === false || process.env.FAVILLA_UPDATE_CHECK === '0') return null;
  const updater = new Updater({
    version,
    feed: BUILT_IN_FEED,
    install: installKind(),
    cacheFile: appPath('update.json'),
    enabled: () => true,
    proxy: () => config.proxy || envProxy() || false,
    freshMs: DAY,
  });
  await updater.check();
  const v = updater.view();
  return v.available && v.latest ? { version: v.latest.version, install: v.install } : null;
}
