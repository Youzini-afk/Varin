import { randomUUID } from 'node:crypto';
import type { KernelScopedClient } from './kernel-client.js';
import type { KernelObjectSlice, KernelPutBlobResult } from './protocol.generated.js';

export interface FileContentReadOptions { representation?: 'manifest'; rangeObject?: string }
type ReadPage = (offset: number, length: number, options: FileContentReadOptions) => Promise<KernelObjectSlice>;

/** Copy the exact descriptor and its flat raw dependencies, preserving both
 * file version and tree identities across resource Hosts. The Rust receiver
 * validates the descriptor, ranges and owners before publishing any root. */
export async function copyRangeContent(target: Pick<KernelScopedClient, 'putBlobStream' | 'releaseBlob'>,
  reference: string, length: number, read: ReadPage, signal?: AbortSignal): Promise<KernelPutBlobResult> {
  const pageSize = 256 * 1024;
  const manifests: Buffer[] = [];
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const page = await read(offset, pageSize, { representation: 'manifest' });
    const bytes = Buffer.from(page.bytesBase64, 'base64');
    if (page.hash !== reference || page.offset !== offset || page.nextOffset !== offset + bytes.length
      || page.nextOffset > page.byteLength || (!page.eof && !bytes.length)) throw new Error('File version descriptor page changed');
    manifests.push(bytes); offset = page.nextOffset;
    if (page.eof) break;
  }
  const descriptor = Buffer.concat(manifests);
  const version = JSON.parse(descriptor.toString('utf8')) as { format?: number; byteLength?: number;
    ranges?: Array<{ objectHash: string; objectLength: number }> };
  if (version.format !== 1 || version.byteLength !== length || !Array.isArray(version.ranges)) throw new Error('Unsupported file version descriptor');
  const dependencies = new Map<string, number>();
  for (const range of version.ranges) {
    if (!/^sha256-[0-9a-f]{64}$/.test(range.objectHash) || !Number.isSafeInteger(range.objectLength) || range.objectLength < 0
      || dependencies.has(range.objectHash) && dependencies.get(range.objectHash) !== range.objectLength) throw new Error('Invalid file version dependency');
    dependencies.set(range.objectHash, range.objectLength);
  }
  const owners: string[] = [];
  try {
    for (const [hash, byteLength] of dependencies) {
      const chunks = (async function* () {
        let position = 0;
        while (position < byteLength) {
          signal?.throwIfAborted();
          const page = await read(position, Math.min(pageSize, byteLength-position), { rangeObject: hash });
          const bytes = Buffer.from(page.bytesBase64, 'base64');
          if (page.hash !== hash || page.offset !== position || page.byteLength !== byteLength || page.nextOffset !== position + bytes.length
            || !bytes.length || page.nextOffset > byteLength || page.eof !== (page.nextOffset === byteLength)) throw new Error('File version dependency page changed');
          position = page.nextOffset; yield bytes;
        }
      })();
      const blob = await target.putBlobStream(chunks, { operationId: `file-version-range:${randomUUID()}`, byteLength, expectedHash: hash }, signal);
      owners.push(blob.ownerId);
    }
    const result = await target.putBlobStream((async function* () { yield descriptor; })(),
      { operationId: `file-version:${randomUUID()}`, byteLength: descriptor.length, expectedHash: reference }, signal);
    if (result.hash !== reference || result.byteLength !== length) throw new Error('Transferred file version changed identity');
    return result;
  } finally {
    // Once installed the descriptor owner retains dependencies through the
    // original Storage reachability rules; upload owners are temporary.
    await Promise.all(owners.map(owner => target.releaseBlob(owner)));
  }
}
