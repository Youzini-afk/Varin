import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeWorkspaceOwner } from './native-workspaces.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import type { KernelClient } from './kernel-client.js';
import type { ProjectEntry } from '@varin/application-client';
import { nativeGitRoots } from './native-git-roots.js';

it('reuses project authority for internal Git data and admits linked external administration', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'varin-git-roots-')));
  try {
    const project = path.join(root, 'project'), external = path.join(root, 'external-admin');
    await mkdir(path.join(project, 'repo', '.git', 'objects'), { recursive: true });
    await mkdir(path.join(project, 'linked'), { recursive: true });
    await mkdir(path.join(external, 'objects'), { recursive: true });
    await writeFile(path.join(project, 'linked', '.git'), `gitdir: ${external}\n`);
    const resolveWorkspace = vi.fn(async ({ path: directory }: { path: string }) => ({ workspaceId: directory }));
    const roots = await nativeGitRoots(project, { resolveWorkspace,
      admitWorkspaceRegistration: async (workspaceId: string) => ({ canonicalPath: await realpath(workspaceId) }) } as never);
    expect(roots).toContain(await realpath(external));
    expect(resolveWorkspace.mock.calls.every(([input]) => input.path.startsWith(external))).toBe(true);
    expect(roots.some(directory => directory.startsWith(project))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps ordinary project tasks independent of mount dependencies and only prepares an explicitly selected backend', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-project-source-'));
  try {
    let project = { id: 'project', path: directory } as ProjectEntry;
    let finish!: () => void;
    let signalEntered!: () => void;
    const entered = { promise: new Promise<void>(resolve => { signalEntered = resolve; }), resolve: () => signalEntered() };
    const adopting = new Promise<void>(resolve => { finish = resolve; });
    let dependenciesReady = false;
    const view = { binding: { generation: 1 }, mount: { state: 'ready', path: '/mounted/project' }, rootId: 'mounted-root' };
    const actor = {
      getOperation: vi.fn(async () => null), inspectWorkspaceBackend: vi.fn(async () => ({ dependenciesReady, detail: 'WinFsp is not installed', helpUrl: 'https://winfsp.dev/rel/' })),
      fileRootRegister: async () => ({ rootId: 'original-root' }),
      adoptWorkspace: vi.fn(async () => { entered.resolve(); await adopting; }),
      openWorkspace: vi.fn(async () => view), mountWorkspace: vi.fn(async () => view), bindWorkspace: async () => view,
    };
    const kernel = { handshake: { kernelEpoch: 'epoch', hostId: 'host' },
      issueGrant: async (input: object) => input, revokeGrant: async () => {}, scoped: () => actor } as unknown as KernelClient;
    const documents = { resolveWorkspace: async () => ({ workspaceId: 'original' }),
      admitWorkspaceRegistration: async () => ({ canonicalPath: directory }) };
    const owner = createNativeWorkspaceOwner({ kernel, documents: documents as never, projects: async () => [project],
      update: async (_id, value) => { project = { ...project, versionedWorkspace: value }; } });
    const live = { prepare: vi.fn(async () => ({ hostId: 'host', canonicalRoot: directory, rootId: 'original-root' })) };
    const prepare = createThreadSourcePreparer({ documents: documents as never, nativeWorkspaces: owner,
      liveSources: live as never, workingStates: {} as never, inspectInventory: async () => { throw new Error('No old capture'); },
      sourceTools: async () => ['file_read'] });
    const input = { runtime: 'agent' as const, resourceOwner: { kind: 'local' as const }, threadId: 'thread:a', branchId: 'branch:a',
      key: 'first', workspaceId: 'original', mode: 'live_root' as const, content: { mode: 'saved-files' as const }, captureScopes: [] };
    expect((await prepare(input)).source.mode).toBe('live_root');
    expect(actor.inspectWorkspaceBackend).not.toHaveBeenCalled();
    expect(project.versionedWorkspace).toBeUndefined();
    await expect(owner.enable(project.id)).rejects.toMatchObject({ code: 'workspace_backend_unavailable', message: expect.stringContaining('WinFsp') });
    expect(actor.adoptWorkspace).not.toHaveBeenCalled();
    expect((await prepare({ ...input, key: 'ordinary-after-failed-mount' })).source.mode).toBe('live_root');
    dependenciesReady = true;
    const first = owner.enable(project.id);
    await entered.promise;
    const second = owner.enable(project.id);
    finish();
    await Promise.all([first, second]);
    const [a, b] = await Promise.all([prepare({ ...input, key: 'mounted-a' }), prepare({ ...input, threadId: 'thread:b', branchId: 'branch:b' })]);
    expect(a.source.mode).toBe('native_workspace');
    expect(a.source).toEqual(b.source);
    expect(a.path).toBe('/mounted/project');
    expect(actor.adoptWorkspace).toHaveBeenCalledTimes(1);
    expect(actor.openWorkspace).toHaveBeenCalledTimes(1);
    expect(project.versionedWorkspace?.state).toBe('ready');
    expect((await prepare({ ...input, key: 'next-task' })).source).toEqual(a.source);
    expect(actor.adoptWorkspace).toHaveBeenCalledTimes(1);
    expect(live.prepare).toHaveBeenCalledTimes(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function encodingFixture(options: { captured?: import('./protocol.generated.js').KernelTextPolicy; checkpoint?: boolean } = {}) {
  const source = { workspace_id: 'workspace', execution_workspace_id: 'execution', branch_id: 'native', native_scope: 'src' };
  const root = 'selected-root', operationId = 'capture', temporary = `native-snapshot:${operationId}`;
  const view = { binding: { generation: 'generation' }, mount: { state: 'ready', path: '/mounted/native' }, rootId: 'mounted-root' };
  const checkpointPolicy = { root: '/original/src', files: { 'a.c': 'utf-8' }, choiceRevisions: { 'a.c': 2 } };
  const actor = {
    openWorkspace: vi.fn(async () => view), mountWorkspace: vi.fn(async () => view),
    bindWorkspace: vi.fn(async (input: { sourcePath?: string }) => ({ ...view,
      mount: { state: 'ready', path: input.sourcePath ? `/mounted/native/${input.sourcePath}` : '/mounted/native' } })),
    readBranch: vi.fn(async (input: { branchId: string; revision?: number }) => ({ branchId: input.branchId, workspaceId: 'workspace', root,
      view: input.revision === undefined ? 'current' : 'revision', revision: input.revision ?? 0, writeRevision: 0, entries: [],
      ...(input.branchId === 'native' ? options.captured === undefined ? {} : { textEncoding: options.captured } : { textEncoding: checkpointPolicy }) })),
    getOperation: vi.fn(async (id: string) => options.checkpoint && id === operationId ? { kind: 'workspace.checkpoint.fork', state: 'committed',
      result: { filesystem: { sourceBranchId: 'native', targetBranchId: temporary, sourcePath: 'src' } } } : null),
    writeBranch: vi.fn(async () => ({ status: 'committed', writeRevision: 1, root })),
    forkWorkspace: vi.fn(async () => ({})), pinBranch: vi.fn(async () => ({ pinId: 'pin', root })),
    putBlob: vi.fn(async (bytes: Buffer) => ({ hash: 'provenance', ownerId: 'blob-owner', byteLength: bytes.byteLength })),
    forkBranch: vi.fn(async () => ({ created: true })), deleteBranch: vi.fn(async () => ({})),
    unpinBranch: vi.fn(async () => ({})), releaseBlob: vi.fn(async () => undefined),
  };
  const textEncodingPolicy = vi.fn(async (_workspace: string, admitted?: import('../projects/text-encoding.js').TextEncodingSource | null) => {
    expect(admitted?.sourcePath).toBe('src');
    return admitted?.frozenPolicy === undefined ? { root: '/original/src', files: { 'a.c': 'gbk' } } : { ...admitted.frozenPolicy, root: '/original/src' };
  });
  const kernel = { handshake: { kernelEpoch: 'epoch', hostId: 'host' }, textEncodingPolicy,
    issueGrant: async (input: object) => input, scoped: () => actor } as unknown as KernelClient;
  const owner = createNativeWorkspaceOwner({ kernel, documents: {
    admitWorkspaceRegistration: async () => ({ canonicalPath: '/original' }),
  } as never, projects: async () => [], update: async () => undefined });
  return { owner, source, actor, textEncodingPolicy, checkpointPolicy, operationId };
}

it.each([{ files: { 'src/a.c': 'gbk' } }, {}])('exposes captured native Document rules and scopes them once without current settings', async captured => {
  const f = encodingFixture({ captured });
  await f.owner.resolveId('documents', undefined, f.source);
  const source = await f.owner.textEncodingSource('documents');
  expect(source).toMatchObject({ workspaceId: 'workspace', canonicalRoot: '/mounted/native/src', sourcePath: 'src',
    frozenPolicy: { ...captured, root: '/original' } });
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
});

it('keeps an ordinary uncaptured native project on its current project rules', async () => {
  const f = encodingFixture();
  await f.owner.resolveId('documents', undefined, f.source);
  expect(await f.owner.textEncodingSource('documents')).not.toHaveProperty('frozenPolicy');
});

it('freezes default native snapshot policy at the original checkpoint and keeps verified checkpoint codecs', async () => {
  const f = encodingFixture();
  await f.owner.snapshot(f.source, 'target', f.operationId);
  expect(f.actor.forkWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: 'src',
    textEncoding: { root: '/original/src', files: { 'a.c': 'gbk' } } }), undefined);
  expect(f.actor.forkBranch).toHaveBeenCalledWith(expect.objectContaining({ textEncoding: f.checkpointPolicy }), undefined);
  expect(JSON.parse(f.actor.putBlob.mock.calls[0]![0].toString()).textEncoding).toEqual(f.checkpointPolicy);
});

