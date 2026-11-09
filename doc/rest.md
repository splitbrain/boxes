# REST API

The [orchestrator](orchestrator.md) serves a REST API under `/api`. The dashboard is its only client. The API has
no authentication of its own, so put [authentication in front of the orchestrator](compose.md) when the deployment is
reachable. In multi-user mode, each route gives only the data of the user in the request. See
[Users](users.md).

Requests and responses are JSON unless stated otherwise. A refusal answers with a 4xx or 5xx status and a body of `{
"error": "…" }`.

## Health

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/healthz` | `HealthResponse` |
| GET | `/readyz` | `ReadyResponse`, status 200 or 503 |

Liveness answers 200 always, also without a username, and describes what is wrong in the body. In multi-user mode,
`user` names the user of the request, and the credentials, harnesses and push subscriptions belong to the same user.
Readiness answers 200 only when the database, the egress proxy, and the Docker daemon are all reachable.

## Harnesses

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/harnesses` | `HarnessInfo[]` |

Lists every [harness](glossary.md) this deployment can run. For each one it carries the registry's defaults, the
adapter's last advertised modes and config options (when one has answered), and the state of its credential.

## Boxes

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes` | `BoxSummary[]` |
| POST | `/api/boxes` | 201, `BoxDetail` |
| GET | `/api/boxes/:id` | `BoxDetail` |
| POST | `/api/boxes/:id/start` | `BoxDetail` |
| POST | `/api/boxes/:id/stop` | `BoxDetail` |
| DELETE | `/api/boxes/:id` | 204 |
| PUT | `/api/boxes/:id/egress-profile` | `BoxDetail` |
| GET | `/api/boxes/:id/denials` | `EgressDenial[]` |

`POST /api/boxes` accepts a `CreateBoxBody`:

```json
{
  "name": "my-box",
  "agentSet": "set-id-or-null",
  "egressProfile": "profile-id-or-null",
  "thread": { "harness": "claude", "modeId": "…", "config": { } }
}
```

Every [box](boxes.md) is created with one thread. `thread` selects its harness and its initial mode and config; absent,
it is Claude on its defaults. `profile` is accepted but ignored. An unknown `agentSet` or `egressProfile` gets a 400.

`PUT …/egress-profile` accepts `{ "egressProfile": "…" }`, or null for the default profile. `GET …/denials` answers the
[refused hosts](egress-profiles.md#refused-hosts) from the proxy, and a 502 when the proxy does not answer.

## Threads

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes/:id/threads` | `ThreadSummary[]` |
| POST | `/api/boxes/:id/threads` | 201, `ThreadSummary` |
| POST | `/api/boxes/:id/threads/:threadId/done` | `ThreadSummary` |
| POST | `/api/boxes/:id/threads/:threadId/background/stop` | `{ "stopped": n }` |
| POST | `/api/boxes/:id/background/stop` | `{ "stopped": n }` |

`POST /api/boxes/:id/threads` accepts a `CreateThreadBody`. `from` names a [thread to fork](threads.md); absent, the new
thread starts empty. `options` selects the harness; it is ignored on a fork, which stays on its source's harness.

`POST …/done` accepts `{ "done": true|false }`. The mark only changes how the thread is drawn in a list; the thread
still runs and answers.

`POST …/background/stop` accepts `{ "processId": "…" }` to stop one task the adapter announced, or no body to stop every
task of that thread.

`POST /api/boxes/:id/background/stop` signals every process in the box's container that the orchestrator did not start
itself. It reaches work no adapter names any more, such as what a crashed adapter left running.

## Attachments

| Method | Path | Answer |
| --- | --- | --- |
| POST | `/api/boxes/:id/attachments?name=<file>` | `StoredAttachment` |

The POST body is the file's raw bytes with content type `application/octet-stream`. The limit is `MAX_ATTACHMENT_MB`
(default 25). The file lands in the box's [workspace](storage.md) under `.boxes/attachments/`, and the answer carries
the workspace-relative path for the prompt that mentions it.

