import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, powerSaveBlocker, shell, utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FromEngine, ToEngine } from './engine';
import { LAG_MS, log, resolveHome } from './log';
import { readSettingDocument } from '@favilla/core/config/document';
import { browserRefuses } from '@favilla/core/net/browser-port';
import { sha256File } from '@favilla/core/update/feed';

/**
 * The desktop app runs the agent engine in a process of its own (engine.ts) and shows the UI it serves from a
 * loopback port that needs a random token. This process keeps the window, so a step that holds the engine up never
 * freezes it: in one process the window stopped answering for up to 55 s. Links (including sign-in pages,
 * where a security key is used) open in the system browser.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const unpacked = here.replace(/app\.asar$/, 'app.asar.unpacked');
process.env.FAVILLA_ASSETS ??= path.join(here, 'assets');
// The two native helpers ship as plain files next to the app (build.mjs says why); the engine inherits these.
const exe = process.platform === 'win32' ? '.exe' : '';
const esbuildExe = path.join(unpacked, 'native', `esbuild${exe}`);
if (fs.existsSync(esbuildExe)) process.env.ESBUILD_BINARY_PATH = esbuildExe;
const rgExe = path.join(unpacked, 'bin', `rg${exe}`);
if (fs.existsSync(rgExe)) process.env.FAVILLA_RG ??= rgExe;

const VERSION = app.getVersion();
process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${(e as Error)?.stack ?? e}`));
let win: BrowserWindow | null = null;

// Low-memory mode (Settings > Appearance): the window draws without the graphics card, which keeps the GPU process
// about 90 MB smaller. It has to be decided before the app is ready, so a change takes a restart.
const settingsFile = path.join(resolveHome(), 'config.json');
const initialTheme = (() => {
  try {
    const { value } = readSettingDocument(settingsFile);
    const desktop = value.desktop as { hardwareAcceleration?: unknown } | undefined;
    if (desktop?.hardwareAcceleration === false) app.disableHardwareAcceleration();
    if (typeof value.theme === 'string') return value.theme;
  } catch {
    // The engine reports the file and uses defaults too.
  }
  return 'auto';
})();

// Only one Favilla runs: a second launch hands over to the first window and exits without starting anything.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  zoom?: number;
}

/** The page draws its own title bar; the window buttons sit on top of it in the theme's colours. */
const TITLE_BAR_HEIGHT = 40;
const BARS: Record<string, { color: string; symbolColor: string; background: string }> = {
  drafting: { color: '#ebeef0', symbolColor: '#47515a', background: '#f6f7f8' },
  nightshift: { color: '#14171b', symbolColor: '#adb6c0', background: '#1a1d22' },
  kiln: { color: '#f5efe1', symbolColor: '#536065', background: '#faf4e5' },
  'kiln-night': { color: '#1d1a17', symbolColor: '#c9bfb1', background: '#24201c' },
  sky: { color: '#d5e5f2', symbolColor: '#3a5874', background: '#e3eef8' },
  'sky-night': { color: '#131c27', symbolColor: '#bccbdc', background: '#18222f' },
  porcelain: { color: '#e5ecf4', symbolColor: '#384860', background: '#f2f6fa' },
  plain: { color: '#f4f4f4', symbolColor: '#454545', background: '#fafafa' },
  daylight: { color: '#f7f8fa', symbolColor: '#4b535c', background: '#ffffff' },
};

/** The colours of the theme in the settings, for the window before the page has drawn its own. */
function firstBar(): (typeof BARS)[string] {
  let theme = initialTheme;
  const dark = nativeTheme.shouldUseDarkColors;
  if (theme === 'kiln-auto') theme = dark ? 'kiln-night' : 'kiln';
  if (theme === 'sky-auto') theme = dark ? 'sky-night' : 'sky';
  return BARS[theme] ?? (dark ? BARS.nightshift : BARS.drafting);
}
const isMac = process.platform === 'darwin';

function boundsFile(): string {
  return path.join(resolveHome(), 'window.json');
}

