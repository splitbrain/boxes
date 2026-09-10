import { createHash } from 'node:crypto';
import net from 'node:net';
import type { EgressCredential, EgressPolicy } from '../../shared/types.ts';

/**
 * The policy the proxy applies, as pure functions over data.
 *
 * Nothing here does I/O and nothing here holds state.
 */

/** The policy of a proxy nobody has pushed to yet. Frozen, because it is shared. */
export const EMPTY_POLICY: EgressPolicy = Object.freeze({
  allowedHosts: Object.freeze([] as string[]),
  ca: null,
  credentials: Object.freeze([] as EgressCredential[]),
}) as EgressPolicy;

// --- host matching ----------------------------------------------------------

/**
 * Whether a hostname matches one allowlist pattern.
 *
 * A pattern is either an exact name or `*.example.com`, where the star stands
 * for exactly one label: `*.example.com` matches `api.example.com` but neither
 * `example.com` nor `a.b.example.com`. Matching is case-insensitive, and an IP
 * literal matches only an identical literal.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (h === '' || p === '') return false;

  if (!p.startsWith('*.')) return h === p;
  if (net.isIP(h) !== 0) return false;

  const suffix = p.slice(2);
  if (suffix === '' || suffix.includes('*')) return false;
  if (!h.endsWith(`.${suffix}`)) return false;
  const label = h.slice(0, h.length - suffix.length - 1);
  return label !== '' && !label.includes('.');
}

/** Whether a hostname matches any of the patterns. */
export function hostMatchesAny(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatches(host, p));
}

/**
 * Whether a host may be reached at all. An empty allowlist is off: any public
 * host, with the resolved-address vetting still the boundary.
 */
export function hostAllowed(host: string, policy: EgressPolicy): boolean {
  if (policy.allowedHosts.length === 0) return true;
  if (hostMatchesAny(host, policy.allowedHosts)) return true;
  // A configured credential's hosts are implied members, so a narrow allowlist
  // cannot cut off the traffic the proxy authenticates.
  return policy.credentials.some((c) => hostMatchesAny(host, c.hosts));
}

/** The credentials configured for a host, in policy order. */
export function credentialsForHost(
  host: string,
  policy: EgressPolicy,
): EgressCredential[] {
  return policy.credentials.filter((c) => hostMatchesAny(host, c.hosts));
}

/**
 * Whether a host's TLS has to be intercepted. Only a host with a credential
 * is decrypted; everything else stays an opaque tunnel.
 */
export function isInjectionHost(host: string, policy: EgressPolicy): boolean {
  return policy.ca !== null && credentialsForHost(host, policy).length > 0;
}

/** Every host pattern the policy intercepts, for logging and status. */
export function injectionPatterns(policy: EgressPolicy): string[] {
  return [...new Set(policy.credentials.flatMap((c) => c.hosts))];
}

// --- credential translation -------------------------------------------------

/**
 * Rewrites one header value so it carries `secret` instead of `placeholder`,
 * or returns null when the value does not carry the placeholder at all.
 *
 * Two framings cover every client without a per-tool rule: the value carries
 * the placeholder verbatim (`Bearer <p>`, `token <p>`, or the bare value), or
 * it is HTTP Basic and the placeholder sits inside the decoded
 * `user:password` pair, which is the shape git's credential helper produces.
 */
export function swapCredentialValue(
  value: string,
  placeholder: string,
  secret: string,
): string | null {
  if (placeholder === '') return null;
  if (value.includes(placeholder)) return value.split(placeholder).join(secret);

  const basic = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value);
  if (!basic?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.includes(placeholder)) return null;
  const swapped = decoded.split(placeholder).join(secret);
  return `Basic ${Buffer.from(swapped, 'utf8').toString('base64')}`;
}

/** What the proxy does with one intercepted request. */
export type CredentialVerdict =
  /** Forward it unchanged: it carries no credential for this host. */
  | { action: 'pass' }
  /** Forward it with these header values replaced. */
  | { action: 'swap'; headers: Record<string, string>; credentialIds: string[] }
  /** Refuse it here rather than let a foreign credential reach the host. */
  | { action: 'deny'; reason: string };

/** Case-insensitive single-value read of a header. */
function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/**
 * Decides what a request to an intercepted host may carry.
 *
 * A request with no credential passes through unauthenticated. One carrying
 * the deployment's placeholder is rewritten to carry the real credential. One
 * carrying anything else is refused here, so a host being allowed does not
 * make every account at that host reachable.
 */