## Files

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes/:id/files/raw?path=<p>` | file bytes |

`path` is absolute in the box, in `/workspace`, `/home/agent` or `/tmp`. The thread uses the route for attachments and
for the images and links in an answer, and the review uses it to open a file. The content type comes from the file
name.

## Code review

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/boxes/:id/review/dir?path=<p>&fresh=1` | `ReviewDirResponse` |
| GET | `/api/boxes/:id/review/file?path=<p>` | `ReviewFileResponse` |
| PUT | `/api/boxes/:id/review/file` | `ReviewFileResponse` |
| PUT | `/api/boxes/:id/review/annotations` | `ReviewAnnotationsResponse` |
| DELETE | `/api/boxes/:id/review/annotations?path=<p>&line=<n>` | `ReviewAnnotationsResponse` |
| PUT | `/api/boxes/:id/review/base` | `ReviewBaseResponse` |
| DELETE | `/api/boxes/:id/review` | 204 |

`path` is always workspace-relative and slash-separated. On `dir`, an empty `path` lists the workspace root, and
`fresh=1` makes the orchestrator ask git again rather than answer from its cache.

`PUT …/review/file` accepts a `ReviewFileBody` with `path`, `content`, and the `hash` the file was read at. A save over
an edit the agent made in the meantime is refused with a 412; the reviewer can then save anyway or drop the changes.

`PUT …/review/annotations` accepts a `ReviewAnnotationBody` with `path`, `line`, and `comment`, and creates or replaces
the comment on that line. `REVIEW.md` holds at most one comment per line. DELETE removes it.

`PUT …/review/base` accepts `{ "rev": "…" }` and compares the whole review against that revision. `null` or absent
clears the base back to each repository's own HEAD. The answer says where the expression resolved in each repository.

`DELETE …/review` deletes `REVIEW.md`, which is the review.

## Agent sets

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/agent-sets` | `AgentSetSummary[]` |
| POST | `/api/agent-sets` | 201, `AgentSetDetail` |
| GET | `/api/agent-sets/:setId` | `AgentSetDetail` |
| PATCH | `/api/agent-sets/:setId` | `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId` | 204 |
| PUT | `/api/agent-sets/:setId/items` | `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId/items?name=<n>` | `AgentSetDetail` |
| PUT | `/api/agent-sets/:setId/mcp-servers` | `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId/mcp-servers?name=<n>` | `AgentSetDetail` |
| POST | `/api/agent-sets/:setId/mcp-servers/:name/connect` | `McpConnectAnswer` |
| POST | `/api/mcp-oauth/callback` | `McpCallbackAnswer` |
| POST | `/api/agent-sets/:setId/repos` | 201, `AgentSetDetail` |
| DELETE | `/api/agent-sets/:setId/repos/:repoId` | `AgentSetDetail` |
| POST | `/api/agent-sets/:setId/repos/:repoId/pull` | `AgentSetDetail` |
| GET | `/api/agent-sets/:setId/preview` | `AgentBundlePreview` |

`POST` accepts `{ "name": "…" }`. `PATCH` accepts `{ "name"?, "agentsMd"? }` and leaves absent fields alone. Every
mutation answers with the whole set.

`PUT …/items` accepts an `AgentItemBody` with `name` and `content`, and creates or replaces the skill under that name.
DELETE removes it.

`PUT …/mcp-servers` accepts an `AgentMcpServerBody` with `name`, `url`, `auth`, `headers` and an optional
`upstreamCa`. It creates the [MCP server](agent-sets.md#mcp-servers), or it changes the headers and the upstream CA of
the server with that name. Each header has `name`, `value` and `secret`. A secret header with an empty value keeps the
stored value. The answer contains each secret header with an empty value. `upstreamCa` holds the
[upstream CA](credentials.md#other-api-keys) of the host of the server as PEM. An absent `upstreamCa` keeps the stored
one, and an empty string removes it. DELETE removes the server.

`POST …/connect` accepts `{ "origin": "…", "clientId"?, "clientSecret"? }` and starts the
[OAuth login](agent-sets.md#mcp-servers) of the server. `origin` is the origin of the dashboard, and it must be equal
to the `Origin` header of the request. The answer contains the `authorizationUrl` for the browser. When the server
needs a client from the user, the answer contains `needsClient: true` and the `redirectUri` for the client.

`POST /api/mcp-oauth/callback` accepts `{ "state": "…", "code"?, "iss"?, "error"?, "errorDescription"? }` with the
parameters of the redirect. It stores the token and answers with the `setId` of the server. The orchestrator accepts
one callback for each login, in the 10 minutes after the connect.

`POST …/repos` accepts an `AgentRepoBody` with `url` and an optional `ref`, adds the repository, and pulls it. A failed
pull is not an error of the request: the set's `repos` list shows it. `POST …/pull` pulls the repository again.

The preview answers what a box that selects this [agent set](agent-sets.md) receives: the global set, with this set laid
over it. Each skill in `skills` names the repository it comes from, or `null`.

## Egress profiles

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/egress-profiles` | `EgressProfileSummary[]` |
| POST | `/api/egress-profiles` | 201, `EgressProfileDetail` |
| GET | `/api/egress-profiles/:profileId` | `EgressProfileDetail` |
| PATCH | `/api/egress-profiles/:profileId` | `EgressProfileDetail` |
| DELETE | `/api/egress-profiles/:profileId` | 204 |

