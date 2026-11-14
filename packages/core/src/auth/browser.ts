import { spawn } from 'node:child_process';
import { isWindows } from '../util/paths';

/** Open a URL in the user's default browser. */
export function openInBrowser(url: string): void {
  const child = isWindows
    ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
