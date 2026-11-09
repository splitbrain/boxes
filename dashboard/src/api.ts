import type {
  AgentBundlePreview,
  AgentItemBody,
  AgentMcpServerBody,
  AgentRepoBody,
  AgentSetDetail,
  AgentSetSummary,
  ApiKeySummary,
  BoxDetail,
  BoxSummary,
  CreateBoxBody,
  CreateEgressProfileBody,
  CreateThreadBody,
  CredentialId,
  CredentialMethod,
  CredentialSummary,
  EgressDenial,
  EgressProfileDetail,
  EgressProfileSummary,
  HarnessInfo,
  HealthResponse,
  LoginCodeBody,
  LoginState,
  McpCallbackAnswer,
  McpCallbackBody,
  McpConnectAnswer,
  McpConnectBody,
  PushKeyResponse,
  PushSubscribeBody,
  ReviewAnnotationBody,
  ReviewAnnotationsResponse,
  ReviewBaseResponse,
  ReviewDirResponse,
  ReviewFileBody,
  ReviewFileResponse,
  Settings,
  StartLoginResponse,
  StoredAttachment,
  ThreadSummary,
  UpdateEgressProfileBody,
} from '../../shared/types.ts';

/**
 * A request that the API refused, with the HTTP status and the message of the API.
 *
 * A caller shows the message. A caller can use the status to handle one type of refusal, e.g., a save that the API
 * refused because the file hash changed.
 */
