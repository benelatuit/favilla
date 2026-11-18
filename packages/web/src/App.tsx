import { lazy, memo, Suspense, useCallback, useEffect, useMemo, type ComponentType } from 'react';
import { actions, getState, setUi, toast, useStore } from './lib/store';
import { productName, resolveLang, translate, useT } from './lib/i18n';
import { desktop, isMac } from './lib/desktop';
import { paintTitleBar } from './lib/titlebar';
import { plainTitle } from './lib/format';
import type { SessionView } from './lib/types';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { Timeline } from './components/Timeline';
import { GoalCard } from './components/GoalCard';
import { watchDiagrams } from './lib/mermaid';
import { Composer, attachFiles } from './components/Composer';
import { FollowNote } from './components/FollowNote';
import { WorkPanel } from './components/WorkPanel';
import { PermissionPrompt, PlanPrompt, QuestionPrompt } from './components/Prompts';
import { FolderPicker } from './components/FolderPicker';
import { Welcome } from './components/Welcome';
import { CommandPalette } from './components/CommandPalette';
import { pickFolder, revealFolder } from './components/Folders';
import { RemoteGate, useRemoteState } from './components/RemoteGate';
import { SimpleBar } from './components/SimpleBar';
import { SimpleHome } from './components/SimpleHome';
import { setComposing, useComposing, useMedia, useSimple } from './lib/layout';
import { remoteMode, watchPictures } from './lib/remote';
import { watchPhone } from './lib/push';
import { contextEntries } from './components/contextMenu';
import { ContextMenuLayer, DialogLayer, ToastLayer, TooltipLayer } from './components/ui/Layers';
import { Viewer } from './components/ui/Viewer';
import { ChangesView } from './components/ChangesView';
import { FileView } from './components/FileView';
import { ChildSheet } from './components/ChildSheet';
import { FindBar } from './components/FindBar';
import { findNext, getFind, openFind } from './lib/find';
import { PAIRS } from './lib/themes';

/**
 * The settings and what only they use (the pairing code's QR library among them) load when first opened, and
 * ahead of that once the window is idle: they were a tenth of the page's first script.
 */
let ResolvedSettings: ComponentType | null = null;
let settingsChunk: Promise<{ default: ComponentType }> | null = null;
const loadSettings = () =>
  (settingsChunk ??= import('./components/Settings').then((m) => {
    ResolvedSettings = m.Settings;
    return { default: m.Settings };
  }));
const Settings = lazy(loadSettings);

/** Docked sidebar and panel need room; below these widths they open as drawers over the page. */
const WIDE_SIDEBAR = '(min-width: 860px)';
const WIDE_PANEL = '(min-width: 1180px)';

