import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeWorkspaceOwner } from './native-workspaces.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import type { KernelClient } from './kernel-client.js';
import type { ProjectEntry } from '@varin/application-client';
import { nativeGitRoots } from './native-git-roots.js';
import { KernelClientError } from './kernel-error.js';

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


it('shares the original filesystem grant across project adoption, frozen preparation and document/terminal consumers', async () => {
  const ref = { workspaceId: 'original', executionWorkspaceId: 'execution', branchId: 'native', adoptionOperationId: 'adopt', state: 'preparing' as const };
  let project = { id: 'managed', path: '/original', versionedWorkspace: ref } as ProjectEntry;
  const view = { binding: { generation: 1 }, mount: { state: 'ready', path: '/mounted' }, rootId: 'mounted-root' };
  let activeGrant: string | undefined;
  const opened: string[] = [], closed: string[] = [];
  const kernel = {
    handshake: { kernelEpoch: 'epoch', hostId: 'host' },
    issueGrant: async (input: { grantId: string }) => input,
    revokeGrant: vi.fn(async () => undefined),
    onWorkspaceIdle: () => () => {}, subscribeExit: () => () => {},
    scoped: (grant: { grantId: string }) => ({
      inspectWorkspaceBackend: async () => ({ dependenciesReady: true }),
      getOperation: async () => ({ kind: 'workspace.adopt', state: 'committed', result: { branchId: ref.branchId, workspaceId: ref.workspaceId, adoption: { sourceRootId: 'physical' } } }),
      fileRootRegister: async () => ({ rootId: 'physical' }),
      openWorkspace: async () => {
        if (activeGrant && activeGrant !== grant.grantId) throw new Error('workspace_owner_required');
        activeGrant = grant.grantId; opened.push(activeGrant); return view;
      },
      mountWorkspace: async () => view, bindWorkspace: async () => view, inspectWorkspace: async () => view,
      closeWorkspace: async () => { expect(grant.grantId).toBe(activeGrant); closed.push(grant.grantId); activeGrant = undefined; },
    }),
  };
  const original = createNativeWorkspaceOwner({ kernel: kernel as never, documents: { admitWorkspaceRegistration: async () => ({ canonicalPath: '/original' }) } as never,
    projects: async () => [], update: async () => { throw new Error('Do not copy a remote project into target Settings'); } });
  const managed = original.projectLifecycle(async () => [project], async (_id, workspace) => { project = { ...project, versionedWorkspace: workspace }; });
  await managed.enable(project.id);
  const selection = { ...ref, mode: 'native_workspace' as const };
  const [prepared, document] = await Promise.all([original.prepareSelection(selection, 'thread'), original.resolveId(ref.executionWorkspaceId)]);
  expect(prepared.path).toBe('/mounted'); expect(document?.root).toBe('/mounted');
  expect((await managed.inspectProject(project.id)).view).toEqual(view);
  expect(opened).toHaveLength(1);
  // A second coordinator adapter with its own configuration rejoins the same
  // filesystem owner rather than opening another session with another grant.
  const reconnected = original.projectLifecycle(async () => [project], async (_id, workspace) => { project = { ...project, versionedWorkspace: workspace }; });
  await reconnected.enable(project.id);
  expect(opened).toHaveLength(1);
  await reconnected.disable(project.id);
  expect(closed).toEqual(opened);
  await managed.enable(project.id);
  await original.prepareSelection(selection, 'next-thread');
  expect(opened).toHaveLength(2);
  expect(opened[1]).not.toBe(opened[0]);
});

function closingFixture() {
  const source={workspace_id:'original',execution_workspace_id:'execution',branch_id:'native'};
  const ref={workspaceId:'original',executionWorkspaceId:'execution',branchId:'native',adoptionOperationId:'adopt',state:'ready' as const};
  let project={id:'managed',path:'/original',versionedWorkspace:ref} as ProjectEntry;
  let idle=false;
  const listeners=new Set<()=>void>(), exits=new Set<(error:Error)=>void>();
  const emitIdle=()=>{for(const listener of [...listeners])listener();};
  const view={binding:{generation:'original-generation'},mount:{state:'ready',path:'/mounted'},rootId:'original-root'};
  const actor={openWorkspace:vi.fn(async()=>view),mountWorkspace:vi.fn(async()=>view),inspectWorkspace:vi.fn(async()=>view),
    closeWorkspace:vi.fn(async(_address:unknown)=>{if(!idle)throw new KernelClientError({code:'workspace_native_handles_active',message:'Original Close is still pending'});}),
    deleteBranch:vi.fn(async()=>({}))};
  const kernel={handshake:{kernelEpoch:'original-epoch',hostId:'target'},issueGrant:vi.fn(async(input:object)=>input),
    revokeGrant:vi.fn(async()=>{}),scoped:()=>actor,
    onWorkspaceIdle:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    subscribeExit:(listener:(error:Error)=>void)=>{exits.add(listener);return()=>{exits.delete(listener);};},
    agentRuntimeRequest:vi.fn(async()=>({claimed:true}))};
  const documents={admitWorkspaceRegistration:async()=>({canonicalPath:'/original'}),canReleaseNativeSource:async()=>true,forgetNativeSource:vi.fn(async()=>{})};
  const owner=createNativeWorkspaceOwner({kernel:kernel as never,documents:documents as never,projects:async()=>[],update:async()=>{throw new Error('Original source does not own project settings');}});
  const update=vi.fn(async(_id:string,value:import('@varin/application-client').VersionedProjectWorkspace)=>{project={...project,versionedWorkspace:value};});
  const managed=owner.projectLifecycle(async()=>[project],update);
  return {source,owner,managed,actor,kernel,documents,update,listeners,exits,emitIdle,
    finish:()=>{idle=true;emitIdle();},exit:(error:Error)=>{for(const listener of [...exits])listener(error);}};
}

