import type { StoredMedia } from '@varin/protocol';
import type { ThreadsAPI } from './threads.js';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from './transport/runtime-switch.js';

type MediaRequest = Omit<Parameters<ThreadsAPI['mediaRead']>[0], 'chunkIndex' | 'expectedContentRef'>;
const equalJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left); const b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key)
    && equalJson(value, (right as Record<string, unknown>)[key]));
};

/** An ephemeral, abortable read through the original holder. No byte cache or hash reader. */
export async function readThreadMedia(
  api: Pick<ThreadsAPI, 'mediaRead'>,
  input: MediaRequest,
  media: StoredMedia,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const request = structuredClone(input);
  const original = structuredClone(media);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const generation = getRuntimeEndpointGeneration();
  const remove = subscribeRuntimeEndpointWillChange(abort);
  const current = () => {
    controller.signal.throwIfAborted();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during media read');
  };
  const fail = () => new Error('The original media response is inconsistent. Refresh the conversation and retry.');
  try {
    const chunks: Uint8Array[] = [];
    let chunkCount = 1; let totalBytes = -1; let length = 0;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      current();
      const chunk = await api.mediaRead({ ...request, chunkIndex, expectedContentRef: original.content_ref.content_object }, controller.signal);
      current();
      if (!chunk || !equalJson(chunk.media, original) || chunk.partIndex !== request.partIndex || chunk.chunkIndex !== chunkIndex
        || !Number.isSafeInteger(chunk.chunkCount) || chunk.chunkCount < 1
        || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0
        || (chunkIndex > 0 && (chunk.chunkCount !== chunkCount || chunk.totalBytes !== totalBytes))
        || typeof chunk.bytesBase64 !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.bytesBase64)) throw fail();
      const decoded = atob(chunk.bytesBase64);
      if (btoa(decoded) !== chunk.bytesBase64) throw fail();
      chunkCount = chunk.chunkCount; totalBytes = chunk.totalBytes; length += decoded.length;
      if (length > totalBytes || (decoded.length === 0 && (totalBytes !== 0 || chunkCount !== 1))) throw fail();
      chunks.push(Uint8Array.from(decoded, char => char.charCodeAt(0)));
    }
    if (length !== totalBytes) throw fail();
    current();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { remove(); signal?.removeEventListener('abort', abort); }
}
