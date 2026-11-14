// Favilla's point-and-tell, added to each page of a preview by its proxy (server/preview.ts). The app asks for a pick
// with a message; the element clicked comes back described, with what the page did in the seconds before (clicks,
// errors, failed requests). Until asked it only keeps that short record, and it never stops the page's own events
// except the click that picks.
(() => {
  if (window.__favillaPoint || window.parent === window) return;
  window.__favillaPoint = true;

  // What happened in the page lately: kept 40 deep, the last 15 seconds go out with a pick.
  const events = [];
  const note = (kind, text) => {
    events.push({ at: Date.now(), kind, text: String(text).replace(/\s+/g, ' ').slice(0, 240) });
    if (events.length > 40) events.shift();
  };
  const where = (e) => (e && e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno}:${e.colno})` : '');
  addEventListener('error', (e) => note('error', `${e.message}${where(e)}`), true);
  addEventListener('unhandledrejection', (e) => note('error', `Unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  const consoleError = console.error;
  console.error = function (...args) {
    note('console', args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safe(a))).join(' '));
    return consoleError.apply(this, args);
  };
  const safe = (v) => {
    try {
      return JSON.stringify(v).slice(0, 120);
    } catch {
      return String(v);
    }
  };
  const fetch0 = window.fetch;
  if (fetch0) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      return fetch0.call(this, input, init).then(
        (r) => {
          if (!r.ok) note('request', `${(init && init.method) || 'GET'} ${bare(url)} ${r.status}`);
          return r;
        },
        (err) => {
          note('request', `${(init && init.method) || 'GET'} ${bare(url)} failed: ${err && err.message}`);
          throw err;
        },
      );
    };
  }
  const open0 = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('loadend', () => {
      if (this.status === 0 || this.status >= 400) note('request', `${method} ${bare(url)} ${this.status || 'failed'}`);
    });
    return open0.call(this, method, url, ...rest);
  };

  // A short CSS path an agent can search for: ids and classes where there are some, positions where needed.
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n === document.body || n === document.documentElement) break;
      let part = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(`${part}#${n.id}`);
        break;
      }
      const cls = [...n.classList].filter((c) => !/^(?:hover|active|focus)/.test(c)).slice(0, 2);
      if (cls.length) part += `.${cls.join('.')}`;
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (!cls.length && same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  // What a thing says, never what was typed into it: a field's value (a password, a token in a hidden field) would go
  // with the message to the model and through every relay on the way. A field is named by its label, hint or name.
  const field = (el) => /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const words = (el) =>
    ((field(el) ? '' : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || (field(el) && el.labels && el.labels[0] ? el.labels[0].innerText : '') || (field(el) ? el.getAttribute('name') : '') || '')
      .toString()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  // The markup with every value left out, for the same reason.
  const markup = (el) => {
    const copy = el.cloneNode(true);
    for (const n of [copy, ...copy.querySelectorAll('*')]) {
      if (n.hasAttribute('value')) n.setAttribute('value', '…');
      if (n.tagName === 'TEXTAREA') n.textContent = '…';
    }
    return copy.outerHTML.replace(/\s+/g, ' ').slice(0, 280);
  };
  // An address without its query, where tokens and personal data ride.
  const bare = (u) => String(u).split(/[?#]/)[0];
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const since = Date.now() - 15000;
    return {
      page: location.href,
      tag: el.tagName.toLowerCase(),
      selector: path(el),
      text: words(el),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      view: [innerWidth, innerHeight],
      style: { color: cs.color, background: cs.backgroundColor, font: `${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily.split(',')[0]}`, padding: cs.padding, margin: cs.margin, radius: cs.borderRadius },
      html: markup(el),
      events: events.filter((e) => e.at >= since).map((e) => ({ ago: Math.round((Date.now() - e.at) / 1000), kind: e.kind, text: e.text })),
    };
  };

  // Picking: an outline over the element under the pointer, its name beside it; a click picks it, Esc leaves.
  let picking = false;
  let asker = null;
  const box = document.createElement('div');
  const tag = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #c2410c;background:rgba(194,65,12,.08);border-radius:3px;display:none;';
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:12px/1.4 ui-monospace,Consolas,monospace;color:#fff;background:#7c2d12;padding:2px 6px;border-radius:3px;display:none;white-space:nowrap;';
  const show = (el) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tag.textContent = `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(tag.style, { display: 'block', left: `${Math.max(0, r.left)}px`, top: `${r.top > 22 ? r.top - 22 : r.bottom + 4}px` });
  };
  const hide = () => {
    box.style.display = 'none';
    tag.style.display = 'none';
  };
  const send = (msg) => asker && window.parent.postMessage({ favilla: 'point', ...msg }, asker);
  const stop = () => {
    picking = false;
    hide();
    document.documentElement.style.cursor = '';
  };
  const target = (e) => (e.target && e.target.nodeType === 1 ? e.target : null);
  addEventListener(
    'mousemove',
    (e) => {
      if (picking && target(e)) show(target(e));
    },
    true,
  );
  // The click that picks is the page's no more: nothing underneath runs.
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    addEventListener(
      type,
      (e) => {
        if (!picking) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }
  addEventListener(
    'click',
    (e) => {
      if (!picking) {
        const el = target(e);
        if (el) note('click', `${path(el)} "${words(el).slice(0, 40)}"`);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = target(e);
      stop();
      if (el) send({ picked: describe(el) });
    },
    true,
  );
  addEventListener(
    'keydown',
    (e) => {
      if (picking && e.key === 'Escape') {
        stop();
        send({ cancelled: true });
      }
    },
    true,
  );
  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.favilla !== 'point') return;
    asker = e.origin;
    if (e.data.on) {
      if (!box.isConnected) document.documentElement.append(box, tag);
      picking = true;
      document.documentElement.style.cursor = 'crosshair';
    } else stop();
  });
})();
