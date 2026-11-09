/**
 * The schemas of the JSON bodies of the REST routes, and the check that
 * applies them.
 *
 * A schema checks only the shape of one body. The code that owns a limit or a
 * lookup checks it, for example the maximum length of a name or the existence
 * of a box. Unknown fields are removed and not refused, so an older
 * orchestrator can serve a newer client.
 */

import { z } from 'zod';
import type { HarnessId } from '../../shared/types.ts';
import { HttpError } from './http-error.ts';

/**
 * Reads a request body, or refuses it with a 400 that names the field and the
 * problem.
 *
 * A request without a body is read as an empty object. So a route with only
 * optional fields accepts it, and a route with a required field answers that
 * the field is missing.
 *
 * @param schema The schema of the body.
 * @param body The parsed JSON body, or undefined for a request without a body.
 * @returns The body in the shape of the schema, without unknown fields.
 * @throws {HttpError} A 400 when the body does not match the schema.
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  if (!issue) throw new HttpError(400, 'invalid body');
  const field = issue.path.join('.');
  throw new HttpError(400, field ? `${field}: ${issue.message}` : issue.message);
}

/** A string that must not be empty. */
const filled = z.string().min(1, 'must not be empty');

/** The harness of a new thread, with the mode and the settings that the dialog chose. */
const threadOptions = z.object({
  harness: z.custom<HarnessId>((id) => typeof id === 'string', 'must be a string'),
  modeId: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
});

/** The body of POST /api/boxes, with the box to create and the options of its first thread. */
export const createBoxBody = z.object({
  name: z.string(),
  profile: z.string().optional(),
  agentSet: z.string().nullable().optional(),
  egressProfile: z.string().nullable().optional(),
  thread: threadOptions.optional(),
});

/**
 * The body of PUT /api/boxes/:id/egress-profile, with the profile of the box
 * or null for the default profile.
 */
export const boxEgressProfileBody = z.object({
  egressProfile: z.string().nullable(),
});

/** The body of POST /api/boxes/:id/threads, with the thread to add. */
export const createThreadBody = z.object({
  from: z.string().optional(),
  options: threadOptions.optional(),
});

/** The body of POST /api/boxes/:id/threads/:threadId/done, with the mark to set or clear. */
export const threadDoneBody = z.object({
  done: z.boolean(),
});

/**
 * The body of POST /api/boxes/:id/threads/:threadId/background/stop, with the
 * id of the task to stop in the adapter. Without it, every task of the thread stops.
 */
export const backgroundStopBody = z.object({
  processId: z.string().optional(),
});

/**
 * The body of PUT /api/boxes/:id/review/file, with the whole file and its hash
 * at the time of the read. An absent hash matches nothing, so the service
 * refuses the save as stale.
 */
export const reviewFileBody = z.object({
  path: filled,
  content: z.string(),
  hash: z.string().optional(),
});

/**
 * The body of PUT /api/boxes/:id/review/annotations, with the comment on one line.
 *
 * `line` is coerced, so a line number in a string also works.
 */
export const reviewAnnotationBody = z.object({
  path: filled,
  line: z.coerce.number(),
  comment: z.string(),
});

/**
 * The body of PUT /api/boxes/:id/review/base, with the revision to compare
 * against. A null or absent value clears the base back to the HEAD of each repository.
 */
export const reviewBaseBody = z.object({
  rev: z.string().nullable().optional(),
});

/** The body of POST /api/agent-sets, with the set to create. */
export const createAgentSetBody = z.object({
  name: z.string(),
});

/**
 * The body of PATCH /api/agent-sets/:setId, with the fields to change. An
 * absent field stays the same.
 */
export const updateAgentSetBody = z.object({
  name: z.string().optional(),
  agentsMd: z.string().optional(),
});

/** The body of POST /api/egress-profiles, with the profile to create. */
export const createEgressProfileBody = z.object({
  name: z.string(),
  open: z.boolean().optional(),
  hosts: z.array(z.string()).optional(),
});

/**
 * The body of PATCH /api/egress-profiles/:id, with the fields to change. An
 * absent field stays the same.
 */
export const updateEgressProfileBody = z.object({
  name: z.string().optional(),
  open: z.boolean().optional(),
  hosts: z.array(z.string()).optional(),
});

/** The body of POST /api/agent-sets/:setId/repos, with the repository to take skills from. */
export const agentRepoBody = z.object({
  url: z.string(),
  ref: z.string().optional(),
});

/** The body of PUT /api/agent-sets/:setId/mcp-servers, with the MCP server to write. */
export const agentMcpServerBody = z.object({
  name: z.string(),
  url: z.string(),
  auth: z.enum(['none', 'bearer', 'headers', 'oauth']),
  headers: z
    .array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().default(false) }))
    .default([]),
  upstreamCa: z.string().optional(),
});

/** The body of POST /api/agent-sets/:setId/mcp-servers/:name/connect, which starts an OAuth login. */
export const mcpConnectBody = z.object({
  origin: z.string(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

/** The body of POST /api/mcp-oauth/callback, with the parameters of the redirect of an OAuth login. */
export const mcpCallbackBody = z.object({
  state: z.string(),
  code: z.string().optional(),
  iss: z.string().optional(),
  error: z.string().optional(),
  errorDescription: z.string().optional(),
});

/** The body of PUT /api/agent-sets/:setId/items, with the skill to write. */
export const agentItemBody = z.object({
  name: z.string(),
  content: z.string(),
});

/**
 * The body of POST /api/push/subscribe, with the push subscription of a browser
 * in the form of PushSubscription.toJSON().
 */
export const pushSubscribeBody = z.object({
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  label: z.string().optional(),
});

/** The body of DELETE /api/push/subscribe, with the subscription to remove. */
export const pushUnsubscribeBody = z.object({
  endpoint: z.string(),
});

/**
 * The body of PUT /api/credentials/:id, with the secret to store and the method that got it.
 *
 * The method defaults to a pasted token, for a client that names no method.
 */
export const putCredentialBody = z.object({
  method: z.enum(['token', 'api_key', 'oauth']).default('token'),
  secret: z.string().trim().min(1, 'must not be empty'),
});

/**
 * The body of PUT /api/api-keys/:name, with the hosts of the key, the key and the upstream CA of the hosts.
 * Without a secret, the stored key stays. Without an upstream CA, the upstream CAs of the hosts stay.
 */
export const putApiKeyBody = z.object({
  hosts: z.array(z.string()),
  secret: z.string().trim().min(1, 'must not be empty').optional(),
  upstreamCa: z.string().optional(),
});

/**
 * The body of POST /api/credentials/:id/login/:loginId/code, with the code that
 * the CLI asked for.
 */
export const loginCodeBody = z.object({
  code: filled,
});

/** The last choices in one thread dialog. */
const threadDialogDefaults = z.object({
  modeId: z.string().optional(),
  config: z.record(z.string(), z.string()).optional(),
});

/**
 * The body of PATCH /api/settings, with the settings to write.
 *
 * Each field is optional, because different screens write the git identity
 * and the choices of a dialog. A screen does not need the values of the other
 * screen to save.
 */
export const patchSettingsBody = z.object({
  gitName: z.string().optional(),
  gitEmail: z.string().optional(),
  dialogs: z.record(z.string(), threadDialogDefaults).optional(),
});
