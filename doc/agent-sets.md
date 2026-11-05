# Agent sets

An agent set is a named collection of agent configuration. It holds an `AGENTS.md` file, skills, and remote MCP
servers. The orchestrator stores sets in its [database](storage.md). The agent in a box reads the `AGENTS.md` file and
the skills from files in its home directory, and the orchestrator writes these files from the sets. The orchestrator
gives the MCP servers to the agent through the [agent protocol](acp.md).

## The global set and named sets

Each set belongs to one [user](users.md). Each user has one global set, which the orchestrator creates at the first
use. The global set applies to every box of its owner, and the user cannot delete it.

More sets can be added in the dashboard. A set has a display name, an optional `AGENTS.md`, any number of skills, and
up to 20 MCP servers.

A set is selected when a [box is created](boxes.md). The selection is stored with the box and cannot change later. A box
that selects no set gets the global set alone. Naming the global set is the same as naming nothing.

## Merging

A box always gets the global set. When another set is selected, the orchestrator merges the two. The two kinds of
content merge differently:

- The `AGENTS.md` files are concatenated: the global one first, the selected set's one after it, separated by a blank
  line.
- A skill is addressed by its name. When two skills have the same name, one wins. The order, highest first:
  1. a skill of the selected set
  2. a skill from a repository of the selected set, in the order of the repository list
  3. a skill of the global set
  4. a skill from a repository of the global set, in the order of the repository list
- An MCP server is addressed by its name. An MCP server of the selected set replaces an MCP server of the global set
  with the same name.

The editor of a named set shows the merged result under "Merged result".

## Skills

A skill is a directory with a `SKILL.md` file. The file needs YAML front matter with a `name` and a `description`. The
description is the only thing the agent sees before it decides to read the skill. A skill without front matter is not
loaded at all. The user can also invoke a skill in the composer by typing its name after a slash.

Skill names must be lowercase letters, digits, and dashes, start with a letter or digit, and be 64 characters or fewer.
A name is fixed once the skill exists. To rename a skill, delete it and add it again.

A set holds at most 100 skills. An `AGENTS.md` or one skill's content may be at most 100,000 characters.

## Skills from repositories

A set can also take skills from Git repositories, for example a Claude plugin repository. Such a skill can have more
files than its `SKILL.md`, for example references or scripts.

A repository is added by its HTTPS URL. A branch, a tag, or a full commit hash is optional. Without one, the default
branch is used. To change the URL or the branch, remove the repository and add it again.

The orchestrator pulls a repository when it is added, once a day, and when the user selects the pull button. Each
directory with a `SKILL.md` file is one skill, at any depth. The directory name is the skill name. A `SKILL.md` at the
root gets the name of the repository. The orchestrator copies the full directory, but no links.

Private repositories on `github.com` use the GitHub [credential](credentials.md) of the owner of the set.

When a pull fails, the editor shows the error on the repository. The skills of the last good pull stay in use.

A set takes skills from at most 20 repositories, and the orchestrator takes at most 100 skills from one repository.

## MCP servers

An MCP server gives the agent more tools. MCP is the Model Context Protocol, and a remote MCP server answers it over
HTTP. Boxes supports remote MCP servers with the Streamable HTTP transport only. Boxes does not support MCP servers that
run as a local process in the box, or MCP servers with the older SSE transport.

Each MCP server has a name, a URL, and an authentication method. The name must be lowercase letters, digits, and dashes,
and it can have at most 32 characters. The name, the URL and the authentication method are fixed. To change one of
them, delete the MCP server and add it again.

The URL must use `https`. An MCP server without secrets can also use `http`, because the egress proxy puts secrets only
into `https` requests. An MCP server can have a private address. An authorization server must have a public address,
unless it is on the host of the MCP server. The URL must not name a loopback, link-local or reserved address. The
[egress proxy](egress.md) always allows the host and the port of an MCP server.

