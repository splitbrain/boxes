import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import type {
  EgressCredential,
  EgressHealth,
  EgressPolicy,
  EgressStatus,
} from '../../shared/types.ts';
import type { Config } from './config.ts';
import { deliverableSecret, type CredentialRow, type CredentialStore } from './credentials.ts';
import { log } from './log.ts';
import { writeSecretFile } from './secret.ts';

/** The orchestrator side of the egress proxy: its policy and key material. */

/** Filename under DATA_DIR holding the CA, the placeholders and the control token. */
const MATERIAL_FILE = 'egress-secrets.json';

/** Random bytes in a generated placeholder, before its prefix. */
const PLACEHOLDER_BYTES = 24;

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/**
 * Everything generated once and then reused for the life of a deployment.
 * Running boxes hold the CA and the placeholders, so both must survive a
 * restart.
 */
export interface EgressMaterial {
  /** The deployment CA. Its certificate is public; its key is not. */
  ca: { key: string; cert: string };
  /** One placeholder per credential id. Worth nothing on their own. */
  placeholders: Record<string, string>;
  /** Bearer the orchestrator authenticates its pushes with. */
  controlToken: string;
}

/** Returns a new placeholder that starts with the credential's own prefix. */
function generatePlaceholder(prefix: string): string {
  return `${prefix}${randomBytes(PLACEHOLDER_BYTES).toString('base64url')}`;
}

/**
 * Loads the deployment's egress material, generating and storing whatever is
 * missing.
 *
 * Running boxes trust this CA, so it is kept across boots. Deleting the file
 * rotates it.
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
    // The proxy's own library generates it, so the proxy accepts the key.
    ca = await generateCACertificate({ subject: { commonName: 'Boxes egress proxy CA' } });
    changed = true;
    log.info('generated an egress CA for this deployment', { path });
  }

  // Placeholders are per deployment rather than per box, so the policy
  // does not change as boxes come and go.
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

/** Writes the material to MATERIAL_FILE, readable only by the orchestrator. */
function writeMaterial(dataDir: string, material: EgressMaterial): void {
  writeSecretFile(join(dataDir, MATERIAL_FILE), `${JSON.stringify(material, null, 2)}\n`);
}

/**
 * Builds the policy the proxy runs, from the deployment's settings, the
 * stored material and the current rows of the credential store.
 *
 * The policy always carries the CA, as boxes created before the first
 * credential already trust it. A host is only intercepted while its
 * credential has a deliverable secret.
 */
export function composePolicy(
  cfg: Config,
  material: EgressMaterial,
  stored: readonly CredentialRow[],
): EgressPolicy {
  // A credential with no deliverable secret counts as absent.
  const secrets = new Map(stored.map((row) => [row.id, deliverableSecret(row) ?? '']));
  const configured = cfg.credentialSet.filter((spec) => (secrets.get(spec.id) ?? '') !== '');

  const credentials: EgressCredential[] = configured.map((spec) => {
    const placeholder = material.placeholders[spec.id];
    if (!placeholder) {
      throw new Error(`no placeholder was generated for the ${spec.id} credential`);
    }
    return {
      id: spec.id,
      hosts: [...spec.hosts],
      headers: [...spec.headers],
      ...(spec.passthroughSchemes ? { passthroughSchemes: [...spec.passthroughSchemes] } : {}),
      placeholder,
      secret: secrets.get(spec.id) ?? '',
    };
  });

  // The proxy allows a credential's own hosts. The other hosts its tools
  // need are added here, so an allowlist cannot break an OAuth refresh.
  const implied = configured.flatMap((spec) => [...spec.alsoAllow]);
  const allowedHosts =
    cfg.egressAllowedHosts.length === 0
      ? []
      : [...new Set([...cfg.egressAllowedHosts, ...implied])];

  return {
    allowedHosts,
    ca: material.ca,
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

/**
 * The proxy's own hostname on the control channel: a Docker container name
 * resolved by the daemon's embedded DNS, or the egress proxy's cluster
 * Service under Kubernetes, where there is no shared bridge network for a
 * bare container name to resolve on.
 */
function egressProxyHost(cfg: Config): string {
  return cfg.RUNTIME === 'kubernetes'
    ? `${cfg.K8S_EGRESS_PROXY_SERVICE}.${cfg.K8S_NAMESPACE}.svc.cluster.local`
    : cfg.EGRESS_PROXY_CONTAINER;
}

/** One authenticated call on the control channel, returning the proxy's status. */
async function controlCall(
  cfg: Config,
  material: EgressMaterial,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<EgressStatus> {
  const url = `http://${egressProxyHost(cfg)}:${cfg.EGRESS_CONTROL_PORT}${path}`;
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
 * Real credentials leave this process only over the control channel, into
 * the proxy's memory. A proxy restart loses the policy, and the push is
 * idempotent, so the reconciler pushes it again on every tick.
 */
export class EgressManager {
  /** The loaded material, or null before prepare(). */
  private material: EgressMaterial | null = null;
  /** The last composed policy, or null before prepare(). */
  private composed: EgressPolicy | null = null;
  /** What the last push reported, or null before the first. */
  private health: EgressHealth | null = null;

  constructor(
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /**
     * Where the secrets come from. The manager only reads it, on every
     * compose.
     */
    private readonly credentials: CredentialStore,
  ) {}

  /** Loads the material and composes the policy, without talking to the proxy. */
  async prepare(): Promise<void> {
    // Every credential in the set gets a placeholder, configured or not. A
    // box's environment is fixed at creation, and a later credential must
    // still reach it.
    this.material = await resolveEgressMaterial(this.cfg.DATA_DIR, this.cfg.credentialSet);
    this.composed = composePolicy(this.cfg, this.material, this.credentials.list());
  }

  /** The CA certificate a box is given to trust. Public, never the key. */
  caCertificate(): string {
    return this.prepared().material.ca.cert;
  }

  /**
   * The prepared state. Throws before prepare(), so no box is built without
   * the placeholders and the CA.
   */
  private prepared(): { material: EgressMaterial; composed: EgressPolicy } {
    if (!this.material || !this.composed) {
      throw new Error('the egress policy has not been prepared yet');
    }
    return { material: this.material, composed: this.composed };
  }

  /**
   * What a box holds in place of a credential, whether or not the credential
   * is stored yet. A box created today then works with a token entered
   * tomorrow.
   *
   * A credential outside the deployment's set has no placeholder. The empty
   * string then drops the variable from the box's environment.
   */
  placeholderFor(id: string): string {
    return this.prepared().material.placeholders[id] ?? '';
  }

  /** The last thing the proxy reported, for /healthz. */
  status(): EgressHealth | null {
    return this.health;
  }

  /**
   * Recomposes the policy from the store, pushes it, and records what the
   * proxy reported. Every store write and every reconciler tick calls it.
   */
  async sync(): Promise<void> {
    if (!this.material) await this.prepare();
    const material = this.prepared().material;
    const composed = composePolicy(this.cfg, material, this.credentials.list());
    this.composed = composed;

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
