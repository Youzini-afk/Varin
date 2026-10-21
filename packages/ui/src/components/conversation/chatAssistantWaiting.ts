import { resolveChatTimelineItem, type ChatTimelineItem, type ChatTimelineLiveItem, type ChatTimelineRow } from './chatTimelineProjection';
export interface ChatAssistantWaitingPresentation { model?: { id: string; provider: string }; retry?: { attempt: number; retryAt: number } }

const turnHasPersistedAssistant = (item: Extract<ChatTimelineItem, { kind: 'turn' }>): boolean => (
  item.turn.entries.some((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
  ))
);

/**
 * Binds transient assistant activity only to the newest unanswered turn.
 * A completed tail turn is a hard stop: working state from compaction,
 * extension actions, or an older request must not leak onto an earlier turn.
 */
export const findChatAssistantWaitingTurnId = (
  items: readonly ChatTimelineRow[],
  active: boolean,
  liveItem?: ChatTimelineLiveItem,
): string | undefined => {
  if (!active) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index];
    if (row?.kind !== 'turn') continue;
    const item = resolveChatTimelineItem(row, liveItem);
    if (item?.kind !== 'turn') continue;
    if (item.turn.liveAssistant?.stopReason === 'pending') return item.id;
    if (!item.turn.liveAssistant && !turnHasPersistedAssistant(item)) return item.id;
    return undefined;
  }
  return undefined;
};
