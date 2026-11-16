import type { ThreadSnapshot } from '@varin/application-client';
import { resolveChatTimelineItem, type ChatTimelineItem, type ChatTimelineLiveItem, type ChatTimelineRow } from './chatTimelineProjection';
export interface ChatAssistantWaitingPresentation {
  model?: { id: string; provider: string };
  stage?: 'preparingRequest' | 'waitingModel' | 'thinking' | 'responding' | 'preparingTool' | 'stopping';
  retry?: { attempt: number; retryAt: number };
}

/** Presentation follows the current request; time spent waiting is not evidence of reasoning. */
export function presentAssistantWaiting(
  snapshot: Pick<ThreadSnapshot, 'activeRun' | 'modelActivity'> | undefined,
): ChatAssistantWaitingPresentation | undefined {
  const run = snapshot?.activeRun;
  if (run && (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled')) return undefined;
  if (run?.cancel_requested) return { stage: 'stopping' };
  if (run?.waiting_on?.startsWith('context-wait:')) return undefined;
  if (!run) return {};
  if (run.state === 'accepted' || run.state === 'preparing' || run.state === 'runnable') return { stage: 'preparingRequest' };
  if (run.state !== 'generating') return {};
  const model = snapshot?.modelActivity;
  if (model?.retry) return { retry: { attempt: model.retry.attempt, retryAt: model.retry.retryAtMs } };
  if (model && !model.dispatched) return { stage: 'preparingRequest' };
  const phase = model?.phase;
  return { stage: phase === 'reasoning' ? 'thinking' : phase === 'output' ? 'responding'
    : phase === 'tool-call' ? 'preparingTool' : 'waitingModel' };
}

const turnHasPersistedAssistant = (item: Extract<ChatTimelineItem, { kind: 'turn' }>): boolean => (
  item.turn.entries.some((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
  ))
);

/**
 * The current Run can request the model again after a persisted tool call.
 * A completed tail from another Run remains a hard stop.
 */
export const findChatAssistantWaitingTurnId = (
  items: readonly ChatTimelineRow[],
  active: boolean,
  liveItem?: ChatTimelineLiveItem,
  activeRunId?: string,
): string | undefined => {
  if (!active) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index];
    if (row?.kind !== 'turn') continue;
    const item = resolveChatTimelineItem(row, liveItem);
    if (item?.kind !== 'turn') continue;
    if (activeRunId && item.turn.entries.at(-1)?.runId === activeRunId) return item.id;
    if (item.turn.liveAssistant?.stopReason === 'pending') return item.id;
    if (!item.turn.liveAssistant && !turnHasPersistedAssistant(item)) return item.id;
    return undefined;
  }
  return undefined;
};
