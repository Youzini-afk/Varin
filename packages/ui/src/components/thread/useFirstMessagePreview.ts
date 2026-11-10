import React from 'react';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { ChatSessionSubmissionStatus, ChatUserMessage } from '../conversation/types';
import type { MessageHandoff } from '../conversation/messageHandoff';

/** The captured submission is a view only; native history takes over as soon as it arrives. */
export function useFirstMessagePreview(draftKey: string, hasHistory: boolean, handoff: MessageHandoff) {
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const request = draft.firstSend ?? draft.firstMessageReceipt;
  const prepared = draft.pendingInput && draft.pendingInput.input.key === request?.key ? draft.pendingInput.input : undefined;
  const key = request?.key, text = request?.editorText, images = prepared?.images ?? request?.images, files = request?.files, contentReferences = request?.contentReferences, contentReferenceOccurrences = request?.contentReferenceOccurrences;
  const selectedAttachments = request?.selectedAttachments, attachmentImageReferences = request?.attachmentImageReferences;
  const message = React.useMemo<ChatUserMessage | undefined>(() => key ? {
    role: 'user', timestamp: Date.now(), contentReferences, contentReferenceOccurrences,
    fileAttachments: [...files?.flatMap(file => file.attachment ? [file.attachment] : []) ?? [], ...selectedAttachments?.flatMap(file => file.attachment ? [file.attachment] : []) ?? []],
    attachmentImageReferences: { ...attachmentImageReferences, ...Object.fromEntries(files?.flatMap(file => file.attachment && file.imageReference !== undefined ? [[file.attachment.ref, file.imageReference]] : []) ?? []) },
    pendingImageFiles: files?.flatMap(file => file.mimeType.startsWith('image/') && file.imageReference !== undefined ? [{ data: file.data, filename: file.filename, reference: file.imageReference, annotation: file.annotation }] : []), pendingFiles: files?.map(file => ({ filename: file.filename, byteLength: file.data.size })),
    content: [{ type: 'text', text: text ?? '' }, ...(images ?? []).map(image => ({ type: 'image' as const, ...image }))],
  } : undefined, [key, text, images, files, selectedAttachments, attachmentImageReferences, contentReferences, contentReferenceOccurrences]);
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
