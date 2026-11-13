import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ThreadPrepareSource, ThreadSource } from '@varin/application-client';
import { createWorkspaceRegistry, type NativeWorkspaceReference } from '../documents/workspace-registry.js';
import { createThreadSourcePreparer, normalizeThreadSourcePreparation } from './thread-sources.js';
import { nativeExecutionWorkspaceId } from './native-workspaces.js';
import { resourceSource } from './thread-context.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(mode: ThreadPrepareSource['mode'], scoped: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-source-registration-')); roots.push(root);
  const registryOptions = { hostId: 'original-host', filePath: path.join(root, 'workspaces.json'), fsPromises: fs };
  let registry = createWorkspaceRegistry(registryOptions);
  const reference: NativeWorkspaceReference = { workspace_id: randomUUID(), execution_workspace_id: randomUUID(),
    branch_id: 'adopted:original', ...(scoped ? { native_scope: 'selected/subtree' } : {}) };
  const workspaceId = scoped ? randomUUID() : reference.execution_workspace_id;
  await registry.registerNative(workspaceId, root, reference);
  const input: ThreadPrepareSource = { runtime: 'agent', threadId: 'calendar-thread', branchId: 'calendar-history',
    key: 'original-occurrence', resourceOwner: { kind: 'local' }, workspaceId, mode, content: { mode: 'saved-files' }, captureScopes: [] };
  const key = createHash('sha256').update(JSON.stringify([input.threadId, input.branchId, input.key])).digest('hex');
  const branchId = `source:${key}`;
  const receipt = { root: 'captured-subtree-root', provenance: { consistency: 'fixed-root' as const, selection: {
    captureIdentity: createHash('sha256').update(JSON.stringify(normalizeThreadSourcePreparation(input))).digest('hex'),
    contentMode: 'saved-files' as const, captureScopes: [], omittedDraftPaths: [],
  } } };
  const release = vi.fn(async () => {});
  const store = { readOriginalSource: vi.fn(async (): Promise<typeof receipt | null> => receipt), getBranchRoot: vi.fn(async () => null), pinBranch: vi.fn(async () => ({
    workspaceId: reference.workspace_id, branchId, revision: 0, root: receipt.root, release,
  })) };
  const source: ThreadSource = { resourceOwner: { kind: 'local' }, mode: 'native_workspace', workspaceId: reference.workspace_id,
    executionWorkspaceId: reference.execution_workspace_id, branchId: reference.branch_id!,
    ...(reference.native_scope ? { nativeScope: reference.native_scope } : {}), tools: [] };
  const native = { prepare: vi.fn(async (): Promise<{ path: string; source: ThreadSource }> => ({ path: path.join(root, 'mounted'), source })),
    retainPrepared: vi.fn(async () => {}), open: vi.fn(async () => ({ grant: 'native-grant' })),
    acquire: vi.fn(async () => ({ path: path.join(root, 'captured-mount') })),
    snapshot: vi.fn(async () => { throw new Error('A mismatched original registration must not be captured'); }) };
  const admitWorkspaceRegistration = vi.fn(async (id: string) => {
    const mapping = await registry.get(id);
    if (!mapping) throw new Error('Original registration is missing');
    return mapping;
  });
  const makePreparer = () => createThreadSourcePreparer({ documents: { admitWorkspaceRegistration } as never,
    nativeWorkspaces: native as never,
    workingStates: { withBranchStore: async (_id: string, _reason: string, work: (value: typeof store) => unknown) => work(store) } as never,
    inspectInventory: async () => { throw new Error('An original capture receipt must not recapture current files'); }, sourceTools: async () => ['file.read'] });
  return { input, reference, source, receipt, store, native, release, branchId, root, makePreparer, admitWorkspaceRegistration,
    reopen() { registry = createWorkspaceRegistry(registryOptions); },
    rebind: (value: NativeWorkspaceReference) => registry.registerNative(workspaceId, root, value) };
}

