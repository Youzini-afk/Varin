/** Binary media held by the existing material storage, with its original Thread owner. */
import { randomUUID } from 'node:crypto';
import type { ImageResourceReference } from '@varin/protocol';
import type { ImageBytes } from '../kernel/image-model.js';
import type { WorkspaceWorkingStateRootAccess } from './working-state/types.js';
import { kernelContext } from './kernel-records.js';

export interface MediaResourceAuthority { owningWorkspaceId: string; threadId: string }

export const MEDIA_RESOURCE_RECORD_TYPE = 'media.resource';
export function createMediaResourceStore(storage: WorkspaceWorkingStateRootAccess) {
  const access = (authority: MediaResourceAuthority): WorkspaceWorkingStateRootAccess => ({
    withBranchStore: (workspaceId, purpose, consume, mode) => storage.withBranchStore(workspaceId, purpose, consume, mode,
      { threadId: authority.threadId }),
  });
  return {
    async put(authority: MediaResourceAuthority, image: ImageBytes, provenance: Record<string, unknown>): Promise<ImageResourceReference> {
      return kernelContext(access(authority), authority.owningWorkspaceId, 'media-resource-put', async (store, context) => {
        const blob = await store.putObject(Buffer.from(image.bytes));
        const resourceId = `media-${randomUUID()}`;
        const ref = { resourceId, mimeType: image.mimeType, byteLength: blob.byteLength };
        await context.records.put({ operationId: `media-resource-put:${resourceId}`, recordId: resourceId, recordType: MEDIA_RESOURCE_RECORD_TYPE,
          state: 'retained', threadId: authority.threadId,
          payloadJson: JSON.stringify({ ...ref, provenance }), ownerIds: [store.ownerIdForObject?.(blob.hash)].filter((id): id is string => !!id),
          references: [{ slot: 'body', objectHash: blob.hash }] });
        return ref;
      });
    },
    async read(authority: MediaResourceAuthority, resourceId: string): Promise<ImageBytes> {
      return kernelContext(access(authority), authority.owningWorkspaceId, 'media-resource-read', async (store, context) => {
        const record = await context.records.get(resourceId);
        if (!record || record.recordType !== MEDIA_RESOURCE_RECORD_TYPE || record.state === 'released'
          || record.threadId !== authority.threadId) {
          throw new Error('Image resource is missing or unavailable to this conversation');
        }
        const payload = JSON.parse(record.payloadJson) as ImageResourceReference;
        const hash = record.references?.find(ref => ref.slot === 'body')?.objectHash;
        if (!hash || payload.resourceId !== resourceId || !payload.mimeType.startsWith('image/')) throw new Error('Image resource metadata is invalid');
        // A fresh storage context has no in-memory upload owner. The retained record
        // is the original proof of access, including after Host restart.
        const bytes = context.client
          ? Buffer.from((await context.client.getBlob(hash, { recordId: record.recordId, slot: 'body' })).bytesBase64, 'base64')
          : await store.getObject(hash);
        if (!bytes || bytes.byteLength !== payload.byteLength) throw new Error('Image resource bytes are unavailable');
        return { bytes, mimeType: payload.mimeType };
      });
    },
  };
}
export type MediaResourceStore = ReturnType<typeof createMediaResourceStore>;
