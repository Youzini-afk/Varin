import os from 'node:os';
import { createDocumentAuthority } from '../documents/authority.js';
import { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
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
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
it('manages the real target Git workspace and joins its original adoption intent without touching the coordinator', async () => {
  const a = createNativeProcessTestHarness(undefined, { hostId: 'management-coordinator' });
  const documentRoot = await mkdtemp(path.join(os.tmpdir(),'varin-managed-documents-'));
  const nativeOwner: { current?: ReturnType<typeof createNativeWorkspaceOwner> } = {};
  const documentAuthority = createDocumentAuthority({ hostId:'management-target',dataDir:documentRoot,isAllowedRoot:async()=>true,isTrusted:async()=>true,
    nativeWorkspaces:{resolveId:(id,signal,ref)=>nativeOwner.current?.resolveId(id,signal,ref)??Promise.resolve(undefined),
      resolvePath:(directory,containing)=>nativeOwner.current?.resolvePath(directory,containing)??Promise.resolve(undefined),
      retainReference:(source,key)=>nativeOwner.current!.retainReference(source,key),releaseReference:key=>nativeOwner.current!.releaseReference(key)} });
  cleanups.push(async()=>{await documentAuthority.dispose();await rm(documentRoot,{recursive:true,force:true});});
  const b = createNativeProcessTestHarness(documentAuthority, { hostId: 'management-target' });
  cleanups.push(() => a.dispose(), () => b.dispose());
  const coordinator = await a.get(), target = await b.get();
  vi.stubEnv('VARIN_DATA_DIR', path.join(target.root, 'target-config'));
  const directory = path.join(target.root, 'project'), local = path.join(coordinator.root, 'project');
  await mkdir(directory); await mkdir(local); await writeFile(path.join(local, 'sentinel'), 'coordinator untouched');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Native Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(directory, 'original.txt'), 'target original'); git('add', '.'); git('commit', '-m', 'initial');
  const workspace = await target.documents.resolveWorkspace({ path: directory });
  const management = createManagedProjectManagementOwner({ kernel: target.client, documents: target.documents });
  const preparedNative = createNativeWorkspaceOwner({ kernel: target.client, documents: target.documents, projects: async () => [],
    update: async () => { throw new Error('Preparing a frozen source must not mutate a project registration'); } });
  nativeOwner.current = preparedNative;
  const prepare = createThreadSourcePreparer({ documents: target.documents, nativeWorkspaces: preparedNative,
    workingStates: { withBranchStore: async () => { throw new Error('Adopted source must use its original native owner'); } } as never,
    inspectInventory: async () => ({ kind: 'directory' }), sourceTools: mode => target.client.agentRuntimeRequest('runtime.source.tools', { mode }) });
  const resourceFiles = createResourceFilesOwner(target.documents,new KernelFileResourceBackend(target.adapter),undefined,async(selection,signal)=>{
    const registration=await target.documents.admitWorkspaceRegistration(selection.workspaceId,signal);
    return {path:(await preparedNative.prepareSelection(selection,'project-files',signal)).path,originalRoot:registration.canonicalPath};
  });
  const sources = createManagedSourceService({ kernel: target.client, hostId: 'management-target', documents: target.documents,
    projectManagement: management, workspaceFiles:resourceFiles, validateLiveSource: async () => { throw new Error('Project management uses registered Documents, not a conversation Source'); }, prepareSource: prepare });
  const app = express(); app.use(express.json());
  let pairedRoot = target.root;
  registerManagedRemoteRoutes(app, { service: { hostId: 'management-target', sources: () => sources,
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
  expect((await list()).map(entry => entry.path)).toEqual([directory]);
  pairedRoot = local;
  await expect(list()).rejects.toThrow(); // A paired host must still respect the target's allowed roots.
  pairedRoot = target.root;
  const created = await remote.projectManagement({ ...base, command: { action: 'worktree-create', input: { worktreeName: 'native-remote', branchName: 'native-remote' } } }) as GitWorktreeCreateResult;
  expect(created.path.startsWith(target.root + path.sep)).toBe(true);
  let bootstrap: GitWorktreeBootstrapStatus | undefined;
  await expect.poll(async () => {
    bootstrap = await remote.projectManagement({ ...base, command: { action: 'worktree-bootstrap', input: { directory: created.path } } }) as GitWorktreeBootstrapStatus;
    return bootstrap.status;
  }, { timeout: 10_000 }).not.toBe('pending');
  expect(bootstrap, `Target worktree bootstrap: ${JSON.stringify(bootstrap)}`).toMatchObject({ status: 'ready' });
  expect(await readFile(path.join(created.path, 'original.txt'), 'utf8')).toBe('target original');
  expect(await remote.projectManagement({ ...base, command: { action: 'worktree-remove', input: { directory: created.path, deleteLocalBranch: true } } })).toEqual({ success: true });
  expect((await list()).map(entry => entry.path)).toEqual([directory]);
  await expect(remote.projectManagement({ ...base, command: { action: 'worktree-remove', input: { directory: local } } })).rejects.toThrow();
  const planned = await remote.projectManagement({ ...base, command: { action: 'workspace-plan', input: {} } }) as VersionedProjectWorkspace;
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
    expect(opened.root).toBe(directory);expect(opened.workspaceId).toBe(planned.executionWorkspaceId);
    const location={coordinatorHostId:base.coordinatorHostId,selection:logical,root:opened.root,workspaceId:opened.workspaceId};
    const listed=await remote.workspace({...location,command:{kind:'list',path:''}});
    expect(listed.kind==='list' && listed.page.entries.some(entry=>entry.name==='original.txt')).toBe(true);
    const body=Buffer.from('written through original target native file owner');
    await remote.workspaceUpload({...location,path:'adopted-only.txt',key:'native-file-write',byteLength:body.length},(async function*(){yield body;})());
    const written=await remote.workspace({...location,command:{kind:'bytes',path:'adopted-only.txt',offset:0}});
    expect(written.kind==='bytes' && Buffer.from(written.bytesBase64,'base64').equals(body)).toBe(true);
    expect(await readFile(path.join(prepared.path,'adopted-only.txt'),'utf8')).toBe(body.toString());
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
