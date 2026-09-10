import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';

/**
 * Resolution of the gateway's WebSocket auth token.
 *
 * An unset WS_AUTH_TOKEN means the deployment generates its own. The
 * generated value lives in the data volume, so it survives restarts and
 * rebuilds, and that file is the only place the token is written.
 */

/** Filename under DATA_DIR holding the generated token. */
const TOKEN_FILE = 'ws-auth-token';

/** Shortest token accepted, configured or generated. */
const MIN_LENGTH = 32;

/**
 * Returns the token for this deployment. A configured token wins and must be
 * at least MIN_LENGTH characters; otherwise the token stored under dataDir is
 * reused, or a fresh one is generated and stored there.
 */
export function resolveWsAuthToken(dataDir: string, configured: string): string {
  if (configured) {
    if (configured.length < MIN_LENGTH) {
      throw new Error(
        `WS_AUTH_TOKEN must be at least ${MIN_LENGTH} characters; ` +
          'leave it unset to have one generated instead',
      );
    }
    return configured;
  }

  const path = join(dataDir, TOKEN_FILE);
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored.length >= MIN_LENGTH) return stored;
    log.warn('stored WS auth token is too short; generating a replacement', { path });
  }

  const token = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file, so a
  // replaced short-token file keeps its old mode.
  chmodSync(path, 0o600);
  log.info('generated a WebSocket auth token for this deployment', { path });
  return token;
}