/** Theme and language on the document; the desktop window's own buttons take the title bar's colours. */
function useAppearance(): void {
  const setting = useStore((s) => s.info?.config.theme ?? 'auto');
  // Until the settings arrive, the theme is the one main.tsx put on the document: applying "auto" meanwhile turned
  // a dark window light for the start screen, and kept that as the next start's theme.
  const known = useStore((s) => !!s.info);
  const lang = useStore((s) => resolveLang(s.info?.config.language));
  useEffect(() => {
    if (!known) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      // "auto" follows the system within the drafting room; "kiln-auto" within Kiln, "sky-auto" within Clear sky.
      const pair = PAIRS[setting];
      const theme = pair ? (media.matches ? pair[1] : pair[0]) : setting;
      const root = document.documentElement;
      if (root.dataset.theme !== theme) {
        // Every control eases between its colours; a theme switched over at once repaints at once instead.
        root.classList.add('is-repainting');
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-repainting')));
      }
      root.dataset.theme = theme;
      try {
        // For the next start's first frame (main.tsx).
        localStorage.setItem('favilla.theme', theme);
      } catch {
        /* storage unavailable */
      }
      paintTitleBar();
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [setting, known]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  // Only these overlays cover the window buttons. Drawers and tabs leave their colours as they were.
  const overlayKey = useStore((s) => `${!!s.ui.settings}|${s.ui.palette}|${s.ui.picker}|${!!s.ui.dialog}|${!!s.ui.viewer}|${!!s.ui.fileView}|${!!s.ui.changesView}`);
  useEffect(() => {
    const frame = requestAnimationFrame(paintTitleBar);
    return () => cancelAnimationFrame(frame);
  }, [overlayKey]);
}

function useWindowTitle(): void {
  const title = useStore((s) => plainTitle(s.session?.meta.title));
  useEffect(() => {
    document.title = title ? `${title} · ${productName}` : productName;
  }, [title]);
}

/** Keyboard shortcuts that work anywhere in the window. Mod is Ctrl, or ⌘ on a Mac. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const ui = getState().ui;
      // The next and previous find match from anywhere while the find bar is open, as in a browser.
      const finding = getFind().open && !ui.dialog && !ui.palette && !ui.settings;
      if (finding && (e.key === 'F3' || (mod && !e.altKey && e.key.toLowerCase() === 'g'))) {
        e.preventDefault();
        e.stopPropagation();
        return findNext(e.shiftKey ? -1 : 1);
      }
      if (e.key === 'Escape' && !mod) {
        if (ui.menu || ui.dialog || ui.palette || ui.settings || ui.picker) return;
        const narrow = !window.matchMedia(WIDE_SIDEBAR).matches;
        if (narrow && ui.sidebar) setUi({ sidebar: false });
        if (!window.matchMedia(WIDE_PANEL).matches && ui.panel) setUi({ panel: false });
        return;
      }
      if (!mod || ui.dialog) return;
      const key = e.key.toLowerCase();
      const run = (f: () => unknown) => {
        e.preventDefault();
        e.stopPropagation();
        Promise.resolve(f()).catch((err) => toast(String(err), 'error'));
      };
      if (key === 'k' && !e.shiftKey && !e.altKey) return run(() => setUi({ palette: !ui.palette }));
      if (ui.palette) return;
      // Find in the open conversation; elsewhere (no session, a sheet over it) the key does what it would.
      if (key === 'f' && !e.shiftKey && !e.altKey && getState().session && !ui.settings && !ui.picker && !ui.sheet && !ui.fileView && !ui.changesView) return run(openFind);
      if (key === 'n' && !e.shiftKey && !e.altKey) return run(() => actions.newSession());
      if (key === 'o' && !e.shiftKey && !e.altKey) return run(pickFolder);
      if (key === 'e' && e.shiftKey && !e.altKey) return run(() => revealFolder(getState().folder, (k) => k));
      if (key === 'b' && e.altKey) return run(() => setUi({ panel: !ui.panel }));
      if (key === 'b') return run(() => setUi({ sidebar: !ui.sidebar }));
      if (key === ',') return run(() => setUi({ settings: true }));
      if (key === 'l') return run(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
      if (desktop && (key === '=' || key === '+')) return run(() => desktop!.zoom(1));
      if (desktop && key === '-') return run(() => desktop!.zoom(-1));
      if (desktop && key === '0') return run(() => desktop!.zoom(0));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

/** In the desktop app, a page that lost its access reloads itself with the token instead of retrying forever. */
function useAccessRecovery(): void {
  const connection = useStore((s) => s.connection);
  useEffect(() => {
    if (connection !== 'unauthorized' || !desktop) return;
    const last = Number(sessionStorage.getItem('favilla.reconnectAt') ?? 0);
    if (Date.now() - last < 15_000) return;
    sessionStorage.setItem('favilla.reconnectAt', String(Date.now()));
    desktop.reconnect();
  }, [connection]);
}

/** The app's own right-click menu, and files dropped anywhere going to the composer. */
function useWindowEvents(): void {
  const t = useT();
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      e.preventDefault();
      const entries = contextEntries(e.target as Element, t);
      setUi({ menu: entries.length ? { x: e.clientX, y: e.clientY, entries } : null });
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) attachFiles([...e.dataTransfer.files]);
    };
    document.addEventListener('contextmenu', onMenu);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('contextmenu', onMenu);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [t]);
}

const EMPTY_MESSAGES: SessionView['messages'] = [];

const ConversationTimeline = memo(function ConversationTimeline() {
  const messages = useStore((s) => s.session?.messages ?? EMPTY_MESSAGES);
  const results = useStore((s) => s.results);
  const drafts = useStore((s) => s.drafts);
  const running = useStore((s) => s.running);
  const pending = useStore((s) => s.session?.pending);
  const footer = useMemo(
    () => (
      <>
        {pending?.permissions.map((p) => <PermissionPrompt key={p.id} req={p} />)}
        {pending?.questions.map((q) => <QuestionPrompt key={q.id} req={q} />)}
        {pending?.plans.map((p) => <PlanPrompt key={p.id} id={p.id} plan={p.plan} />)}
      </>
    ),
    [pending],
  );
  return <Timeline messages={messages} results={results} drafts={drafts} running={running} footer={footer} />;
});

