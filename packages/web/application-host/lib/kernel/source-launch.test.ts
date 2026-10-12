import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { admitMaterializedRoot, admitRunSourceAuthority, originalMaterializationLocation } from './source-launch.js';

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
    await symlink(another.targetPath, original.targetPath, 'dir');
    await expect(admitMaterializedRoot(original.targetPath)).rejects.toMatchObject({ code: 'source_changed' });
    await expect(originalMaterializationLocation(root, 'workspace', '')).rejects.toMatchObject({ code: 'source_changed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('uses current Documents admission before minting a source grant and revokes it if trust changes during preparation', async () => {
  const f = await createDocumentAuthorityHarness();
  try {
    const source = { workspaceId: f.identity.workspaceId, executionWorkspaceId: f.identity.workspaceId,
      runId: 'run', mode: 'fixed_branch' as const, branchId: 'fixed', revision: 7, tools: [] };
    let revokeDuringRead = false;
    const readBranch = vi.fn(async () => {
      if (revokeDuringRead) f.setTrusted(false);
      return { workspaceId: source.workspaceId, branchId: source.branchId, revision: 7, view: 'revision', root: 'fixed-root' };
    });
    const kernel = { subscribeExit() {}, onToolReleased() {}, scoped: () => ({ readBranch }),
      issueGrant: vi.fn(async (input: { grantId: string }) => ({ grantId: input.grantId })), revokeGrant: vi.fn(async () => {}),
      agentRuntimeRequest: vi.fn(async (method: string) => {
        if (method === 'runtime.run.inspect') return { id: 'run', thread_id: 'thread', state: 'runnable' };
        if (method === 'runtime.launch.inspect') return { selection: { source: { mode: 'fixed_branch', workspace_id: source.workspaceId,
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
