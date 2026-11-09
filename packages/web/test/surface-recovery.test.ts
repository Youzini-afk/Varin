import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DocumentRegistry } from '@varin/ui/lib/documents/registry';
import { parseDocumentWatchEvent, type DocumentsAPI } from '@varin/application-client';
import type { DocumentSurfaceBinding } from '#application-host/lib/documents/authority.js';
import { createDocumentAuthorityHarness } from '#application-host/lib/documents/contract-fixtures.js';
import { createRecoveryFileStore } from '#application-host/lib/recovery/file-store.test-helper.js';
import type { RecoveryFileStore, RecoveryIdentity } from '#application-host/lib/recovery/journal-files.js';
import { createSurfaceRecovery, parseCombinedSafety } from '#application-host/lib/recovery/surface-recovery.js';

async function fixture(loseReply = false) {
  const h = await createDocumentAuthorityHarness();
  const resource = h.resource('created.txt');
  const note = path.join(h.workspaceRoot, resource.resourceId);
  await fs.writeFile(note, '\ufeffcreated\r\n');
  const documents = {
    ...h.authority,
    ackDirtyStateBarrier: h.authority.acknowledgeDirtyStateBarrier,
    watch(...[workspaceId, listener, options]: Parameters<DocumentsAPI['watch']>) {
      const surface = options?.dirtyOwner ? h.authority.registerDirtySurface({ workspaceId, ...options.dirtyOwner },
        event => listener(parseDocumentWatchEvent(event))) : null;
      return { close() { surface?.close(); } };
    },
  } as unknown as DocumentsAPI;
  const registry = new DocumentRegistry({ documents, getGeneration: () => 1, recoverySessionId: 'missing-surface', journalDebounceMs: 0 });
  // The content seam retains only bytes. Registry, barrier admission, capture,
  // restore validation and recovery binding construction are the real owners.
  const content = new Map<string, Buffer>();
  const fileStore: RecoveryFileStore = {
    ...createRecoveryFileStore(),
    async storeContent(_identity, bytes) {
      const objectHash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
      content.set(objectHash, Buffer.from(bytes));
      return { state: { kind: 'regular-file', objectHash, byteLength: bytes.length }, release: async () => {} };
    },
    async readContent(_identity, state) {
      const bytes = content.get(state.objectHash);
      if (!bytes) throw new Error('Missing surface fixture content');
      return Buffer.from(bytes);
    },
  };
  let replyLost = false;
  const recovery = createSurfaceRecovery(fileStore, async request => {
    const result = await h.authority.requestSurfaceOperation(request);
    if (loseReply && request.action === 'restore' && !replyLost) {
      replyLost = true;
      throw new Error('Restore reply lost after Registry applied it');
    }
    return result;
  });
  const identity: RecoveryIdentity = { authorityId: h.authority.hostId, canonicalRoot: h.workspaceRoot,
    filesystemProfile: 'test', workspaceId: h.identity.workspaceId };
  let barrier: Awaited<ReturnType<typeof h.authority.beginDirtyStateBarrier>> | undefined;
  const cleanup = async () => { await barrier?.release(); await registry.dispose(); await h.cleanup(); };
  try {
    await registry.open(resource);
    registry.applyTransaction(resource, 'unsaved draft\n', { origin: 'editor' });
    const original = { ...registry.get(resource)! };
    await registry.flushRecoveryJournals();
    barrier = await h.authority.beginDirtyStateBarrier(identity.workspaceId, [resource.resourceId]);
    const publication = (await h.authority.inspectDirtyBuffers(identity.workspaceId))[0]!;
    const entry = publication.resources[0]!;
    const owner = { ownerId: publication.ownerId, generation: publication.generation,
      registrationId: publication.registrationId!, workspaceId: identity.workspaceId };
    const binding: DocumentSurfaceBinding = { ...entry, baseFormat: entry.baseFormat ?? entry.sourceFormat,
      documentInstanceId: entry.documentInstanceId!, bufferHash: entry.bufferHash!,
      encoding: entry.encoding!, bom: entry.bom!, lineEnding: entry.lineEnding! };
    const prepared = await recovery.prepare(identity, 'remove-created', barrier.barrierId, owner, binding, { kind: 'missing' });
    await prepared.release();
    await fs.unlink(note);
    const applied = recovery.replace(identity, 'remove-created', barrier.barrierId, prepared.safety, 'apply', async () => {});
    if (loseReply) await expect(applied).rejects.toThrow('Restore reply lost');
    else await applied;
    // Reopen the persisted coordination state, not its in-memory object identity.
    const safety = parseCombinedSafety(JSON.parse(JSON.stringify({ kind: 'missing', surfaces: [prepared.safety] }))).surfaces![0]!;
    const reopened = createSurfaceRecovery(fileStore, h.authority.requestSurfaceOperation);
    await reopened.observe('remove-created', barrier.barrierId, safety);
    expect(safety.phase).toBe('applied');
    expect(registry.get(resource)).toMatchObject({ buffer: '', baseContent: '', baseRevision: null,
      dirty: false, status: 'missing', encoding: 'utf-8', bom: false, lineEnding: 'lf' });
    await barrier.release();
    return { registry, resource, original, identity, owner, safety, reopened, cleanup,
      async beginUndo() {
        barrier = await h.authority.beginDirtyStateBarrier(identity.workspaceId, [resource.resourceId]);
        return barrier;
      } };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

it.each([false, true])('undo captures a removed file after restoring its missing baseline (lost reply: %s)', async loseReply => {
  const f = await fixture(loseReply);
  try {
    const barrier = await f.beginUndo();
    const undo = await f.reopened.prepare(f.identity, 'undo-remove-created', barrier.barrierId, f.owner,
      f.safety.appliedBinding!, { kind: 'missing' }, f.safety.text);
    try {
      await f.reopened.replace(f.identity, 'undo-remove-created', barrier.barrierId, undo.safety, 'apply', async () => {});
      expect(f.registry.get(f.resource)).toMatchObject({ buffer: f.original.buffer, baseContent: f.original.baseContent,
        baseRevision: f.original.baseRevision, baseFormat: f.original.baseFormat, dirty: true,
        encoding: f.original.encoding, bom: f.original.bom, lineEnding: f.original.lineEnding, status: 'ready' });
    } finally { await undo.release(); }
  } finally { await f.cleanup(); }
});

it('rejects the saved missing-file binding after the editor format changes', async () => {
  const f = await fixture();
  try {
    f.registry.setFormat(f.resource, { encoding: 'utf-16be' });
    const changed = { ...f.registry.get(f.resource)! };
    const barrier = await f.beginUndo();
    await expect(f.reopened.prepare(f.identity, 'stale-undo', barrier.barrierId, f.owner,
      f.safety.appliedBinding!, { kind: 'missing' }, f.safety.text)).rejects.toMatchObject({ code: 'stale-plan' });
    expect(f.registry.get(f.resource)).toMatchObject({ buffer: changed.buffer, encoding: changed.encoding,
      localEditRevision: changed.localEditRevision, dirty: true });
  } finally { await f.cleanup(); }
});