An MCP server uses a bearer token, custom headers, an OAuth login, or no authentication. An MCP server has at most 20
custom headers, and a header value can have at most 4096 characters. A header value is literal or secret, and an
`Authorization` header must be secret. The orchestrator stores a bearer token and each secret value with the MCP
server, and a box gets only a placeholder, as for a [credential](credentials.md#the-path-of-a-credential-into-a-box).

For an OAuth login, the user starts the login in the dashboard and logs in at the authorization server of the MCP
server. The orchestrator then stores the token and keeps it fresh. The agent gets an MCP server with an OAuth login only
after the first login. When a refresh fails or the MCP server refuses the token, the orchestrator marks the login as
failing with the reason, and the user logs in again.

Many authorization servers accept the orchestrator as a client without a registration by the user. For the other
authorization servers, for example GitHub, the user registers a client at the authorization server, for example a
GitHub App. The registration needs the redirect URI `<dashboard origin>/oauth/callback`. The dashboard then asks for
the client ID and the optional client secret.

## File installation into a box

At each box start, the [file service](files.md) in the box installs the merged set into the home, in the layout of each
[harness](glossary.md), together with the [built-in skills](skills.md). Files that the agent wrote stay.

The practical effects:

- Changes to a set reach a box the next time the box starts. A running box keeps what it has. A new secret or a new
  OAuth login of an MCP server applies without a restart of the box.
- An item deleted from a set is removed from the box at the next start. A built-in skill whose condition no longer
  holds is removed in the same way.
- When a set is deleted, the boxes that selected it keep what is already installed, and get the global set alone at the
  next start.

## Managing sets

Sets are managed in the dashboard. The agent configuration icon on the box list opens the set list; from there, one set
can be opened in its editor.

## Technical internals

The implementation is `orchestrator/src/agents.ts`, over the `agent_sets`, `agent_items`, `agent_repos`,
`agent_mcp_servers` and `agent_mcp_secrets` tables. The database is the source of truth; the files are derived from it.

### Repository checkouts

`orchestrator/src/skill-repos.ts` fetches a repository into `DATA_DIR/skill-repos/<repo id>/tree`. Each pull is a
shallow fetch into a new git directory, and the new files replace the old checkout in one step. The `agent_repos` row
keeps the commit, the skills found, and the error of the last pull.

This is the one place where the orchestrator runs git itself. A repository cannot make git run a program here: the new
git directory has no hooks, the configuration that names filters and helpers is never fetched, no system or user
configuration is read, and submodules are not fetched.

### Installation

`AgentStore.pack` packs the merged set as a tar stream, with one copy for each layout of the harness registry
(`orchestrator/src/harness.ts`). A box can have threads of each harness, and each agent reads only its own
directories:

| Content | Claude | Codex | opencode |
| --- | --- | --- | --- |
| Instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.config/opencode/AGENTS.md` |
| Skills | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |

Codex and opencode read the same skill directory, so the tar holds each skill in it only once. opencode can also read
the instructions and skills of Claude Code. The orchestrator turns this off with `OPENCODE_DISABLE_CLAUDE_CODE`, so
opencode does not read the Claude Code copy of the set in addition to its own copy.

The file service (`files/src/agentset.ts`) unpacks the stream into a stage directory first, so a refused path changes
nothing.

### The reversible install

`~/.boxes/managed` lists what the last install put into the home: each instructions file, and each skill as a
directory. The next install removes these first. The file service accepts only paths inside the layouts. A stream or a
managed file cannot name `.ssh` or all of `.claude`.

### Deleting a set

The box's `agent_set_id` column references the set with `ON DELETE SET NULL`, and the set's items and repositories are
deleted with it, together with the repository checkouts.

### MCP servers

`orchestrator/src/mcp-servers.ts` checks an MCP server at save and makes the `mcpServers` list for the
[ACP gateway](acp.md#mcp-servers). At each box start, the orchestrator copies the merged MCP servers into the
`mcp_servers` column of the box, so the list survives a restart of the orchestrator.

The `agent_mcp_secrets` table (`orchestrator/src/mcp-secrets.ts`) holds each secret with its full header value and its
placeholder. The placeholder stays the same while the secret exists, so a new token needs no new session.

`orchestrator/src/mcp-oauth.ts` is the OAuth client, based on `oauth4webapi`. It runs one refresh of a token at a time,
because a rotated refresh token works only once. The reconciler refreshes the tokens. The orchestrator also handles the
refused tokens that the [egress proxy](egress.md#interception) reports.
