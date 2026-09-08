import type {
  AcpLogPage,
  AgentBundlePreview,
  AgentItemBody,
  AgentItemKind,
  AgentSetDetail,
  AgentSetSummary,
  CreateSessionBody,
  CreateThreadBody,
  HealthResponse,
  PushKeyResponse,
  PushSubscribeBody,
  ReviewAnnotationBody,
  ReviewAnnotationsResponse,
  ReviewBaseResponse,
  ReviewFileResponse,
  ReviewTreeResponse,
  SessionDetail,
  SessionSummary,
  StoredAttachment,
  ThreadSummary,
} from '../../shared/types.ts';

/**
 * Typed fetch client for the orchestrator's REST API.
 */

/**
 * Sends one JSON request and returns the parsed body. Throws with the API's
 * own error message when the response is not a success.
 *
 * The content type is declared only for a call that carries a body: the API
 * rejects an empty body that claims to be JSON, and start, stop and delete
 * send none.
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
      // non-JSON error body
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Every REST call the dashboard makes. */
export const api = {
  listSessions: () => request<SessionSummary[]>('/api/sessions'),
  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (body: CreateSessionBody) =>
    request<SessionDetail>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startSession: (id: string) =>
    request<SessionDetail>(`/api/sessions/${id}/start`, { method: 'POST' }),
  stopSession: (id: string) =>
    request<SessionDetail>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  listThreads: (id: string) => request<ThreadSummary[]>(`/api/sessions/${id}/threads`),
  createThread: (id: string, body: CreateThreadBody = {}) =>
    request<ThreadSummary>(`/api/sessions/${id}/threads`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  selectThread: (id: string, threadId: string) =>
    request<ThreadSummary>(`/api/sessions/${id}/threads/${threadId}/select`, {
      method: 'POST',
    }),
  /**
   * Kills what a conversation left running in its box: one process, or all of
   * them.
   *
   * Not `session/cancel`, which is what the composer's stop sends. That
   * interrupts the conversation and reaches the subagents a turn is being
   * held open for; it does nothing to a command still running, which is a
   * child of the agent's own process and outlives the turn by design.
   */
  stopBackgroundWork: (id: string, threadId: string, processId?: string) =>
    request<{ stopped: number }>(`/api/sessions/${id}/threads/${threadId}/background/stop`, {
      method: 'POST',
      body: JSON.stringify({ processId }),
    }),
  /**
   * Stores one file the user attached, and answers with where it landed.
   *
   * The bytes go up as themselves rather than as a form or as base64: this
   * is the one call in the client that carries a file, and the endpoint
   * wants nothing else from it but the name, which travels in the query.
   */
  uploadAttachment: (id: string, file: File) =>
    request<StoredAttachment>(
      `/api/sessions/${id}/attachments?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
    ),
  getLog: (id: string, after = 0) =>
    request<AcpLogPage>(`/api/sessions/${id}/log?after=${after}&limit=200`),
  health: () => request<HealthResponse>('/healthz'),
  pushKey: () => request<PushKeyResponse>('/api/push/key'),
  subscribePush: (body: PushSubscribeBody) =>
    request<void>('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  unsubscribePush: (endpoint: string) =>
    request<void>('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  // --- code review over the session's workspace ---------------------------
  //
  // Batched to match the endpoints: the tree call carries the whole left
  // panel and the file call the whole file view, so a phone on a slow link
  // makes one request per screen.

  reviewTree: (id: string) => request<ReviewTreeResponse>(`/api/sessions/${id}/review/tree`),
  reviewFile: (id: string, path: string) =>
    request<ReviewFileResponse>(
      `/api/sessions/${id}/review/file?path=${encodeURIComponent(path)}`,
    ),
  setAnnotation: (id: string, body: ReviewAnnotationBody) =>
    request<ReviewAnnotationsResponse>(`/api/sessions/${id}/review/annotations`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAnnotation: (id: string, path: string, line: number) =>
    request<ReviewAnnotationsResponse>(
      `/api/sessions/${id}/review/annotations?path=${encodeURIComponent(path)}&line=${line}`,
      { method: 'DELETE' },
    ),
  setReviewBase: (id: string, rev: string | null) =>
    request<ReviewBaseResponse>(`/api/sessions/${id}/review/base`, {
      method: 'PUT',
      body: JSON.stringify({ rev }),
    }),
  deleteReview: (id: string) =>
    request<void>(`/api/sessions/${id}/review`, { method: 'DELETE' }),

  // --- agent configuration -------------------------------------------------
  //
  // Every mutation answers with the whole set, so the editor never has to
  // stitch a patch into what it already holds.

  listAgentSets: () => request<AgentSetSummary[]>('/api/agent-sets'),
  getAgentSet: (setId: string) => request<AgentSetDetail>(`/api/agent-sets/${setId}`),
  createAgentSet: (name: string) =>
    request<AgentSetDetail>('/api/agent-sets', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateAgentSet: (setId: string, body: { name?: string; agentsMd?: string }) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteAgentSet: (setId: string) =>
    request<void>(`/api/agent-sets/${setId}`, { method: 'DELETE' }),
  putAgentItem: (setId: string, body: AgentItemBody) =>
    request<AgentSetDetail>(`/api/agent-sets/${setId}/items`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAgentItem: (setId: string, kind: AgentItemKind, name: string) =>
    request<AgentSetDetail>(
      `/api/agent-sets/${setId}/items?kind=${kind}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  agentSetPreview: (setId: string) =>
    request<AgentBundlePreview>(`/api/agent-sets/${setId}/preview`),
};
