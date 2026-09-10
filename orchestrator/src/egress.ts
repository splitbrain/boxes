import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import type {
  EgressCredential,
  EgressHealth,
  EgressPolicy,
  EgressStatus,
} from '../../shared/types.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';

/**
 * The orchestrator's half of token translation: what the proxy is told, and
 * the key material that has to outlive a restart.
 *
 * Real credentials come from the environment and never leave this process
 * except over the control channel, into the proxy's memory. A session is given
 * a placeholder in their place, so nothing inside a session container is worth
 * stealing.
 *
 * Two pieces of material must survive a restart, because running sessions hold
 * them in their environment and trust store: the CA the proxy mints
 * interception certificates from, and the placeholders themselves. They live
 * beside the generated WebSocket token, on the orchestrator's own data volume,
 * and are never handed to the proxy as a file.
 */

/** Filename under DATA_DIR holding the CA and the placeholders. */
const MATERIAL_FILE = 'egress-secrets.json';

/** Random bytes in a generated placeholder, before its prefix. */
const PLACEHOLDER_BYTES = 24;

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/** Everything generated once and then reused for the life of a deployment. */
export interface EgressMaterial {
  /** The deployment CA. Its certificate is public; its key is not. */
  ca: { key: string; cert: string };
  /** One placeholder per credential id. Worth nothing on their own. */
  placeholders: Record<string, string>;
  /** Bearer the orchestrator authenticates its pushes with. */
  controlToken: string;
}

/** A placeholder shaped like the credential it stands in for. */
function generatePlaceholder(prefix: string): string {
  return `${prefix}${randomBytes(PLACEHOLDER_BYTES).toString('base64url')}`;
}

/**
 * Loads the deployment's egress material, generating and storing whatever is
 * missing.
 *
 * A running session holds this CA's certificate in the trust file its tools
 * were pointed at, so a CA regenerated on every boot would break TLS against
 * every intercepted host. Rotating it means deleting this file.
 */
export async function resolveEgressMaterial(
  dataDir: string,
  credentials: readonly { id: string; placeholderPrefix: string }[],
): Promise<EgressMaterial> {
  const path = join(dataDir, MATERIAL_FILE);

  let stored: Partial<EgressMaterial> = {};
  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<EgressMaterial>;
    } catch (err) {
      log.warn('stored egress material is unreadable; generating a replacement', {
        path,
        error: (err as Error).message,
      });
    }
  }

  let changed = false;

  let ca = stored.ca;
  if (!ca?.key || !ca?.cert) {
    // Generated with the engine's own helper, so the key the proxy signs
    // interception certificates with is one it is guaranteed to accept.
    ca = await generateCACertificate({ subject: { commonName: 'Boxes egress proxy CA' } });
    changed = true;
    log.info('generated an egress CA for this deployment', { path });
  }

  // Placeholders are per deployment rather than per session, so the policy
  // does not change as sessions come and go.
  const placeholders: Record<string, string> = { ...stored.placeholders };
  for (const { id, placeholderPrefix } of credentials) {
    if (placeholders[id]) continue;
    placeholders[id] = generatePlaceholder(placeholderPrefix);
    changed = true;
  }

  const controlToken = stored.controlToken || randomBytes(32).toString('hex');
  if (controlToken !== stored.controlToken) changed = true;

  const material: EgressMaterial = { ca, placeholders, controlToken };
  if (changed) writeMaterial(dataDir, material);
  return material;
}

