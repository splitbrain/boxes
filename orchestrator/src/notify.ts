import type { Config } from './config.ts';
import {
  deletePushSubscription,
  listPushSubscriptions,
  touchPushSubscription,
  type Db,
} from './db.ts';
import { log } from './log.ts';
import { loadVapidKeys, sendPush, type VapidKeys } from './push.ts';

/**
 * The one place that says "something needs you".
 *
 * One channel: Web Push, which reaches every browser that subscribed,
 * including ones with no tab open.
 *
 * Every send is fire-and-forget. A turn that is waiting on a human must not
 * also be waiting on a push service, so nothing here is ever awaited by the
 * gateway and nothing here throws.
 */

/** What happened, which picks the wording. */
export type NotifyKind = 'approval' | 'idle';

/** One thing worth interrupting somebody for. */
export interface NotifyEvent {
  kind: NotifyKind;
  sessionId: string;
  sessionName: string;
  /** The dashboard's own thread id, so the notification can link at it. */
  threadId: string | null;
  /** What that conversation is called, or null for an untitled one. */
  threadName: string | null;
  /**
   * Whether that conversation still has work running in it, for an event that
   * knows.
   *
   * This thread's own work: another conversation in the same box having a
   * build running says nothing about whether this one is finished.
   */
  background?: boolean;
}

/** The JSON a service worker receives. */
interface PushPayload {
  title: string;
  body: string;
  /**
   * Replaces an earlier notification with the same tag rather than stacking
   * on it, so a thread that asks twice does not leave two to dismiss.
   */
  tag: string;
  /** Where a tap goes, relative to the dashboard's own origin. */
  url: string;
}

/**
 * Title and body for one event.
 *
 * Exported so a test can read it: the payload is encrypted end to end, so
 * what a notification says cannot be checked on the wire.
 */
export function wording(event: NotifyEvent): { title: string; body: string } {
  const where = event.threadName
    ? `${event.sessionName} · ${event.threadName}`
    : event.sessionName;
  if (event.kind === 'approval') {
    return {
      title: 'Boxes: approval needed',
      body: `${where} is waiting for a permission decision.`,
    };
  }
  // That something is running, rather than what: a lock screen is not the
  // place to read a command line.
  const still = event.background ? ' Something is still running.' : '';
  return {
    title: 'Boxes: waiting for you',
    body: `${where} has stopped and is waiting for input.${still}`,
  };
}

/** Where a notification about this event points. */
function target(event: NotifyEvent): string {
  return event.threadId
    ? `/sessions/${event.sessionId}/threads/${event.threadId}`
    : `/sessions/${event.sessionId}`;
}

/** Sends one event to every subscribed browser. */
export class Notifier {
  private keys: VapidKeys | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  /**
   * The deployment's VAPID public key, which a browser needs before it can
   * subscribe at all.
   *
   * Generated on first read rather than at boot, so a deployment nobody
   * subscribes from never writes a keypair to its data volume.
   */
  get publicKey(): string {
    return this.vapid().publicKey;
  }

  /** The keypair, loaded or generated on first use. */
  private vapid(): VapidKeys {
    if (!this.keys) this.keys = loadVapidKeys(this.cfg.DATA_DIR);
    return this.keys;
  }

  /**
   * Sends one event.
   *
   * Returns a promise so a test can wait for it, but no caller in the gateway
   * awaits it: a turn already waiting on a human must not also wait on a push
   * service. Every failure inside is logged and swallowed.
   *
   * Swallowed here because the callers discard this promise, and a rejection
   * nobody is holding would take the orchestrator down. `sendPush` answers
   * with a result rather than throwing, but reading the subscriptions,
   * generating the keypair and pruning a dead row can all fail.
   */
  async notify(event: NotifyEvent): Promise<void> {
    try {
      await this.push(event);
    } catch (err) {
      log.warn('could not notify anybody about a session event', {
        kind: event.kind,
        session: event.sessionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Pushes to every subscribed browser, dropping the ones the push service
   * reports as finished.
   *
   * A dead subscription is the normal end of one — the browser was
   * uninstalled, the permission revoked, Safari expired it — so pruning on a
   * 404 or 410 is ordinary housekeeping rather than an error path.
   */
  private async push(event: NotifyEvent): Promise<void> {
    const subscriptions = listPushSubscriptions(this.db);
    if (subscriptions.length === 0) return;

    const { title, body } = wording(event);
    const payload: PushPayload = {
      title,
      body,
      tag: `${event.threadId ?? event.sessionId}:${event.kind}`,
      url: target(event),
    };
    const message = JSON.stringify(payload);
    const keys = this.vapid();

    await Promise.all(
      subscriptions.map(async (row) => {
        const result = await sendPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          message,
          keys,
          this.cfg.PUSH_SUBJECT,
        );
        if (result.ok) {
          touchPushSubscription(this.db, row.endpoint);
          return;
        }
        if (result.gone) {
          deletePushSubscription(this.db, row.endpoint);
          log.info('dropped a finished push subscription', {
            status: result.status,
            endpoint: originOf(row.endpoint),
          });
          return;
        }
        log.warn('push notification failed', {
          status: result.status,
          endpoint: originOf(row.endpoint),
          error: result.error,
        });
      }),
    );
  }
}

/**
 * The push service an endpoint belongs to, for the log. The path is a
 * capability — anyone holding it can push to that browser — so it never
 * reaches a log line.
 */
function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unparseable';
  }
}
