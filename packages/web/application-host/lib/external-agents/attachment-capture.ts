import { ExternalAgentError } from '@varin/application-client';
import type { KernelClient } from '../kernel/kernel-client.js';
import { AttachmentCaptureError, captureOwnedAttachment, restoreCapturedAttachment, releaseCapturedAttachments } from '../kernel/attachment-capture.js';
import type { AttachmentConversation } from './attachments.js';

async function external<T>(work: Promise<T>): Promise<T> {
  try { return await work; }
  catch (error) { if (error instanceof AttachmentCaptureError) throw new ExternalAgentError(error.code, error.message); throw error; }
}
export function captureExternalFile(kernel: KernelClient, conversation: AttachmentConversation, key: string, selectedPath: string,
  source: { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string }, signal?: AbortSignal) {
  return external(captureOwnedAttachment(kernel, conversation, key, selectedPath, source, signal));
}
export function restoreExternalCapture(kernel: KernelClient, conversation: AttachmentConversation, key: string, selectedPath: string, signal?: AbortSignal) {
  return external(restoreCapturedAttachment(kernel, conversation, key, selectedPath, signal));
}
export function releaseExternalCaptures(kernel: KernelClient, conversationId: string) {
  return external(releaseCapturedAttachments(kernel, conversationId));
}