export function App() {
  useAppearance();
  useWindowTitle();
  useShortcuts();
  useWindowEvents();
  useAccessRecovery();
  useEffect(() => watchDiagrams(), []);
  const loading = useStore((s) => s.loading);
  const hasSession = useStore((s) => !!s.session);
  const following = useStore((s) => !!s.session?.following);
  const ui = useStore((s) => s.ui);
  const wideSidebar = useMedia(WIDE_SIDEBAR);
  const closeSidebarDrawer = useCallback(() => {
    if (!wideSidebar) setUi({ sidebar: false });
  }, [wideSidebar]);
  const widePanel = useMedia(WIDE_PANEL);
  const remoteState = useRemoteState();
  const simple = useSimple();
  const composing = useComposing();
  // A session opened (from the list, a notification, the first message of a new one) ends writing a new one.
  useEffect(() => {
    if (hasSession) setComposing(false);
  }, [hasSession]);

  useEffect(() => {
    // On a phone, pictures from the computer come over the sealed channel too.
    const stopPictures = remoteMode ? watchPictures() : undefined;
    actions
      .boot()
      // A tapped notification opens its session; the computer hears while Favilla is in view here.
      .then(() => remoteMode && watchPhone((id) => void actions.open(id)))
      .catch((e) => toast(`${translate(resolveLang(getState().info?.config.language), 'Cannot reach Favilla')}: ${(e as Error).message}`, 'error'));
    const idle = window.requestIdleCallback
      ? (f: () => void) => window.requestIdleCallback(f, { timeout: 1200 })
      : (f: () => void) => window.setTimeout(f, 1200);
    idle(() => void loadSettings().catch(() => {}));
    return stopPictures;
  }, []);

  // Drawers start closed on small windows, whatever was docked last time.
  useEffect(() => {
    if (!wideSidebar && getState().ui.sidebar) setUi({ sidebar: false });
  }, [wideSidebar]);
  useEffect(() => {
    if (!widePanel && getState().ui.panel) setUi({ panel: false });
  }, [widePanel]);

  if (remoteState && (remoteState === 'unpaired' || remoteState === 'refused' || (loading && remoteState !== 'open'))) return <RemoteGate state={remoteState} />;
  if (loading) {
    return (
      <div className="boot" aria-busy="true">
        <img src="./icon.png" alt="" />
      </div>
    );
  }

  const panel = ui.panel && hasSession && !simple;
  const classes = [
    'app',
    simple && 'is-simple',
    !simple && ui.sidebar && 'has-sidebar',
    panel && 'has-panel',
    wideSidebar ? 'dock-sidebar' : 'drawer-sidebar',
    widePanel ? 'dock-panel' : 'drawer-panel',
    desktop && 'is-desktop',
    isMac && 'is-mac',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {simple ? <SimpleBar /> : <TitleBar />}
      {!simple && <Sidebar onNavigate={closeSidebarDrawer} />}
      {!simple && ((!wideSidebar && ui.sidebar) || (!widePanel && panel)) && <div className="drawer-scrim" onClick={() => setUi({ sidebar: wideSidebar ? ui.sidebar : false, panel: widePanel ? ui.panel : false })} aria-hidden />}
      <main className="main">
        {hasSession ? (
          <>
            <FindBar />
            <div className="scroll">
              <GoalCard />
              <ConversationTimeline />
            </div>
            <div className="dock">
              {following ? <FollowNote /> : <Composer />}
            </div>
          </>
        ) : simple && !composing ? (
          <SimpleHome />
        ) : (
          <Welcome />
        )}
      </main>
      {hasSession && !simple && <WorkPanel />}
      {ui.settings &&
        (ResolvedSettings ? (
          <ResolvedSettings />
        ) : (
          <Suspense fallback={null}>
            <Settings />
          </Suspense>
        ))}
      {ui.picker && <FolderPicker />}
      <CommandPalette />
      <ContextMenuLayer />
      <DialogLayer />
      <Viewer />
      <ChangesView />
      <FileView />
      <ChildSheet />
      <ToastLayer />
      <TooltipLayer />
    </div>
  );
}
