import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { admitMaterializedRoot, admitRunSourceAuthority, originalMaterializationLocation, sourceToolSchemas } from './source-launch.js';

it('requires the original materialized directory and rejects substitution inside the same managed root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-original-materialization-'));
  try {
    const original = await originalMaterializationLocation(root, 'workspace', 'original-run');
    const another = await originalMaterializationLocation(root, 'workspace', 'another-run');
    await mkdir(original.targetPath, { recursive: true }); await mkdir(another.targetPath, { recursive: true });
    await writeFile(path.join(original.targetPath, 'identity'), 'original working copy');
    expect(await admitMaterializedRoot(original.targetPath)).toBe(original.targetPath);
    await rename(original.targetPath, `${original.targetPath}-moved`);
    await expect(admitMaterializedRoot(original.targetPath)).rejects.toMatchObject({ code: 'source_environment_unavailable' });
    await symlink(another.targetPath, original.targetPath, process.platform==='win32'?'junction':'dir');
    await expect(admitMaterializedRoot(original.targetPath)).rejects.toMatchObject({ code: 'source_changed' });
    await expect(originalMaterializationLocation(root, 'workspace', '')).rejects.toMatchObject({ code: 'source_changed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('uses current Documents admission before minting a source grant and revokes it if trust changes during preparation', async () => {
  const f = await createDocumentAuthorityHarness();
  try {
    const source = { resourceOwner: { kind: 'local' as const }, workspaceId: f.identity.workspaceId, executionWorkspaceId: f.identity.workspaceId,
      runId: 'run', mode: 'fixed_branch' as const, branchId: 'fixed', revision: 7, tools: [] };
    let revokeDuringRead = false;
    const readBranch = vi.fn(async () => {
      if (revokeDuringRead) f.setTrusted(false);
      return { workspaceId: source.workspaceId, branchId: source.branchId, revision: 7, view: 'revision', root: 'fixed-root' };
    });
    const kernel = { subscribeExit() {}, onToolReleased() {}, scoped: () => ({ readBranch, executionViewInspect: async () => null, getOperation: async () => null, workingResultGet: async () => null }),
      issueGrant: vi.fn(async (input: { grantId: string }) => ({ grantId: input.grantId })), revokeGrant: vi.fn(async () => {}),
      agentRuntimeRequest: vi.fn(async (method: string) => {
        if (method === 'runtime.run.inspect') return { id: 'run', thread_id: 'thread', state: 'runnable' };
        if (method === 'runtime.launch.inspect') return { selection: { source: { mode: 'fixed_branch', resource_owner: source.resourceOwner, workspace_id: source.workspaceId,
          execution_workspace_id: source.executionWorkspaceId, branch_id: 'fixed', revision: 7, live_root: null }, tools: [], extension_bindings: [] } };
        throw new Error('Source preparation must not start a model or tool');
      }) };
    const client = kernel as unknown as KernelClient;
    const runtime = new AgentRuntimeClient(client, undefined, undefined, undefined, undefined, undefined, f.authority.admitWorkspaceRegistration);
    f.setTrusted(false);
    await expect(admitRunSourceAuthority(client, runtime, source)).rejects.toMatchObject({ code: 'untrusted' });
    expect(kernel.issueGrant).not.toHaveBeenCalled();
    f.setTrusted(true); revokeDuringRead = true;
    await expect(admitRunSourceAuthority(client, runtime, source)).rejects.toMatchObject({ code: 'untrusted' });
    expect(kernel.issueGrant).toHaveBeenCalledOnce();
    expect(kernel.revokeGrant).toHaveBeenCalledExactlyOnceWith(kernel.issueGrant.mock.calls[0]![0].grantId);
    const unbound = new AgentRuntimeClient(client);
    await expect(admitRunSourceAuthority(client, unbound, source)).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(kernel.issueGrant).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});


it('binds hybrid file_read paths only to the original admitted Source', async () => {
  const f = await createDocumentAuthorityHarness();
  try {
    f.setTrusted(true);
    const fileRead = { name: 'file_read', version: '1', description: '', schema: { type: 'object' } };
    const resourceRead = { name: 'resource_read', version: '4', description: '', schema: { type: 'object' } };
    const selected = { source: { mode: 'fixed_branch' as const, resource_owner: { kind: 'local' as const },
      workspace_id: f.identity.workspaceId, execution_workspace_id: f.identity.workspaceId,
      branch_id: 'fixed', revision: 7, live_root: null }, tools: [fileRead, resourceRead], extension_bindings: [] };
    const selection = selected as unknown as Parameters<typeof sourceToolSchemas>[0];
    const source = { resourceOwner: selected.source.resource_owner, workspaceId: f.identity.workspaceId,
      executionWorkspaceId: f.identity.workspaceId, runId: 'run', mode: 'fixed_branch' as const,
      branchId: 'fixed', revision: 7, tools: sourceToolSchemas(selection).map(tool => tool.name) as ['file_read'] };
    const kernel = { subscribeExit() {}, onToolReleased() {},
      scoped: () => ({ readBranch: vi.fn(async () => ({ workspaceId: source.workspaceId, branchId: 'fixed', revision: 7, view: 'revision', root: 'original-root' })), executionViewInspect: async () => null, getOperation: async () => null, workingResultGet: async () => null }),
      issueGrant: vi.fn(async (input: { grantId: string }) => ({ grantId: input.grantId })), revokeGrant: vi.fn(async () => {}),
      agentRuntimeRequest: vi.fn(async (method: string) => {
        if (method === 'runtime.run.inspect') return { id: 'run', thread_id: 'thread', state: 'runnable' };
        if (method === 'runtime.launch.inspect') return { selection };
        throw new Error(`Unexpected source call: ${method}`);
      }) };
    const client = kernel as unknown as KernelClient;
    const runtime = new AgentRuntimeClient(client, undefined, undefined, undefined, undefined, undefined, f.authority.admitWorkspaceRegistration);
    const admitted = await admitRunSourceAuthority(client, runtime, source);
    expect(admitted.toolBinding.enabledTools).toEqual(['file_read']);
    expect(admitted.toolBinding.fileSource).toEqual({ branchId: 'fixed', revision: 7 });
    expect(kernel.issueGrant).toHaveBeenCalledOnce();
    expect(sourceToolSchemas({ ...selection, source: null })).toEqual([]);
    expect(sourceToolSchemas({ ...selection, extension_bindings: [{ tool: fileRead }] as typeof selection.extension_bindings })).toEqual([]);
    expect(sourceToolSchemas({ ...selection, mcp_binding: { tools: [fileRead] } as NonNullable<typeof selection.mcp_binding> })).toEqual([]);
    await admitted.release();
  } finally { await f.cleanup(); }
});

it('awaits durable conversion reconciliation on the admitted native subtree before publishing its binding', async () => {
  const f = await createDocumentAuthorityHarness();
  try {
    const source = { resourceOwner: { kind: 'local' as const }, workspaceId: f.identity.workspaceId,
      executionWorkspaceId: f.identity.workspaceId, runId: 'run', mode: 'native_workspace' as const,
      branchId: 'native-branch', nativeScope: 'src', tools: [] };
    const selected = { source: { mode: source.mode, resource_owner: source.resourceOwner,
      workspace_id: source.workspaceId, execution_workspace_id: source.executionWorkspaceId,
      branch_id: source.branchId, native_scope: source.nativeScope, revision: null, live_root: null }, tools: [], extension_bindings: [] };
    const actor = { readBranch: async () => ({ workspaceId: source.workspaceId, branchId: source.branchId, revision: 0, view: 'revision', root: 'native-base' }) };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const textEncodingPolicy = vi.fn(async () => {
      await pending;
      return { root: `${f.workspaceRoot}/src`, files: { 'a.c': 'utf-8' }, choiceRevisions: { 'a.c': 2 } };
    });
    const kernel = { subscribeExit() {}, onToolReleased() {}, scoped: () => actor, textEncodingPolicy,
      nativeWorkspaces: { acquire: vi.fn(async () => ({ rootId: 'native-root', path: '/mounted/src', hostId: 'host', address: { branchId: 'native-branch', sourcePath: 'src' } })) },
      issueGrant: vi.fn(async (input: { grantId: string }) => ({ grantId: input.grantId })), revokeGrant: vi.fn(async () => {}),
      agentRuntimeRequest: vi.fn(async (method: string) => {
        if (method === 'runtime.run.inspect') return { id: 'run', thread_id: 'thread', state: 'runnable' };
        if (method === 'runtime.launch.inspect') return { selection: selected };
        throw new Error(`Unexpected source call: ${method}`);
      }) };
    const client = kernel as unknown as KernelClient;
    const runtime = new AgentRuntimeClient(client, undefined, undefined, undefined, undefined, undefined, f.authority.admitWorkspaceRegistration);
    let completed = false;
    const admission = admitRunSourceAuthority(client, runtime, source).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(textEncodingPolicy).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(textEncodingPolicy).toHaveBeenCalledWith(source.workspaceId,
      { rootId: 'native-root', canonicalRoot: '/mounted/src', client: actor, sourcePath: 'src' }, undefined);
    finish();
    const admitted = await admission;
    expect(admitted.toolBinding.textEncoding).toEqual({ root: `${f.workspaceRoot}/src`, files: { 'a.c': 'utf-8' }, choiceRevisions: { 'a.c': 2 } });
    await admitted.release();
  } finally { await f.cleanup(); }
});

it.each([{ root: '/captured', files: { 'a.c': 'gbk' } }, {}])('binds a new fixed Run to its captured policy rather than current project settings', async captured => {
  const f = await createDocumentAuthorityHarness();
  try {
    const selected = { source: { mode: 'fixed_branch' as const, resource_owner: { kind: 'local' as const },
      workspace_id: f.identity.workspaceId, execution_workspace_id: f.identity.workspaceId, branch_id: 'fixed', revision: 0, live_root: null }, tools: [], extension_bindings: [] };
    const actor = {
      readBranch: async () => ({ workspaceId: f.identity.workspaceId, branchId: 'fixed', revision: 0, view: 'revision', root: 'base-root', textEncoding: captured }),
      executionViewInspect: async () => null,
      getOperation: async () => { throw new Error('Private source body is not authorized to this new Run'); },
      getBlob: async () => { throw new Error('Private source body is not authorized to this new Run'); },
    };
    const textEncodingPolicy = vi.fn(async () => { throw new Error('Current project settings must not reinterpret the fixed source'); });
    const kernel = { subscribeExit() {}, onToolReleased() {}, scoped: () => actor, textEncodingPolicy,
      issueGrant: async (input: { grantId: string }) => ({ grantId: input.grantId }), revokeGrant: vi.fn(async () => {}),
      agentRuntimeRequest: async (method: string) => {
        if (method === 'runtime.run.inspect') return { id: 'new-run', thread_id: 'thread', state: 'runnable' };
        if (method === 'runtime.launch.inspect') return { selection: selected };
        throw new Error(`Unexpected source call: ${method}`);
      } } as unknown as KernelClient;
    const runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, undefined, f.authority.admitWorkspaceRegistration);
    const admission = await admitRunSourceAuthority(kernel, runtime, { resourceOwner: selected.source.resource_owner, mode: 'fixed_branch',
      workspaceId: f.identity.workspaceId, executionWorkspaceId: f.identity.workspaceId, branchId: 'fixed', revision: 0, runId: 'new-run', tools: [] });
    expect(admission.toolBinding.textEncoding).toEqual(captured);
    expect(textEncodingPolicy).not.toHaveBeenCalled();
    await admission.release();
  } finally { await f.cleanup(); }
});
