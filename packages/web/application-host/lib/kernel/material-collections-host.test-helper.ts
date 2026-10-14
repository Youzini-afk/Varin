/** Installed materials service and original Storage/read/recovery owners over test stdio.
 * Family/Run identities come from Catalog. No product listener or external fetch runs. */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { WEB_CAPABILITY, VARIN_BUILTIN_WEB_EXTENSION_ID } from '@varin/extension-builtins';
import type { ExtensionToolBinding } from './protocol.generated.js';
import { KernelStorageAdapter, KernelWorkingStateRootStore } from './storage-adapter.js';
import { createMaterialStorageAccess, threadMaterialScope } from './material-storage.js';
import { createWebRuntime } from './web-runtime.js';
import { createExtensionTools, type ExtensionToolScope } from './extension-tool-owner.js';
import { createMaterialReceiptReconciler } from './material-receipts.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createWebMaterialStore } from '../harness/web-materials.js';
import { createDocumentReader } from '../harness/document-reading.js';
import { createMaterialCollections } from '../harness/material-collections.js';
import { createMaterialLifecycle } from '../harness/material-lifecycle.js';
import { createMaterialReviewFixture, withMaterialReviewClient, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';
import { makePdf } from '../harness/pdf-test-fixture.js';
const unreachable = async (): Promise<never> => { throw new Error('Collection fixture attempted network/model/file-source work'); };
const fixture = createMaterialReviewFixture(params => {
  assert.equal(params.sessionId, undefined); assert.equal(params.runId, undefined);
  assert.deepEqual(params.pathScopes, []);
  assert.equal(params.owningWorkspace, params.executionWorkspace);
  assert([threadMaterialScope('thread:parent'), threadMaterialScope('thread:foreign')].includes(String(params.owningWorkspace)));
  for (const cap of params.capabilities as string[]) assert(['storage.read', 'storage.write', 'storage.maintenance', 'storage.gc'].includes(cap));
});
const { kernel, runtime, bridge } = fixture;
let storage: KernelStorageAdapter, extensions: ApplicationExtensionRuntime;
let web: ReturnType<typeof createWebRuntime>, collections: ReturnType<typeof createMaterialCollections>;
let reader: ReturnType<typeof createDocumentReader>;
const scopes: ExtensionToolScope[] = [];
const scopeId = threadMaterialScope('thread:parent');
async function select(frame: Record<string, unknown>) {
  const runId = String(frame.runId), threadId = String(frame.threadId);
  const prepare = createExtensionTools({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [] }),
    prepareConfiguration: (run, required) => web.prepareConfiguration(run, required) });
  const selected = await prepare({ threadId, runId, branchId: (await runtime.run(runId)).branch_id, source: null }, (frame.required ?? []) as ExtensionToolBinding[], new AbortController().signal);
  scopes.push(selected);
  const material = selected.initial.find(entry => entry.binding.tool.name === 'materials'); assert(material);
  const registered = bridge.register(runId, material.lease);
  const snapshots: Record<string, string> = {};
  if (frame.seed) for (const label of ['PRIV', 'PUBL', 'ORPH']) {
    const result = await reader.ingest({ sourceUrl: `https://fixture.invalid/${label}.pdf`, contentType: 'application/pdf',
      source: Buffer.from(makePdf().toString('latin1').replace('LEFT', label), 'latin1') },
    { workspaceId: scopeId, authority: { kind: 'thread', threadId, owningWorkspaceId: scopeId } });
    assert.equal(result.status, 'ok'); if (result.status !== 'ok') throw new Error('Original PDF producer failed');
    snapshots[label] = result.snapshot!.snapshotId;
  }
  write({ kind: 'fixture-prepared', live: { ownerId: registered.ownerId, generation: material.generation, binding: material.binding }, snapshots });
}
async function initialize(frame: Record<string, unknown>) {
  fixture.initialize(frame);
  storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot: String(frame.storageRoot), resolveWorkspaceRoot: unreachable });
  const access = createMaterialStorageAccess({ kernel, storage, onCleanupError: error => { throw error; } });
  const materials = createWebMaterialStore(access);
  reader = createDocumentReader({ materials }); collections = createMaterialCollections(access, { materials });
  const webFetch = createWebFetch({ ssrf: { check: unreachable, isSameHost: () => false }, materials, documentReader: reader });
  web = createWebRuntime({ runtime, webFetch, documentReader: reader, materials, collections, fetch: unreachable, readAuth: unreachable,
    settings: async () => ({ global: {}, globalRevision: 'default', project: {}, projectRevision: 'none', projectTrusted: false }) });
  if (frame.readerOnly) { write({ kind: 'fixture-reader-ready' }); return; }
  extensions = await ApplicationExtensionRuntime.create({ dataDir: join(String(frame.root), 'extensions'), varinVersion: '0.9.25',
    brokerScript: join(resolve('.'), 'packages/extension-host/broker/broker-child.mjs') });
  extensions.capabilities.register(WEB_CAPABILITY, web.capability);
  await extensions.start(); await extensions.activateExtension(VARIN_BUILTIN_WEB_EXTENSION_ID);
  await select(frame);
}
async function publicRead(frame: Record<string, unknown>) {
  await withMaterialReviewClient(runtime, web.user, async api => {
    for (const test of frame.cases as Array<{ threadId: string; branchId: string; snapshotId: string; expected?: string }>) {
      const result = await api.materials.read({ runtime: 'agent', threadId: test.threadId, branchId: test.branchId },
        { snapshotId: test.snapshotId, view: 'text', pages: 'all' });
      assert.equal(result.status, test.expected ? 'ok' : 'snapshot-missing', JSON.stringify(test));
      if (result.status === 'ok') assert(result.markdown?.includes(test.expected!));
    }
    if (frame.image) {
      const test = frame.image as { threadId: string; branchId: string; snapshotId: string };
      const result = await api.materials.read({ runtime: 'agent', threadId: test.threadId, branchId: test.branchId }, { snapshotId: test.snapshotId, view: 'page-image', page: 1 });
      assert.equal(result.status, 'ok'); if (result.status !== 'ok') throw new Error('Shared PDF image unavailable');
      const bytes = result.pageImage ?? result.pageImages?.[0]; assert(bytes);
      assert.equal(Buffer.from(bytes.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
  });
  write({ kind: 'fixture-public-result', ok: true });
}
async function cleanup(frame: Record<string, unknown>) {
  // Exercise the original owner deletion routine, not a new public native Thread-delete API.
  const grant = await kernel.issueGrant({ grantId: 'material-cleanup-fixture', threadId: String(frame.threadId), owningWorkspace: scopeId,
    executionWorkspace: scopeId, pathScopes: [], capabilities: ['storage.read', 'storage.write', 'storage.maintenance', 'storage.gc'] });
  try {
    const originalContext = await storage.contextFromBranchGrant({ grant, owningWorkspaceId: scopeId, executionWorkspaceId: scopeId });
    const context = originalContext;
    const access = { withBranchStore: async <T>(_scope: string, _purpose: string, consume: (store: KernelWorkingStateRootStore, context: typeof originalContext) => Promise<T>): Promise<T> => consume(new KernelWorkingStateRootStore(context), context) };
    await createMaterialLifecycle(access).releaseThreadMaterials(scopeId, String(frame.threadId));
    await kernel.scoped(grant).gc(`fixture-gc:${String(frame.threadId)}`);
  } finally { await kernel.revokeGrant(grant.grantId); }
  write({ kind: 'fixture-cleaned' });
}
async function receive(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (fixture.receive(frame)) return;
  if (frame.kind === 'fixture-select') return select(frame);
  if (frame.kind === 'fixture-public') return publicRead(frame);
  if (frame.kind === 'fixture-cleanup') return cleanup(frame);
  if (frame.kind === 'fixture-failed-receipt') {
    const grant = await kernel.issueGrant({ grantId: 'failed-receipt-fixture', threadId: 'thread:parent', owningWorkspace: scopeId,
      executionWorkspace: scopeId, pathScopes: [], capabilities: ['storage.read', 'storage.write', 'storage.maintenance'] });
    try {
      const client = kernel.scoped(grant);
      const record = { workspaceId: scopeId, recordId: 'material.collection:fixture-cas', recordType: 'material.collection', state: 'temporary', threadId: 'thread:parent', payloadJson: '{}', references: [], ownerIds: [] };
      await client.putRecord({ ...record, operationId: 'fixture-cas-initial' });
      await assert.rejects(client.putRecord({ ...record, operationId: 'fixture-cas-failed', expectedRecordRevision: 0 }));
      const receipt = await client.getOperation('fixture-cas-failed');
      assert.equal(receipt?.state, 'failed');
      const foreign = await kernel.issueGrant({ grantId: 'failure-foreign-fixture', threadId: 'thread:foreign', owningWorkspace: threadMaterialScope('thread:foreign'),
        executionWorkspace: threadMaterialScope('thread:foreign'), pathScopes: [], capabilities: ['storage.read', 'storage.maintenance'] });
      try { await assert.rejects(kernel.scoped(foreign).getOperation('fixture-cas-failed'), /authorization error/); }
      finally { await kernel.revokeGrant(foreign.grantId); }
      write({ kind: 'fixture-failed-receipt-read' });
    } finally { await kernel.revokeGrant(grant.grantId); }
    return;
  }
  if (frame.kind === 'fixture-recover') {
    const errors: string[] = [];
    await createMaterialReceiptReconciler({ runtime, kernel, collections, onError: (id, error) => errors.push(`${id}: ${String(error)}`) })(new AbortController().signal);
    assert.deepEqual(errors, []); write({ kind: 'fixture-recovered' }); return;
  }
  if (frame.kind === 'fixture-list') {
    const result = await collections.execute({ action: 'list' }, { authority: { kind: 'thread', threadId: String(frame.threadId), owningWorkspaceId: scopeId } });
    write({ kind: 'fixture-listed', result: result.result }); return;
  }
  if (frame.kind === 'fixture-finish') {
    for (const selected of scopes) selected.close(); await bridge.close(); if (extensions) await extensions.stop(); await storage.dispose();
    write({ kind: 'fixture-finished' }); return;
  }
  throw new Error(`Unexpected collection frame ${JSON.stringify(frame)}`);
}
createInterface({ input: process.stdin }).on('line', line => {
  void receive(JSON.parse(line) as Record<string, unknown>).catch(error => write({ kind: 'fixture-failed', error: error instanceof Error ? error.stack : String(error) }));
});
