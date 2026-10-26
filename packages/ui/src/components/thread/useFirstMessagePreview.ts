import React from 'react';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { ChatSessionSubmissionStatus, ChatUserMessage } from '../conversation/types';
import type { MessageHandoff } from '../conversation/messageHandoff';

/** The captured submission is a view only; native history takes over as soon as it arrives. */
export function useFirstMessagePreview(draftKey: string, hasHistory: boolean, handoff: MessageHandoff) {
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const request = draft.firstSend ?? draft.firstMessageReceipt;
  const key = request?.key, text = request?.text, images = request?.images;
  const message = React.useMemo<ChatUserMessage | undefined>(() => key ? {
    role: 'user', timestamp: Date.now(),
    content: [{ type: 'text', text: text ?? '' }, ...(images ?? []).map(image => ({ type: 'image' as const, ...image }))],
  } : undefined, [key, text, images]);
  React.useLayoutEffect(() => {
    if (!hasHistory && key && message) handoff.preview(key, message.timestamp);
  }, [handoff, hasHistory, key, message]);
  React.useEffect(() => {
    if (hasHistory && draft.firstMessageReceipt) useThreadDraftStore.getState().patch(draftKey, { firstMessageReceipt: undefined });
  }, [draftKey, hasHistory, draft.firstMessageReceipt]);
  const status: ChatSessionSubmissionStatus = draft.pendingInput?.status === 'unknown' ? 'uncertain'
    : draft.firstSend?.status === 'failed' ? 'failed'
    : draft.firstMessageReceipt || draft.pendingInput?.kind === 'submit' && draft.pendingInput.acceptedInputId ? 'accepted'
    : draft.pendingInput ? 'dispatching' : 'preparing';
  return { message: hasHistory ? undefined : message, status };
}