it.each(['release','disable'] as const)('keeps the original grant until actual native Close completes explicit %s',async method=>{
  const f=closingFixture();
  const original=await f.owner.open(f.source);
  const closing=method==='release'?Promise.all([f.owner.releaseSource(f.source),f.owner.releaseSource(f.source)]):f.managed.disable('managed');
  try {
    await vi.waitFor(()=>expect(f.actor.closeWorkspace).toHaveBeenCalledTimes(1));
    expect(f.kernel.revokeGrant).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();
    // A real idle event can belong to another source. It only rechecks the
    // same original generation; it cannot manufacture a detach receipt.
    f.emitIdle();
    await vi.waitFor(()=>expect(f.actor.closeWorkspace).toHaveBeenCalledTimes(2));
    await Promise.resolve();await Promise.resolve();
    expect(f.actor.closeWorkspace).toHaveBeenCalledTimes(2);
    expect(f.kernel.revokeGrant).not.toHaveBeenCalled();
  } finally {f.finish();await closing;}
  expect(f.actor.closeWorkspace).toHaveBeenCalledTimes(3);
  expect(f.actor.closeWorkspace.mock.calls.every(([address])=>JSON.stringify(address)===JSON.stringify({branchId:'native',generation:'original-generation'}))).toBe(true);
  expect(f.kernel.revokeGrant).toHaveBeenCalledExactlyOnceWith(original.grant.grantId);
  if(method==='disable')expect(f.update).toHaveBeenCalledWith('managed',expect.objectContaining({state:'disabled'}));
  expect(f.listeners.size).toBe(0);expect(f.exits.size).toBe(0);
});

it('does not lose native Close delivered before its pending RPC response',async()=>{
  const f=closingFixture();await f.owner.open(f.source);
  f.actor.closeWorkspace.mockImplementationOnce(async()=>{
    f.finish();throw new KernelClientError({code:'workspace_native_handles_active',message:'Close raced the pending response'});
  });
  await f.owner.releaseSource(f.source);
  expect(f.actor.closeWorkspace).toHaveBeenCalledTimes(2);expect(f.kernel.revokeGrant).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);expect(f.exits.size).toBe(0);
});

it('stops awaiting a dead original kernel without revoking or replacing its pending source',async()=>{
  const f=closingFixture();await f.owner.open(f.source);
  const exited=new Error('Original kernel exited');
  const closing=f.owner.releaseSource(f.source).then(()=>({error:undefined}),error=>({error}));
  await vi.waitFor(()=>expect(f.actor.closeWorkspace).toHaveBeenCalledOnce());
  f.exit(exited);
  expect(await closing).toEqual({error:exited});expect(f.kernel.revokeGrant).not.toHaveBeenCalled();
  expect(f.actor.openWorkspace).toHaveBeenCalledOnce();expect(f.listeners.size).toBe(0);expect(f.exits.size).toBe(0);
});

it('does not reinterpret active execution leases as native Close progress',async()=>{
  const f=closingFixture();await f.owner.open(f.source);
  const busy=new KernelClientError({code:'workspace_in_use',message:'Original process is still running'});
  f.actor.closeWorkspace.mockRejectedValue(busy);
  await expect(f.managed.disable('managed')).rejects.toBe(busy);
  expect(f.actor.closeWorkspace).toHaveBeenCalledOnce();expect(f.kernel.revokeGrant).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);expect(f.exits.size).toBe(0);
});

it('defers source retirement without blocking maintenance and resumes only after original Close',async()=>{
  const f=closingFixture();await f.owner.open(f.source);
  expect(await f.owner.retireSource(f.source,'cleanup')).toBe(false);
  expect(f.actor.closeWorkspace).toHaveBeenCalledOnce();expect(f.kernel.revokeGrant).not.toHaveBeenCalled();
  expect(f.kernel.agentRuntimeRequest).toHaveBeenLastCalledWith('runtime.source.retirement',{cleanupId:'cleanup',defer:true});
  expect(f.listeners.size).toBe(0);expect(f.documents.forgetNativeSource).not.toHaveBeenCalled();
  f.finish();
  expect(await f.owner.retireSource(f.source,'cleanup')).toBe(true);
  expect(f.actor.deleteBranch).toHaveBeenCalledWith({operationId:'source-cleanup:cleanup',branchId:'native'},undefined);
  expect(f.documents.forgetNativeSource).toHaveBeenCalledWith(f.source);
});

it('does not reuse a sealed generation while its original close is awaiting native idle',async()=>{
  const f=closingFixture(),original=await f.owner.open(f.source);
  const closing=f.owner.releaseSource(f.source);
  await vi.waitFor(()=>expect(f.actor.closeWorkspace).toHaveBeenCalledOnce());
  const reopening=f.owner.open(f.source);
  try {
    await Promise.resolve();await Promise.resolve();
    expect(f.actor.openWorkspace).toHaveBeenCalledOnce();expect(f.kernel.revokeGrant).not.toHaveBeenCalled();
  } finally {f.finish();await closing;}
  const reopened=await reopening;
  expect(reopened.grant.grantId).not.toBe(original.grant.grantId);
  expect(f.actor.openWorkspace).toHaveBeenCalledTimes(2);
});