it('recovers a committed checkpoint without recomputing later live or caller policy', async () => {
  const f = encodingFixture({ checkpoint: true });
  f.textEncodingPolicy.mockRejectedValue(new Error('Original live settings are no longer available'));
  await f.owner.snapshot(f.source, 'target', f.operationId, undefined, undefined,
    { textEncoding: { root: '/original/src', files: { 'a.c': 'gbk' } } });
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
  expect(f.actor.forkWorkspace).not.toHaveBeenCalled();
  expect(f.actor.forkBranch).toHaveBeenCalledWith(expect.objectContaining({ textEncoding: f.checkpointPolicy }), undefined);
});


it('overlays actual selected draft codecs on the checkpoint policy rather than stale caller rules', async () => {
  const f = encodingFixture();
  const drafts = { threadId: 'thread', branchId: 'history', snapshotRef: 'drafts', ownerId: 'owner', ownerGeneration: 1,
    resources: [{ workspaceId: 'workspace', resourceId: 'a.c', baseRevision: null, localEditRevision: 1, revision: 'draft', encoding: 'gbk', bom: false }] };
  await f.owner.snapshot(f.source, 'target', f.operationId, undefined, undefined, {
    textEncoding: { root: '/original/src', files: { 'a.c': 'utf-16le' } },
    editorDrafts: [{ path: 'a.c', content: Buffer.from('actual draft') }],
    selection: { captureIdentity: 'a'.repeat(64), contentMode: 'fixed-draft-baseline', captureScopes: [], omittedDraftPaths: [], drafts },
  });
  expect(f.actor.forkWorkspace).toHaveBeenCalledWith(expect.objectContaining({ textEncoding: { root: '/original/src', files: { 'a.c': 'utf-16le' } } }), undefined);
  expect(f.actor.forkBranch).toHaveBeenCalledWith(expect.objectContaining({ textEncoding: {
    ...f.checkpointPolicy, files: { 'a.c': 'gbk' } } }), undefined);
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
});
