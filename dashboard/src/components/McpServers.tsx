/** The MCP servers section of the set editor. */
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CopyField } from '@/components/CopyField';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  AgentMcpAuth,
  AgentMcpHeader,
  AgentMcpServerBody,
  AgentMcpServerState,
  McpConnectBody,
} from '../../../shared/types.ts';

/** The text of each status of an OAuth token. */
const TOKEN_STATUS = {
  ok: 'Connected',
  failing: 'Failing',
  disconnected: 'Not connected',
} as const;

/**
 * Gives the scheme of a URL.
 *
 * @param raw The URL as typed.
 * @returns The scheme with its colon, or null when the text is not a URL.
 */
function schemeOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).protocol;
  } catch {
    return null;
  }
}

/**
 * Checks if a text is an http or https URL.
 *
 * @param raw The URL as typed.
 * @returns True for an http or https URL.
 */
function validUrl(raw: string): boolean {
  const scheme = schemeOf(raw);
  return scheme === 'https:' || scheme === 'http:';
}

/**
 * The list of MCP servers, with its own add button.
 *
 * @param servers The servers of the set.
 * @param overridden The names of the servers in this set that replace a server of the global set.
 * @param busy True while a change runs, which disables the buttons.
 * @param onAdd Opens the dialog for a new server.
 * @param onEdit Opens the dialog for an existing server.
 * @param onDelete Asks to delete a server.
 */
