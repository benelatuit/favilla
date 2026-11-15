// What the update check reports, shared with the page (packages/web), which cannot load the updater's Node modules.

/** How the running copy was installed, which decides what an update means for it. */
export type InstallKind =
  /** The desktop app from its installer: download, check, run the installer, restart. */
  | 'setup'
  /** The desktop app as one portable file: the new file is downloaded by hand. */
  | 'portable'
  /** The command from npm: `npm install -g favilla`. */
  | 'npm'
  /** The command the desktop app carries: it is updated with the app. */
  | 'app';

export interface UpdateView {
  /** A feed is built in; without one nothing about updates is shown. */
  feed: boolean;
  /** The feed's host, '' for a feed on this computer. */
  host: string;
  /** Checking is on in the settings. */
  enabled: boolean;
  current: string;
  install: InstallKind;
  checking: boolean;
  checkedAt?: number;
  latest?: { version: string; date?: string; notes?: string };
  /** The latest version is newer than this one. */
  available: boolean;
  /** Why the last check failed. */
  error?: string;
  download: { state: 'idle' | 'downloading' | 'ready' | 'failed'; received: number; total: number; error?: string };
  /** The checked installer, once the download is ready. */
  file?: string;
  sha256?: string;
  /** Where the portable file is, for a portable copy. */
  portableUrl?: string;
}
