/** The orchestrator side of the egress proxy: its policy and key material. */

import { randomBytes } from 'node:crypto';
import { generateCACertificate } from 'mockttp';
import type {
  EgressBoxPolicy,
  EgressCredential,
  EgressDenial,
  EgressHealth,
  EgressPolicy,
  EgressPushAnswer,
  EgressRefusedToken,
  EgressUpstreamCa,
} from '../../shared/types.ts';
import type { ApiKeyRow, ApiKeyStore } from './api-keys.ts';
import type { Config } from './config.ts';
import {
  type CredentialId,
  type CredentialMethod,
  type CredentialRow,
  type CredentialStore,
  deliverableSecret,
} from './credentials.ts';
import { type Db, readAppKey, writeAppKey } from './db.ts';
import { log } from './log.ts';
import type { McpSecretEntry } from './mcp-secrets.ts';
import { mcpHostPattern } from './mcp-servers.ts';
import type { UpstreamCaRow } from './upstream-cas.ts';

/** The app key under which the CA and the control token are stored. */
const APP_KEY = 'egress';

/** How long a control-channel call may take, in milliseconds. */
const CONTROL_TIMEOUT_MS = 5_000;

/**
 * Everything generated once and then reused for the life of a deployment.
 * Running boxes trust the CA, so it must survive a restart.
 */
export interface EgressMaterial {
  /** The deployment CA. The certificate is public, and the key is secret. */
  ca: { key: string; cert: string };
  /** The bearer token that authenticates the calls of the orchestrator on the control channel. */
  controlToken: string;
}

/**
 * Loads the deployment's egress material, generating and storing it on first
 * use. Deleting the row rotates it.
 *
 * @param db The database that holds the material.
 * @returns The material.
 */
export async function resolveEgressMaterial(db: Db): Promise<EgressMaterial> {
  const stored = readAppKey<EgressMaterial>(db, APP_KEY);
  if (stored) return stored;

  // The proxy's own library generates it, so the proxy accepts the key.
  const ca = await generateCACertificate({ subject: { commonName: 'Boxes egress proxy CA' } });
  const material: EgressMaterial = { ca, controlToken: randomBytes(32).toString('hex') };
  writeAppKey(db, APP_KEY, material);
  log.info('generated an egress CA for this deployment');
  return material;
}

/** The facts of one box that the policy of the box needs. */
export interface EgressBoxInput {
  /** The id of the box. */
  id: string;
  /** The owner of the box. */
  owner: string;
  /** The token of the box at the proxy. */
  token: string;
  /** The mode of the egress profile of the box. */
  open: boolean;
  /** The host patterns of the egress profile of the box. */
  hosts: readonly string[];
  /** The host patterns of the MCP servers of the box. */
  mcpHosts: readonly string[];
}

/**
 * Gives the id of a credential in the policy. The owner is the prefix, because
 * the ids must be unique and each user can store each credential. The empty
 * user has no prefix.
 *
 * @param owner The owner of the credential.
 * @param id The id of the credential for its owner.
 * @returns The id in the policy.
 */
export function policyId(owner: string, id: string): string {
  return owner === '' ? id : `${owner}/${id}`;
}

/**
 * Gives the id of an API key in the policy.
 *
 * @param key The API key.
 * @returns The id in the policy.
 */
function apiKeyPolicyId(key: ApiKeyRow): string {
  return `api-key:${policyId(key.owner, key.name)}`;
}

/**
 * Gives the id of a secret row of an MCP server in the policy.
 *
 * @param row The secret row.
 * @returns The id in the policy.
 */
export function mcpPolicyId(row: McpSecretEntry): string {
  return policyId(row.owner, `mcp/${row.set_id}/${row.server}/${row.header}`);
}

/** A refused OAuth token that the proxy reported, with its secret row. */
export interface RefusedMcpToken {
  /** The secret row of the token. */
  row: McpSecretEntry;
  /** The report of the proxy. */
  refusal: EgressRefusedToken;
}

