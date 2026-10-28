import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeAPIs, ThreadIdentity, ThreadPreparedSource, ThreadSubmit, ThreadsAPI } from '@varin/application-client';
import type { CreateMultiRunParams } from '@/types/multirun';
const endpoint = vi.hoisted(() => ({ generation: 1, host: 'host-a' }));
const worktrees = vi.hoisted(() => ({ create: vi.fn(), check: vi.fn(), tracking: vi.fn(), wait: vi.fn() }));
const navigation = vi.hoisted(() => ({ selectedIdentity: null as ThreadIdentity | null, loadCatalog: vi.fn(async () => {}), selectThread: vi.fn(async (identity: ThreadIdentity) => identity) }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => endpoint.generation }));
vi.mock('@/stores/useThreadStore', () => ({ threadHostKey: () => endpoint.host, useThreadStore: { getState: () => navigation } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ currentDirectory: '/repo' }) } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ activeProjectId: 'project:one', projects: [{ id: 'project:one', path: '/repo' }] }) } }));
vi.mock('@/lib/project-config', () => ({ getWorktreeSetupWaitEnabled: async () => true }));
vi.mock('@/lib/varinWorktrees', () => ({ checkVarinGitRepository: worktrees.check, createVarinWorktree: worktrees.create, resolveVarinRootTrackingRemote: worktrees.tracking }));
vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: worktrees.wait }));
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useMultiRunStore } from './useMultiRunStore';
const params = (): CreateMultiRunParams => ({ name: 'Compare models', groups: [{ prompt: 'Implement the fix', models: [
  { providerID: 'channel-a', modelID: 'model-a', variant: 'high' }, { providerID: 'channel-b', modelID: 'model-b' },
] }], isolateRuns: true, worktreeBaseBranch: 'main', setupCommands: ['npm ci'] });
function fixture() {
  const identities = new Map<string, ThreadIdentity>(); let seq = 0;
  const api = { create: vi.fn(async (key: string) => { let identity = identities.get(key); if (!identity) { identity = { runtime: 'agent', threadId: `thread:${++seq}`, branchId: `branch:${seq}` }; identities.set(key, identity); } return identity; }),
    snapshot: vi.fn(async () => ({ thread: { revision: 1 } })), update: vi.fn(async () => ({})),
    sources: { resolve: vi.fn(async (_identity, input) => ({ workspaceId: `workspace:${input.path}`, resourceOwner: { kind: 'local' }, path: input.path })) },
    prepareSource: vi.fn(async input => ({ path: '/actual-worktree', source: { resourceOwner: input.resourceOwner, workspaceId: input.workspaceId,
      executionWorkspaceId: input.workspaceId, mode: 'live_root', liveRoot: { hostId: 'host-a', canonicalRoot: input.workspaceId, rootId: `root:${input.threadId}` }, tools: ['file_read', 'file_write'] } } as ThreadPreparedSource)),
    submit: vi.fn(async (input: ThreadSubmit) => ({ thread_id: input.threadId, branch_id: input.branchId, run_id: `run:${input.key}`, input_id: `input:${input.key}`, cursor: 1 })),
  } as unknown as ThreadsAPI;
  registerRuntimeAPIs({ threads: api } as RuntimeAPIs); return api;
}
beforeEach(async () => {
  await Promise.resolve(); useMultiRunStore.getState().keepResultsAndReset();
  useMultiRunStore.setState({ error: null, isLoading: false, attempts: [] });
  endpoint.generation += 1; endpoint.host = 'host-a'; navigation.selectedIdentity = null; navigation.selectThread.mockClear();
  worktrees.check.mockReset().mockResolvedValue(true); worktrees.tracking.mockReset().mockResolvedValue('origin'); worktrees.wait.mockReset().mockResolvedValue(undefined);
  worktrees.create.mockReset().mockImplementation(async (_project, options) => ({ path: `/worktrees/${options.preferredName}`, branch: options.branchName }));
});
it('launches actual native branches with independent prepared worktrees, models, thinking levels and attachments', async () => {
  const api = fixture(); const input = params(); input.files = [{ filename: 'image.png', mime: 'image/png', url: 'data:image/png;base64,AA==' }, { filename: 'notes.txt', mime: 'text/plain', url: 'data:text/plain,Keep%20the%20contract' }];
  const result = await useMultiRunStore.getState().createMultiRun(input);
  expect(result?.identities).toHaveLength(2); expect(result?.failures).toEqual([]); expect(worktrees.create).toHaveBeenCalledTimes(2);
  expect(worktrees.wait).toHaveBeenCalledTimes(2); expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread:1', title: 'compare-models/channel-a/model-a', expectedRevision: 1 }));
  const requests = vi.mocked(api.submit).mock.calls.map(call => call[0]);
  expect(requests[0]).toMatchObject({ runtime: 'agent', threadId: 'thread:1', branchId: 'branch:1', expectedHead: null,
    model: { providerId: 'channel-a', modelId: 'model-a', thinkingLevel: 'high' }, images: [{ data: 'AA==', mimeType: 'image/png' }], text: expect.stringContaining('Keep the contract') });
  expect(requests[0].source?.workspaceId).not.toBe(requests[1].source?.workspaceId);
  expect(vi.mocked(api.prepareSource).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(api.submit).mock.invocationCallOrder[0]);
  expect(useMultiRunStore.getState().attempts.every(attempt => attempt.status === 'accepted')).toBe(true);
});
it('retains native acceptance and retries an uncertain submission with exactly the original command', async () => {
  const api = fixture(); const input = params(); input.groups[0].models.splice(1);
  vi.mocked(api.submit).mockRejectedValueOnce(new Error('reply lost'));
  const first = await useMultiRunStore.getState().createMultiRun(input); expect(first?.failures).toHaveLength(1);
  const original = vi.mocked(api.submit).mock.calls[0][0]; const attempt = useMultiRunStore.getState().attempts[0];
  expect(attempt.status).toBe('unknown'); expect(attempt.identity).toBeDefined(); expect(attempt.worktreePath).toBeDefined();
  const second = await useMultiRunStore.getState().createMultiRun(input);
  expect(second?.failures).toEqual([]); expect(vi.mocked(api.submit).mock.calls[1][0]).toBe(original);
  expect(api.create).toHaveBeenCalledTimes(1); expect(worktrees.create).toHaveBeenCalledTimes(1); expect(api.prepareSource).toHaveBeenCalledTimes(1);
});
it('retries an uncertain native create using its original key and retains the successfully created worktree', async () => {
  const api = fixture(); const input = params(); input.groups[0].models.splice(1);
  vi.mocked(api.create).mockRejectedValueOnce(new Error('create reply lost'));
  await useMultiRunStore.getState().createMultiRun(input); const key = vi.mocked(api.create).mock.calls[0][0];
  expect(useMultiRunStore.getState().attempts[0].status).toBe('unknown');
  await useMultiRunStore.getState().createMultiRun(input);
  expect(vi.mocked(api.create).mock.calls[1][0]).toBe(key); expect(worktrees.create).toHaveBeenCalledTimes(1);
});
it('does not replay non-idempotent Git creation after a lost reply or silently replace unfinished parameters', async () => {
  const api = fixture(); const input = params(); input.groups[0].models.splice(1);
  worktrees.create.mockRejectedValueOnce(new Error('worktree reply lost'));
  await useMultiRunStore.getState().createMultiRun(input); await useMultiRunStore.getState().createMultiRun(input);
  expect(worktrees.create).toHaveBeenCalledTimes(1); expect(api.create).not.toHaveBeenCalled();
  expect(useMultiRunStore.getState().attempts[0].error).toContain('will not be replayed');
  await useMultiRunStore.getState().createMultiRun({ ...input, name: 'Different batch' });
  expect(useMultiRunStore.getState().error).toContain('unchanged selections');
});
it('retains a late create receipt while fencing all subsequent source and submission calls on a Host switch', async () => {
  const api = fixture(); const input = params();
  vi.mocked(api.create).mockImplementationOnce(async () => { endpoint.generation += 1; endpoint.host = 'host-b'; return { runtime: 'agent', threadId: 'thread:old-host', branchId: 'branch:old-host' }; });
  await useMultiRunStore.getState().createMultiRun(input);
  expect(useMultiRunStore.getState().attempts[0].identity?.threadId).toBe('thread:old-host');
  expect(api.sources.resolve).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled(); expect(api.create).toHaveBeenCalledTimes(1);
  expect(useMultiRunStore.getState().error).toContain('original Host');
});
it('deduplicates repeated launch clicks and does not override newer user navigation', async () => {
  const api = fixture(); const input = params(); let resolve!: () => void;
  worktrees.check.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = () => done(false); }));
  const first = useMultiRunStore.getState().createMultiRun(input); const second = useMultiRunStore.getState().createMultiRun(input);
  expect(first).toBe(second); await vi.waitFor(() => expect(worktrees.check).toHaveBeenCalledOnce()); navigation.selectedIdentity = { runtime: 'agent', threadId: 'thread:user-choice', branchId: 'branch:user-choice' }; resolve();
  await first; expect(api.create).toHaveBeenCalledTimes(2); expect(navigation.selectThread).not.toHaveBeenCalled();
});
it('stops future launches without removing already created threads or worktrees', async () => {
  const api = fixture(); const input = params();
  vi.mocked(api.create).mockImplementationOnce(async () => { useMultiRunStore.getState().stopLaunching(); return { runtime: 'agent', threadId: 'thread:retained', branchId: 'branch:retained' }; });
  await useMultiRunStore.getState().createMultiRun(input);
  expect(api.create).toHaveBeenCalledTimes(1); expect(api.submit).not.toHaveBeenCalled();
  expect(useMultiRunStore.getState().attempts[0]).toMatchObject({ identity: { threadId: 'thread:retained' }, worktreePath: expect.any(String) });
});
