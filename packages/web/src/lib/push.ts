import { api } from './api';
import { remoteMode } from './remote';

/**
 * Notifications from the computer on a paired phone (core/src/remote/push.ts): the phone subscribes with the
 * computer's key, gives it the words of each kind in its own language, and says while it has Favilla in view.
 */
type PushWords = Record<'done' | 'limit' | 'failed' | 'ask', string>;

/** On an iPhone or iPad, Safari gives notifications only to a page added to the Home Screen and opened from there. */
export function needsHomeScreen(): boolean {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function pushSupported(): boolean {
  return remoteMode && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const key = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), (c) => c.charCodeAt(0));

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

export async function pushState(): Promise<{ on: boolean; key: string }> {
  return api<{ on: boolean; key: string }>('/notify');
}

/** Permission first, then a subscription made with this computer's key; one made with another key is replaced. */
export async function enablePush(words: PushWords): Promise<boolean> {
  const state = await pushState();
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const want = key(state.key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, want)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('/notify/subscribe', { body: { sub: sub.toJSON(), words } });
  return true;
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  await api('/notify/unsubscribe', { body: {} });
}

/**
 * On a phone: tell the computer while Favilla is in view (and again every 20 seconds), so it does not notify about
 * what is on the screen; and open the session a tapped notification is about.
 */
export function watchPhone(open: (id: string) => void): void {
  if (!remoteMode) return;
  let timer: number | undefined;
  const tell = () => void api('/notify/visible', { body: { visible: document.visibilityState === 'visible' } }).catch(() => {});
  const update = () => {
    clearInterval(timer);
    tell();
    if (document.visibilityState === 'visible') timer = window.setInterval(tell, 20_000);
  };
  document.addEventListener('visibilitychange', update);
  update();
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const m = e.data as { t?: string; s?: unknown } | null;
    if (m?.t === 'open' && typeof m.s === 'string') open(m.s);
  });
  const hash = /^#session=([\w-]+)$/.exec(location.hash);
  if (hash) {
    history.replaceState(null, '', location.pathname);
    open(hash[1]);
  }
}
