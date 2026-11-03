import { expect, it, vi } from 'vitest';
import { createThreadSourceFiles, parseThreadSourceFileOptions, querySourceFiles } from './thread-source-files.js';
import type { KernelComputeService } from './compute-service.js';
import type { KernelComputeResult } from './compute-runner.js';
import { createManagedSourceConsumers } from './managed-source-consumers.js';
import { ThreadAdapter } from './thread-adapter.js';
import { resourceSource } from './thread-context.js';
import type { ThreadSource } from '@varin/application-client';

const identity = { runtime: 'agent' as const, threadId: 'thread:files', branchId: 'branch:files' };
const source: ThreadSource = { resourceOwner: { kind: 'local' }, mode: 'fixed_branch', workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'fixed', revision: 3, tools: [] };
const entry = (path: string, type = 'file') => ({ kind: 'entry', path, revision: '', data: { kind: type } });
const done = (records = [] as ReturnType<typeof entry>[]) => ({ records, status: records.length ? 'ready' : 'empty' } as KernelComputeResult);
const metadata = (records: ReturnType<typeof entry>[]) => vi.fn<Parameters<typeof querySourceFiles>[0]>(async (_input, config) => {
  await config.onRecords?.(records); return done(records);
});

it('pages actual files and empty directories without reading bodies or confusing the page limit with partial native failure', async () => {
  const compute = metadata([entry('z.ts'), entry('empty', 'directory'), entry('a.ts'), entry('nested', 'directory'), entry('nested/b.ts'), entry('link', 'symlink')]);
  const first = await querySourceFiles(compute, source, { limit: 2 });
  expect(first.entries.map(item => item.path)).toEqual(['a.ts', 'empty']);
  expect(first.entries[1]).toEqual({ path: 'empty', relativePath: 'empty', name: 'empty', type: 'directory' });
  expect(first.nextCursor).toBeTypeOf('string');
  const second = await querySourceFiles(compute, source, { limit: 2, cursor: first.nextCursor! });
  expect(second.entries.map(item => item.path)).toEqual(['nested', 'nested/b.ts']);
  const directories = await querySourceFiles(compute, source, { type: 'directory' });
  expect(directories.entries.map(item => item.path)).toEqual(['empty', 'nested']);
  expect(compute.mock.calls[0]![0]).toMatchObject({ operation: 'list', includeRevisions: false });
  expect(compute.mock.calls[0]![0]).not.toHaveProperty('maxResults');
  await expect(querySourceFiles(compute, { ...source, revision: 4 }, { limit: 2, cursor: first.nextCursor! })).rejects.toThrow('continuation changed');
  await expect(querySourceFiles(compute, source, { query: 'different', cursor: first.nextCursor! })).rejects.toThrow('continuation changed');
  await expect(querySourceFiles(async () => ({ status: 'partial', message: 'Unreadable source' } as KernelComputeResult), source)).rejects.toThrow('Unreadable source');
  expect(() => parseThreadSourceFileOptions({ limit: 0 })).toThrow('malformed');
  expect(() => parseThreadSourceFileOptions({ type: ['directory'] })).toThrow('malformed');
});

it('cold local drafts use admitted native directory metadata, never a Thread, skill catalog or capture', async () => {
  const resolved = vi.fn(async () => ({ workspaceId: 'local', hostId: 'A' }));
  const admitted = vi.fn(async () => ({ canonicalPath: '/actual/local', workspaceId: 'local', hostId: 'A' }));
  const directory = vi.fn<KernelComputeService['directory']>(async (_path, _input, config) => { await config?.onRecords?.([entry('empty', 'directory')]); return done(); });
  const unexpected = new Proxy({}, { get: () => { throw new Error('No kernel Thread or content reader is needed'); } });
  const owner = createThreadSourceFiles({ kernel: unexpected as never, documents: { resolveWorkspace: resolved, admitWorkspaceRegistration: admitted } as never,
    validateLiveSource: vi.fn(), compute: { directory } });
  const result = await owner.draftFiles({ source: { resourceOwner: { kind: 'local' }, path: '/picked' } });
  expect(resolved).toHaveBeenCalledWith({ path: '/picked' });
  expect(directory).toHaveBeenCalledWith('/actual/local', expect.objectContaining({ operation: 'list', includeRevisions: false }), expect.objectContaining({ collect: false }));
  expect(result.entries).toEqual([{ path: 'empty', relativePath: 'empty', name: 'empty', type: 'directory' }]);
  admitted.mockRejectedValueOnce(new Error('Trust revoked'));
  await expect(owner.draftFiles({ source: { resourceOwner: { kind: 'local' }, path: '/picked' } })).rejects.toThrow('Trust revoked');
});

