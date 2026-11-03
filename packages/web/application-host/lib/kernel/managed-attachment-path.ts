import { createHash } from 'node:crypto';
import type { Attachment } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelObjectSlice, KernelObjectView, LaunchSource } from './protocol.generated.js';
import { copyRangeContent, type FileContentReadOptions } from './file-content-transfer.js';
import { resourceThreadSource } from './thread-context.js';

/** The caller holds the original attachment ACL/record for this entire copy.
 * Only immutable bytes are transferred; neither Source nor cwd is changed. */
export async function prepareManagedAttachmentPath(input: {
  runtime: AgentRuntimeClient; runId: string; source: LaunchSource; attachment: Attachment; contentHash: string;
  readPage(offset: number, length: number, view?: FileContentReadOptions): Promise<KernelObjectSlice>; signal?: AbortSignal | undefined;
}): Promise<KernelObjectView> {
  const { runtime, runId, source, attachment, contentHash, readPage, signal } = input;
  const operationId = `attachment-path:${createHash('sha256').update(JSON.stringify([runId, attachment.ref])).digest('hex')}`;
  return runtime.withManagedSourceAuthority(runId, resourceThreadSource(source)!, async ({ client, binding }) => {
    const address = { coordinatorHostId: runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const original = { ...address, operationId, attachment, contentHash };
    const retained = await client.attachmentBegin(original, signal);
    if (retained.complete) return client.attachmentPath(original, signal);
    const put = (body: AsyncIterable<Uint8Array>, objectHash: string, byteLength: number) => client.attachmentPut({ ...address,
      operationId, ref: attachment.ref, contentHash, objectHash, byteLength }, body, signal);
    if (contentHash.startsWith('ranges-')) {
      await copyRangeContent({
        putBlobStream: (body, object) => put(body, object.expectedHash!, object.byteLength),
        // Each target upload is already retained by its independent import
        // record. Source retirement, not a transfer response, releases it.
        releaseBlob: async () => ({}),
      }, contentHash, attachment.byteLength, readPage, signal, operationId);
    } else {
      const chunks = (async function* () {
        let offset = 0;
        while (offset < attachment.byteLength) {
          signal?.throwIfAborted();
          const page = await readPage(offset, Math.min(256 * 1024, attachment.byteLength - offset));
          const bytes = Buffer.from(page.bytesBase64, 'base64');
          if (page.hash !== contentHash || page.byteLength !== attachment.byteLength || page.offset !== offset
            || !bytes.length || page.nextOffset !== offset + bytes.length || page.nextOffset > attachment.byteLength
            || page.eof !== (page.nextOffset === attachment.byteLength)) throw new Error('Original attachment bytes changed during transfer');
          offset = page.nextOffset; yield bytes;
        }
      })();
      await put(chunks, contentHash, attachment.byteLength);
    }
    return client.attachmentPath(original, signal);
  }, signal);
}