/** Writes the material back, readable only by the orchestrator. */
function writeMaterial(dataDir: string, material: EgressMaterial): void {
  const path = join(dataDir, MATERIAL_FILE);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(material, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file, so a
  // rewritten file keeps its old mode without this.
  chmodSync(path, 0o600);
}

/**
 * Builds the policy the proxy runs, from the environment and the stored
 * material. It is static per deployment: composed once at boot and re-pushed
 * unchanged, because nothing about it varies per session.
 */
export function composePolicy(cfg: Config, material: EgressMaterial): EgressPolicy {
  const credentials: EgressCredential[] = cfg.egressCredentials.map((spec) => {
    const placeholder = material.placeholders[spec.id];
    if (!placeholder) {
      throw new Error(`no placeholder was generated for the ${spec.id} credential`);
    }
    return {
      id: spec.id,
      hosts: [...spec.hosts],
      headers: [...spec.headers],
      placeholder,
      secret: spec.secret,
    };
  });

  // A configured credential's own hosts are implied by the proxy; the hosts
  // its tools merely need are added here, so a narrow allowlist cannot break
  // an OAuth refresh or a tarball download.
  const implied = cfg.egressCredentials.flatMap((spec) => [...spec.alsoAllow]);
  const allowedHosts =
    cfg.egressAllowedHosts.length === 0
      ? []
      : [...new Set([...cfg.egressAllowedHosts, ...implied])];

  return {
    allowedHosts,
    ca: credentials.length > 0 ? material.ca : null,
    credentials,
  };
}

/** Pushes a policy to the proxy and returns what it reports back. */
export async function pushPolicy(
  cfg: Config,
  material: EgressMaterial,
  policy: EgressPolicy,
): Promise<EgressStatus> {
  return controlCall(cfg, material, 'POST', '/policy', policy);
}

/** Reads the proxy's current status without changing anything. */
export async function readStatus(
  cfg: Config,
  material: EgressMaterial,
): Promise<EgressStatus> {
  return controlCall(cfg, material, 'GET', '/status');
}

/** One authenticated call on the control channel. */
async function controlCall(
  cfg: Config,
  material: EgressMaterial,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<EgressStatus> {
  const url = `http://${cfg.EGRESS_PROXY_CONTAINER}:${cfg.EGRESS_CONTROL_PORT}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${material.controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    const detail = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        return text;
      }
    })();
    throw new Error(`proxy answered ${res.status}: ${detail.trim()}`);
  }
  return JSON.parse(text) as EgressStatus;
}

/**
 * Owns the composed policy and keeps the proxy holding it.
 *
 * The proxy has nothing at rest, so a restart leaves it with no policy at
 * all. Re-pushing on every reconcile tick closes that window, so the push is
 * cheap and idempotent.
 */
export class EgressManager {
  private material: EgressMaterial | null = null;
  private composed: EgressPolicy | null = null;
  private health: EgressHealth | null = null;

  constructor(private readonly cfg: Config) {}

  /** Loads the material and composes the policy, without talking to the proxy. */
  async prepare(): Promise<void> {
    this.material = await resolveEgressMaterial(this.cfg.DATA_DIR, this.cfg.egressCredentials);
    this.composed = composePolicy(this.cfg, this.material);
  }

  /** The CA certificate a session is given to trust. Public, never the key. */
  caCertificate(): string {
    const { material, composed } = this.prepared();
    return composed.ca ? material.ca.cert : '';
  }

  /**
   * The prepared state, or a refusal.
   *
   * Every caller here decides what a session container will hold. An
   * unprepared manager that fell back to the real credential would put it
   * inside the sandbox, so this refuses instead.
   */
  private prepared(): { material: EgressMaterial; composed: EgressPolicy } {
    if (!this.material || !this.composed) {
      throw new Error('the egress policy has not been prepared yet');
    }
    return { material: this.material, composed: this.composed };
  }

  /**
   * What a session is given in place of a credential: the placeholder when
   * this deployment translates that credential, and the value itself when it
   * does not.
   *
   * The swap is keyed on the secret matching, not just on the credential being
   * configured, so a profile carrying some other token is handed its own value
   * rather than a placeholder the proxy would refuse to translate.
   */
  sessionValue(id: string, real: string): string {
    if (real === '') return '';
    const { composed } = this.prepared();
    const credential = composed.credentials.find((c) => c.id === id);
    return credential?.secret === real ? credential.placeholder : real;
  }

  /** The last thing the proxy reported, for /healthz. */
  status(): EgressHealth | null {
    return this.health;
  }

  /** Pushes the composed policy and records what came back. */
  async sync(): Promise<void> {
    if (!this.material || !this.composed) await this.prepare();
    const { material, composed } = this.prepared();

    try {
      const status = await pushPolicy(this.cfg, material, composed);
      this.health = {
        inSync: status.applied,
        allowlistActive: composed.allowedHosts.length > 0,
        credentialIds: status.credentialIds,
        denials: status.denials,
        error: null,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.health = {
        inSync: false,
        allowlistActive: composed.allowedHosts.length > 0,
        credentialIds: [],
        denials: this.health?.denials ?? {},
        error: message,
      };
      throw err;
    }
  }
}