it('remote pending and prepared sources stay on B, and release short-lived authority after metadata failure', async () => {
  const remote = { ...source, resourceOwner: { kind: 'managed_host' as const, hostId: 'B', connectionId: 'connection:B', endpointIdentity: 'B:identity' } };
  const files = vi.fn(async () => ({ entries: [{ path: 'B.ts', relativePath: 'B.ts', name: 'B.ts', type: 'file' as const }], nextCursor: null }));
  const bind = vi.fn(async () => ({ authorityId: 'B-read', resourceEpoch: 'B-epoch', source: resourceSource(remote), physicalRoot: null }));
  const service = vi.fn(async (_input: unknown) => { throw new Error('B is unavailable'); });
  const release = vi.fn(async () => ({}));
  const registry = { source: vi.fn(async () => ({ files, bind, service, release })), sourceTargets: vi.fn() };
  const consumers = createManagedSourceConsumers({ coordinatorHostId: () => 'A', registry: registry as never, withRunAuthority: vi.fn() });
  expect((await consumers.files.draftFiles({ source: { resourceOwner: remote.resourceOwner, path: '/same-name' }, type: 'file' })).entries[0]!.path).toBe('B.ts');
  expect(files).toHaveBeenCalledWith({ coordinatorHostId: 'A', path: '/same-name', type: 'file' }, undefined);
  await expect(consumers.files.files(identity, remote, { query: 'B' })).rejects.toThrow('B is unavailable');
  expect(bind).toHaveBeenCalledWith(expect.objectContaining({ source: remote, scope: expect.objectContaining({ kind: 'source_read', threadId: identity.threadId }), purpose: 'read', retention: 'caller' }));
  expect(service.mock.calls[0]![0]).toMatchObject({ authorityId: 'B-read', operation: { kind: 'files', options: { query: 'B' } } });
  expect(release).toHaveBeenCalledWith({ coordinatorHostId: 'A', authorityId: 'B-read', resourceEpoch: 'B-epoch', mode: 'retire' });
});

it('native Thread discovery follows its own latest Run and validates branch and Source before touching metadata', async () => {
  const runtime = { thread: vi.fn(async () => ({ thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, latest_run: { id: 'actual-run' } }] })),
    launch: vi.fn(async () => ({ selection: { source: resourceSource(source) } })) };
  const admit = vi.fn(async () => {}), files = vi.fn(async () => ({ entries: [], nextCursor: null }));
  const adapter = new ThreadAdapter(runtime as never, {} as never, admit, vi.fn());
  adapter.bindSourceFiles({ files, draftFiles: vi.fn() });
  await adapter.files(identity, { type: 'file' });
  expect(admit).toHaveBeenCalledWith(source, identity, 'actual-run', undefined);
  expect(files).toHaveBeenCalledWith(identity, source, { type: 'file' }, undefined, 'actual-run');
  await expect(adapter.files({ ...identity, branchId: 'other' })).rejects.toThrow();
  expect(files).toHaveBeenCalledTimes(1);
  const pending = { ...source, revision: 4 };
  await adapter.files(identity, { source: pending });
  expect(admit).toHaveBeenLastCalledWith(pending, identity, undefined, undefined);
  runtime.launch.mockResolvedValueOnce({ selection: { source: null } } as never);
  expect(await adapter.files(identity)).toEqual({ entries: [], nextCursor: null });
});

