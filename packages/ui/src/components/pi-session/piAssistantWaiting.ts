import type { ModelDescriptor, PiUserMessage, SessionSnapshot } from '@varin/protocol';
import { projectPiSessionActivity } from '@/lib/pi-runtime/sessionActivity';
import type {
  PiSessionSubmissionMode,
  PiSessionSubmissionStatus,
} from '@/stores/usePiSessionStore';
import { resolvePiTimelineItem, type PiTimelineItem, type PiTimelineLiveItem, type PiTimelineRow } from './piTimelineProjection';

export interface PiAssistantWaitingPresentation {
  model?: Pick<ModelDescriptor, 'id' | 'provider'>;
}

interface PiAssistantWaitingInput {
  liveUser?: PiUserMessage;
  snapshot?: SessionSnapshot;
  submission?: {
    mode: PiSessionSubmissionMode;
    status: PiSessionSubmissionStatus;
  };
}

export const projectPiAssistantWaiting = ({
  liveUser,
  snapshot,
  submission,
}: PiAssistantWaitingInput): PiAssistantWaitingPresentation | undefined => {
  const promptSubmissionActive = submission?.mode === 'prompt'
    && (
      submission.status === 'preparing'
      || submission.status === 'dispatching'
      || submission.status === 'accepted'
    );
  if (!promptSubmissionActive && !liveUser && !projectPiSessionActivity(snapshot).isWorking) {
    return undefined;
  }
  return snapshot?.model ? { model: snapshot.model } : {};
};

const turnHasPersistedAssistant = (item: Extract<PiTimelineItem, { kind: 'turn' }>): boolean => (
  item.turn.entries.some((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
  ))
);

/**
 * Binds transient assistant activity only to the newest unanswered turn.
 * A completed tail turn is a hard stop: working state from compaction,
 * extension actions, or an older request must not leak onto an earlier turn.
 */
export const findPiAssistantWaitingTurnId = (
  items: readonly PiTimelineRow[],
  active: boolean,
  liveItem?: PiTimelineLiveItem,
): string | undefined => {
  if (!active) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const row = items[index];
    if (row?.kind !== 'turn') continue;
    const item = resolvePiTimelineItem(row, liveItem);
    if (item?.kind !== 'turn') continue;
    if (item.turn.liveAssistant?.stopReason === 'pending') return item.id;
    if (!item.turn.liveAssistant && !turnHasPersistedAssistant(item)) return item.id;
    return undefined;
  }
  return undefined;
};
