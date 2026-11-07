/** Catalog authenticates the receiving Thread and holds original event bytes. Storage
 * acquires its normal attachment record only when the original file is actually used. */
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { EventAttachmentCapture } from './thread-attachments.js';
import { HarnessServiceError } from '../harness/service-error.js';

const PAGE = 256 * 1024;
export function createEventAttachmentCapture(runtime: Pick<AgentRuntimeClient, 'readEventAttachment'>) {
  return async (threadId: string, ref: string, signal?: AbortSignal): Promise<EventAttachmentCapture> => {
    const first = await runtime.readEventAttachment({ threadId, ref, offset: 0, length: PAGE }, signal);
    if (first.attachment.ref !== ref || !/^sha256-[a-f0-9]{64}$/.test(first.contentHash)
      || !Number.isSafeInteger(first.attachment.byteLength) || first.attachment.byteLength < 0)
      throw new HarnessServiceError('unavailable', 'The original event attachment changed identity');
    return { attachment: first.attachment, contentHash: first.contentHash,
      readPage: async (offset, length) => {
        signal?.throwIfAborted();
        const page = offset === 0 && length === Math.min(PAGE, first.attachment.byteLength) ? first
          : await runtime.readEventAttachment({ threadId, ref, offset, length }, signal);
        if (!isDeepStrictEqual(page.attachment, first.attachment) || page.contentHash !== first.contentHash)
          throw new HarnessServiceError('unavailable', 'The original event attachment changed during transfer');
        return { hash: page.contentHash, byteLength: page.attachment.byteLength, offset: page.offset,
          nextOffset: page.nextOffset, eof: page.eof, bytesBase64: page.bytesBase64 };
      } };
  };
}
