# Credentials

Credentials authenticate the services the processes in a box talk to. They are entered on the settings page of the
dashboard and stored in the [orchestrator database](storage.md). In multi-user mode, each user has their own
credentials, and a box uses the credentials of its owner. See [Users](users.md).

## The path of a credential into a box

A real credential never enters a box container. The orchestrator places a generated placeholder in the environment of
each [box](boxes.md), one per stored credential. The [egress proxy](egress.md) intercepts the requests to the hosts a
credential belongs to and replaces the placeholder with the stored secret.

The placeholder is generated when the credential is stored and is deleted with it. The environment of a box is fixed
when its container is created, so a credential that is stored or removed later takes effect in a box at its next start.

## The credentials

The settings page manages the credentials below. Each is either pasted or obtained by an account login the orchestrator
runs.

### Claude

Authenticates the Claude Code harness against `api.anthropic.com`. Three ways to set it up:

- **Log in**: the orchestrator runs `claude setup-token` in a throwaway container. You open the shown URL in a browser
  and paste the code it gives you back into the dashboard. This is the convenient path for a subscription seat.
- **Paste a token**: enter the token `claude setup-token` printed on another machine (`sk-ant-oat01-…`). The result is
  the same as logging in.
- **Paste an API key**: enter an Anthropic API key (`sk-ant-api03-…`). The key is billed per use, not against a
  subscription seat.

A token is set as `CLAUDE_CODE_OAUTH_TOKEN` and an API key as `ANTHROPIC_API_KEY`; the placeholder goes in only one of
the two. The settings page tells them apart by their prefix.

A token expires one year after it was stored and cannot be refreshed. The credential is then marked `expired`; log in or
paste again. An API key can have an expiry date, set when the key is created. The orchestrator does not know this date
and does not mark the key `expired`. When the key expires, paste a new one.

### OpenAI

Authenticates the Codex harness against `api.openai.com`. The placeholder is set as `CODEX_API_KEY`.

- **Paste an API key** (`sk-…`): the only way to run Codex threads today.
- ~~**Log in** (subscription):~~ the orchestrator runs `codex login --device-auth` and stores the login. **This
  currently does not work**: the subscription login is a document the harness reads from its home directory, not a value
  the environment can carry, so the orchestrator cannot deliver it to the harness.

### GitHub

A personal access token (`ghp_…`, paste only). The placeholder is set as `GH_TOKEN`.

