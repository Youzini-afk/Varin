import type { ThreadIdentity, ThreadSnapshot } from '@varin/application-client';
import type { StreamingToolCall } from '@/lib/agent-runtime/thread-projection';

/**
 * What a conversation's current Run is visibly doing, for peripheral presentation such as the Bot
 * figure. It is derived from the conversation's own projection and owns nothing.
 */
export interface ThreadLiveActivity {
  identity: ThreadIdentity;
  runId: string | null;
  /** The kind of the current Run's latest streamed delta. */
  text: 'thinking' | 'text' | null;
  /** Tool calls of the current Run being written or running, in call order. */
  tools: readonly { name: string; arguments: unknown }[];
}
export interface ThreadProgressActivity { runId: string; activity?: 'text' | 'thinking' | 'retry' | 'provider' }

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function threadLiveActivity(snapshot: ThreadSnapshot, streaming: readonly StreamingToolCall[], progress: ThreadProgressActivity | null): ThreadLiveActivity {
  const run = snapshot.activeRun;
  const runId = run && !['completed', 'failed', 'cancelled'].includes(run.state) ? run.id : null;
  const tools: { name: string; arguments: unknown }[] = [];
  if (runId) {
    for (const operation of snapshot.operations) {
      if (operation.run_id !== runId || (operation.phase !== 'running' && operation.phase !== 'settling')) continue;
      const intent = record(operation.intent), call = record(intent?.call), contract = record(intent?.contract);
      // Only admitted tool contracts; a decorative executor label is not a tool.
      if (intent?.kind !== 'tool' || typeof call?.name !== 'string' || contract?.name !== call.name) continue;
      tools.push({ name: call.name, arguments: call.arguments });
    }
    // A gateway call is already named by its target; its own arguments stay on `gateway`.
    for (const call of streaming) if (!call.interrupted) tools.push({ name: call.name, arguments: call.arguments });
  }
  const text = runId && progress?.runId === runId ? progress.activity === 'thinking' ? 'thinking' : progress.activity === 'text' ? 'text' : null : null;
  return { identity: snapshot.identity, runId, text, tools };
}