function loadBounds(): Bounds {
  const defaults = { width: 1380, height: 900 };
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8')) as Partial<Bounds>;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return defaults;
    const positive = (n: number | undefined) => Number.isSafeInteger(n) && n! > 0;
    return {
      width: positive(b.width) ? b.width! : defaults.width,
      height: positive(b.height) ? b.height! : defaults.height,
      ...(Number.isSafeInteger(b.x) ? { x: b.x } : {}),
      ...(Number.isSafeInteger(b.y) ? { y: b.y } : {}),
      maximized: b.maximized === true,
      ...(typeof b.zoom === 'number' && Number.isFinite(b.zoom) && b.zoom > 0 ? { zoom: b.zoom } : {}),
    };
  } catch {
    return defaults;
  }
}

function saveBounds(w: BrowserWindow): void {
  try {
    const b = w.getNormalBounds();
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...b, maximized: w.isMaximized(), zoom: w.webContents.getZoomFactor() }));
  } catch {
    /* not important */
  }
}

const validPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535;

// How this copy was installed, for the engine's update check (core/src/update/updater.ts): the installer can replace
// an installed copy; a portable one is replaced by hand; a copy run from the sources is not updated at all.
const installKind = !app.isPackaged ? 'app' : process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'setup';
const UPDATE_DIR = path.join(os.tmpdir(), 'favilla-update');
const INSTALLER_NAME = /^Favilla-Setup-\d+\.\d+\.\d+\.exe$/;

/** The engine's process, and the address its server answered on. */
interface Engine {
  proc: UtilityProcess;
  url: string;
  token: string;
  port: number;
}

/**
 * Starts the engine on a port (0: any) with the app's token; resolves once its server answers. `gone` names engines
 * of this app that stopped: their session locks are a dead process's, whoever has their PID now.
 */
function startEngine(port: number, token: string, onMessage: (m: FromEngine) => void, gone: number[] = []): Promise<Engine> {
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(path.join(here, 'engine.mjs'), [], {
      serviceName: 'Favilla engine',
      env: { ...process.env, FAVILLA_PORT: String(port), FAVILLA_TOKEN: token, FAVILLA_VERSION: VERSION, FAVILLA_WEB_DIR: path.join(here, 'web'), FAVILLA_GONE_PIDS: gone.join(','), FAVILLA_INSTALL_KIND: installKind },
    });
    let ready = false;
    proc.on('message', (m: FromEngine) => {
      if (m.type === 'ready' && !ready) {
        const url = `http://127.0.0.1:${m.port}/`;
        if (!validPort(m.port) || m.url !== url || m.token !== token) {
          reject(new Error('The engine did not report its own loopback server.'));
          proc.kill();
          return;
        }
        ready = true;
        resolve({ proc, url, token, port: m.port });
      } else onMessage(m);
    });
    proc.once('exit', (code) => {
      if (!ready) reject(new Error(`the engine stopped before its server answered (exit ${code}); see ${path.join(resolveHome(), 'logs', 'desktop.log')}`));
    });
  });
}

/** Asks the engine to close its sessions and server, and waits for it (10 s at most, then it is ended). */
function stopEngine(e: Engine): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      e.proc.kill();
      resolve();
    }, 10_000);
    e.proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    e.proc.postMessage({ type: 'shutdown' } satisfies ToEngine);
  });
}

