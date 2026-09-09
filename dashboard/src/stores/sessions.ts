import { useSyncExternalStore } from 'react';
import type { DeploymentImages, SessionSummary } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { pollWhileVisible } from '../lib/poll.ts';

/**
 * The session list every view reads, together with the deployment facts a
 * view has to warn about, kept fresh by polling.
 *
 * A plain module-level store with a subscriber set: React reads it through
 * useSyncExternalStore, and nothing outside this file needs a hook to change
 * it.
 */

/** What the views render. */
export interface SessionsState {
  sessions: SessionSummary[];
  /**
   * False once a probe has reported that the deployment holds no Claude
   * token. True to begin with, so a slow first answer shows no warning.
   */
  claudeTokenConfigured: boolean;
  /**
   * Which build of each of the deployment's images is running, all three null
   * until a probe has said otherwise.
   */
  images: DeploymentImages;
  /** The message from the last failed poll, or null. */
  error: string | null;
  /** True until the first poll has finished, however it went. */
  loading: boolean;
}

let state: SessionsState = {
  sessions: [],
  claudeTokenConfigured: true,
  images: { orchestrator: null, proxy: null, session: null },
  error: null,
  loading: true,
};
const listeners = new Set<() => void>();

/** Replaces the state and wakes every subscriber. */
function set(next: Partial<SessionsState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the polled session list, re-rendering on every change. */
export function useSessions(): SessionsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * What a failed list says, in the terms of the thing that went wrong.
 *
 * A request that never reached the server rejects with the browser's own
 * "Failed to fetch", which names neither what failed nor what happens next.
 * An answer the server did send is already a sentence, and is passed through.
 */
function reachable(error: Error): string {
  return error instanceof TypeError
    ? 'Could not reach Boxes. Still trying.'
    : error.message;
}

/**
 * Fetches the session list and the health probe once.
 *
 * The two are settled apart: a failed probe says nothing about the sessions,
 * and neither does a failed list say anything about the token, so one
 * failure never discards the other's answer.
 */
export async function refresh(): Promise<void> {
  const [list, health] = await Promise.allSettled([api.listSessions(), api.health()]);
  set({
    ...(list.status === 'fulfilled'
      ? { sessions: list.value, error: null }
      : { error: reachable(list.reason as Error) }),
    ...(health.status === 'fulfilled'
      ? {
          claudeTokenConfigured: health.value.claudeTokenConfigured,
          images: health.value.images,
        }
      : {}),
    loading: false,
  });
}

/** Time between polls, in milliseconds. */
const POLL_MS = 5000;

/** Polls for as long as the tab is visible, and returns the teardown. */
export function startPolling(): () => void {
  void refresh();
  return pollWhileVisible(() => void refresh(), POLL_MS);
}
