/**
 * The dashboard's service worker: the part of Boxes that runs when Boxes is
 * not open.
 *
 * A push arrives here whether or not a tab exists. Caching and offline
 * shells are deliberately absent: the dashboard is useless without the
 * orchestrator, and a stale cached bundle talking to a newer API is a class
 * of bug worth not having.
 *
 * Served from the bundle root so its scope is the whole origin. It is plain
 * JavaScript rather than TypeScript because it is not part of the Vite graph:
 * nothing imports it, the browser fetches it by name.
 */

/* global self, clients */

/**
 * Take over as soon as a new copy is installed, rather than waiting for every
 * tab to close. A push handler is not something to leave on an old version.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

/**
 * Shows one notification.
 *
 * Every push must display something: browsers grant the subscription on that
 * condition and revoke it from a worker that stays silent. So a payload that
 * fails to parse still produces a notification rather than nothing.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Boxes';
  const options = {
    body: payload.body || 'A session wants your attention.',
    // Same tag replaces rather than stacks: a thread that asks twice should
    // not leave two notifications to dismiss.
    tag: payload.tag || 'boxes',
    renotify: Boolean(payload.tag),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Opens what the notification was about.
 *
 * An already-open Boxes window is reused and navigated rather than duplicated
 * — waking a phone should not leave three tabs behind — and a new one is
 * opened only when there is none.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        return client.focus().then((focused) => {
          // navigate() is unavailable in some browsers when the client is not
          // controlled by this worker; focusing it is still better than a
          // second window.
          if (typeof focused.navigate !== 'function') return focused;
          return focused.navigate(url).catch(() => focused);
        });
      }
      return clients.openWindow(url);
    }),
  );
});

/**
 * Re-registers when the push service rotates a subscription out, which
 * Safari in particular does on its own schedule.
 *
 * Without this the browser silently stops receiving anything: the old
 * subscription is dead and the orchestrator never hears about the new one.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = await fetch('/api/push/key')
        .then((res) => res.json())
        .then((body) => body.publicKey);
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
    })().catch(() => {
      // Nothing useful to do from here: the page re-subscribes on its next
      // load, which is the path that recovers this.
    }),
  );
});
