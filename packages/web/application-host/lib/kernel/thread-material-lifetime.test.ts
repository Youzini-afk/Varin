import { expect, it, vi } from 'vitest';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createThreadMaterialLifetime } from './thread-material-lifetime.js';
import type { MaterialRetention } from './protocol.generated.js';

it('inherits only readable frozen references, survives parent deletion, and releases after the last recipient', async () => {
  const scope = 'thread-materials:parent', f = createMaterialStoreFixture({ workspaceId: scope });
  const authority = (threadId: string) => ({ kind: 'thread' as const, owningWorkspaceId: scope, threadId });
  const draft = { sourceUrl: 'file:///report.docx', finalUrl: 'file:///report.docx', contentType: 'text/plain', representation: 'ooxml-index', document: { kind: 'docx' as const, parser: 'ooxml' } };
  const ref = await f.materials.put(scope, draft, Buffer.from('section index'), authority('parent'), { source: { bytes: Buffer.from('original document'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
  const privateRef = await f.materials.put(scope, draft, Buffer.from('private'), authority('unrelated'));
  const plan: MaterialRetention = { threads: [{ threadId: 'parent', rootThreadId: 'parent', release: false }, { threadId: 'child', rootThreadId: 'parent', release: false }],
    inheritances: [{ parentThreadId: 'parent', childThreadId: 'child', rootThreadId: 'parent', snapshotIds: [ref.snapshotId, privateRef.snapshotId] }] };
  const releaseBrowser = vi.fn();
  const owner = createThreadMaterialLifetime({ storage: f.workingStates, materials: f.materials, runtime: { materialRetention: async () => plan }, releaseBrowser });
  await owner.prepareChild('child'); await owner.prepareChild('child');
  expect([...f.records.values()].filter(record => record.recordType === 'material.inheritance')).toHaveLength(1);
  expect(await f.materials.read(scope, privateRef.snapshotId, authority('child'))).toBeNull();
  plan.threads[0]!.release = true;
  await owner.releaseDeleted();
  expect((await f.reopen().read(scope, ref.snapshotId, authority('child'), { includeSource: true }))?.source?.bytes.toString()).toBe('original document');
  expect(await f.materials.read(scope, ref.snapshotId, authority('unrelated'))).toBeNull();
  plan.threads[1]!.release = true; plan.inheritances = [];
  await owner.releaseDeleted();
  expect(await f.materials.read(scope, ref.snapshotId, authority('child'))).toBeNull();
  expect([...f.records.values()].some(record => record.recordType === 'material.inheritance')).toBe(false);
  expect(await f.materials.read(scope, privateRef.snapshotId, authority('unrelated'))).not.toBeNull();
  expect(releaseBrowser).toHaveBeenCalledWith('child');
});
