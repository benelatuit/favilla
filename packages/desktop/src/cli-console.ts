import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { fileURLToPath } from 'node:url';

/**
 * Set up before any of the CLI's code loads (cli.ts imports this first). The installed app's favilla command is
 * Favilla.exe in Node mode on cli.mjs inside app.asar, so the prompts, the web UI and the two native helpers are
 * where the app keeps them, and the CLI is pointed at them as main.ts points the engine.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const unpacked = here.replace(/app\.asar$/, 'app.asar.unpacked');
const exe = process.platform === 'win32' ? '.exe' : '';
process.env.FAVILLA_ASSETS ??= path.join(here, 'assets');
process.env.FAVILLA_WEB ??= path.join(here, 'web');
// The esbuild package in app.asar must run the binary of its own version, so this one is used whatever is set.
const esbuildExe = path.join(unpacked, 'native', `esbuild${exe}`);
if (fs.existsSync(esbuildExe)) process.env.ESBUILD_BINARY_PATH = esbuildExe;
const rgExe = path.join(unpacked, 'bin', `rg${exe}`);
if (fs.existsSync(rgExe)) process.env.FAVILLA_RG ??= rgExe;

// The variable that started Favilla.exe as Node is for this process alone: a program the agent runs from its shell
// (VS Code, another Electron app) would start as Node too. Where Favilla runs itself again (the shell bridge, Node
// shadow tests) it sets the variable for that child.
if (process.versions.electron) delete process.env.ELECTRON_RUN_AS_NODE;

const isCharDevice = (fd: number) => {
  try {
    return fs.fstatSync(fd).isCharacterDevice();
  } catch {
    return false;
  }
};

/**
 * Favilla.exe is a window program. Run as Node in a terminal, Electron attaches it to the terminal's console and
 * sends its output there, but leaves its input on the NUL device, so the terminal UI could not read a key and raw
 * mode did not exist. The console's own input opens as CONIN$ and stands in for stdin. Input from a pipe or a file
 * is not a character device and stays as it is (`git diff | favilla -p "review this"`).
 */
if (process.platform === 'win32' && process.versions.electron && tty.isatty(1) && !tty.isatty(0) && isCharDevice(0)) {
  try {
    const input = new tty.ReadStream(fs.openSync('\\\\.\\CONIN$', 'r+'));
    Object.defineProperty(process, 'stdin', { value: input, configurable: true, enumerable: true, writable: true });
  } catch {
    // No console to read from after all: the command runs as it would have, without keys.
  }
}