/**
 * Builds the policy that the proxy runs, for every user and every box.
 *
 * The policy always carries the CA, as boxes created before the first
 * credential already trust it. The proxy intercepts a host while a credential
 * for it has a deliverable secret, and for the boxes of a user with an
 * upstream CA for the host. One host can have a credential
 * of each user. The proxy selects the credential whose placeholder is in the
 * request. An API key names no header, so the proxy swaps it in whatever
 * header carries its placeholder. A secret of an MCP server names its header
 * and the host of its server.
 *
 * A box can always reach the hosts of the credentials with a deliverable
 * secret and of the API keys of its owner, the other hosts that the tools of
 * these credentials need, and the hosts of its MCP servers. The egress profile
 * of the box adds its mode and its own hosts. Each box gets the upstream CAs
 * of its owner.
 *
 * @param cfg The configuration of the deployment.
 * @param material The CA and the control token.
 * @param stored The rows of the credential store.
 * @param apiKeys The rows of the API key store.
 * @param boxes The boxes that are not deleted.
 * @param mcpSecrets The secret rows of the MCP servers.
 * @param upstreamCas The rows of the upstream CA store.
 * @returns The policy for the proxy.
 */
export function composePolicy(
  cfg: Config,
  material: EgressMaterial,
  stored: readonly CredentialRow[],
  apiKeys: readonly ApiKeyRow[],
  boxes: readonly EgressBoxInput[],
  mcpSecrets: readonly McpSecretEntry[] = [],
  upstreamCas: readonly UpstreamCaRow[] = [],
): EgressPolicy {
  const credentials: EgressCredential[] = [];
  const ownerHosts = new Map<string, string[]>();
  const addOwnerHosts = (owner: string, hosts: readonly string[]): void => {
    ownerHosts.set(owner, [...(ownerHosts.get(owner) ?? []), ...hosts]);
  };
  for (const spec of cfg.credentialSet) {
    for (const row of stored) {
      // A credential with no deliverable secret counts as absent.
      const secret = row.id === spec.id ? deliverableSecret(row) : null;
      if (!secret) continue;
      // The other hosts of the tools are allowed too, so an OAuth refresh works in a closed profile.
      addOwnerHosts(row.owner, [...spec.hosts, ...spec.alsoAllow]);
      credentials.push({
        id: policyId(row.owner, spec.id),
        hosts: [...spec.hosts],
        headers: [...spec.headers],
        placeholder: row.placeholder,
        secret,
      });
    }
  }
  for (const key of apiKeys) {
    addOwnerHosts(key.owner, key.hosts);
    credentials.push({
      id: apiKeyPolicyId(key),
      hosts: [...key.hosts],
      headers: [],
      placeholder: key.placeholder,
      secret: key.secret,
    });
  }
  for (const row of mcpSecrets) {
    const host = mcpHostPattern(row.url);
    if (row.secret === '' || host === null) continue;
    credentials.push({
      id: mcpPolicyId(row),
      hosts: [host],
      headers: [row.header],
      placeholder: row.placeholder,
      secret: row.secret,
      ...(row.auth === 'oauth' ? { oauth: true } : {}),
    });
  }

  const ownerCas = new Map<string, EgressUpstreamCa[]>();
  for (const row of upstreamCas) {
    ownerCas.set(row.owner, [
      ...(ownerCas.get(row.owner) ?? []),
      { host: row.host, cert: row.cert },
    ]);
  }

  const boxPolicies = boxes.map(
    (box): EgressBoxPolicy => ({
      box: box.id,
      token: box.token,
      open: box.open,
      hosts: [...new Set([...box.hosts, ...(ownerHosts.get(box.owner) ?? []), ...box.mcpHosts])],
      ...(ownerCas.has(box.owner) ? { upstreamCas: ownerCas.get(box.owner) } : {}),
    }),
  );

  return {
    boxes: boxPolicies,
    ca: material.ca,
    credentials,
  };
}

