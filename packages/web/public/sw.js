// Favilla on a paired phone: shows the notifications the computer sends (Web Push, sealed for this browser alone) and
// opens the session one is about when it is tapped. It keeps nothing and caches nothing; the words come with each
// notification, in the phone's language.
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    // Not one of the computer's.
  }
  event.waitUntil(self.registration.showNotification(d.t || 'Favilla', { body: d.b || '', tag: d.s || 'favilla', renotify: true, icon: '/icon.png', data: { s: d.s } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const s = event.notification.data && event.notification.data.s;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of open) {
        if (!('focus' in c)) continue;
        await c.focus();
        if (s) c.postMessage({ t: 'open', s });
        return;
      }
      await self.clients.openWindow(s ? `/#session=${encodeURIComponent(s)}` : '/');
    })(),
  );
});
