import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
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
import { WorkPanel } from './components/WorkPanel';
import { PermissionPrompt, PlanPrompt, QuestionPrompt } from './components/Prompts';
import { FolderPicker } from './components/FolderPicker';
import { Welcome } from './components/Welcome';
import { CommandPalette } from './components/CommandPalette';
import { pickFolder, revealFolder } from './components/Folders';
import { RemoteGate, useRemoteState } from './components/RemoteGate';
import { remoteMode, watchPictures } from './lib/remote';
import { watchPhone } from './lib/push';
import { contextEntries } from './components/contextMenu';
import { ContextMenuLayer, DialogLayer, ToastLayer, TooltipLayer } from './components/ui/Layers';
import { Viewer } from './components/ui/Viewer';
import { FileView } from './components/FileView';
import { ChildSheet } from './components/ChildSheet';
import { FindBar } from './components/FindBar';
import { findNext, getFind, openFind } from './lib/find';

/**
 * The settings and what only they use (the pairing code's QR library among them) load when first opened, and
 * ahead of that once the window is idle: they were a tenth of the page's first script.
 */
const loadSettings = () => import('./components/Settings');
const Settings = lazy(() => loadSettings().then((m) => ({ default: m.Settings })));

/** Docked sidebar and panel need room; below these widths they open as drawers over the page. */
const WIDE_SIDEBAR = '(min-width: 860px)';
const WIDE_PANEL = '(min-width: 1180px)';

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

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
      // "auto" follows the system within the drafting room; "kiln-auto" within Kiln.
      const theme = setting === 'auto' ? (media.matches ? 'nightshift' : 'drafting') : setting === 'kiln-auto' ? (media.matches ? 'kiln-night' : 'kiln') : setting;
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
  const { settings, palette, picker, dialog, viewer, fileView } = useStore((s) => s.ui);
  useEffect(() => {
    const frame = requestAnimationFrame(paintTitleBar);
    return () => cancelAnimationFrame(frame);
  }, [settings, palette, picker, dialog, viewer, fileView]);
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
      if (key === 'f' && !e.shiftKey && !e.altKey && getState().session && !ui.settings && !ui.picker && !ui.sheet && !ui.fileView) return run(openFind);
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

function ConversationTimeline({ session }: { session: SessionView }) {
  const results = useStore((s) => s.results);
  const drafts = useStore((s) => s.drafts);
  const running = useStore((s) => s.running);
  const pending = session.pending;
  return (
    <Timeline
      messages={session.messages}
      results={results}
      drafts={drafts}
      running={running}
      footer={
        <>
          {pending?.permissions.map((p) => <PermissionPrompt key={p.id} req={p} />)}
          {pending?.questions.map((q) => <QuestionPrompt key={q.id} req={q} />)}
          {pending?.plans.map((p) => <PlanPrompt key={p.id} id={p.id} plan={p.plan} />)}
        </>
      }
    />
  );
}

export function App() {
  useAppearance();
  useWindowTitle();
  useShortcuts();
  useWindowEvents();
  useAccessRecovery();
  useEffect(() => watchDiagrams(), []);
  const loading = useStore((s) => s.loading);
  const session = useStore((s) => s.session);
  const ui = useStore((s) => s.ui);
  const wideSidebar = useMedia(WIDE_SIDEBAR);
  const closeSidebarDrawer = useCallback(() => {
    if (!wideSidebar) setUi({ sidebar: false });
  }, [wideSidebar]);
  const widePanel = useMedia(WIDE_PANEL);
  const remoteState = useRemoteState();

  useEffect(() => {
    // On a phone, pictures from the computer come over the sealed channel too.
    const stopPictures = remoteMode ? watchPictures() : undefined;
    actions
      .boot()
      // A tapped notification opens its session; the computer hears while Favilla is in view here.
      .then(() => remoteMode && watchPhone((id) => void actions.open(id)))
      .catch((e) => toast(`${translate(resolveLang(getState().info?.config.language), 'Cannot reach Favilla')}: ${(e as Error).message}`, 'error'));
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
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

  const panel = ui.panel && !!session;
  const classes = [
    'app',
    ui.sidebar && 'has-sidebar',
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
      <TitleBar />
      <Sidebar onNavigate={closeSidebarDrawer} />
      {((!wideSidebar && ui.sidebar) || (!widePanel && panel)) && <div className="drawer-scrim" onClick={() => setUi({ sidebar: wideSidebar ? ui.sidebar : false, panel: widePanel ? ui.panel : false })} aria-hidden />}
      <main className="main">
        {session ? (
          <>
            <FindBar />
            <div className="scroll">
              <GoalCard />
              <ConversationTimeline session={session} />
            </div>
            <div className="dock">
              <Composer />
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </main>
      {session && <WorkPanel />}
      {ui.settings && (
        <Suspense fallback={null}>
          <Settings />
        </Suspense>
      )}
      {ui.picker && <FolderPicker />}
      <CommandPalette />
      <ContextMenuLayer />
      <DialogLayer />
      <Viewer />
      <FileView />
      <ChildSheet />
      <ToastLayer />
      <TooltipLayer />
    </div>
  );
}