it('does not publish late metadata after cancellation', async () => {
  const stop = new AbortController();
  const compute = metadata([entry('late.ts')]);
  compute.mockImplementation(async (_input, config) => { stop.abort(); await config.onRecords?.([entry('late.ts')]); return done(); });
  await expect(querySourceFiles(compute, source, {}, stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it('local fixed metadata retains the immutable branch, never touches disk, and retires its read-only grant after native drainage', async () => {
  const grant = { grantId: 'read-only', capabilities: ['storage.read'], pathScopes: [''] };
  const readBranch = vi.fn(async () => ({ workspaceId: source.workspaceId, branchId: source.branchId, view: 'revision', revision: source.revision }));
  const computeStart = vi.fn(async (input: { jobId: string; workspaceId: string }) => ({ ...done([entry('from-fixed.ts')]), jobId: input.jobId,
    workspaceId: input.workspaceId, kernelEpoch: 'epoch', nextCursor: 1, endCursor: 1, scannedFiles: 1, root: 'immutable-root' }));
  const computeRelease = vi.fn(async () => {}), retireGrant = vi.fn(async () => {}), issueGrant = vi.fn(async (_input: unknown) => grant);
  const kernel = { handshake: { hostId: 'local', storageRoot: '/unopened-storage' }, issueGrant, scoped: () => ({ readBranch, computeStart, computeRelease }), assertGrantForScope: () => grant, retireGrant };
  const admitWorkspaceRegistration = vi.fn(async () => ({ canonicalPath: '/moved-original-root' }));
  const directory = vi.fn(async () => { throw new Error('Fixed metadata cannot consult current disk'); });
  const owner = createThreadSourceFiles({ kernel: kernel as never, compute: { directory }, validateLiveSource: vi.fn(),
    documents: { admitWorkspaceRegistration } as never });
  expect((await owner.files(identity, source, {})).entries[0]!.path).toBe('from-fixed.ts');
  expect(issueGrant.mock.calls[0]![0]).toMatchObject({ capabilities: ['storage.read'], pathScopes: [''], threadId: identity.threadId });
  expect(computeStart.mock.calls[0]![0]).toMatchObject({ operation: 'list', branchId: 'fixed', revision: 3 });
  expect(computeStart.mock.calls[0]![0]).not.toHaveProperty('rootId');
  expect(directory).not.toHaveBeenCalled();
  expect(computeRelease).toHaveBeenCalledOnce();
  expect(retireGrant).toHaveBeenCalledWith('read-only');
  await owner.files(identity, { ...source, mode: 'materialized' }, {});
  expect(issueGrant.mock.calls[1]![0]).toMatchObject({ capabilities: ['storage.read'] });
  expect(computeStart.mock.calls[1]![0]).toMatchObject({ branchId: 'fixed', revision: 3 });
  computeStart.mockImplementationOnce(async input => ({ ...done(), status: 'failed', message: 'Fixed source unavailable', jobId: input.jobId,
    workspaceId: input.workspaceId, kernelEpoch: 'epoch', nextCursor: 0, endCursor: 0, scannedFiles: 0, root: 'immutable-root' }));
  await expect(owner.files(identity, source, {})).rejects.toThrow('Fixed source unavailable');
  expect(retireGrant).toHaveBeenCalledTimes(3);
});

it('retains an existing materialized environment for remote metadata after the old Run tool grant retires', async () => {
  const selected = { ...source, mode: 'materialized' as const, resourceOwner: { kind: 'managed_host' as const, hostId: 'B', connectionId: 'B', endpointIdentity: 'B' } };
  const bind = vi.fn(async (input: { source: ThreadSource }) => ({ source: resourceSource(input.source), physicalRoot: null, authorityId: 'reader', resourceEpoch: 'B-epoch' }));
  const service = vi.fn(async () => ({ entries: [], nextCursor: null })), release = vi.fn();
  const withRunAuthority = vi.fn(async () => { throw new Error('The old Run grant has retired'); });
  const consumers = createManagedSourceConsumers({ coordinatorHostId: () => 'A', registry: { source: async () => ({ bind, service, release }) } as never, withRunAuthority });
  await consumers.files.files(identity, selected, {}, undefined, 'finished-run');
  expect(withRunAuthority).not.toHaveBeenCalled();
  expect(bind).toHaveBeenCalledWith(expect.objectContaining({ source: { ...selected, environmentRunId: 'finished-run' }, scope: expect.objectContaining({ kind: 'source_read' }), purpose: 'read', retention: 'caller' }));
  expect(release).toHaveBeenCalledOnce();
});