async function main(): Promise<void> {
  // Notifications and the taskbar group under the installed app's id instead of "electron.app.Favilla".
  app.setAppUserModelId('io.github.benelatuit.favilla');
  await app.whenReady();
  log(`starting ${VERSION} from ${here}`);
  Menu.setApplicationMenu(null);
  const pickFolder = async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  };
  // The same port as last time when it is free: the page's address stays the same, and with it what the
  // page keeps in its own storage (drafts). The window's state itself is kept by the server either way.
  const portFile = path.join(app.getPath('userData'), 'server-port.json');
  let preferred = Number(process.env.FAVILLA_PORT ?? 0);
  if (!validPort(preferred)) {
    try {
      const saved = JSON.parse(fs.readFileSync(portFile, 'utf8'))?.port;
      // A port saved before the server avoided the ones a browser refuses would leave the window blank on every start.
      preferred = validPort(saved) && !browserRefuses(saved) ? saved : 0;
    } catch {
      preferred = 0;
    }
  }
  // Scripted checks can fix the token (and port) through the environment; normally it is random, one per run.
  const token = process.env.FAVILLA_TOKEN || crypto.randomBytes(24).toString('base64url');

  // A phone reaches this computer only while it is awake: the engine says when work runs or waits for an answer
  // with remote control on; this process holds the blocker. The screen may still turn off.
  let blocker: number | null = null;
  const onEngine = (m: FromEngine) => {
    if (m.type === 'pick-folder') {
      void pickFolder()
        .catch(() => null)
        .then((folder) => engine.proc.postMessage({ type: 'picked', id: m.id, path: folder } satisfies ToEngine));
    } else if (m.type === 'open-external') void shell.openExternal(m.url);
    else if (m.type === 'awake' && m.want !== (blocker !== null)) {
      if (m.want) blocker = powerSaveBlocker.start('prevent-app-suspension');
      else {
        powerSaveBlocker.stop(blocker!);
        blocker = null;
      }
      log(m.want ? 'keeping the computer awake for remote control' : 'the computer may sleep again');
    }
  };

  let engine = await startEngine(preferred, token, onEngine);
  try {
    fs.writeFileSync(portFile, JSON.stringify({ port: engine.port }));
  } catch {
    /* not important */
  }
  // An engine that stops on its own is started again on the same port with the same token: the page reconnects by
  // itself. Three stops within a minute end the app with the reason.
  let quitting = false;
  const stops: number[] = [];
  const gone: number[] = [];
  const watch = (e: Engine) => {
    // Read now: a process that has exited no longer has one.
    const pid = e.proc.pid;
    e.proc.once('exit', (code) => {
      if (quitting) return;
      const now = Date.now();
      stops.push(now);
      if (pid) gone.push(pid);
      log(`engine stopped (exit ${code}); starting it again`);
      if (stops.filter((t) => now - t < 60_000).length >= 3) {
        dialog.showErrorBox('Favilla stopped', `Its engine stopped three times within a minute (last exit ${code}). The log is in ${path.join(resolveHome(), 'logs', 'desktop.log')}.`);
        app.quit();
        return;
      }
      startEngine(e.port, token, onEngine, gone.slice(-10))
        .then((next) => {
          engine = next;
          watch(next);
          if (next.url !== e.url) win?.loadURL(`${next.url}?token=${next.token}`).catch((err) => log(`reload failed: ${err}`));
        })
        .catch((err) => {
          log(`engine did not start again: ${err}`);
          dialog.showErrorBox('Favilla stopped', String(err));
          app.quit();
        });
    });
  };
  watch(engine);
  const reportIdle = () => engine.proc.postMessage({ type: 'idle', seconds: powerMonitor.getSystemIdleTime() } satisfies ToEngine);
  reportIdle();
  setInterval(reportIdle, 5000).unref();

  ipcMain.handle('favilla:pick-folder', () => pickFolder());
  ipcMain.on('favilla:open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('favilla:open-path', (_e, file: string) => (typeof file === 'string' && path.isAbsolute(file) ? shell.openPath(file) : 'Not an absolute path'));
  ipcMain.on('favilla:show-item', (_e, file: string) => {
    if (typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file);
  });
  ipcMain.on('favilla:titlebar', (_e, c: { color?: string; symbol?: string; background?: string }) => {
    const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
    const color = hex(c.color);
    const symbolColor = hex(c.symbol);
    const background = hex(c.background);
    if (!win) return;
    if (!isMac && color && symbolColor) win.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT });
    if (background) win.setBackgroundColor(background);
  });
  // The page lost its sign-in cookie (for instance after the browser's network process restarted): load it again with the token.
  ipcMain.on('favilla:reconnect', () => {
    if (win) win.loadURL(`${engine.url}?token=${engine.token}`).catch((e) => log(`reconnect failed: ${e}`));
  });
  // An update the engine downloaded and checked is run from here, where the app can close for it. What to run comes
  // from the engine's own view (its file and the feed's SHA-256), not from the page: only an installer of ours in the
  // download folder, hashed again just before. The engine stops first so its sessions close cleanly; the installer
  // then replaces this copy silently and starts the new version (--force-run). --updated tells it the app is closing
  // by itself rather than to be ended.
  let installing = false;
  ipcMain.handle('favilla:install-update', async (): Promise<string> => {
    if (installing) return '';
    if (installKind !== 'setup') return 'Only an installed copy can update itself';
    const view = (await fetch(`${engine.url}api/update`, { headers: { Authorization: `Bearer ${engine.token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { available?: boolean; download?: { state?: string }; file?: unknown; sha256?: unknown } | null;
    if (!view?.available || view.download?.state !== 'ready' || typeof view.file !== 'string' || typeof view.sha256 !== 'string') return 'No installer';
    const full = path.resolve(view.file);
    if (path.dirname(full).toLowerCase() !== UPDATE_DIR.toLowerCase() || !INSTALLER_NAME.test(path.basename(full))) return 'Not an installer from the update folder';
    const hash = await sha256File(full).catch(() => '');
    if (!hash || hash !== view.sha256.toLowerCase()) return 'The installer does not match the update feed';
    installing = true;
    // Installed for this user unless the app lives outside the user's own folders (an install for every user).
    const local = process.env.LOCALAPPDATA;
    const perUser = !!local && path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(local).toLowerCase() + path.sep);
    log(`installing ${path.basename(full)} over ${VERSION} (${perUser ? 'this user' : 'every user'})`);
    quitting = true;
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    await stopEngine(engine);
    try {
      const child = spawn(full, ['--updated', '/S', perUser ? '/currentuser' : '/allusers', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => log(`the installer did not start: ${err}`));
      child.unref();
    } catch (err) {
      log(`the installer did not start: ${err}`);
    }
    app.quit();
    return '';
  });
  ipcMain.handle('favilla:zoom', (_e, step: number) => {
    if (!win) return 1;
    const wc = win.webContents;
    const next = step === 0 ? 1 : Math.min(1.6, Math.max(0.7, Math.round((wc.getZoomFactor() + step * 0.1) * 10) / 10));
    wc.setZoomFactor(next);
    return next;
  });

  const b = loadBounds();
  const bar = firstBar();
  win = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 560,
    title: 'Favilla',
    icon: path.join(here, 'icon.png'),
    backgroundColor: bar.background,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: bar.color, symbolColor: bar.symbolColor, height: TITLE_BAR_HEIGHT } }),
    show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (b.zoom && b.zoom !== 1) win.webContents.once('did-finish-load', () => win?.webContents.setZoomFactor(b.zoom!));
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win?.webContents.toggleDevTools();
    });
  }
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => win && saveBounds(win));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(engine.url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // Notifications come from the page (in the user's language, and a click opens that session); it asks for the
  // window to come up.
  ipcMain.on('favilla:focus', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  log(`server ${engine.url}`);
  // Up to 0.9.8 the page's files with lasting names (the icon) were sent as never changing, and the window's cache
  // kept an old version's: after an update the cache goes, once. Sign-ins and the page's own storage stay.
  const versionFile = path.join(app.getPath('userData'), 'last-version.txt');
  let lastVersion = '';
  try {
    lastVersion = fs.readFileSync(versionFile, 'utf8').trim();
  } catch {
    /* the first start of a version that keeps this file */
  }
  if (lastVersion !== VERSION) {
    await win.webContents.session.clearCache().catch((e) => log(`cache not cleared: ${e}`));
    try {
      fs.writeFileSync(versionFile, VERSION);
    } catch {
      /* cleared again next time */
    }
    log(`cache cleared after an update from ${lastVersion || 'an earlier version'}`);
  }
  await win.loadURL(`${engine.url}?token=${engine.token}`);
  log('window loaded');

  // This thread now only keeps the window; a hold-up of it is logged, as the engine logs its own.
  const lag = monitorEventLoopDelay({ resolution: 50 });
  lag.enable();
  setInterval(() => {
    const worst = Math.round(lag.max / 1e6);
    lag.reset();
    if (worst >= LAG_MS) log(`main thread held up ${worst} ms`);
  }, 5000).unref();

  // Development aid: FAVILLA_CAPTURE=<file.png> saves what the window shows after it settles.
  const capture = process.env.FAVILLA_CAPTURE;
  if (capture) {
    setTimeout(async () => {
      const img = await win!.webContents.capturePage();
      fs.writeFileSync(capture, img.toPNG());
      if (process.env.FAVILLA_CAPTURE_QUIT) app.quit();
    }, Number(process.env.FAVILLA_CAPTURE_DELAY ?? 5000));
  }

  app.on('window-all-closed', async () => {
    quitting = true;
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    await stopEngine(engine);
    app.quit();
  });
}

if (primary) {
  main().catch((e) => {
    log(`failed: ${(e as Error)?.stack ?? e}`);
    dialog.showErrorBox('Favilla could not start', String((e as Error)?.stack ?? e));
    app.quit();
  });
}