It authenticates git over HTTPS and the GitHub CLI (`gh`) in every box. The [box setup](boxes.md#the-setup)
configures git's credential helper from the placeholder; the token travels to `github.com`, `api.github.com` and
`*.githubusercontent.com`.

The orchestrator also uses the token to pull private skill repositories from `github.com` for
[agent sets](agent-sets.md).

### GitLab

A personal access token (`glpat-…`, paste only) with the `api` and `write_repository` scopes. The placeholder is set as
`GITLAB_TOKEN`. The [box setup](boxes.md#the-setup) points git's credential helper for the configured host at the
GitLab CLI (`glab`).

The token travels to `gitlab.com` by default. Set the `GITLAB_HOST` [environment variable](environment.md) of the
orchestrator to a bare hostname to use a self-managed instance; the credential is then intercepted on that host instead.

### Dev Tunnels

Authenticates the Microsoft Dev Tunnels service, which the `share-app` [skill](skills.md) uses to publish a port that
listens in a box. The placeholder is set as `DEVTUNNELS_TOKEN`.

**Log in** is the only way to set it up: it runs GitHub's device flow for the Dev Tunnels app. You open the shown URL
and enter the one-time code. The orchestrator stores the login under the GitHub account it belongs to and refreshes it
periodically.

### Other API keys

You can add API keys for other services, for example OpenRouter. Each key has three fields and an optional upstream
CA:

- **Environment variable**: the name of the variable that holds the placeholder in each box, for example
  `OPENROUTER_API_KEY`. The orchestrator refuses a name that Boxes or the box image sets itself, e.g., `GH_TOKEN` or
  `PATH`.
- **Hosts**: the hosts the proxy sends the key to. A host is an exact name, e.g., `openrouter.ai`, or a name that starts
  with `*.`. The name `*.example.com` includes `api.example.com`, but it does not include `example.com` or
  `a.b.example.com`, and a host can end in a port, as in an [egress profile](egress-profiles.md#modes-and-hosts).
- **Key**: the secret. To change only the hosts, leave it empty.
- **Upstream CA**: the certificate of a private certificate authority, as PEM, for a host with a certificate from
  that authority, e.g., a Kubernetes API server. The [egress proxy](egress.md#upstream-cas) trusts it for the hosts of
  the key.

A host has one upstream CA. The API keys and [MCP servers](agent-sets.md#mcp-servers) of a user share the upstream CA
of each host they name. A save sets the upstream CA of all hosts of the key to the content of the field, and an empty
field removes it. A key shows the upstream CA only when all its hosts have the same one. The orchestrator removes the
upstream CA of a host together with the last API key or MCP server of the user that names the host.

The placeholder has the same prefix and the same length as the key, so a client that checks the format of its key
accepts the placeholder. The prefix is the start of the key up to and including the last `-` or `_`, but each part
between two separators can have only up to eight lowercase letters or digits. For example, the prefix of
`sk-or-v1-0a1b2c…` is `sk-or-v1-`, and the prefix of `sk-proj-AbC_dEf…` is `sk-proj-`, because `AbC` has uppercase
letters. The orchestrator fills the rest of the placeholder with random characters, so the placeholder has no part of
the secret. A new key with a different prefix or length gets a new placeholder, which takes effect in a box at its next
start.

The proxy replaces the placeholder in any header of a request to one of the hosts.

The opencode harness has no credential of its own and runs on these keys. It can always run, because some of its models
need no key.

## Statuses and refresh

The orchestrator keeps account logins valid: it checks them once a minute and refreshes a login against its service
before its access token expires. A pasted token cannot be refreshed.

Each credential carries a status:

- **ok** — believed to work.
- **expired** — a token that cannot be renewed has passed its expiry. Log in or paste again.
- **failing** — the last refresh failed. The reason is stored with the credential and shown on the settings page. The
  credential is kept, and the next refresh retries it.

Removing a credential on the settings page deletes it from the database, and the proxy then stops using its secret.

## Git identity

The settings page also sets the identity git commits as. The orchestrator writes it to `~/.config/git/config` in every
box of the user at each start. Git reads that file as global configuration, and `~/.gitconfig` of the agent wins over
it. Both are settings, not credentials: they authenticate nothing.

## Technical internals

### Storage

The `credentials` table holds one row per credential: the secret as the harness needs it, plus its metadata — the
account it is shown as, expiry, refresh state, status, and the last error. The orchestrator stores secrets unencrypted,
because it must hand them to the proxy on every boot and there is nobody to ask for a passphrase. The API never returns
a secret: a summary carries the account, the status and the times only. The account defaults to the secret's last four
characters, or to nothing when the secret is that short — the API never shows a whole secret. The structured logger
(`orchestrator/src/log.ts`) redacts fields whose name or value looks credential-shaped before they reach stderr.

The `api_keys` table holds one row for each of the other API keys, with the variable name, the hosts, the key and the
placeholder. The API returns only the name, the hosts, the upstream CA and the last four characters of the key.

The `upstream_cas` table (`orchestrator/src/upstream-cas.ts`) holds one row for each user and host pattern, with the
certificates as PEM. The host pattern is the host of the API key as entered, or the host and the port of the MCP
server. The patterns `mcp.internal` and `mcp.internal:443` are two rows.

### Refresh and delivery

Only account logins are refreshed — a pasted token cannot be. Both providers rotate the refresh token, so the
orchestrator rewrites the whole stored document on a refresh. Every write to the store fires a hook that recomposes the
egress policy and pushes it to the proxy, so a credential entered on the settings page is live within the second; the
reconciler's minute tick is only the retry for a proxy that missed it.

The orchestrator delivers a credential to a box only if the harness can use it. The ChatGPT subscription login is a
document rather than a header value, so the orchestrator stores, refreshes and reports it but never delivers it: the
proxy's policy treats it as absent, and the settings page shows the reason.

### Logins

`orchestrator/src/login.ts` runs the flows. Claude and Codex run their CLIs in a throwaway container built from the box
image. The orchestrator parses the login URL from the CLI output; for Codex it also parses the one-time code, and for
Claude it writes the code the user pasted back to the CLI's stdin. The orchestrator itself runs the Dev Tunnels login —
GitHub's device flow — because there is no CLI output to read. One login per credential runs at a time, and a new one
aborts the old. The orchestrator removes the container when the flow ends. A sweep removes login containers by age, on a
window deliberately longer than the login timeout, so the sweep never removes a live login.