/**
 * Pushes a policy to the proxy.
 *
 * @param cfg The configuration of the deployment, with the URL of the control channel.
 * @param material The material with the control token.
 * @param policy The policy to push.
 * @returns The status that the proxy reports back, with the refused OAuth tokens since the last push.
 * @throws Error When the call fails or the proxy answers with an error status.
 */
export async function pushPolicy(
  cfg: Config,
  material: EgressMaterial,
  policy: EgressPolicy,
): Promise<EgressPushAnswer> {
  return controlCall<EgressPushAnswer>(cfg, material, 'POST', '/policy', policy);
}

/**
 * Reads the targets that the egress profile of a box refused.
 *
 * @param cfg The configuration of the deployment, with the URL of the control channel.
 * @param material The material with the control token.
 * @param box The id of the box.
 * @returns The refused targets, the most recent first.
 * @throws Error When the call fails or the proxy answers with an error status.
 */
export async function fetchDenials(
  cfg: Config,
  material: EgressMaterial,
  box: string,
): Promise<EgressDenial[]> {
  return controlCall(cfg, material, 'GET', `/denials?box=${encodeURIComponent(box)}`);
}

/**
 * Makes one authenticated call on the control channel.
 *
 * @param cfg The configuration of the deployment, with the URL of the control channel.
 * @param material The material with the control token.
 * @param method The HTTP method.
 * @param path The path on the control channel.
 * @param body The JSON body, or undefined for a call without a body.
 * @returns The decoded JSON answer of the proxy.
 * @throws Error When the call fails, times out after CONTROL_TIMEOUT_MS, or the proxy answers with an error status.
 */
async function controlCall<T>(
  cfg: Config,
  material: EgressMaterial,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, cfg.EGRESS_CONTROL_URL);
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
  return JSON.parse(text) as T;
}

/**
 * The owner of the composed egress policy, which it pushes to the proxy.
 *
 * Real credentials leave this process only over the control channel, into
 * the proxy's memory. A proxy restart loses the policy, and the push is
 * idempotent, so the reconciler pushes it again on every tick.
 */
export class EgressManager {
  /** The loaded material, or null before prepare(). */
  private material: EgressMaterial | null = null;
  /** The health that the last push reported, or null before the first push. */
  private health: EgressHealth | null = null;

  /**
   * @param cfg The configuration of the deployment.
   * @param credentials The source of the secrets.
   * @param apiKeys The source of the API keys.
   * @param db The database that holds the CA and the control token.
   * @param boxes The function that returns the boxes that are not deleted, with their profiles and MCP hosts.
   * @param mcpSecrets The function that returns the secret rows of the MCP servers.
   * @param onRefused The function that gets the refused OAuth tokens that a push reports.
   * @param upstreamCas The function that returns the rows of the upstream CA store.
   */
  constructor(
    /** The deployment's configuration. */
    private readonly cfg: Config,
    /** The source of the secrets, read on every compose. */
    private readonly credentials: CredentialStore,
    /** The source of the API keys, read on every compose. */
    private readonly apiKeys: ApiKeyStore,
    /** Where the CA and the control token are kept. */
    private readonly db: Db,
    /** Returns the boxes that are not deleted, read on every compose. */
    private readonly boxes: () => EgressBoxInput[] = () => [],
    /** Returns the secret rows of the MCP servers, read on every compose. */
    private readonly mcpSecrets: () => McpSecretEntry[] = () => [],
    /** Gets the refused OAuth tokens that a push reports. */
    private readonly onRefused: (tokens: RefusedMcpToken[]) => void = () => undefined,
    /** Returns the rows of the upstream CA store, read on every compose. */
    private readonly upstreamCas: () => UpstreamCaRow[] = () => [],
  ) {}

  /** Loads the material, without talking to the proxy. */
  async prepare(): Promise<void> {
    this.material = await resolveEgressMaterial(this.db);
  }

  /**
   * Returns the CA certificate that a box trusts.
   *
   * @returns The certificate, without the key.
   * @throws Error Before prepare().
   */
  caCertificate(): string {
    return this.prepared().ca.cert;
  }