export function McpSection({
  servers,
  overridden,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  servers: AgentMcpServerState[];
  overridden: Set<string>;
  busy: boolean;
  onAdd: () => void;
  onEdit: (server: AgentMcpServerState) => void;
  onDelete: (server: AgentMcpServerState) => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">MCP servers</h2>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onAdd}>
          <Plus />
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Remote MCP servers that give the agent more tools. Each thread gets them over the Streamable
        HTTP transport. The orchestrator stores the secrets of a server, and the egress proxy puts
        them into the requests, so a secret never goes into a box.
      </p>

      {servers.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">None in this set.</p>
      ) : null}

      {servers.map((server) => (
        <div
          key={server.name}
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-mono text-xs">{server.name}</span>
            <span className="truncate text-xs text-muted-foreground">{server.url}</span>
            {overridden.has(server.name) ? (
              <span className="text-xs text-muted-foreground">replaces the global one</span>
            ) : null}
            {server.status === 'ok' ? (
              <span className="text-xs text-muted-foreground">{TOKEN_STATUS.ok}</span>
            ) : server.status ? (
              <span className="text-xs text-warn">
                {TOKEN_STATUS[server.status]}
                {server.lastError ? `: ${server.lastError}` : ''}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${server.name}`}
            disabled={busy}
            onClick={() => onEdit(server)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${server.name}`}
            className="text-danger"
            disabled={busy}
            onClick={() => onDelete(server)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </Card>
  );
}

/**
 * Dialog that edits one MCP server.
 *
 * The name, the URL and the auth mode are fixed once the server exists. A
 * secret field of a stored server starts empty, and an empty field keeps the
 * stored secret. The upstream CA field starts with the upstream CA of the host,
 * and a save sets the upstream CA of the host to the content of the field.
 *
 * @param server The server to edit, or null for a new server.
 * @param busy True while a save runs, which disables the buttons.
 * @param error The error of the last save, or null.
 * @param onCancel Closes the dialog without a save.
 * @param onSave Saves the server.
 * @param onConnect Saves the server and starts its OAuth login. Resolves to the redirect URI when the user must
 *   enter a client ID, or to null.
 */
export function McpDialog({
  server,
  busy,
  error,
  onCancel,
  onSave,
  onConnect,
}: {
  server: AgentMcpServerState | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (body: AgentMcpServerBody) => void;
  onConnect: (
    body: AgentMcpServerBody,
    client: Omit<McpConnectBody, 'origin'>,
  ) => Promise<string | null>;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [auth, setAuth] = useState<AgentMcpAuth>(server?.auth ?? 'none');
  const [token, setToken] = useState('');
  const [headers, setHeaders] = useState<AgentMcpHeader[]>(
    server?.auth === 'headers' && server.headers.length > 0
      ? server.headers
      : [{ name: '', value: '', secret: false }],
  );
  /** The redirect URI that the client of the user needs, after the server asked for a client ID. */
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [upstreamCa, setUpstreamCa] = useState(server?.upstreamCa ?? '');
  const https = schemeOf(url) === 'https:';

  /**
   * Checks if the header of a row has a stored secret, so an empty value keeps the secret.
   *
   * @param row The index of the header.
   * @returns True when the stored server has a secret header with the same name.
   */
  const stored = (row: number): boolean => {
    const header = headers[row];
    return (
      server?.auth === 'headers' &&
      header !== undefined &&
      server.headers.some((h) => h.secret && h.name.toLowerCase() === header.name.toLowerCase())
    );
  };

  /** The server that a save sends. */
  const body: AgentMcpServerBody = {
    name: name.trim(),
    url: url.trim(),
    auth,
    headers:
      auth === 'bearer'
        ? [
            {
              name: 'Authorization',
              value: token.trim() === '' ? '' : `Bearer ${token.trim()}`,
              secret: true,
            },
          ]
        : auth === 'headers'
          ? headers.filter((h) => h.name.trim() !== '' || h.value !== '')
          : [],
    ...(https ? { upstreamCa } : {}),
  };

  /**
   * Sets one field of one header.
   *
   * @param row The index of the header.
   * @param change The fields to set.
   */
  const setHeader = (row: number, change: Partial<AgentMcpHeader>): void =>
    setHeaders((rows) => rows.map((h, i) => (i === row ? { ...h, ...change } : h)));

  const ready =
    name.trim() !== '' &&
    validUrl(url) &&
    (auth !== 'bearer' || token.trim() !== '' || server?.auth === 'bearer');
  const connected = server?.status === 'ok' || server?.status === 'failing';

  /** Saves the server and starts the login, with the client of the user when the server asked for one. */
  const connect = async (): Promise<void> => {
    const client = redirectUri
      ? {
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        }
      : {};
    const asked = await onConnect(body, client);
    if (asked) setRedirectUri(asked);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{server ? `Edit MCP server ${server.name}` : 'New MCP server'}</DialogTitle>
          <DialogDescription>A remote server with the Streamable HTTP transport.</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              disabled={server !== null}
              maxLength={32}
              placeholder="github"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {server
                ? 'The name, the URL and the authentication are fixed once the server exists. Delete the server and add it again to change them.'
                : 'Lowercase letters, digits and dashes. A server of this set replaces a global server with the same name.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={url}
              disabled={server !== null}
              placeholder="https://api.githubcopilot.com/mcp/"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-auth">Authentication</Label>
            <Select
              value={auth}
              disabled={server !== null}
              onValueChange={(value) => setAuth(value as AgentMcpAuth)}
            >
              <SelectTrigger id="mcp-auth" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="headers">Custom headers</SelectItem>
                <SelectItem value="oauth">OAuth</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {auth === 'bearer' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-token">Token</Label>
              <Input
                id="mcp-token"
                type="password"
                autoComplete="off"
                className="font-mono"
                value={token}
                placeholder={
                  server?.auth === 'bearer' ? 'Leave empty to keep the stored token' : ''
                }
                onChange={(e) => setToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The agent sends <code>Authorization: Bearer</code> with the token.
              </p>
            </div>
          ) : null}

          {auth === 'headers' ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Headers</span>
              <p className="text-xs text-muted-foreground">
                Mark each header with a secret value, such as a key, as secret. A literal value,
                such as a tenant name, goes into the box as it is.
              </p>
              {headers.map((header, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the rows have no id
                <div key={row} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    aria-label={`Header ${row + 1} name`}
                    value={header.name}
                    placeholder="X-API-Key"
                    className="font-mono sm:w-48"
                    onChange={(e) => setHeader(row, { name: e.target.value })}
                  />
                  <Input
                    aria-label={`Header ${row + 1} value`}
                    type={header.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={header.value}
                    placeholder={header.secret && stored(row) ? 'Leave empty to keep' : ''}
                    className="font-mono sm:flex-1"
                    onChange={(e) => setHeader(row, { value: e.target.value })}
                  />
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Header ${row + 1} is secret`}
                      checked={header.secret}
                      onChange={(e) => setHeader(row, { secret: e.target.checked })}
                    />
                    Secret
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove header ${row + 1}`}
                    className="text-danger"
                    onClick={() => setHeaders((rows) => rows.filter((_, i) => i !== row))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setHeaders((rows) => [...rows, { name: '', value: '', secret: false }])
                  }
                >
                  <Plus />
                  Add header
                </Button>
              </div>
            </div>
          ) : null}

          {https ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-upstream-ca">Upstream CA (optional)</Label>
              <Textarea
                id="mcp-upstream-ca"
                className="max-h-40 font-mono text-xs md:text-xs"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={upstreamCa}
                onChange={(e) => setUpstreamCa(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The certificate of a private certificate authority, as PEM. The egress proxy and the
                OAuth login trust it for the host of the server, in addition to the public
                authorities. The host shares it with your API keys and MCP servers for the same
                host.
              </p>
            </div>
          ) : null}

          {auth === 'oauth' ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">OAuth</span>
              <p className="text-xs text-muted-foreground">
                {server?.status ? TOKEN_STATUS[server.status] : TOKEN_STATUS.disconnected}
                {server?.lastError ? `: ${server.lastError}` : ''}
              </p>
              {redirectUri ? (
                <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    The authorization server has no client registration. Register a client with this
                    redirect URI, and enter its client ID.
                  </p>
                  <CopyField label="Redirect URI" value={redirectUri} />
                  <Label htmlFor="mcp-client-id">Client ID</Label>
                  <Input
                    id="mcp-client-id"
                    className="font-mono"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <Label htmlFor="mcp-client-secret">Client secret (optional)</Label>
                  <Input
                    id="mcp-client-secret"
                    type="password"
                    autoComplete="off"
                    className="font-mono"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={auth === 'oauth' ? 'outline' : 'default'}
            disabled={busy || !ready}
            onClick={() => onSave(body)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {auth === 'oauth' ? (
            <Button
              type="button"
              disabled={busy || !ready || (redirectUri !== null && clientId.trim() === '')}
              onClick={() => void connect()}
            >
              {connected ? 'Reconnect' : 'Connect'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
