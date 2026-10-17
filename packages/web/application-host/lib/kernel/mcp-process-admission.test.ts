import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createMcpSourceProcessAdmission } from './mcp-process-admission.js';
import { originalMaterializationLocation } from './source-launch.js';
import type { LaunchSource } from './protocol.generated.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fixture = async (mode: 'live_root' | 'materialized') => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'varin-mcp-source-'))); roots.push(root);
  const source: LaunchSource = { resource_owner: { kind: 'local' }, workspace_id: 'source', execution_workspace_id: 'execution', mode,
    branch_id: mode === 'materialized' ? 'original-branch' : null, revision: mode === 'materialized' ? 1 : null,
    live_root: mode === 'live_root' ? { hostId: 'host', rootId: 'root', canonicalRoot: root } : null,
    ...(mode === 'materialized' ? { environment_run_id: 'original-environment' } : {}) };
  const cwd = mode === 'live_root' ? root : (await originalMaterializationLocation(root, 'source', 'original-environment')).targetPath;
  if (mode === 'materialized') await mkdir(cwd, { recursive: true });
  let current = structuredClone(source), revoked = false;
  const validate = vi.fn(async () => { if (revoked) throw new Error('Original root revoked'); });
  const admit = vi.fn(async (_id: string) => { if (revoked) throw new Error('Workspace revoked'); return { canonicalPath: root }; });
  const owner = createMcpSourceProcessAdmission({ kernel: { handshake: { storageRoot: root }, agentRuntimeRequest: async () => ({ selection: { source: current } }) } as never,
    runId: 'consumer-run', source, executionCwd: cwd, admitWorkspaceRegistration: admit, validateLiveSource: validate });
  return { root, cwd, source, owner, validate, admit, replace: () => { current = { ...current, execution_workspace_id: 'other' }; }, revoke: () => { revoked = true; } };
};
it('keeps the admitted live source and rechecks both workspace registrations before each process', async () => {
  const f = await fixture('live_root');
  expect(await f.owner(new AbortController().signal)).toEqual({ workspaceId: 'source', executionWorkspaceId: 'execution', canonicalRoot: f.root });
  expect(f.admit.mock.calls.map(([id]) => id)).toEqual(['source', 'execution']); expect(f.validate).toHaveBeenCalledOnce();
  f.revoke(); await expect(f.owner(new AbortController().signal)).rejects.toThrow('revoked');
});
it('rejects a changed launch instead of accepting the same pathname', async () => {
  const f = await fixture('live_root'); f.replace(); await expect(f.owner(new AbortController().signal)).rejects.toThrow('unavailable'); expect(f.admit).not.toHaveBeenCalled();
});
it('uses the original environment Run materialization and refuses replacement aliases', async () => {
  const f = await fixture('materialized'); expect((await f.owner(new AbortController().signal)).canonicalRoot).toBe(f.cwd); expect(f.validate).not.toHaveBeenCalled();
  await rm(f.cwd, { recursive: true }); const substitute = join(f.root, 'substitute'); await mkdir(substitute); await symlink(substitute, f.cwd);
  await expect(f.owner(new AbortController().signal)).rejects.toMatchObject({ code: 'source_changed' });
});
