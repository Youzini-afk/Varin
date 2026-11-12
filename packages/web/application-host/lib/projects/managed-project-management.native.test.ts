import { looksLikeCanonicalWorkspaceId } from '../documents/workspace-registry.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import { executeProjectGit, configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@varin/application-client';
import { registerProjectManagementRoutes } from './project-management-routes.js';
import { registerGitRoutes } from '../git/routes.js';
import { createKernelComputeService } from '../kernel/compute-service.js';
import { createKernelProcessIdentityResolver } from '../kernel/process-identity.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { createWorkspaceContentSearch } from '../search/content.js';
import os from 'node:os';
import { createDocumentAuthority } from '../documents/authority.js';
import { bindDocumentTextCodec } from '../documents/inspect.js';
import { createResourceFilesOwner } from '../workspace/resource-files.js';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitWorktreeInfo, GitWorktreeCreateResult, GitWorktreeBootstrapStatus, ProjectWorkspaceStatus, VersionedProjectWorkspace, WorkspaceBackendStatus } from '@varin/application-client';
import { createNativeProcessTestHarness } from '../process/native-process.test-helper.js';
import { createManagedSourceService } from '../harness/managed-source-service.js';
import { registerManagedRemoteRoutes } from '../harness/managed-remote-routes.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { createNativeWorkspaceOwner } from '../kernel/native-workspaces.js';
import { createThreadSourcePreparer } from '../kernel/thread-sources.js';
import { createManagedProjectManagementOwner } from './managed-project-management.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const close of cleanups.splice(0).reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
  } finally { vi.unstubAllEnvs(); }
  if (errors.length) throw new AggregateError(errors, 'Managed project fixture cleanup failed');
});
it('manages the real target Git workspace and joins its original adoption intent without touching the coordinator', async () => {
  const a = createNativeProcessTestHarness(undefined, { hostId: 'management-coordinator' });
  const documentRoot = await mkdtemp(path.join(os.tmpdir(),'varin-managed-documents-'));
  cleanups.push(() => rm(documentRoot, { recursive: true, force: true }));
  const nativeOwner: { current?: ReturnType<typeof createNativeWorkspaceOwner> } = {};
  const documentAuthority = createDocumentAuthority({ hostId:'management-target',dataDir:documentRoot,isAllowedRoot:async()=>true,isTrusted:async()=>true,
    nativeWorkspaces:{resolveId:(id,signal,ref)=>nativeOwner.current?.resolveId(id,signal,ref)??Promise.resolve(undefined),
      resolvePath:(directory,containing)=>nativeOwner.current?.resolvePath(directory,containing)??Promise.resolve(undefined),
      retainReference:(source,key)=>nativeOwner.current!.retainReference(source,key),releaseReference:key=>nativeOwner.current!.releaseReference(key)} });
  const b = createNativeProcessTestHarness(documentAuthority, { hostId: 'management-target' });
  // Caller-owned Documents must drain while its original storage/kernel lives.
  cleanups.push(() => a.dispose(), () => b.dispose(), () => documentAuthority.dispose());
  const coordinator = await a.get(), target = await b.get();
  // Assemble the target's existing native text owner, as the Application Host
  // does. A remote Documents read must not silently rely on another fixture.
  const releaseTextCodec = bindDocumentTextCodec(target.client);
  cleanups.push(async () => { releaseTextCodec(); });
  vi.stubEnv('VARIN_DATA_DIR', path.join(target.root, 'target-config'));
  const directory = path.join(target.root, 'project'), local = path.join(coordinator.root, 'project');
  await mkdir(directory); await mkdir(local); await writeFile(path.join(local, 'sentinel'), 'coordinator untouched');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Native Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(directory, 'original.txt'), 'target original'); git('add', '.'); git('commit', '-m', 'initial');
  const workspace = await target.documents.resolveWorkspace({ path: directory });
  const preparedNative = createNativeWorkspaceOwner({ kernel: target.client, documents: target.documents, projects: async () => [],
    update: async () => { throw new Error('Preparing a frozen source must not mutate a project registration'); } });
  nativeOwner.current = preparedNative;
  const management = createManagedProjectManagementOwner({ kernel: target.client, documents: target.documents,
    nativeWorkspaces: preparedNative, gitDispatch: registerGitRoutes(express(), { documents: target.documents }) });
  const prepare = createThreadSourcePreparer({ documents: target.documents, nativeWorkspaces: preparedNative,
    workingStates: { withBranchStore: async () => { throw new Error('Adopted source must use its original native owner'); } } as never,
    inspectInventory: async () => ({ kind: 'directory' }), sourceTools: mode => target.client.agentRuntimeRequest('runtime.source.tools', { mode }) });
  const compute = createKernelComputeService({client:target.client,resolveIdentity:createKernelProcessIdentityResolver({documents:target.documents})});
  cleanups.push(() => compute.dispose());
  // Production Files and Documents share this exact backend and its original
  // mutation lease. A second backend would compete with the enclosing writer.
  const resourceFiles = createResourceFilesOwner(target.documents,target.backend,undefined,async(selection,signal)=>{
    const registration=await target.documents.admitWorkspaceRegistration(selection.workspaceId,signal);
    return {path:(await preparedNative.prepareSelection(selection,'project-files',signal)).path,originalRoot:registration.canonicalPath};
  }, {files:createFsSearchRuntime({compute}),content:createWorkspaceContentSearch({documents:target.documents,compute})});
  const sources = createManagedSourceService({ kernel: target.client, hostId: 'management-target', documents: target.documents,
    projectManagement: management, workspaceFiles:resourceFiles, validateLiveSource: async () => { throw new Error('Project management uses registered Documents, not a conversation Source'); }, prepareSource: prepare });
  const app = express(); app.use(express.json());
  let pairedRoot = target.root;
  registerManagedRemoteRoutes(app, { documents:target.documents, service: { hostId: 'management-target', sources: () => sources,
    identity: async () => ({ protocolVersion: 1, hostId: 'management-target', capabilities: ['sources'], machine: { machineId: 'managed:management-target', kind: 'managed-remote', state: 'available' } }) } as never,
    resolveAuthContext: async () => ({ type: 'client', clientId: 'paired-management', client: { capabilities: ['filesystem:read','filesystem:write','terminal:use','process:control'], allowedDirectories: [pairedRoot] } } as never) });
  const server = await new Promise<import('node:http').Server>(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'management-coordinator', kernel: coordinator.client, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'target', apiUrl: endpoint }] }) });
  const owner = (await registry.sourceTargets()).targets[0]!.resourceOwner, remote = await registry.source(owner);
  const base = { coordinatorHostId: 'management-coordinator', projectId: 'registered-project', workspaceId: workspace.workspaceId };
  const list = () => remote.projectManagement({ ...base, command: { action: 'worktrees', input: {} } }) as Promise<GitWorktreeInfo[]>;
  expect(await Promise.all((await list()).map(async entry => normalizePathIdentity(await canonicalizePathIdentity(entry.path))))).toEqual([normalizePathIdentity((await target.documents.admitWorkspaceRegistration(workspace.workspaceId)).canonicalPath)]);
  pairedRoot = local;
  await expect(list()).rejects.toThrow(); // A paired host must still respect the target's allowed roots.
  pairedRoot = target.root;
  const created = await remote.projectManagement({ ...base, command: { action: 'worktree-create', input: { worktreeName: 'native-remote', branchName: 'native-remote' } } }) as GitWorktreeCreateResult;
  expect(path.relative(await canonicalizePathIdentity(target.root), await canonicalizePathIdentity(created.path)).startsWith('..')).toBe(false);
  let bootstrap: GitWorktreeBootstrapStatus | undefined;
  await expect.poll(async () => {
    bootstrap = await remote.projectManagement({ ...base, command: { action: 'worktree-bootstrap', input: { directory: created.path } } }) as GitWorktreeBootstrapStatus;
    return bootstrap.status;
  }, { timeout: 10_000 }).not.toBe('pending');
  expect(bootstrap, `Target worktree bootstrap: ${JSON.stringify(bootstrap)}`).toMatchObject({ status: 'ready' });
  expect(await readFile(path.join(created.path, 'original.txt'), 'utf8')).toBe('target original');
  expect(await remote.projectManagement({ ...base, command: { action: 'worktree-remove', input: { directory: created.path, deleteLocalBranch: true } } })).toEqual({ success: true });
  expect(await Promise.all((await list()).map(async entry => normalizePathIdentity(await canonicalizePathIdentity(entry.path))))).toEqual([normalizePathIdentity((await target.documents.admitWorkspaceRegistration(workspace.workspaceId)).canonicalPath)]);
  await expect(remote.projectManagement({ ...base, command: { action: 'worktree-remove', input: { directory: local } } })).rejects.toThrow();
  const physicalLocation={coordinatorHostId:base.coordinatorHostId,root:directory,workspaceId:workspace.workspaceId};
  const originalAsset=await remote.workspaceAsset({...physicalLocation,path:'original.txt',asset:{kind:'raw'}});
  expect(await originalAsset.text()).toBe('target original');
  const physicalBody=Buffer.from('physical target upload through the original Documents lease');
  await remote.workspaceUpload({...physicalLocation,path:'physical-upload.txt',key:'physical-file-write',byteLength:physicalBody.length},(async function*(){yield physicalBody;})());
  expect(await readFile(path.join(directory,'physical-upload.txt'),'utf8')).toBe(physicalBody.toString());
  const physicalDocument = await remote.documents('read', 'POST', { resource: { workspaceId: workspace.workspaceId, resourceId: 'physical-upload.txt' } });
  expect(physicalDocument.status).toBe(200);
  expect(JSON.stringify(await physicalDocument.json())).toContain(physicalBody.toString());
  await mkdir(path.join(directory,'nested'));await writeFile(path.join(directory,'nested','search.txt'),'actual target search content');
  expect(await remote.workspace({...physicalLocation,command:{kind:'filename-search',path:'',query:'search'}})).toMatchObject({kind:'filename-search',results:[{path:'nested/search.txt'}],enumerationStatus:'complete'});
  expect(await remote.workspace({...physicalLocation,command:{kind:'content-search',path:'',query:'actual target',fixedStrings:true}})).toMatchObject({kind:'content-search',result:{status:'ready',hits:[{resource:{workspaceId:workspace.workspaceId,resourceId:'nested/search.txt'},line:1,column:1,revision:expect.any(String)}]}});
  pairedRoot=local;await expect(remote.workspace({...physicalLocation,command:{kind:'filename-search',path:'',query:'search'}})).rejects.toThrow();pairedRoot=target.root;
  const planned = await remote.projectManagement({ ...base, command: { action: 'workspace-plan', input: {} } }) as VersionedProjectWorkspace;
  expect(looksLikeCanonicalWorkspaceId(planned.executionWorkspaceId)).toBe(true);
  // Typed Git commands use the same target Documents writer as HTTP Git.
  const projectSource = { workspaceId: workspace.workspaceId, resourceOwner: owner };
  registerProjectManagementRoutes(app, { requireAuth: (_request, _response, next) => next(), authorize: async () => true,
    coordinatorHostId: base.coordinatorHostId, projects: async () => [{ id: base.projectId, path: directory, source: projectSource } as import('@varin/application-client').ProjectEntry],
    update: async () => { throw new Error('Git does not mutate project registration'); }, remote: async () => remote });
  const priorResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: endpoint });
  cleanups.push(async () => { setRuntimeUrlResolver(priorResolver); });
  const gitCommand = (operation: 'getGitStatus' | 'stageGitFile' | 'unstageGitFile', selection: import('@varin/application-client').ProjectSourceSelection,
    file?: string) => operation === 'getGitStatus'
      ? executeProjectGit(base.projectId, projectSource, selection, operation, [directory])
      : executeProjectGit(base.projectId, projectSource, selection, operation, [directory, file!]);
  await writeFile(path.join(directory, 'git-command.txt'), 'original target index');
  expect(await gitCommand('getGitStatus', {mode:'live_root'})).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({path:'git-command.txt'})]) });
  await gitCommand('stageGitFile', {mode:'live_root'}, 'git-command.txt');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('git-command.txt');
  await gitCommand('unstageGitFile', {mode:'live_root'}, 'git-command.txt');
  expect(git('diff', '--cached', '--name-only').trim()).toBe('');
  const backend = await remote.projectManagement({ ...base, command: { action: 'backend', input: {} } }) as WorkspaceBackendStatus;
  await expect(remote.projectManagement({ ...base, workspace: { ...planned, branchId: 'foreign-branch' }, command: { action: 'enable', input: {} } })).rejects.toThrow();
  const enable = { ...base, workspace: planned, command: { action: 'enable' as const, input: {} } };
  if (backend.dependenciesReady) {
    const first = await remote.projectManagement(enable) as ProjectWorkspaceStatus;
    // Discard the first completion as if its network response was lost. A new
    // connection joins the same original Storage adoption, never recopies.
    const reconnected = await registry.source(owner);
    const retry = await reconnected.projectManagement(enable) as ProjectWorkspaceStatus;
    expect(retry.workspace).toEqual(first.workspace);
    const { state: _state, ...selection } = planned;
    const prepared = await remote.prepare({ coordinatorHostId: base.coordinatorHostId, input: { resourceOwner: owner,
      runtime: 'agent', threadId: 'thread:adopted-project-draft', branchId: 'branch:adopted-project-draft', key: 'frozen-project-source',
      workspaceId: workspace.workspaceId, mode: 'native_workspace', selection: { ...selection, mode: 'native_workspace' },
      content: { mode: 'saved-files' }, captureScopes: [] } });
    expect(prepared.source).toMatchObject({ resourceOwner: owner, workspaceId: planned.workspaceId,
      executionWorkspaceId: planned.executionWorkspaceId, branchId: planned.branchId, mode: 'native_workspace' });
    expect(await readFile(path.join(prepared.path, 'original.txt'), 'utf8')).toBe('target original');
    const logical={...selection,mode:'native_workspace' as const};
    const opened=await remote.workspace({coordinatorHostId:base.coordinatorHostId,selection:logical,command:{kind:'open',path:directory}});
    expect(opened.kind).toBe('opened');if(opened.kind!=='opened')throw new Error('Native project file view missing');
    expect(normalizePathIdentity(await canonicalizePathIdentity(opened.root))).toBe(normalizePathIdentity((await target.documents.admitWorkspaceRegistration(workspace.workspaceId)).canonicalPath));expect(opened.workspaceId).toBe(planned.executionWorkspaceId);
    const location={coordinatorHostId:base.coordinatorHostId,selection:logical,root:opened.root,workspaceId:opened.workspaceId};
    const listed=await remote.workspace({...location,command:{kind:'list',path:''}});
    expect(listed.kind==='list' && listed.page.entries.some(entry=>entry.name==='original.txt')).toBe(true);
    const body=Buffer.from('written through original target native file owner');
    await remote.workspaceUpload({...location,path:'adopted-only.txt',key:'native-file-write',byteLength:body.length},(async function*(){yield body;})());
    const written=await remote.workspace({...location,command:{kind:'bytes',path:'adopted-only.txt',offset:0}});
    expect(written.kind==='bytes' && Buffer.from(written.bytesBase64,'base64').equals(body)).toBe(true);
    expect(await readFile(path.join(prepared.path,'adopted-only.txt'),'utf8')).toBe(body.toString());
    const documentRead=await remote.documents('read','POST',{resource:{workspaceId:opened.workspaceId,resourceId:'adopted-only.txt'}});
    expect(documentRead.status).toBe(200);expect(JSON.stringify(await documentRead.json())).toContain(body.toString());
    expect(await remote.workspace({...location,command:{kind:'filename-search',path:'',query:'adopted-only'}})).toMatchObject({kind:'filename-search',results:[{path:'adopted-only.txt'}],enumerationStatus:'complete'});
    expect(await remote.workspace({...location,command:{kind:'content-search',path:'',query:'written through original',fixedStrings:true}})).toMatchObject({kind:'content-search',result:{status:'ready',hits:[{resource:{workspaceId:opened.workspaceId,resourceId:'adopted-only.txt'},line:1,column:1,revision:expect.any(String)}]}});

    const frozen = { ...selection, mode: 'native_workspace' as const };
    expect(await gitCommand('getGitStatus', frozen)).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({path:'adopted-only.txt'})]) });
    await gitCommand('stageGitFile', frozen, 'adopted-only.txt');
    const viewGit = (...args: string[]) => execFileSync('git', args, { cwd: prepared.path, encoding: 'utf8' });
    expect(viewGit('diff', '--cached', '--name-only')).toContain('adopted-only.txt');
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
    await gitCommand('unstageGitFile', frozen, 'adopted-only.txt');
    expect(viewGit('diff', '--cached', '--name-only').trim()).toBe('');
    await expect(readFile(path.join(directory,'adopted-only.txt'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(path.join(directory,'original.txt'),'utf8')).toBe('target original');
    pairedRoot=local;await expect(remote.workspace({...location,command:{kind:'list',path:''}})).rejects.toThrow();pairedRoot=target.root;

    await preparedNative.releaseSource({ workspace_id: planned.workspaceId, execution_workspace_id: planned.executionWorkspaceId, branch_id: planned.branchId });

    const grant = await target.client.issueGrant({ grantId: 'adoption-receipt-check', owningWorkspace: workspace.workspaceId, executionWorkspace: planned.executionWorkspaceId, capabilities: ['storage.read'], pathScopes: [] });
    try { expect(await target.client.scoped(grant).getOperation(planned.adoptionOperationId)).toMatchObject({ kind: 'workspace.adopt', state: 'committed' }); }
    finally { await target.client.retireGrant(grant.grantId); }
    await remote.projectManagement({ ...base, workspace: first.workspace!, command: { action: 'disable', input: {} } });
  } else {
    await expect(remote.projectManagement(enable)).rejects.toThrow();
    console.warn('Native management adoption unavailable on this target:', backend.backend, backend.detail);
  }
  expect(await readFile(path.join(local, 'sentinel'), 'utf8')).toBe('coordinator untouched');
  expect(await readFile(path.join(directory, 'original.txt'), 'utf8')).toBe('target original');
}, 60_000);
