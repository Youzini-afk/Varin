import path from 'node:path';
import type { KernelClient } from './kernel-client.js';
import { captureOwnedAttachment, restoreCapturedAttachment } from './attachment-capture.js';

/** Documents admission grants only the selected absolute file; the execution Source stays unchanged. */
export function createAbsoluteAttachmentCapture(options: {
  kernel: KernelClient;
  resolveWorkspace(directory: string, signal?: AbortSignal): Promise<{ workspaceId: string; canonicalRoot: string }>;
}) {
  return async (input: { threadId: string; operationId: string; ref: string; selectedPath: string; captureScope?: string }, signal?: AbortSignal) => {
    if (!path.isAbsolute(input.selectedPath)) throw new Error('Select an absolute path on this resource Host');
    const owner = { id: input.threadId, ...(input.captureScope ? { captureScope: input.captureScope } : {}) }, key = JSON.stringify(['absolute', input.captureScope ?? 'local', input.operationId, input.ref]);
    const retained = await restoreCapturedAttachment(options.kernel, owner, key, input.selectedPath, signal);
    if (retained) return retained;
    const selected = await options.resolveWorkspace(path.dirname(input.selectedPath), signal);
    signal?.throwIfAborted();
    return captureOwnedAttachment(options.kernel, owner, key, input.selectedPath, {
      workspaceId: selected.workspaceId, executionWorkspaceId: selected.workspaceId, canonicalRoot: selected.canonicalRoot,
    }, signal, false, input.captureScope ? undefined : `attachment-preparation:${Buffer.from(input.operationId).toString('base64url')}:ref:${Buffer.from(input.ref).toString('base64url')}`);
  };
}
