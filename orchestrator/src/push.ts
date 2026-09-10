import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as signWith,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';

/**
 * Web Push: the part of a notification that survives the app being closed.
 *
 * A browser subscribes with a push service of its vendor's choosing and hands
 * back an endpoint plus two keys. Posting an encrypted payload to that
 * endpoint wakes the service worker with no tab open.
 *
 * The crypto is RFC 8291 (`aes128gcm` payload encryption) over RFC 8188, and
 * the sender authenticates itself with RFC 8292 (VAPID). Both are implemented
 * here on `node:crypto`, against the published test vectors.
 */

/** One browser's subscription, as the Push API hands it to the page. */
export interface PushSubscription {
  /** The push service URL to POST to. Opaque, and unique per subscription. */
  endpoint: string;
  /** The subscriber's public key, uncompressed P-256, base64url. */
  p256dh: string;
  /** The subscriber's authentication secret, 16 bytes, base64url. */
  auth: string;
}

/** The deployment's VAPID identity, base64url over the raw key material. */
export interface VapidKeys {
  /** Uncompressed P-256 point, 65 bytes. Handed to the browser verbatim. */
  publicKey: string;
  /** The scalar, 32 bytes. Never leaves the orchestrator. */
  privateKey: string;
}

/** Record size the payload is written with; every message here fits one. */
const RECORD_SIZE = 4096;

/** How long a push service should hold an undelivered message, in seconds. */
const DEFAULT_TTL = 12 * 60 * 60;

/**
 * How long one delivery attempt may take, in milliseconds.
 *
 * `fetch` has no timeout of its own, and the caller pushes to every
 * subscribed browser at once and awaits all of them, so one push service that
 * accepted a connection and went quiet would hold that fan-out open. The next
 * event pushes again.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Lifetime of a VAPID assertion. Well under the 24h RFC 8292 allows. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

/** Filename under DATA_DIR holding the generated keypair. */
const KEY_FILE = 'vapid-keys.json';

/** Base64url of raw bytes, which is how every key and salt here travels. */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** The bytes behind a base64url string. */
function unb64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** HKDF-SHA256 over Node's one-shot, as a Buffer. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** A fresh P-256 keypair, in the raw form both halves of this file want. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    // A scalar with leading zero bytes is returned short; every consumer of
    // it expects exactly 32, so it is padded rather than passed on as-is.
    privateKey: b64url(pad32(ecdh.getPrivateKey())),
  };
}

/** Left-pads a scalar to the 32 bytes P-256 uses. */
function pad32(scalar: Buffer): Buffer {
  if (scalar.length >= 32) return scalar;
  return Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
}

/**
 * The deployment's keypair, generated once and kept in the data volume.
 *
 * A keypair regenerated on every boot would invalidate every subscription
 * anybody has made.
 */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, KEY_FILE);
  if (existsSync(path)) {
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<VapidKeys>;
      if (
        typeof stored.publicKey === 'string' &&
        typeof stored.privateKey === 'string' &&
        unb64url(stored.publicKey).length === 65 &&
        unb64url(stored.privateKey).length === 32
      ) {
        return { publicKey: stored.publicKey, privateKey: stored.privateKey };
      }
      log.warn('stored VAPID keys are malformed; generating a replacement', { path });
    } catch (err) {
      log.warn('could not read the stored VAPID keys; generating a replacement', {
        path,
        error: (err as Error).message,
      });
    }
  }

  const keys = generateVapidKeys();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file, so a
  // replaced malformed file keeps its old mode without this.
  chmodSync(path, 0o600);
  log.info('generated a VAPID keypair for this deployment', { path });
  return keys;
}

// --- RFC 8291 payload encryption -------------------------------------------

/**
 * Encrypts one push message for one subscriber, producing a whole
 * `aes128gcm` body: header, then a single record.
 *
 * `salt` and `senderKeys` exist so the test can pin the random inputs to the
 * RFC's own; nothing else passes them.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscriberKey: Buffer,
  authSecret: Buffer,
  salt: Buffer = randomBytes(16),
  senderKeys: VapidKeys = generateVapidKeys(),
): Buffer {
  const senderPublic = unb64url(senderKeys.publicKey);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(unb64url(senderKeys.privateKey));
  const shared = ecdh.computeSecret(subscriberKey);

  // The two public keys go into the info in receiver-then-sender order, which
  // is what binds the derived key to this exact pair.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    subscriberKey,
    senderPublic,
  ]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 0x02 is the delimiter for the last record. There is only ever one here:
  // these messages are a couple of hundred bytes against a 4096-byte record.
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}

// --- RFC 8292 VAPID --------------------------------------------------------

/** The `aud` of a VAPID assertion: the push service's own origin. */
function audienceOf(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * The Authorization header proving this deployment sent the message.
 *
 * `subject` identifies whoever operates the deployment, so a push service
 * with a problem has somebody to contact; the RFC requires a mailto: or an
 * https: URL.
 */
export function vapidHeader(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audienceOf(endpoint),
        exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
        sub: subject,
      }),
      'utf8',
    ),
  );
  const signingInput = Buffer.from(`${header}.${claims}`, 'utf8');

  const publicKey = unb64url(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(publicKey.subarray(1, 33)),
      y: b64url(publicKey.subarray(33, 65)),
    },
    format: 'jwk',
  });
  // JWS wants the raw r||s pair, not the DER sequence Node signs with by
  // default.
  const signature = signWith('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' });

  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

// --- sending ---------------------------------------------------------------

/** What one delivery attempt did, as the caller needs to see it. */
export interface PushResult {
  ok: boolean;
  /** HTTP status from the push service, or 0 when it could not be reached. */
  status: number;
  /**
   * True when the push service says this subscription is finished — 404 for
   * an endpoint it never had, 410 for one the browser has dropped. Either way
   * it is dead for good and the row should go.
   */
  gone: boolean;
  /** Why the attempt failed, or null. Never carries the payload. */
  error: string | null;
}

/**
 * Posts one encrypted message to one push service.
 *
 * Never throws: a push service that is down, slow or hostile is not something
 * a permission request should be held up by, so every failure comes back as a
 * result the caller can log and move past.
 */
export async function sendPush(
  subscription: PushSubscription,
  payload: string,
  keys: VapidKeys,
  subject: string,
  ttl: number = DEFAULT_TTL,
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPayload(
      Buffer.from(payload, 'utf8'),
      unb64url(subscription.p256dh),
      unb64url(subscription.auth),
    );
  } catch (err) {
    // Malformed keys on the subscription row: it will never work, so it is
    // gone in the same sense a 410 is.
    return { ok: false, status: 0, gone: true, error: (err as Error).message };
  }

  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(subscription.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: res.ok ? null : `push service answered ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: (err as Error).message };
  }
}
