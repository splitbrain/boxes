import type { TaskUsage } from '../../../shared/task-notifications.ts';

/**
 * What the thread does with a background task's report.
 *
 * What the harness sends, and how it is read back out of a transcript, is
 * shared between both ends. This is the display half: the name the renderer
 * is keyed by, and the one line that says what a task cost.
 */

/** The name the converted part carries, and the renderer is keyed by. */
export const TASK_NOTIFICATION_PART = 'task-notification';

/** A token count as something to read, in the units a person would say. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  if (tokens < 1000 * 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${(tokens / (1000 * 1000)).toFixed(1)}M tokens`;
}

/**
 * A duration as something to read; seconds below a minute, then minutes.
 *
 * Exported because a task that is still going is timed the same way as one
 * that has finished — the row under a report and the bar above the composer
 * should not count in two different vocabularies.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** What a task cost, as the one line the row shows under it. */
export function formatUsage(usage: TaskUsage): string {
  return [
    usage.tokens === undefined ? '' : formatTokens(usage.tokens),
    usage.toolUses === undefined
      ? ''
      : `${usage.toolUses} tool ${usage.toolUses === 1 ? 'call' : 'calls'}`,
    usage.durationMs === undefined ? '' : formatDuration(usage.durationMs),
  ]
    .filter(Boolean)
    .join(' · ');
}