it.each([false, true])('live native registration (scoped=%s) keeps the admitted original tuple through reopen', async scoped => {
  const f = await fixture('live_root', scoped);
  const first = await f.makePreparer()(f.input);
  expect(first.source).toEqual({ ...f.source, tools: ['file.read'] });
  expect(first.sourcePreparation).toEqual({ threadId: f.input.threadId, branchId: f.input.branchId, key: f.input.key,
    resourceOwner: f.input.resourceOwner, workspaceId: f.input.workspaceId, mode: 'live_root',
    nativeSource: resourceSource(f.source), preparedSource: resourceSource(first.source) });
  expect(f.admitWorkspaceRegistration).toHaveBeenCalledWith(f.input.workspaceId, expect.any(AbortSignal));
  expect(f.store.readOriginalSource).not.toHaveBeenCalled();
  f.reopen();
  expect(await f.makePreparer()(f.input)).toEqual(first);
  await expect(f.rebind({ ...f.reference, branch_id: 'different-branch' })).rejects.toThrow('registration changed');
  await expect(f.rebind({ ...f.reference, native_scope: 'different/subtree' })).rejects.toThrow('registration changed');
});

it.each(['branchId', 'executionWorkspaceId', 'nativeScope'] as const)('live native %s must match the persisted registration, not just owning workspace', async field => {
  const f = await fixture('live_root', true);
  f.native.prepare.mockResolvedValue({ path: f.root, source: { ...f.source, [field]: 'different-view' } as ThreadSource });
  await expect(f.makePreparer()(f.input)).rejects.toMatchObject({ code: 'source_changed' });
});

it.each(['materialized', 'fixed_branch'] as const)('restores %s scoped capture with its original registration and new branch root', async mode => {
  const f = await fixture(mode, true);
  const prepared = await f.makePreparer()(f.input);
  expect(prepared.source).toMatchObject({ workspaceId: f.reference.workspace_id, branchId: f.branchId,
    mode: mode === 'materialized' ? 'native_workspace' : 'fixed_branch',
    executionWorkspaceId: mode === 'materialized' ? nativeExecutionWorkspaceId(f.branchId) : f.reference.workspace_id });
  expect(prepared.source).not.toHaveProperty('nativeScope');
  expect(prepared.sourcePreparation?.nativeSource).toEqual(resourceSource(f.source));
  expect(prepared.sourcePreparation?.preparedSource).toEqual(resourceSource(prepared.source));
  expect(prepared.sourcePreparation?.workspaceId).toBe(f.input.workspaceId);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.native.prepare).not.toHaveBeenCalled();
  expect(f.native.acquire).toHaveBeenCalledTimes(mode === 'materialized' ? 1 : 0);
  f.reopen();
  expect(await f.makePreparer()(f.input)).toEqual(prepared);
  f.receipt.provenance.selection.captureIdentity = 'another-input-capture';
  await expect(f.makePreparer()(f.input)).rejects.toThrow('different selection');
});

it('normalization discards caller-supplied source bindings and the real preparer constructs its own', async () => {
  const f = await fixture('live_root', true);
  const forged = { ...f.input, sourcePreparation: { workspaceId: 'forged', nativeSource: { native_scope: 'outside' } } };
  expect(normalizeThreadSourcePreparation(forged)).not.toHaveProperty('sourcePreparation');
  const prepared = await f.makePreparer()(forged);
  expect(prepared.sourcePreparation?.workspaceId).toBe(f.input.workspaceId);
  expect(prepared.sourcePreparation?.nativeSource.native_scope).toBe('selected/subtree');
});


it.each(['branchId', 'nativeScope'] as const)('cannot attest registration A after a fresh capture selects another %s in the same owning workspace', async field => {
  const f = await fixture('materialized', true);
  f.store.readOriginalSource.mockResolvedValueOnce(null);
  f.native.prepare.mockResolvedValueOnce({ path: f.root, source: { ...f.source, [field]: 'different-view' } as ThreadSource });
  await expect(f.makePreparer()(f.input)).rejects.toMatchObject({ code: 'source_changed' });
  expect(f.native.snapshot).not.toHaveBeenCalled();
});