  /**
   * Returns the prepared material. It throws before prepare(), so no box is built
   * without the CA.
   *
   * @returns The material.
   * @throws Error Before prepare().
   */
  private prepared(): EgressMaterial {
    if (!this.material) throw new Error('the egress policy has not been prepared yet');
    return this.material;
  }

  /**
   * Returns the placeholder that stands for a credential of a user in a box.
   * The empty string drops the variable from the environment of the box.
   *
   * @param owner The user.
   * @param id The id of the credential.
   * @returns The placeholder, or the empty string for a credential that is not stored.
   */
  placeholderFor(owner: string, id: string): string {
    return this.credentials.placeholderFor(owner, id);
  }

  /**
   * Returns the placeholder of each stored API key of a user.
   *
   * @param owner The user.
   * @returns The placeholders, by the name of the variable in a box.
   */
  apiKeyEnv(owner: string): Record<string, string> {
    return Object.fromEntries(this.apiKeys.list(owner).map((key) => [key.name, key.placeholder]));
  }

  /**
   * Returns how a stored credential of a user was obtained.
   *
   * @param owner The user.
   * @param id The id of the credential.
   * @returns The method, or null for a credential that is not stored.
   */
  methodFor(owner: string, id: CredentialId): CredentialMethod | null {
    return this.credentials.get(owner, id)?.method ?? null;
  }

  /**
   * Returns the last health that the proxy reported.
   *
   * @returns The health, or null before the first push.
   */
  status(): EgressHealth | null {
    return this.health;
  }

  /**
   * Returns the last health that the proxy reported, with only the credential
   * ids of one user, for /healthz. The ids of the other users name those users.
   *
   * @param owner The user.
   * @returns The health, or null before the first push.
   */
  statusFor(owner: string): EgressHealth | null {
    if (!this.health) return null;
    const own = new Set([
      ...this.credentials.list(owner).map((row) => policyId(owner, row.id)),
      ...this.apiKeys.list(owner).map(apiKeyPolicyId),
      ...this.mcpSecrets()
        .filter((row) => row.owner === owner)
        .map(mcpPolicyId),
    ]);
    return {
      ...this.health,
      credentialIds: this.health.credentialIds.filter((id) => own.has(id)),
    };
  }

  /**
   * Reads the targets that the egress profile of a box refused.
   *
   * @param box The id of the box.
   * @returns The refused targets, the most recent first.
   * @throws Error When the call to the proxy fails.
   */
  async denials(box: string): Promise<EgressDenial[]> {
    if (!this.material) await this.prepare();
    return fetchDenials(this.cfg, this.prepared(), box);
  }

  /**
   * Recomposes the policy from the store, pushes it, and records what the
   * proxy reported. The boot, every store write and every reconciler tick call it.
   * The refused OAuth tokens of the answer go to onRefused.
   *
   * @throws Error When the push fails. The health then records the error.
   */
  async sync(): Promise<void> {
    if (!this.material) await this.prepare();
    const material = this.prepared();
    const mcpSecrets = this.mcpSecrets();
    const composed = composePolicy(
      this.cfg,
      material,
      this.credentials.listAll(),
      this.apiKeys.listAll(),
      this.boxes(),
      mcpSecrets,
      this.upstreamCas(),
    );

    let status: EgressPushAnswer;
    try {
      status = await pushPolicy(this.cfg, material, composed);
      this.health = {
        inSync: status.applied,
        credentialIds: status.credentialIds,
        denials: status.denials,
        error: null,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.health = {
        inSync: false,
        credentialIds: [],
        denials: this.health?.denials ?? {},
        error: message,
      };
      throw err;
    }

    const rows = new Map(mcpSecrets.map((row) => [mcpPolicyId(row), row]));
    const refused = (status.refusedTokens ?? []).flatMap((refusal) => {
      const row = rows.get(refusal.credentialId);
      return row ? [{ row, refusal }] : [];
    });
    if (refused.length > 0) this.onRefused(refused);
  }
}
