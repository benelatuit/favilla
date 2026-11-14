/** What the desktop app's preload script offers; undefined in the browser. */
interface DesktopBridge {
  platform: string;
  pickFolder(): Promise<string | null>;
  openExternal(url: string): void;
  /** Opens a file with its default app; resolves to an error message, or '' on success. */
  openPath(file: string): Promise<string>;
  showItem(file: string): void;
  /** The path of a file dropped or picked in the page. */
  pathForFile(file: File): string;
  setTitleBar(colors: { color: string; symbol: string; background: string }): void;
  /** Steps the page zoom by tenths (0 resets) and resolves to the new factor. */
  zoom(step: number): Promise<number>;
  /** Load the page again with the access token, when the page has lost its sign-in cookie. */
  reconnect(): void;
  /** Bring the window up (from a notification). */
  focusWindow?(): void;
}

declare global {
  interface Window {
    favillaDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.favillaDesktop : undefined;

export const isMac = (desktop?.platform ?? navigator.platform).toLowerCase().startsWith('mac') || desktop?.platform === 'darwin';

/** Join a session folder and a path the agent reported relative to it. */
export function absolutePath(cwd: string, file: string): string {
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(file)) return file;
  const sep = cwd.includes('\\') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${file.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)}`;
}