export class ApiError extends Error {
  /**
   * @param status The HTTP status of the response.
   * @param message The API's error message, or the status line.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Sends one JSON request and returns the parsed body, or undefined for a 204.
 *
 * Sets the JSON content type only when the call has a body, because the API
 * rejects an empty body that claims to be JSON.
 *
 * @param path The URL path of the request.
 * @param init The fetch options.
 * @returns The parsed response body.
 * @throws {ApiError} When the response is not a success.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // The error body is not JSON.
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Typed client for the orchestrator's REST API. */
export const api = {
  /**
   * Lists every box.
   *
   * @returns The summary of each box.
   */
  listBoxes: () => request<BoxSummary[]>('/api/boxes'),
  /**
   * Reads one box.
   *
   * @param id The id of the box.
   * @returns The details of the box.
   */
  getBox: (id: string) => request<BoxDetail>(`/api/boxes/${id}`),
  /**
   * Creates a box.
   *
   * @param body The settings of the new box.
   * @returns The details of the new box.
   */
  createBox: (body: CreateBoxBody) =>
    request<BoxDetail>('/api/boxes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Starts the container of a box.
   *
   * @param id The id of the box.
   * @returns The details of the box after the start.
   */
  startBox: (id: string) => request<BoxDetail>(`/api/boxes/${id}/start`, { method: 'POST' }),
  /**
   * Stops the container of a box.
   *
   * @param id The id of the box.
   * @returns The details of the box after the stop.
   */
  stopBox: (id: string) => request<BoxDetail>(`/api/boxes/${id}/stop`, { method: 'POST' }),
  /**
   * Deletes a box.
   *
   * @param id The id of the box.
   */
  deleteBox: (id: string) => request<void>(`/api/boxes/${id}`, { method: 'DELETE' }),
  /**
   * Lists the threads of a box.
   *
   * @param id The id of the box.
   * @returns The summary of each thread.
   */
  listThreads: (id: string) => request<ThreadSummary[]>(`/api/boxes/${id}/threads`),
  /**
   * Adds a thread to a box, empty or with the context of the thread named by `from`.
   *
   * @param id The id of the box.
   * @param body The thread to fork and the options of the new thread.
   * @returns The summary of the new thread.
   */
  createThread: (id: string, body: CreateThreadBody = {}) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Marks a thread done, or removes the mark, and returns the thread.
   *
   * The mark changes only how the dashboard shows the thread.
   *
   * @param id The id of the box.
   * @param threadId The id of the thread.
   * @param done True to set the mark, false to remove it.
   * @returns The summary of the thread.
   */
  setThreadDone: (id: string, threadId: string, done: boolean) =>
    request<ThreadSummary>(`/api/boxes/${id}/threads/${threadId}/done`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),
  /**
   * Stops one task a thread left running, or every task it has, and returns
   * how many the adapter stopped.
   *
   * A cancel does not stop a background command, because the command
   * continues to run after the turn that started it.
   *
   * @param id The id of the box.
   * @param threadId The id of the thread.
   * @param processId The adapter's id for the task. Without it, every task
   *   of the thread stops.
   * @returns The number of tasks that the adapter stopped.
   */
  stopBackgroundWork: (id: string, threadId: string, processId?: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/threads/${threadId}/background/stop`, {
      method: 'POST',
      body: JSON.stringify({ processId }),
    }),
  /**
   * Kills every process in a box that Boxes did not start, and returns
   * how many processes got the signal.
   *
   * After an adapter restart, no adapter knows the tasks that the old process
   * left running. The orchestrator uses the process table of the box container.
   *
   * @param id The id of the box.
   * @returns The number of processes that got the signal.
   */
  stopBoxWork: (id: string) =>
    request<{ stopped: number }>(`/api/boxes/${id}/background/stop`, { method: 'POST' }),
  /**
   * Uploads one attached file into the box's workspace and returns where it
   * was stored.
   *
   * The body holds the raw bytes. The query holds the file name.
   *
   * @param id The id of the box.
   * @param file The file to upload.
   * @returns The stored name, path and size of the file.
   */
  uploadAttachment: (id: string, file: File) =>
    request<StoredAttachment>(
      `/api/boxes/${id}/attachments?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    ),
  /**
   * Reads the orchestrator's health probe.
   *
   * @returns The health of the deployment.
   */
  health: () => request<HealthResponse>('/healthz'),
  /**
   * Reads the public key a browser subscribes to push with.
   *
   * @returns The public key.
   */
  pushKey: () => request<PushKeyResponse>('/api/push/key'),
  /**
   * Registers a browser's push subscription.
   *
   * @param body The push subscription of the browser.
   */
  subscribePush: (body: PushSubscribeBody) =>
    request<void>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Removes the push subscription with this endpoint.
   *
   * @param endpoint The endpoint URL of the subscription.
   */
  unsubscribePush: (endpoint: string) =>
    request<void>('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  /**
   * Reads one directory of the review, with all the data that the side panel needs.
   *
   * @param id The id of the box.
   * @param path The path relative to the workspace, or empty for the workspace root.
   * @param fresh True when the browser arrives at the review, and false when it opens a folder.
   *   When true, the orchestrator reads the git state again.
   * @returns The directory data.
   */
  reviewDir: (id: string, path: string, fresh: boolean) =>
    request<ReviewDirResponse>(
      `/api/boxes/${id}/review/dir?path=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`,
    ),
  /**
   * Reads one file of the review, with all the data that the file view needs.
   *
   * @param id The id of the box.
   * @param path The path of the file, relative to the workspace.
   * @returns The file data.
   */
  reviewFile: (id: string, path: string) =>
    request<ReviewFileResponse>(`/api/boxes/${id}/review/file?path=${encodeURIComponent(path)}`),
  /**
   * Saves an edited file.
   *
   * @param id The id of the box.
   * @param body The path, the new content and the hash that the browser last read.
   * @returns The file as the orchestrator reads it back.
   */
  saveReviewFile: (id: string, body: ReviewFileBody) =>
    request<ReviewFileResponse>(`/api/boxes/${id}/review/file`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Adds or replaces the comment on one line.
   *
   * @param id The id of the box.
   * @param body The file, the line and the comment.
   * @returns The comments after the change.
   */
  setAnnotation: (id: string, body: ReviewAnnotationBody) =>
    request<ReviewAnnotationsResponse>(`/api/boxes/${id}/review/annotations`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Removes the comment on one line.
   *
   * @param id The id of the box.
   * @param path The path of the file, relative to the workspace.
   * @param line The line of the comment.
   * @returns The comments after the change.
   */
  deleteAnnotation: (id: string, path: string, line: number) =>
    request<ReviewAnnotationsResponse>(
      `/api/boxes/${id}/review/annotations?path=${encodeURIComponent(path)}&line=${line}`,
      { method: 'DELETE' },
    ),
  /**
   * Sets the revision the review compares against.
   *
   * @param id The id of the box.
   * @param rev The revision, or null for HEAD.
   * @returns The stored base and the commit it resolves to in each repository.
   */
  setReviewBase: (id: string, rev: string | null) =>
    request<ReviewBaseResponse>(`/api/boxes/${id}/review/base`, {
      method: 'PUT',
      body: JSON.stringify({ rev }),
    }),
  /**
   * Deletes the REVIEW.md of a box, which holds the review.
   *
   * @param id The id of the box.
   */
  deleteReview: (id: string) => request<void>(`/api/boxes/${id}/review`, { method: 'DELETE' }),

  /**
   * Selects the egress profile of a box.
   *
   * @param id The id of the box.
   * @param egressProfile The id of the profile, or null for the default profile.
   * @returns The box after the change.
   */
  setBoxEgressProfile: (id: string, egressProfile: string | null) =>
    request<BoxDetail>(`/api/boxes/${id}/egress-profile`, {
      method: 'PUT',
      body: JSON.stringify({ egressProfile }),
    }),
  /**
   * Lists the targets that the egress profile of a box refused.
   *
   * @param id The id of the box.
   * @returns The refused targets, the most recent first.
   */
  boxDenials: (id: string) => request<EgressDenial[]>(`/api/boxes/${id}/denials`),

  /**
   * Lists every egress profile.
   *
   * @returns The summary of each profile, the default profile first.
   */
  listEgressProfiles: () => request<EgressProfileSummary[]>('/api/egress-profiles'),
  /**
   * Reads one egress profile.
   *
   * @param profileId The id of the profile.
   * @returns The profile with its hosts.
   */
  getEgressProfile: (profileId: string) =>
    request<EgressProfileDetail>(`/api/egress-profiles/${profileId}`),
  /**
   * Creates an egress profile.
   *
   * @param body The name, and optionally the mode and the hosts.
   * @returns The new profile.
   */
  createEgressProfile: (body: CreateEgressProfileBody) =>
    request<EgressProfileDetail>('/api/egress-profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Changes the name, the mode or the hosts of an egress profile.
   *
   * @param profileId The id of the profile.
   * @param body The fields to change.
   * @returns The profile after the change.
   */
  updateEgressProfile: (profileId: string, body: UpdateEgressProfileBody) =>
    request<EgressProfileDetail>(`/api/egress-profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /**
   * Deletes an egress profile.
   *
   * @param profileId The id of the profile.
   */
  deleteEgressProfile: (profileId: string) =>
    request<void>(`/api/egress-profiles/${profileId}`, { method: 'DELETE' }),

  /**
   * Lists every agent set.
   *
   * @returns The summary of each agent set.
   */
  listAgentSets: () => request<AgentSetSummary[]>('/api/agent-sets'),
  /**
   * Reads one agent set.
   *
   * @param setId The id of the agent set.
   * @returns The whole set.
   */
  getAgentSet: (setId: string) => request<AgentSetDetail>(`/api/agent-sets/${setId}`),
  /**
   * Creates an empty agent set.
   *
   * @param name The name of the new set.
   * @returns The whole new set.
   */
  createAgentSet: (name: string) =>
    request<AgentSetDetail>('/api/agent-sets', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  /**
   * Renames a set or replaces its AGENTS.md.
   *
   * @param setId The id of the agent set.
   * @param body The new name, the new AGENTS.md, or both.
   * @returns The whole set after the change.
   */
  updateAgentSet: (setId: string, body: { name?: string; agentsMd?: string }) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /**
   * Deletes an agent set.
   *
   * @param setId The id of the agent set.
   */
  deleteAgentSet: (setId: string) =>
    request<void>(`/api/agent-sets/${setId}`, { method: 'DELETE' }),
  /**
   * Adds or replaces one skill of a set.
   *
   * @param setId The id of the agent set.
   * @param body The name and the SKILL.md of the skill.
   * @returns The whole set after the change.
   */
  putAgentItem: (setId: string, body: AgentItemBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Removes one skill of a set.
   *
   * @param setId The id of the agent set.
   * @param name The name of the skill.
   * @returns The whole set after the change.
   */
  deleteAgentItem: (setId: string, name: string) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  /**
   * Adds one MCP server to a set, or changes the headers or the upstream CA of a server.
   *
   * @param setId The id of the agent set.
   * @param body The name, the URL, the auth mode, the headers and the upstream CA of the server.
   * @returns The whole set after the change.
   */
  putAgentMcpServer: (setId: string, body: AgentMcpServerBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/mcp-servers`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Removes one MCP server of a set.
   *
   * @param setId The id of the agent set.
   * @param name The name of the server.
   * @returns The whole set after the change.
   */
  deleteAgentMcpServer: (setId: string, name: string) =>
    request<AgentSetDetail>(
      `/api/agent-sets/${setId}/mcp-servers?name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  /**
   * Starts the OAuth login of an MCP server.
   *
   * @param setId The id of the agent set.
   * @param name The name of the server.
   * @param body The origin of the dashboard, and the client that the user entered.
   * @returns The authorization URL, or the request for a client ID.
   */
  connectAgentMcpServer: (setId: string, name: string, body: McpConnectBody) =>
    request<McpConnectAnswer>(
      `/api/agent-sets/${setId}/mcp-servers/${encodeURIComponent(name)}/connect`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /**
   * Ends the OAuth login of an MCP server with the parameters of the redirect.
   *
   * @param body The parameters of the redirect.
   * @returns The id of the agent set of the server.
   */
  mcpOAuthCallback: (body: McpCallbackBody) =>
    request<McpCallbackAnswer>('/api/mcp-oauth/callback', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Adds a repository to take skills from, and pulls it.
   *
   * @param setId The id of the agent set.
   * @param body The URL and the ref of the repository.
   * @returns The whole set after the change.
   */
  addAgentRepo: (setId: string, body: AgentRepoBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/repos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /**
   * Removes a repository from a set.
   *
   * @param setId The id of the agent set.
   * @param repoId The id of the repository.
   * @returns The whole set after the change.
   */
  deleteAgentRepo: (setId: string, repoId: string) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/repos/${repoId}`, { method: 'DELETE' }),
  /**
   * Pulls one repository of a set now.
   *
   * @param setId The id of the agent set.
   * @param repoId The id of the repository.
   * @returns The whole set after the pull.
   */
  pullAgentRepo: (setId: string, repoId: string) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/repos/${repoId}/pull`, { method: 'POST' }),
  /**
   * Reads the agent files that a box with this set receives, including the global set.
   *
   * @param setId The id of the agent set.
   * @returns The merged AGENTS.md and skills.
   */
  agentSetPreview: (setId: string) =>
    request<AgentBundlePreview>(`/api/agent-sets/${setId}/preview`),

  /**
   * Lists every harness that this deployment can run.
   *
   * Each harness has the registry defaults, the last capabilities of its adapter and the state of its credential. The
   * health probe returns the same harnesses without the catalogues.
   *
   * @returns The data of each harness.
   */
  harnesses: () => request<HarnessInfo[]>('/api/harnesses'),

  /**
   * Lists every stored credential.
   *
   * @returns The account and status of each credential, without the secret.
   */
  listCredentials: () => request<CredentialSummary[]>('/api/credentials'),
  /**
   * Stores a pasted secret for a credential.
   *
   * @param id The id of the credential.
   * @param method The type of the secret: a token, an API key or an OAuth token.
   * @param secret The secret.
   * @returns The account and status of the credential, without the secret.
   */
  putCredential: (id: CredentialId, method: CredentialMethod, secret: string) =>
    request<CredentialSummary>(`/api/credentials/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ method, secret }),
    }),
  /**
   * Removes a stored credential.
   *
   * @param id The id of the credential.
   */
  deleteCredential: (id: CredentialId) =>
    request<void>(`/api/credentials/${id}`, { method: 'DELETE' }),

  /**
   * Lists every API key a user added.
   *
   * @returns The name, the hosts and the last four characters of each key.
   */
  listApiKeys: () => request<ApiKeySummary[]>('/api/api-keys'),
  /**
   * Stores an API key, or only its hosts when no secret is given.
   *
   * @param name The environment variable name of the key.
   * @param hosts The hosts for which the egress proxy swaps in the key.
   * @param secret The key. Without it, the orchestrator keeps the stored key.
   * @param upstreamCa The upstream CA for all hosts as PEM, an empty string to remove the upstream CA of the hosts,
   *   or undefined to keep the upstream CAs of the hosts.
   * @returns The name, the hosts, the last four characters and the upstream CA of the key, and the flag for hosts
   *   with different upstream CAs.
   */
  putApiKey: (name: string, hosts: string[], secret?: string, upstreamCa?: string) =>
    request<ApiKeySummary>(`/api/api-keys/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({
        hosts,
        ...(secret ? { secret } : {}),
        ...(upstreamCa !== undefined ? { upstreamCa } : {}),
      }),
    }),
  /**
   * Removes an API key.
   *
   * @param name The environment variable name of the key.
   */
  deleteApiKey: (name: string) =>
    request<void>(`/api/api-keys/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /**
   * Starts a login. The orchestrator runs the CLI of the harness in a temporary container.
   *
   * @param id The id of the credential.
   * @returns The id that the other login calls take.
   */
  startLogin: (id: CredentialId) =>
    request<StartLoginResponse>(`/api/credentials/${id}/login`, { method: 'POST' }),
  /**
   * Reads the state of a login. `CredentialLogin` polls this call.
   *
   * @param id The id of the credential.
   * @param loginId The id of the login.
   * @returns The state of the login.
   */
  loginState: (id: CredentialId, loginId: string) =>
    request<LoginState>(`/api/credentials/${id}/login/${loginId}`),
  /**
   * Sends the code from the login page of the provider to the CLI.
   *
   * Only Claude's CLI asks for a code. The login state reports what happens
   * next.
   *
   * @param id The id of the credential.
   * @param loginId The id of the login.
   * @param code The code that the user pasted.
   */
  submitLoginCode: (id: CredentialId, loginId: string, code: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code } satisfies LoginCodeBody),
    }),
  /**
   * Cancels a login and removes its container.
   *
   * @param id The id of the credential.
   * @param loginId The id of the login.
   */
  cancelLogin: (id: CredentialId, loginId: string) =>
    request<void>(`/api/credentials/${id}/login/${loginId}`, { method: 'DELETE' }),
  /**
   * Reads the deployment settings.
   *
   * @returns All settings.
   */
  getSettings: () => request<Settings>('/api/settings'),
  /**
   * Writes the settings that the body names.
   *
   * @param body The settings to change.
   * @returns All settings after the change.
   */
  patchSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};
