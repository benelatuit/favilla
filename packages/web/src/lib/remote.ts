import { b64, newAgreementKey, phoneHello, unb64, type Channel, type KeyPair } from '@favilla/core/remote/e2e';
import { RemoteParts } from '@favilla/core/remote/parts';

/**
 * The page on a phone, opened through Favilla's relay: every request, the live events and the pictures go over one
 * sealed channel to the computer (e2e.ts), never as plain requests to the relay. The phone's key is made here and
 * kept in this browser only (IndexedDB, the private half not extractable); the computer's key comes from the
 * pairing QR, in the link's fragment, which no server sees.
 */
export const remoteMode = typeof document !== 'undefined' && !!document.querySelector('meta[name="favilla-remote"]');

interface Pairing {
  pc: string;
  kx: string;
  name: string;
  /** The one-time pairing code, until the first handshake has used it. */
  code?: string;
}

const DB = 'favilla-remote';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** The pairing in this browser: a new one from the link's fragment (then the fragment is cleared), or the one kept. */
async function pairing(): Promise<Pairing | null> {
  const m = /#pair=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      const p = JSON.parse(new TextDecoder().decode(unb64(m[1]))) as { pc: string; kx: string; c: string; n?: string };
      const fresh: Pairing = { pc: p.pc, kx: p.kx, name: p.n ?? 'Favilla', code: p.c };
      await put('pairing', fresh);
      history.replaceState(null, '', location.pathname);
      return fresh;
    } catch {
      history.replaceState(null, '', location.pathname);
    }
  }
  return (await get<Pairing>('pairing')) ?? null;
}

async function phoneKeys(): Promise<KeyPair> {
  const kept = await get<KeyPair>('keys');
  if (kept) return kept;
  const fresh = await newAgreementKey(false);
  await put('keys', fresh);
  return fresh;
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return [kind, browser].filter(Boolean).join(' · ');
};

export type RemoteState = 'connecting' | 'open' | 'offline' | 'unpaired' | 'refused';
type Res = { s: number; b?: unknown; text?: string; b64?: string; ct?: string };

/** One sealed channel to the computer, made again after every drop; requests wait for it. */
class Remote {
  state: RemoteState = 'connecting';
  error = '';
  private ws: WebSocket | null = null;
  private ch: Channel | null = null;
  private next = 1;
  private pending = new Map<number, (r: Res) => void>();
  private queue: (() => void)[] = [];
  private parts = new RemoteParts(() => this.ws?.close());
  private listeners = new Set<(s: RemoteState) => void>();
  private events: ((e: unknown) => void) | null = null;
  private retry = 800;
  private started = false;

  onState(l: (s: RemoteState) => void): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => this.listeners.delete(l);
  }

  private set(s: RemoteState, error = ''): void {
    this.state = s;
    this.error = error;
    for (const l of this.listeners) l(s);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  /** The channel and what was under way on it let go: half-received messages, and requests told they went nowhere. */
  private drop(why: string): void {
    this.ch = null;
    this.parts.clear();
    for (const [, done] of this.pending) done({ s: 503, b: { error: why } });
    this.pending.clear();
  }

  private async connect(): Promise<void> {
    const p = await pairing();
    if (!p) return this.set('unpaired');
    this.set('connecting');
    const keys = await phoneKeys();
    const ws = new WebSocket(`${location.protocol === 'http:' ? 'ws' : 'wss'}://${location.host}/ws/phone/${p.pc}`);
    this.ws = ws;
    let finish: ((w: string) => Promise<Channel>) | null = null;
    const hello = async () => {
      const h = await phoneHello({ phone: keys, pc: unb64(p.kx), code: p.code ? unb64(p.code) : undefined, name: deviceName() });
      finish = h.finish;
      ws.send(JSON.stringify({ t: 'data', d: h.hello }));
    };
    ws.onopen = () => void hello();
    ws.onmessage = async (m) => {
      const f = JSON.parse(String(m.data)) as { t: string; d?: string };
      // The computer gone, its channel goes with it: when it is back, its welcome opens a new one. The old channel had
      // stayed and was handed the new welcome, which it could never open.
      if (f.t === 'offline') {
        this.drop('The computer went offline.');
        return this.set('offline');
      }
      if (f.t === 'online') {
        this.drop('The computer went offline.');
        return void hello();
      }
      if (f.t !== 'data' || typeof f.d !== 'string') return;
      if (!this.ch) {
        if (!finish) return;
        try {
          this.ch = await finish(f.d);
        } catch (e) {
          this.set('refused', (e as Error).message);
          ws.close();
          return;
        }
        if (p.code) await put('pairing', { ...p, code: undefined });
        this.retry = 800;
        this.set('open');
        if (this.events) void this.send({ t: 'sub' });
        for (const go of this.queue.splice(0)) go();
        return;
      }
      const channel = this.ch;
      let msg: { t: string; id?: number; es?: unknown[] } & Res;
      try {
        const opened = await channel.open(f.d);
        if (this.ch !== channel || this.ws !== ws) return;
        const frame = JSON.parse(opened);
        if (frame.t === 'part') {
          const text = this.parts.take(frame);
          if (text === null) return;
          msg = JSON.parse(text);
        } else msg = frame;
      } catch {
        // An unreadable or incomplete message cannot answer the requests that are waiting on this connection.
        ws.close();
        return;
      }
      if (msg.t === 'res' && msg.id) this.pending.get(msg.id)?.(msg), this.pending.delete(msg.id);
      else if (msg.t === 'evs') for (const e of msg.es ?? []) this.events?.(e);
    };
    ws.onclose = () => {
      this.ws = null;
      this.drop('The connection to the computer dropped.');
      if (this.state === 'refused' || this.state === 'unpaired') return;
      if (this.state !== 'offline') this.set('connecting');
      setTimeout(() => void this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15_000);
    };
  }

  private async send(message: unknown): Promise<void> {
    if (!this.ch || !this.ws) return;
    this.ws.send(JSON.stringify({ t: 'data', d: await this.ch.seal(JSON.stringify(message)) }));
  }

  request(method: string, path: string, body?: unknown): Promise<Res> {
    this.start();
    return new Promise((resolve) => {
      const go = () => {
        const id = this.next++;
        this.pending.set(id, resolve);
        void this.send({ t: 'req', id, m: method, p: path, ...(body !== undefined ? { b: body } : {}) });
      };
      if (this.ch) go();
      else this.queue.push(go);
    });
  }

  subscribe(onEvent: (e: unknown) => void): () => void {
    this.events = onEvent;
    this.start();
    if (this.ch) void this.send({ t: 'sub' });
    return () => {
      this.events = null;
      void this.send({ t: 'unsub' });
    };
  }
}

