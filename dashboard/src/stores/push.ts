import { useSyncExternalStore } from 'react';
import { api } from '../api.ts';

/**
 * Web Push registration: the notification that arrives with Boxes closed.
 *
 * The browser subscribes with a push service of its vendor's choosing and
 * hands back an endpoint the orchestrator posts to. From then on the service
 * worker is woken whether or not a tab exists, which is the difference
 * between this and asking the page to notice something.
 *
 * A plain module-level store with a subscriber set: React reads it through
 * useSyncExternalStore, and nothing outside this file needs a hook to change
 * it.
 */

/** Why this browser cannot subscribe, when it cannot. */
export type PushBlocker =
  /** Not https and not localhost. Service workers do not exist here at all. */
  | 'insecure'
  /** iOS Safari before the page has been added to the Home Screen. */
  | 'needs-install'
  /** No Push API, whatever the reason. */
  | 'unsupported'
  /** The user said no. Only they can undo it, in site settings. */
  | 'denied';

/** What the toggle renders. */
export interface PushState {
  /** True when this browser could subscribe if asked. */
  supported: boolean;
  /** Why not, when it cannot. Null while it can. */
  blocker: PushBlocker | null;
  /** True once this browser is registered with the orchestrator. */
  subscribed: boolean;
  /** True while a subscribe or unsubscribe is in flight. */
  busy: boolean;
  /** What the last attempt failed with, or null. */
  error: string | null;
}

let state: PushState = {
  supported: false,
  blocker: 'unsupported',
  subscribed: false,
  busy: false,
  error: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<PushState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the registration state, re-rendering on every change. */
export function usePush(): PushState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Whether this browser is running as an installed app.
 *
 * iOS exposes the Push API only to a page added to the Home Screen, and the
 * API is absent until then, with no way to ask whether installing would help.
 * So a browser missing it while running in a tab on a platform that has
 * service workers is told to install rather than told it cannot.
 */
function installed(): boolean {
  const legacy = (navigator as { standalone?: boolean }).standalone;
  return legacy === true || window.matchMedia('(display-mode: standalone)').matches;
}

/** What stops this browser from subscribing, or null. */
function blockerOf(): PushBlocker | null {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) {
    return installed() ? 'unsupported' : 'needs-install';
  }
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

/** base64url, for comparing a subscription's key against the deployment's. */
function b64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Whether a subscription was made against the key the deployment holds now.
 *
 * A deployment whose data volume was replaced generates a fresh keypair, and
 * every subscription made against the old one becomes undeliverable — the
 * push service rejects the assertion, and nothing about that reaches the
 * browser. Checking here is what makes that recoverable rather than a silent
 * end to notifications.
 */
function matchesDeployment(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  return key ? b64url(key) === publicKey : false;
}

/** The registered worker, registering it on first call. */
async function worker(): Promise<ServiceWorkerRegistration> {
  // Scope is the whole origin, which is why sw.js is served from the root
  // rather than from the hashed asset directory.
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * Registers the service worker, whatever push is doing.
 *
 * Not part of refreshPush, which returns before registering anything as soon
 * as it finds a blocker — and the blockers are the cases that need the worker
 * most. A browser whose user declined notifications would never register one,
 * and neither would an iPhone reading this in a tab, which is the browser
 * that has to install the app before it can subscribe at all. Installing is
 * the worker's other job: browsers that still gate the install offer on a
 * registered worker are asking at first load, long before anybody taps the
 * toggle.
 *
 * Resolves either way: nothing on the page depends on the outcome.
 */
export async function installWorker(): Promise<void> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  await worker().catch(() => undefined);
}

/**
 * Brings the store up to date, and re-registers a browser that is already
 * subscribed.
 *
 * The re-registration is not redundant: a push service may hand out a new
 * subscription at any time — Safari expires them on its own schedule — and
 * the orchestrator only learns about that from here. Posting the same
 * subscription twice is free, because the endpoint is the row's key.
 */
export async function refreshPush(): Promise<void> {
  const blocker = blockerOf();
  if (blocker) {
    set({ supported: false, blocker, subscribed: false });
    return;
  }
  set({ supported: true, blocker: null });

  try {
    const registration = await worker();
    let existing = await registration.pushManager.getSubscription();
    if (!existing) {
      set({ subscribed: false });
      return;
    }

    const { publicKey } = await api.pushKey();
    if (!matchesDeployment(existing, publicKey)) {
      // Made against a keypair this deployment no longer has. Permission is
      // already granted, so re-subscribing needs no gesture and no prompt.
      await api.unsubscribePush(existing.endpoint).catch(() => {});
      await existing.unsubscribe();
      existing = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
    }

    await api.subscribePush({
      ...(existing.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }),
      label: navigator.userAgent.slice(0, 100),
    });
    set({ subscribed: true, error: null });
  } catch (err) {
    set({ subscribed: false, error: (err as Error).message });
  }
}

/**
 * Subscribes this browser, asking for permission on the way.
 *
 * Called from a click and nowhere else: an unprompted permission request is
 * refused outright by some browsers and held against the origin by others.
 */
export async function enablePush(): Promise<void> {
  if (state.busy) return;
  set({ busy: true, error: null });
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') {
      // Only the user can undo this, in site settings, so the toggle stops
      // offering and says where to go instead.
      set({ supported: false, blocker: 'denied' });
      return;
    }
    if (permission !== 'granted') {
      // Dismissed rather than refused. Nothing has changed, and the toggle
      // stays exactly as it was so it can be tried again.
      return;
    }

    const registration = await worker();
    // The service worker has to be running before it can be subscribed for.
    await navigator.serviceWorker.ready;
    const { publicKey } = await api.pushKey();
    // Reuse what this browser already has, but only if it was made against
    // the key the deployment holds now; see matchesDeployment.
    const existing = await registration.pushManager.getSubscription();
    if (existing && !matchesDeployment(existing, publicKey)) await existing.unsubscribe();
    const subscription =
      existing && matchesDeployment(existing, publicKey)
        ? existing
        : await registration.pushManager.subscribe({
            // Required by Chrome: every push must show something. Which is
            // the intent here anyway — a silent push would be a tracking
            // channel.
            userVisibleOnly: true,
            applicationServerKey: publicKey,
          });

    await api.subscribePush({
      ...(subscription.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      }),
      label: navigator.userAgent.slice(0, 100),
    });
    set({ subscribed: true, supported: true, blocker: null });
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ busy: false });
  }
}

/**
 * Unsubscribes this browser, in the browser and in the orchestrator.
 *
 * The orchestrator is told first, because a subscription it still holds after
 * the browser dropped it is one it pushes to until a 410 comes back.
 */
export async function disablePush(): Promise<void> {
  if (state.busy) return;
  set({ busy: true, error: null });
  try {
    const registration = await worker();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api.unsubscribePush(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe();
    }
    set({ subscribed: false });
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ busy: false });
  }
}
