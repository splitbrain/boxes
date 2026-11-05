/** The OAuth client of the orchestrator for the remote MCP servers of the agent sets. */

import dns from 'node:dns';
import net from 'node:net';
import * as oauth from 'oauth4webapi';
import { Agent, fetch as undiciFetch } from 'undici';
import { type AddressKind, addressKind } from '../../shared/cidr.ts';
import type {
  AgentMcpServer,
  McpCallbackAnswer,
  McpCallbackBody,
  McpConnectAnswer,
  McpConnectBody,
} from '../../shared/types.ts';
import { bearerChallenge } from '../../shared/www-authenticate.ts';
import { REFRESH_WINDOW_MS } from './credentials.ts';
import type { RefusedMcpToken } from './egress.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { type McpSecretStore, OAUTH_HEADER } from './mcp-secrets.ts';

/** The time that a started login waits for its callback, in milliseconds. */
const LOGIN_TTL_MS = 10 * 60_000;

/** The timeout of one request to a remote server, in milliseconds. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The maximum size of the answer to one request, in bytes. */
const MAX_ANSWER_BYTES = 1 << 20;

/** The minimum age of a token before a refused token gets a refresh, in milliseconds. */
const REPORT_REFRESH_GAP_MS = 5 * 60_000;

/** The client name in a Dynamic Client Registration. */
const CLIENT_NAME = 'Boxes';

/** The path of the redirect URI under the origin of the dashboard. */
const CALLBACK_PATH = '/oauth/callback';

/** The JSON-RPC request that the orchestrator sends without a token, to get the challenge of a server. */
const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: '1' },
  },
});

/** The request options that the OAuth client gives to its fetch function. */
export interface OAuthRequest {
  /** The HTTP method. */
  method?: string;
  /** The request headers. */
  headers?: Record<string, string>;
  /** The request body. */
  body?: string | URLSearchParams;
  /** The redirect mode. */
  redirect?: 'manual';
  /** The signal that aborts the request. */
  signal?: AbortSignal;
  /**
   * The hostname of the MCP server that the user entered. Only this host may have a private address, because the
   * user named it. Hosts that a remote server names stay public.
   */
  privateHost?: string;
}

/** The function that sends one request of the OAuth client. Tests pass a fake. */
export type OAuthFetch = (url: string, init: OAuthRequest) => Promise<Response>;

/** The client of an MCP server at its authorization server. */
interface OAuthClient {
  /** The client ID. */
  client_id: string;
  /** The client secret, or undefined for a public client. */
  client_secret?: string;
  /** The way the client authenticates at the token endpoint. */
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  /** The source of the client: a Dynamic Client Registration, or the user. */
  registered: 'dcr' | 'manual';
  /** The redirect URI of the registration of the client. */
  redirect_uri: string;
}

/** The parts of the authorization server metadata that the login and the refresh need. */
interface OAuthServer {
  /** The issuer. */
  issuer: string;
  /** The authorization endpoint. */
  authorization_endpoint: string;
  /** The token endpoint. */
  token_endpoint: string;
  /** The registration endpoint, or undefined when the server has no Dynamic Client Registration. */
  registration_endpoint?: string;
  /** True when the server sends the `iss` parameter in each authorization response. */
  authorization_response_iss_parameter_supported?: boolean;
}

/** The OAuth document in the `oauth` column of a secret row. */
export interface OAuthDocument {
  /** The client, or undefined before the first connect or after the server refused the client. */
  client?: OAuthClient;
  /** The authorization server, or undefined before the first connect. */
  server?: OAuthServer;
  /** The refresh token, or undefined when the server returned none or refused it. */
  refresh_token?: string;
  /** The scopes for the next login. */
  scopes: string[];
}

/** A started login that waits for its callback. */
interface PendingLogin {
  /** The user who started the login. */
  owner: string;
  /** The set of the server. */
  setId: string;
  /** The name of the server. */
  server: string;
  /** The URL of the server, which is the resource of the token. */
  resource: string;
  /** The PKCE code verifier. */
  verifier: string;
  /** The redirect URI of the login. */
  redirectUri: string;
  /** The authorization server, with the issuer that the callback checks. */
  as: OAuthServer;
  /** The client of the login. */
  client: OAuthClient;
  /** The scopes of the login. */
  scopes: string[];
  /** The time after which the callback is refused, in epoch milliseconds. */
  expiresAt: number;
}