export const remote = new Remote();

interface Picture {
  src: string;
  images: Set<HTMLImageElement>;
  url?: string;
  loading?: boolean;
  retry?: number;
}

/**
 * Pictures in the page point at the computer's /api paths. While any image shows one, share its request and
 * object URL over the sealed channel. The last image leaving also releases the decoded picture.
 */
export function watchPictures(): () => void {
  const pictures = new Map<string, Picture>();
  const shown = new Map<HTMLImageElement, Picture>();

  const release = (img: HTMLImageElement) => {
    const p = shown.get(img);
    if (!p) return;
    shown.delete(img);
    delete img.dataset.remoteSrc;
    p.images.delete(img);
    if (p.images.size) return;
    pictures.delete(p.src);
    window.clearTimeout(p.retry);
    if (p.url) URL.revokeObjectURL(p.url);
  };

  const load = async (p: Picture, retry = true) => {
    if (p.url || p.loading || !p.images.size) return;
    window.clearTimeout(p.retry);
    p.retry = undefined;
    p.loading = true;
    let transient = true;
    try {
      const r = await remote.request('GET', p.src.replace(/^\/api/, ''));
      if (pictures.get(p.src) !== p) return;
      transient = r.s >= 500 || r.s < 400;
      if (r.s >= 400 || !r.b64) throw new Error(`picture ${r.s}`);
      p.url = URL.createObjectURL(new Blob([unb64(r.b64)], { type: r.ct || 'application/octet-stream' }));
      for (const img of p.images) if (img.isConnected && !img.hasAttribute('src')) img.setAttribute('src', p.url);
    } catch {
      if (pictures.get(p.src) !== p) return;
      for (const img of p.images) if (!img.hasAttribute('src')) img.setAttribute('alt', img.alt || 'picture');
      // Retry once while on screen. After a disconnect the new channel retries any still-visible failures.
      if (retry && transient && remote.state === 'open') p.retry = window.setTimeout(() => void load(p, false), 500);
    } finally {
      p.loading = false;
    }
  };

  const swap = (img: HTMLImageElement) => {
    const src = img.getAttribute('src');
    const previous = shown.get(img);
    if (previous && (src === previous.url || (src === null && !previous.url))) return;
    if (previous && src !== previous.src) release(img);
    if (!src?.startsWith('/api/')) return;
    let p = pictures.get(src);
    if (!p) pictures.set(src, (p = { src, images: new Set() }));
    p.images.add(img);
    shown.set(img, p);
    img.dataset.remoteSrc = src;
    if (p.url) img.setAttribute('src', p.url);
    else {
      img.removeAttribute('src');
      void load(p);
    }
  };

  const collect = (node: Node, into: Set<HTMLImageElement>) => {
    if (node instanceof HTMLImageElement) into.add(node);
    else if (node instanceof Element) for (const img of node.querySelectorAll('img')) into.add(img);
  };
  const observer = new MutationObserver((records) => {
    const touched = new Set<HTMLImageElement>();
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof HTMLImageElement) touched.add(r.target);
      for (const n of r.addedNodes) collect(n, touched);
      for (const n of r.removedNodes) collect(n, touched);
    }
    // A re-render may add a new image for the same picture before removing the old one.
    for (const img of touched) if (img.isConnected) swap(img);
    for (const img of touched) if (!img.isConnected) release(img);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  const off = remote.onState((state) => {
    if (state === 'open') for (const p of pictures.values()) void load(p);
  });
  document.querySelectorAll<HTMLImageElement>('img[src^="/api/"]').forEach(swap);
  return () => {
    observer.disconnect();
    off();
    for (const [img, p] of shown) {
      if (img.isConnected && (!img.hasAttribute('src') || img.getAttribute('src') === p.url)) img.setAttribute('src', p.src);
      release(img);
    }
  };
}
