/**
 * Checks and resolution of the remote MCP servers of the agent sets.
 *
 * Only the placeholder of a secret reaches an adapter, and only the egress
 * proxy puts in the secret.
 */

import net from 'node:net';
import type { McpServer } from '@agentclientprotocol/sdk';
import { addressKind } from '../../shared/cidr.ts';
import type { AgentMcpAuth, AgentMcpServer } from '../../shared/types.ts';
import { HttpError } from './http-error.ts';
import { OAUTH_HEADER } from './mcp-secrets.ts';

/** The maximum number of MCP servers in one set. */
export const MAX_MCP_SERVERS = 20;

/** The maximum number of headers of one server. */
const MAX_HEADERS = 20;

/** The maximum length of one header value. */
const MAX_VALUE = 4096;

/** The maximum length of a server URL. */
const MAX_URL = 2048;

/**
 * The pattern of a server name. Claude names the tools of a server
 * `mcp__<server>__<tool>`, and the model API limits a tool name to 64
 * characters, so the name has at most 32 characters.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The auth modes of a server. */
const AUTH_MODES: readonly AgentMcpAuth[] = ['none', 'bearer', 'headers', 'oauth'];

/** The pattern of an HTTP header name, which is an HTTP token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The header names, in lower case, that the MCP client of the agent sets itself. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
]);

/** A merged server of a box, with the id of its set. */
export interface McpSnapshotEntry extends AgentMcpServer {
  /** The id of the set of the server. */
  setId: string;
}

/** The host and the port that the agent connects to for a server. */
interface Target {
  /** The hostname or IP literal, without brackets. */
  host: string;
  /** The port, with the default port of the scheme when the URL names none. */
  port: number;
}

/**
 * Gives the target of a server URL.
 *
 * @param url The parsed URL.
 * @returns The host and the port.
 */
function targetOf(url: URL): Target {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host, port };
}

/**
 * Gives the host pattern that the egress proxy allows for a server. The
 * pattern always names the port.
 *
 * @param url The URL of the server.
 * @returns The pattern, as in mcp.example.com:443, or null when the URL is not valid.
 */
export function mcpHostPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const { port } = targetOf(parsed);
  // The hostname of an IPv6 literal keeps its brackets, as the pattern needs.
  return `${parsed.hostname.toLowerCase()}:${port}`;
}

/**
 * Checks a server that a user saves.
 *
 * @param body The server from the request. The value of a secret header is empty to keep the stored value.
 * @returns The server, with a trimmed name in lower case, a trimmed URL and trimmed header names.
 * @throws {HttpError} A 400 when a field is not valid.
 */
export function validMcpServer(body: AgentMcpServer): AgentMcpServer {
  const name = body.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'name must be lowercase letters, digits and dashes, start with a letter or digit, ' +
        'and be 32 characters or fewer',
    );
  }
  if (!AUTH_MODES.includes(body.auth)) {
    throw new HttpError(400, `auth must be one of ${AUTH_MODES.join(', ')}`);
  }

  const rawUrl = body.url.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'url must be an absolute http or https URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, 'url must be an absolute http or https URL');
  }
  if (rawUrl.length > MAX_URL) {
    throw new HttpError(400, `url must be ${MAX_URL} characters or fewer`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(400, 'url must not contain credentials; put them into a header');
  }
  const target = targetOf(url);
  // A private address is fine, because the user names the server. Loopback,
  // link-local and the other forbidden ranges stay out of reach of the proxy.
  if (net.isIP(target.host) !== 0 && addressKind(target.host) === 'forbidden') {
    throw new HttpError(400, 'url must not name a loopback, link-local or reserved address');
  }
  if (body.auth === 'oauth' && url.protocol !== 'https:') {
    throw new HttpError(400, 'url must use https, because an OAuth token goes only over https');
  }

  if (body.headers.length > MAX_HEADERS) {
    throw new HttpError(400, `A server has at most ${MAX_HEADERS} headers`);
  }
  const seen = new Set<string>();
  const headers = body.headers.map((header) => {
    const headerName = header.name.trim();
    const value = header.value;
    if (!HEADER_NAME.test(headerName)) {
      throw new HttpError(400, `headers: ${headerName || 'a name'} is not a valid header name`);
    }
    const lower = headerName.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new HttpError(400, `headers: the agent sets ${headerName} itself`);
    }
    if (seen.has(lower)) throw new HttpError(400, `headers: ${headerName} is given twice`);
    seen.add(lower);
    if (value.length > MAX_VALUE) {
      throw new HttpError(400, `headers: the value of ${headerName} is longer than ${MAX_VALUE}`);
    }
    // A control character could end the header and start another one.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the check is for control characters
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new HttpError(400, `headers: the value of ${headerName} holds a control character`);
    }
    if (lower === OAUTH_HEADER && !header.secret) {
      throw new HttpError(400, 'headers: the Authorization header must be secret');
    }
    if (header.secret && url.protocol !== 'https:') {
      throw new HttpError(400, 'url must use https, because a secret header goes only over https');
    }
    return { name: headerName, value, secret: header.secret };
  });

  if ((body.auth === 'none' || body.auth === 'oauth') && headers.length > 0) {
    throw new HttpError(400, `headers: a server with the auth mode ${body.auth} has no headers`);
  }
  if (
    body.auth === 'bearer' &&
    (headers.length !== 1 || headers[0]?.name.toLowerCase() !== OAUTH_HEADER)
  ) {
    throw new HttpError(400, 'headers: a bearer server has exactly one Authorization header');
  }

  return { name, url: rawUrl, auth: body.auth, headers };
}

/**
 * Makes the `mcpServers` list for an adapter. Each secret header gets the
 * placeholder of its secret row, and an OAuth server gets the Authorization
 * header with the placeholder of its token. A server without a stored secret
 * is left out, because it would get no credential.
 *
 * @param servers The merged servers of the box.
 * @param placeholder The function that gives the placeholder of a secret row with a secret, or undefined.
 * @param skipped Receives the name of each left-out server and the header without a secret.
 * @returns The list for the adapter.
 */
export function resolveMcpServers(
  servers: readonly McpSnapshotEntry[],
  placeholder: (setId: string, server: string, header: string) => string | undefined,
  skipped: (server: string, header: string) => void,
): McpServer[] {
  const resolved: McpServer[] = [];
  for (const server of servers) {
    const headers = server.headers.map((header) => ({
      name: header.name,
      value: header.secret
        ? placeholder(server.setId, server.name, header.name.toLowerCase())
        : header.value,
    }));
    if (server.auth === 'oauth') {
      headers.push({
        name: 'Authorization',
        value: placeholder(server.setId, server.name, OAUTH_HEADER),
      });
    }
    const missing = headers.find((header) => header.value === undefined);
    if (missing) {
      skipped(server.name, missing.name);
      continue;
    }
    resolved.push({
      type: 'http',
      name: server.name,
      url: server.url,
      headers: headers.map((header) => ({ name: header.name, value: header.value ?? '' })),
    });
  }
  return resolved;
}
