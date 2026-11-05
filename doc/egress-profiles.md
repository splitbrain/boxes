# Egress profiles

An egress profile sets the hosts that the agent in a [box](boxes.md) can reach through the [egress proxy](egress.md).
Each [user](users.md) has their own profiles. Each box uses exactly one profile, which the user selects when they create
the box. The user can change the profile of a box at any time, and the proxy applies the change to the next connection
of the box without a restart.

## Modes and hosts

A profile has a mode and a list of hosts. In the open mode, a box can reach all public hosts on the ports 80 and 443. In
the closed mode, a box can reach only the hosts that the proxy adds to the mode. The proxy always adds these hosts:

- the hosts of the [credentials and the other API keys](credentials.md) of the box owner, and the hosts that the related
  tools need,
- the host and the port of each MCP server in the [agent sets](agent-sets.md) of the box,
- the hosts in the profile.

The proxy refuses a private address, such as a Kubernetes service or a host in a Tailscale network, unless a host in
this list names the host. The open mode alone does not allow a private address. The proxy always refuses loopback,
link-local, multicast and reserved addresses.

A host in the list is an exact name or a name that starts with `*.`. A name that starts with `*.` includes one level of
subdomains, so `*.npmjs.org` includes `registry.npmjs.org`, but not `npmjs.org` or `a.b.npmjs.org`. A name with a port,
such as `mcp.example.com:8443`, allows only that port. A name without a port allows the ports 80 and 443. A profile has
at most 200 hosts, and a bare `*` is not valid.

A closed profile should list the package registries that the agent uses, for example `registry.npmjs.org` or the hosts
for the [nix skill](skills.md#nix), otherwise those tools will not work.

## The default profile

Each user has one default profile. The orchestrator creates it in the open mode at the first use, and the user cannot
delete it. A box without a selected profile uses the default profile. When a user deletes a profile, its boxes use the
default profile.

## Refused hosts

The proxy keeps a list of the hosts that the profile of each box refused, with the port, the number of attempts and the
time of the last attempt. The list holds the 50 most recent hosts of each box, and the details page of the box shows it.
The proxy keeps the list in memory only, so a restart of the proxy clears it. When the agent needs a host from the
list, add the host to the profile. The list also shows a host that has a private address and that no host pattern of
the box names.

## Technical internals

`EgressProfileStore` in `orchestrator/src/egress-profiles.ts` stores the profiles in the `egress_profiles` table. The
column `is_default` marks the default profile, and a unique index allows one default profile for each owner. The
column `hosts` holds the host patterns as a JSON array.

The column `egress_profile_id` of the `boxes` table holds the selected profile. Null means the default profile, and the
foreign key sets the column to null when the profile is deleted. The column `proxy_token` holds the token of the box.

The orchestrator pushes the [egress policy](egress.md#control-channel) again after each write of a profile, after the
creation and the deletion of a box, after a change of the profile of a box, and after a write of the MCP servers of an
agent set. The MCP hosts of a box come from its current agent sets. The adapters of a box use the servers of its last
start, so a server that a user removes from a set fails at once, also before the next start of the box.