/** The result of the discovery of the authorization server of an MCP server. */
interface Discovery {
  /** The authorization server metadata. */
  as: oauth.AuthorizationServer;
  /** The scopes of the challenge in the 401 answer, or an empty list. */
  challengeScopes: string[];
  /** The `scopes_supported` of the protected resource metadata, or an empty list. */
  resourceScopes: string[];
}

/** The OAuth client of the MCP servers. */
export class McpOAuth {
  /** The started logins, by `state`. */
  private readonly logins = new Map<string, PendingLogin>();

  /** The running refreshes, by set and server. */
  private readonly refreshes = new Map<string, Promise<void>>();

  /**
   * @param secrets The store of the secret rows.
   * @param server The function that gives a stored MCP server of a user, or throws a 404.
   * @param fetch The function that sends the requests to the remote servers.
   * @param now The clock.
   */
  constructor(
    /** The store of the secret rows. */
    private readonly secrets: McpSecretStore,
    /** Gives a stored MCP server of a user. */
    private readonly server: (owner: string, setId: string, name: string) => AgentMcpServer,
    /** Sends the requests to the remote servers. */
    private readonly fetch: OAuthFetch = guardedFetch,
    /** The clock. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Starts the OAuth login of an MCP server.
   *
   * @param owner The user.
   * @param setId The set of the server.
   * @param name The name of the server.
   * @param body The origin of the dashboard and the client that the user entered.
   * @param requestOrigin The Origin header of the request.
   * @returns The authorization URL, or the request for a client ID with the redirect URI.
   * @throws {HttpError} A 404 for an unknown server, a 400 for a bad origin or a server without OAuth, or a 502
   *   when a remote server fails.
   */
  async connect(
    owner: string,
    setId: string,
    name: string,
    body: McpConnectBody,
    requestOrigin: string | undefined,
  ): Promise<McpConnectAnswer> {
    const entry = this.server(owner, setId, name);
    if (entry.auth !== 'oauth') throw new HttpError(400, 'The MCP server does not use OAuth');
    const redirectUri = `${dashboardOrigin(body.origin, requestOrigin)}${CALLBACK_PATH}`;
    const row = this.secrets.get(setId, entry.name, OAUTH_HEADER);
    if (!row) throw new HttpError(404, 'No such MCP server');
    const doc = readDocument(row.oauth);

    try {
      const found = await this.discover(entry.url);
      const as = found.as;
      const client = await this.selectClient(doc, as, redirectUri, body, entry.url);
      if (client === null) return { needsClient: true, redirectUri };

      const server: OAuthServer = {
        issuer: as.issuer,
        authorization_endpoint: httpsUrl(as.authorization_endpoint, 'authorization_endpoint'),
        token_endpoint: httpsUrl(as.token_endpoint, 'token_endpoint'),
        ...(as.registration_endpoint ? { registration_endpoint: as.registration_endpoint } : {}),
        ...(as.authorization_response_iss_parameter_supported !== undefined
          ? {
              authorization_response_iss_parameter_supported:
                as.authorization_response_iss_parameter_supported,
            }
          : {}),
      };
      this.secrets.putOAuth(setId, entry.name, JSON.stringify({ ...doc, client, server }));

      const scopes = selectScopes(doc.scopes, found, as);
      const verifier = oauth.generateRandomCodeVerifier();
      const state = oauth.generateRandomState();
      this.prune();
      this.logins.set(state, {
        owner,
        setId,
        server: entry.name,
        resource: entry.url,
        verifier,
        redirectUri,
        as: server,
        client,
        scopes,
        expiresAt: this.now() + LOGIN_TTL_MS,
      });

      const url = new URL(server.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.client_id);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      url.searchParams.set('resource', entry.url);
      if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
      return { authorizationUrl: url.href };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Could not start the login: ${describe(err)}`);
    }
  }

  /**
   * Ends an OAuth login with the parameters of the redirect, and stores the token.
   *
   * @param owner The user.
   * @param body The parameters of the redirect.
   * @returns The set of the server.
   * @throws {HttpError} A 400 for an unknown login or a refused answer, a 404 for a deleted server, or a 502 when
   *   the token request fails.
   */
  async callback(owner: string, body: McpCallbackBody): Promise<McpCallbackAnswer> {
    this.prune();
    const login = this.logins.get(body.state);
    if (!login || login.owner !== owner) {
      throw new HttpError(400, 'The login is unknown or older than 10 minutes. Connect again');
    }
    this.logins.delete(body.state);

    const params = new URLSearchParams({ state: body.state });
    if (body.code !== undefined) params.set('code', body.code);
    if (body.iss !== undefined) params.set('iss', body.iss);
    if (body.error !== undefined) params.set('error', body.error);
    if (body.errorDescription !== undefined) params.set('error_description', body.errorDescription);

    const as: oauth.AuthorizationServer = { ...login.as };
    const client: oauth.Client = { client_id: login.client.client_id };
    let checked: URLSearchParams;
    try {
      checked = oauth.validateAuthResponse(as, client, params, body.state);
    } catch (err) {
      if (err instanceof oauth.AuthorizationResponseError) {
        const reason = err.error_description ? `${err.error}: ${err.error_description}` : err.error;
        throw new HttpError(400, `The authorization server refused the login (${reason})`);
      }
      throw new HttpError(
        400,
        `The answer of the authorization server is not valid: ${describe(err)}`,
      );
    }

    let tokens: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        clientAuth(login.client),
        checked,
        login.redirectUri,
        login.verifier,
        { ...this.httpOptions(login.resource), additionalParameters: { resource: login.resource } },
      );
      tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
    } catch (err) {
      throw new HttpError(502, `The token request failed: ${describe(err)}`);
    }

    const now = this.now();
    const updated: OAuthDocument = {
      client: login.client,
      server: login.as,
      scopes: login.scopes,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    };
    this.secrets.putToken(login.setId, login.server, {
      secret: `Bearer ${tokens.access_token}`,
      oauth: JSON.stringify(updated),
      expires_at: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
      refreshed_at: now,
    });
    return { setId: login.setId };
  }

  /**
   * Refreshes each OAuth token that expires soon. The margin is the smaller of REFRESH_WINDOW_MS and half the
   * lifetime of the token. A token without an expiry or without a refresh token gets no refresh.
   */
  async refreshDue(): Promise<void> {
    const now = this.now();
    for (const row of this.secrets.listAll()) {
      if (row.auth !== 'oauth' || row.secret === '' || row.expires_at === null) continue;
      if (!readDocument(row.oauth).refresh_token) continue;
      const lifetime =
        row.refreshed_at === null ? Number.POSITIVE_INFINITY : row.expires_at - row.refreshed_at;
      if (row.expires_at - now <= Math.min(REFRESH_WINDOW_MS, lifetime / 2)) {
        await this.refresh(row.set_id, row.server);
      }
    }
  }

  /**
   * Reacts to the refused tokens that the proxy reported. A token gets a refresh at once, when it has a refresh
   * token and its last token is at least REPORT_REFRESH_GAP_MS old. Otherwise, the token gets the status `failing`. A 403 with
   * `insufficient_scope` adds the scopes of the challenge to the next login and sets the status `failing`.
   *
   * @param tokens The refused tokens with their rows.
   */
  async handleRefused(tokens: readonly RefusedMcpToken[]): Promise<void> {
    for (const { row: reported, refusal } of tokens) {
      // The reported row is from the compose of the policy, and the stored row can be newer.
      const row = this.secrets.get(reported.set_id, reported.server, reported.header);
      if (row?.auth !== 'oauth') continue;
      const doc = readDocument(row.oauth);
      if (refusal.status === 403 && refusal.error === 'insufficient_scope') {
        const scopes = [...new Set([...doc.scopes, ...splitScopes(refusal.scope)])];
        this.secrets.putOAuth(row.set_id, row.server, JSON.stringify({ ...doc, scopes }));
        this.secrets.markStatus(
          row.set_id,
          row.server,
          'failing',
          'the server needs more permissions: reconnect',
        );
        continue;
      }
      const recent =
        row.refreshed_at !== null && this.now() - row.refreshed_at < REPORT_REFRESH_GAP_MS;
      if (doc.refresh_token && !recent) {
        await this.refresh(row.set_id, row.server);
        continue;
      }
      const reason = refusal.error ? `${refusal.status} ${refusal.error}` : `${refusal.status}`;
      this.secrets.markStatus(
        row.set_id,
        row.server,
        'failing',
        `the server refused the token (${reason}): reconnect`,
      );
    }
  }

  /**
   * Refreshes the token of a server. A second call for the same server while a refresh runs gets the running
   * refresh, because a rotated refresh token works only once.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   */
  refresh(setId: string, server: string): Promise<void> {
    const key = `${setId}\n${server}`;
    const running = this.refreshes.get(key);
    if (running) return running;
    const work = this.refreshNow(setId, server).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, work);
    return work;
  }

  /**
   * The body of refresh. An answer with `invalid_grant` drops the refresh token, and an answer with
   * `invalid_client` drops the client, so the next login selects a new client. Each failure sets the status
   * `failing`.
   *
   * @param setId The set of the server.
   * @param server The name of the server.
   */
  private async refreshNow(setId: string, server: string): Promise<void> {
    const row = this.secrets.get(setId, server, OAUTH_HEADER);
    const doc = readDocument(row?.oauth ?? null);
    if (!row || !doc.refresh_token || !doc.client || !doc.server) return;

    const as: oauth.AuthorizationServer = { ...doc.server };
    const client: oauth.Client = { client_id: doc.client.client_id };
    let tokens: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        clientAuth(doc.client),
        doc.refresh_token,
        { ...this.httpOptions(row.url), additionalParameters: { resource: row.url } },
      );
      tokens = await oauth.processRefreshTokenResponse(as, client, response);
    } catch (err) {
      const code = err instanceof oauth.ResponseBodyError ? err.error : null;
      if (code === 'invalid_grant' || code === 'invalid_client') {
        const { refresh_token: _token, client: kept, ...rest } = doc;
        const updated: OAuthDocument = code === 'invalid_client' ? rest : { ...rest, client: kept };
        this.secrets.putOAuth(setId, server, JSON.stringify(updated));
        this.secrets.markStatus(
          setId,
          server,
          'failing',
          `the authorization server refused the refresh (${code}): reconnect`,
        );
      } else {
        this.secrets.markStatus(setId, server, 'failing', `could not refresh: ${describe(err)}`);
      }
      log.warn('could not refresh the OAuth token of an MCP server', {
        set: setId,
        server,
        error: describe(err),
      });
      return;
    }

    const now = this.now();
    this.secrets.putToken(setId, server, {
      secret: `Bearer ${tokens.access_token}`,
      oauth: JSON.stringify({ ...doc, refresh_token: tokens.refresh_token ?? doc.refresh_token }),
      expires_at: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
      refreshed_at: now,
    });
  }

  /**
   * Finds the authorization server of an MCP server through its protected resource metadata.
   *
   * @param url The URL of the MCP server.
   * @returns The authorization server metadata and the scopes of the resource.
   * @throws {Error} When a step fails.
   */
  private async discover(url: string): Promise<Discovery> {
    const fetch = this.fetchFor(url);
    const probe = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: PROBE_BODY,
      redirect: 'manual',
    });
    await probe.body?.cancel();
    const challenge =
      probe.status === 401
        ? bearerChallenge(probe.headers.get('www-authenticate') ?? undefined)
        : null;

    const resource = new URL(url);
    const candidates: { url: string; expected: string[] }[] = challenge?.resource_metadata
      ? [{ url: challenge.resource_metadata, expected: [resource.href] }]
      : wellKnownResource(resource);
    let metadata: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      const res = await this.getJson(candidate.url, fetch);
      if (res === null) continue;
      const named = typeof res.resource === 'string' ? res.resource : '';
      if (!candidate.expected.includes(normalUrl(named))) {
        throw new Error(`the protected resource metadata names the resource ${named}, not ${url}`);
      }
      metadata = res;
      break;
    }
    if (metadata === null) throw new Error('the MCP server has no protected resource metadata');
    const servers = metadata.authorization_servers;
    const first = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : null;
    if (first === null)
      throw new Error('the protected resource metadata names no authorization server');

    const issuer = new URL(httpsUrl(first, 'authorization server'));
    let as: oauth.AuthorizationServer | null = null;
    for (const candidate of wellKnownServer(issuer)) {
      const res = await fetch(candidate, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        continue;
      }
      as = await oauth.processDiscoveryResponse(issuer, res);
      break;
    }
    if (as === null) throw new Error(`the authorization server ${first} has no metadata`);

    return {
      as,
      challengeScopes: splitScopes(challenge?.scope ?? null),
      resourceScopes: Array.isArray(metadata.scopes_supported)
        ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === 'string')
        : [],
    };
  }

  /**
   * Reads one JSON document.
   *
   * @param url The URL of the document.
   * @param fetch The fetch function of the MCP server.
   * @returns The document, or null when the answer is not a 200 with a JSON object.
   * @throws {Error} When the URL does not use https, or the request fails.
   */
  private async getJson(url: string, fetch: OAuthFetch): Promise<Record<string, unknown> | null> {
    const res = await fetch(httpsUrl(url, 'metadata URL'), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    const parsed: unknown = await res.json().catch(() => null);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  }

  /**
   * Selects the client of a login. A client ID of the user comes first. A stored client of the same
   * authorization server with the same redirect URI comes next. Otherwise, the orchestrator registers a new
   * client through Dynamic Client Registration.
   *
   * @param doc The stored OAuth document.
   * @param as The authorization server metadata.
   * @param redirectUri The redirect URI of the login.
   * @param body The client that the user entered.
   * @param mcpUrl The URL of the MCP server.
   * @returns The client, or null when the user must enter a client ID.
   */
  private async selectClient(
    doc: OAuthDocument,
    as: oauth.AuthorizationServer,
    redirectUri: string,
    body: McpConnectBody,
    mcpUrl: string,
  ): Promise<OAuthClient | null> {
    const clientId = body.clientId?.trim() ?? '';
    if (clientId !== '') {
      const secret = body.clientSecret?.trim() || undefined;
      return {
        client_id: clientId,
        ...(secret ? { client_secret: secret } : {}),
        token_endpoint_auth_method: secretMethod(as, secret),
        registered: 'manual',
        redirect_uri: redirectUri,
      };
    }
    const stored = doc.client;
    if (stored && stored.redirect_uri === redirectUri && doc.server?.issuer === as.issuer) {
      return stored;
    }
    if (stored?.registered === 'manual' || !as.registration_endpoint) return null;

    const response = await oauth.dynamicClientRegistrationRequest(
      as,
      {
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(as.token_endpoint_auth_methods_supported?.includes('none')
          ? { token_endpoint_auth_method: 'none' }
          : {}),
      },
      this.httpOptions(mcpUrl),
    );
    const registered = await oauth.processDynamicClientRegistrationResponse(response);
    const secret =
      typeof registered.client_secret === 'string' && registered.client_secret !== ''
        ? registered.client_secret
        : undefined;
    const method = registered.token_endpoint_auth_method;
    return {
      client_id: registered.client_id,
      ...(secret ? { client_secret: secret } : {}),
      token_endpoint_auth_method:
        secret && (method === 'client_secret_basic' || method === 'client_secret_post')
          ? method
          : secretMethod(as, secret),
      registered: 'dcr',
      redirect_uri: redirectUri,
    };
  }

  /**
   * Gives the fetch function for the requests of one MCP server. The host of the MCP server may have a private
   * address, because the user entered it.
   *
   * @param mcpUrl The URL of the MCP server.
   * @returns The fetch function.
   */
  private fetchFor(mcpUrl: string): OAuthFetch {
    const privateHost = new URL(mcpUrl).hostname;
    return (url, init) => this.fetch(url, { ...init, privateHost });
  }

  /**
   * Gives the options of the requests of oauth4webapi.
   *
   * @param mcpUrl The URL of the MCP server.
   * @returns The options with the fetch function.
   */
  private httpOptions(mcpUrl: string): { [oauth.customFetch]: OAuthFetch } {
    return { [oauth.customFetch]: this.fetchFor(mcpUrl) };
  }

  /** Deletes the started logins that are older than LOGIN_TTL_MS. */
  private prune(): void {
    const now = this.now();
    for (const [state, login] of this.logins) {
      if (login.expiresAt <= now) this.logins.delete(state);
    }
  }
}

/**
 * Checks the origin of the dashboard that a connect request sends.
 *
 * @param origin The origin from the body.
 * @param requestOrigin The Origin header of the request.
 * @returns The origin.
 * @throws {HttpError} A 400 when the origin is not an http or https origin, or differs from the header.
 */
function dashboardOrigin(origin: string, requestOrigin: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(400, 'origin must be the origin of the dashboard');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
    throw new HttpError(400, 'origin must be the origin of the dashboard');
  }
  if (requestOrigin !== origin) {
    throw new HttpError(400, 'origin differs from the Origin header of the request');
  }
  return origin;
}

/**
 * Selects the scopes of a login. The stored scopes come first, then the scopes of the challenge, and then the
 * scopes of the protected resource metadata. The list gets `offline_access` when the authorization server lists it.
 *
 * @param stored The stored scopes.
 * @param found The result of the discovery.
 * @param as The authorization server metadata.
 * @returns The scopes.
 */
function selectScopes(
  stored: readonly string[],
  found: Discovery,
  as: oauth.AuthorizationServer,
): string[] {
  const scopes =
    stored.length > 0
      ? [...stored]
      : found.challengeScopes.length > 0
        ? found.challengeScopes
        : found.resourceScopes;
  if (as.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access')) {
    scopes.push('offline_access');
  }
  return scopes;
}

/**
 * Gives the way a client authenticates at the token endpoint. A client without a secret uses `none`. A client with
 * a secret uses the first of `client_secret_basic` and `client_secret_post` in the list of the server, and
 * `client_secret_basic` when the server lists neither.
 *
 * @param as The authorization server metadata.
 * @param secret The client secret, or undefined.
 * @returns The method.
 */
function secretMethod(
  as: oauth.AuthorizationServer,
  secret: string | undefined,
): OAuthClient['token_endpoint_auth_method'] {
  if (!secret) return 'none';
  const listed = (as.token_endpoint_auth_methods_supported ?? []).find(
    (method) => method === 'client_secret_basic' || method === 'client_secret_post',
  );
  return listed === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic';
}

/**
 * Gives the client authentication of oauth4webapi for a client.
 *
 * @param client The client.
 * @returns The client authentication.
 */
function clientAuth(client: OAuthClient): oauth.ClientAuth {
  if (!client.client_secret) return oauth.None();
  return client.token_endpoint_auth_method === 'client_secret_post'
    ? oauth.ClientSecretPost(client.client_secret)
    : oauth.ClientSecretBasic(client.client_secret);
}

/**
 * Lists the well-known URLs of the protected resource metadata of a server, with the resource that each document
 * must name. The URL with the path of the server comes first.
 *
 * @param resource The URL of the server.
 * @returns The URLs.
 */
function wellKnownResource(resource: URL): { url: string; expected: string[] }[] {
  const base = `${resource.origin}/.well-known/oauth-protected-resource`;
  const root = { url: base, expected: [resource.href, normalUrl(resource.origin)] };
  if (resource.pathname === '/') return [root];
  return [{ url: `${base}${resource.pathname}`, expected: [resource.href] }, root];
}

/**
 * Lists the well-known URLs of the metadata of an authorization server. An issuer with a path gets the RFC 8414
 * and the OpenID Connect URLs, each with the path inserted and with the path appended.
 *
 * @param issuer The issuer.
 * @returns The URLs in the order of the tries.
 */
function wellKnownServer(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/$/, '');
  const oauthServer = '/.well-known/oauth-authorization-server';
  const openid = '/.well-known/openid-configuration';
  if (path === '') return [`${issuer.origin}${oauthServer}`, `${issuer.origin}${openid}`];
  return [
    `${issuer.origin}${oauthServer}${path}`,
    `${issuer.origin}${path}${oauthServer}`,
    `${issuer.origin}${openid}${path}`,
    `${issuer.origin}${path}${openid}`,
  ];
}

/**
 * Normalizes a URL for a comparison.
 *
 * @param url The URL.
 * @returns The URL as the URL parser writes it, or the text when it does not parse.
 */
function normalUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * Checks that a URL of a remote server uses https.
 *
 * @param url The URL.
 * @param what The name of the URL, for the error.
 * @returns The URL.
 * @throws {Error} When the URL does not parse or does not use https.
 */
function httpsUrl(url: string | undefined, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    throw new Error(`the ${what} is not a URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`the ${what} ${url} does not use https`);
  return parsed.href;
}

/**
 * Splits a scope parameter.
 *
 * @param scope The space-delimited scopes, or null.
 * @returns The scopes.
 */
function splitScopes(scope: string | null): string[] {
  return (scope ?? '').split(' ').filter((part) => part !== '');
}

/**
 * Parses a stored OAuth document.
 *
 * @param text The content of the `oauth` column, or null.
 * @returns The document, with an empty scope list when the text has none.
 */
export function readDocument(text: string | null): OAuthDocument {
  if (!text) return { scopes: [] };
  try {
    const parsed = JSON.parse(text) as Partial<OAuthDocument>;
    return { ...parsed, scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [] };
  } catch {
    return { scopes: [] };
  }
}

/**
 * Describes an error of a remote server for the user.
 *
 * @param err The error.
 * @returns The description, with the OAuth error code when the answer had one.
 */
function describe(err: unknown): string {
  if (err instanceof oauth.ResponseBodyError) {
    return err.error_description ? `${err.error}: ${err.error_description}` : err.error;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The signature of the lookup function of a connection. */
type Lookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * Checks if an address kind passes.
 *
 * @param kind The kind of the address.
 * @param allowPrivate True when the host may have a private address.
 * @returns True when the address passes.
 */
function kindAllowed(kind: AddressKind, allowPrivate: boolean): boolean {
  return kind === 'public' || (kind === 'private' && allowPrivate);
}

/**
 * Makes a lookup that resolves a hostname and refuses it when an address does not pass. The connections of
 * guardedFetch use it, so the check also covers the address that the connection uses.
 *
 * @param allowPrivate True when the host may have a private address. A forbidden address never passes.
 * @returns The lookup function.
 */
function guardedLookup(allowPrivate: boolean): Lookup {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const blocked = addresses.find(
        (entry) => !kindAllowed(addressKind(entry.address), allowPrivate),
      );
      if (blocked || addresses.length === 0) {
        callback(new Error(`${hostname} resolves to the blocked address ${blocked?.address}`), []);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0] as dns.LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/** The connection pool of guardedFetch for public hosts. */
const guardedAgent = new Agent({ connect: { lookup: guardedLookup(false) } });

/** The connection pool of guardedFetch for the host of an MCP server, which may have a private address. */
const privateAgent = new Agent({ connect: { lookup: guardedLookup(true) } });

/**
 * Sends one request to a remote server of an OAuth login. The request refuses a URL without https and a host with
 * a private address. It has a timeout of REQUEST_TIMEOUT_MS, and it refuses an answer above MAX_ANSWER_BYTES.
 *
 * @param url The URL.
 * @param init The request options.
 * @returns The answer, with the whole body read.
 * @throws {Error} When a check or the request fails.
 */
export const guardedFetch: OAuthFetch = async (url, init) => {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error(`${url} does not use https`);
  const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const allowPrivate =
    init.privateHost !== undefined && sameHost(target.hostname, init.privateHost);
  if (net.isIP(host) !== 0 && !kindAllowed(addressKind(host), allowPrivate)) {
    throw new Error(`${target.host} is a blocked address`);
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(init.signal ? [init.signal] : []),
  ]);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      dispatcher: allowPrivate ? privateAgent : guardedAgent,
      signal,
    });
  } catch (err) {
    // The fetch error says only "fetch failed", and its cause has the reason.
    const cause = (err as { cause?: unknown }).cause;
    const reason = cause instanceof Error ? cause.message : (err as Error).message;
    throw new Error(`could not reach ${target.host}: ${reason}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        await res.body.cancel();
        throw new Error(`the answer of ${target.host} is larger than ${MAX_ANSWER_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
  }
  const empty = res.status === 204 || res.status === 304;
  return new Response(empty ? null : Buffer.concat(chunks), {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
  });
};

/**
 * Compares two hostnames of URLs. Case and a trailing dot do not count.
 *
 * @param a The first hostname.
 * @param b The second hostname.
 * @returns True when both name the same host.
 */
function sameHost(a: string, b: string): boolean {
  const norm = (h: string): string => h.toLowerCase().replace(/\.$/, '');
  return norm(a) === norm(b);
}