export function decideCredentials(
  host: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  policy: EgressPolicy,
): CredentialVerdict {
  const credentials = credentialsForHost(host, policy);
  if (credentials.length === 0) return { action: 'pass' };

  const names = [...new Set(credentials.flatMap((c) => c.headers))];
  const replacements: Record<string, string> = {};
  const used: string[] = [];

  for (const name of names) {
    const present = headerValue(headers, name);
    if (present === null) continue;

    // Credentials that may travel in this header, in policy order. The first
    // whose placeholder the value carries is the one to swap.
    const candidates = credentials.filter((c) => c.headers.includes(name));
    let swapped: string | null = null;
    for (const credential of candidates) {
      swapped = swapCredentialValue(present, credential.placeholder, credential.secret);
      if (swapped !== null) {
        used.push(credential.id);
        break;
      }
    }
    if (swapped === null) {
      return {
        action: 'deny',
        reason: `foreign credential in ${name} for ${candidates[0]?.id ?? host}`,
      };
    }
    replacements[name] = swapped;
  }

  if (used.length === 0) return { action: 'pass' };
  return { action: 'swap', headers: replacements, credentialIds: [...new Set(used)] };
}

// --- identity ---------------------------------------------------------------

/**
 * A stable fingerprint of a policy, so the orchestrator can tell whether what
 * it composed is what the proxy is running. Secrets are hashed, never echoed,
 * because this value travels back over the control channel and into /healthz.
 */
export function policyHash(policy: EgressPolicy): string {
  const canonical = JSON.stringify({
    allowedHosts: [...policy.allowedHosts].map((h) => h.toLowerCase()).sort(),
    ca: policy.ca ? createHash('sha256').update(policy.ca.cert).digest('hex') : null,
    credentials: [...policy.credentials]
      .map((c) => ({
        id: c.id,
        hosts: [...c.hosts].map((h) => h.toLowerCase()).sort(),
        headers: [...c.headers].sort(),
        placeholder: createHash('sha256').update(c.placeholder).digest('hex'),
        secret: createHash('sha256').update(c.secret).digest('hex'),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Parses and validates a pushed policy, throwing on anything malformed. */
export function parsePolicy(input: unknown): EgressPolicy {
  const fail = (why: string): never => {
    throw new Error(`invalid policy: ${why}`);
  };
  if (typeof input !== 'object' || input === null) return fail('not an object');
  const raw = input as Record<string, unknown>;

  const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value)) return fail(`${field} must be an array`);
    return value.map((v) => {
      if (typeof v !== 'string' || v.trim() === '') return fail(`${field} has an empty entry`);
      return v.trim();
    });
  };

  const allowedHosts = stringArray(raw['allowedHosts'] ?? [], 'allowedHosts');
  for (const pattern of allowedHosts) {
    if (pattern === '*') return fail('a bare * allowlist entry would allow everything');
    if (pattern.includes('*') && !pattern.startsWith('*.')) {
      return fail(`allowlist entry ${pattern} may only use a leading *. wildcard`);
    }
  }

  let ca: EgressPolicy['ca'] = null;
  const rawCa = raw['ca'];
  if (rawCa !== null && rawCa !== undefined) {
    if (typeof rawCa !== 'object') return fail('ca must be an object or null');
    const { key, cert } = rawCa as Record<string, unknown>;
    if (typeof key !== 'string' || typeof cert !== 'string' || !key || !cert) {
      return fail('ca needs a key and a cert');
    }
    ca = { key, cert };
  }

  const rawCredentials = raw['credentials'] ?? [];
  if (!Array.isArray(rawCredentials)) return fail('credentials must be an array');
  const credentials = rawCredentials.map((entry, i): EgressCredential => {
    if (typeof entry !== 'object' || entry === null) return fail(`credential ${i} is not an object`);
    const c = entry as Record<string, unknown>;
    const id = c['id'];
    const placeholder = c['placeholder'];
    const secret = c['secret'];
    if (typeof id !== 'string' || !id) return fail(`credential ${i} needs an id`);
    if (typeof placeholder !== 'string' || !placeholder) {
      return fail(`credential ${id} needs a placeholder`);
    }
    if (typeof secret !== 'string' || !secret) return fail(`credential ${id} needs a secret`);
    if (placeholder === secret) {
      return fail(`credential ${id} has a placeholder equal to its secret`);
    }
    const hosts = stringArray(c['hosts'], `credential ${id} hosts`);
    if (hosts.length === 0) return fail(`credential ${id} needs at least one host`);
    const headers = stringArray(c['headers'], `credential ${id} headers`).map((h) =>
      h.toLowerCase(),
    );
    if (headers.length === 0) return fail(`credential ${id} needs at least one header`);
    return { id, hosts, headers, placeholder, secret };
  });

  if (credentials.length > 0 && ca === null) {
    return fail('credentials cannot be translated without a CA to intercept with');
  }
  return { allowedHosts, ca, credentials };
}