`POST` accepts `{ "name": "…", "open"?, "hosts"? }`, and a profile without `open` is closed. `PATCH` accepts
`{ "name"?, "open"?, "hosts"? }` and leaves absent fields alone. A DELETE of the default profile gets a 400.

## Credentials

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/credentials` | `CredentialSummary[]` |
| PUT | `/api/credentials/:id` | `CredentialSummary` |
| DELETE | `/api/credentials/:id` | 204 |

`:id` is one of `claude`, `openai`, `github`, `gitlab`, `devtunnels`. A PUT accepts a `PutCredentialBody` with `method`
(`token`, `api_key`, or `oauth`; default `token`) and the `secret`. The secret goes in and never comes back out: every
answer carries only an account and a status.

## API keys

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/api-keys` | `ApiKeySummary[]` |
| PUT | `/api/api-keys/:name` | `ApiKeySummary` |
| DELETE | `/api/api-keys/:name` | 204 |

`:name` is the environment variable of the [API key](credentials.md#other-api-keys). A PUT accepts `hosts`, an optional
`secret` and an optional `upstreamCa`. A PUT without a `secret` keeps the stored key. `upstreamCa` holds the upstream
CA of all hosts of the key as PEM. An absent `upstreamCa` keeps the upstream CAs of the hosts, and an empty string
removes them. The answer holds the name, the hosts, the last four characters of the key, the upstream CA that all
hosts of the key share, or `null`, and `mixedUpstreamCas`, which is true when the hosts have different upstream CAs.

## Logins

A login obtains a [credential](credentials.md) that cannot be pasted. The orchestrator runs the harness's own CLI in a
throwaway container and drives it.

| Method | Path | Answer |
| --- | --- | --- |
| POST | `/api/credentials/:id/login` | `StartLoginResponse` |
| GET | `/api/credentials/:id/login/:loginId` | `LoginState` |
| POST | `/api/credentials/:id/login/:loginId/code` | 204 |
| DELETE | `/api/credentials/:id/login/:loginId` | 204 |

POST starts a login and answers with the id the other calls take. The page polls the GET for the state, which is
`starting`, `awaiting_browser` (with a URL, and a one-time code where the flow has one), `awaiting_code`, `done`, or
`failed`. The POST to `…/code` hands the CLI the code the login page gave the user; only Claude's CLI asks for one.
DELETE cancels the login and removes its container. `github` and `gitlab` have no flow and answer a 400.

## Settings

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/settings` | `Settings` |
| PATCH | `/api/settings` | `Settings` |

Settings are the plain configuration of the user and hold no secrets. They hold the
[git identity](credentials.md) the agent in a box commits as, and what each thread dialog last chose. PATCH writes the
fields it names and answers with all of them.

## Web Push

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/api/push/key` | `PushKeyResponse` |
| POST | `/api/push/subscribe` | 204 |
| DELETE | `/api/push/subscribe` | 204 |

The key is the deployment's VAPID public key. A browser reads it before it [subscribes](notifications.md). POST accepts
a `PushSubscribeBody` shaped like the browser's own `PushSubscription.toJSON()`, with the endpoint, the encryption keys,
and an optional label. DELETE accepts `{ "endpoint": "…" }` and forgets that subscription.

A subscription belongs to the user of the request, and DELETE forgets only a subscription of the same user.

## Static files

Every GET outside `/api` and `/ws` serves the dashboard bundle. A path that names a file in the bundle gets that file;
every other path gets `index.html`, so client-side routes survive a reload. Content-hashed assets under `/assets/` carry
an immutable year-long cache header; everything else is revalidated on every load.
