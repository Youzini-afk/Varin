import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { ThreadCollaboration } from './thread-collaboration.js';
import { registerThreadRoutes } from './thread-routes.js';
import type { DelegatedExecution, LaunchSource } from './protocol.generated.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:child', branchId: 'branch:child' };
const source: LaunchSource = { mode: 'fixed_branch', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'old-result', revision: 7, live_root: null };
function execution(): DelegatedExecution {
  return { execution_id: 'execution:new', child_operation_id: 'original-dispatch', parent_run_id: 'original-parent-run', parent_thread_id: 'thread:parent', parent_branch_id: 'branch:parent',
    origin: { kind: 'model_step', request_id: 'original-request' }, call_id: 'original-call', child_thread_id: identity.threadId, child_branch_id: identity.branchId, project_id: null,
    trigger: { kind: 'user_continuation', key: 'new-input', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' },
    input: { text: '/skill:research next step' }, configuration: { model: 'pinned-model' }, selected_profile: { preset_id: null, catalog_identity: null, work_mode: 'isolated_write', tools: ['file_read'], instructions: 'Original worker role' },
    launch: { credential_scope: { authority: 'original', reference: 'credential', generation: 1, account: 'original' }, child_dispatch: null,
      connection_identity: 'original', provider_family: 'fixture', model: 'pinned-model', configuration_generation: 1, tool_schema_generation: 1,
      tools: [{ name: 'file_read', version: '1', description: 'Read', schema: {}, output_schema: null, metadata: null }], policy: { name: 'default', version: '1' },
      mcp_binding: null, extension_bindings: [], policy_models: [], source: null }, policy_target: { kind: 'default' },
    source_basis: { kind: 'working_result', source, root: 'fixed-result-root', provenance: { consistency: 'fixed-root', root: 'fixed-result-root' },
      result: { publication_id: 'old-publication', workspace_id: 'workspace', branch_id: 'old-result', result_revision: 7, root: 'fixed-result-root', base_root: 'old-base', record_id: 'old-result-record' } },
    source: null, code_result: { kind: 'pending' }, state: 'preparing', revision: 1, cursor: 7, receipt: null, report: null, terminal_head: null,
    resources_released: false, cancel_requested: false };
}
afterEach(() => vi.unstubAllGlobals());

it('public User continuation preserves exact predecessor and input without selecting new configuration or starting cold work', async () => {
  const accepted = execution();
  const requests = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'runtime.thread.inspect') return { thread_id: params.threadId, observer_project_ids: [],
      branches: (params.threadId === 'thread:parent' ? ['branch:parent', 'parent-fork'] : [identity.branchId, 'history-fork']).map(branch_id => ({ branch_id, active_run_id: null, head: 'old-head', latest_run: null })) };
    if (method === 'runtime.child.for_thread' || method === 'runtime.child.inspect') return { operation_id: 'original-dispatch', child_thread_id: identity.threadId, child_branch_id: identity.branchId, parent_thread_id: 'thread:parent', parent_branch_id: 'branch:parent' };
    if (method === 'runtime.child.continuation.accept') return structuredClone(accepted);
    if (method === 'runtime.child.execution.list') return [structuredClone(accepted)];
    if (method === 'runtime.child.execution.inspect') return structuredClone(accepted);
    if (method === 'runtime.child.execution.report.read') return { execution_id: params.executionId, operation_id: 'original-dispatch', item_id: params.itemId, offset: params.offset, next_offset: null, total_bytes: 3, text: 'new' };
    throw new Error(`Unexpected RPC ${method}`);
  });
  const runtime = new AgentRuntimeClient({ subscribeExit() {}, onToolReleased() {}, agentRuntimeRequest: requests } as unknown as KernelClient);
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const admitSource = vi.fn();
  const adapter = new ThreadAdapter(runtime, models, admitSource, vi.fn());
  const handlers = new Map<string, RequestHandler[]>();
  registerThreadRoutes({ post: (path: string, ...chain: RequestHandler[]) => handlers.set(path, chain), get() {} } as unknown as Express,
    adapter, (req, res, next) => { if (req.headers.authorization !== 'host-session') res.status(401).end(); else next(); });
  const request = async (path: string, body: unknown, authenticated = true) => {
    let status = 200; let output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; }, json(value: unknown) { output = value; this.writableEnded = true; return this; }, end() { this.writableEnded = true; return this; } });
    const input = { body, headers: authenticated ? { authorization: 'host-session' } : {} } as Request;
    await new Promise<void>((resolve, reject) => {
      let index = 0;
      const next = () => {
        const handler = handlers.get(path)![index++]; if (!handler) return resolve();
        Promise.resolve(handler(input, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  };
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => request(new URL(url, 'http://fixture.invalid').pathname, JSON.parse(String(init.body))));
  const api = createThreadsHttpAPI().collaboration!;
  const input = { ...identity, key: 'new-input', previousRunId: 'old-run', expectedHead: 'old-head', text: '  原文\nnext  ' };
  expect(await api.continueChild(input)).toEqual(accepted);
  expect(requests.mock.calls.at(-1)).toEqual(['runtime.child.continuation.accept', { key: input.key, childOperationId: 'original-dispatch', previousRunId: input.previousRunId, expectedHead: input.expectedHead, input: { text: input.text } }, expect.any(AbortSignal)]);
  await api.continueChild(input);
  expect(requests.mock.calls.filter(([method]) => method === 'runtime.child.continuation.accept').map(([, value]) => value)).toEqual(Array(2).fill({ key: input.key, childOperationId: 'original-dispatch', previousRunId: input.previousRunId, expectedHead: input.expectedHead, input: { text: input.text } }));
  expect(await api.executions(identity)).toEqual([accepted]);
  const fork = { ...identity, branchId: 'history-fork' };
  expect(await api.executions(fork)).toEqual([]);
  await expect(api.executions(fork, 'original-dispatch')).rejects.toMatchObject({ status: 400 });
  await expect(api.continueChild({ ...input, branchId: fork.branchId })).rejects.toMatchObject({ status: 400 });
  expect(await api.readExecutionReport(identity, accepted.execution_id, 'new-report', 0)).toMatchObject({ execution_id: accepted.execution_id, text: 'new' });
  const parentFork: ThreadIdentity = { runtime: 'agent', threadId: 'thread:parent', branchId: 'parent-fork' };
  expect(await api.executions(parentFork, 'original-dispatch')).toEqual([accepted]);
  expect(await api.readExecutionReport(parentFork, accepted.execution_id, 'new-report')).toMatchObject({ execution_id: accepted.execution_id, text: 'new' });
  for (const extra of [{ childOperationId: 'another' }, { configuration: {} }, { source: {} }, { actor: 'agent' }]) {
    expect((await request('/api/threads/child/continue', { ...input, ...extra })).status).toBe(400);
  }
  expect((await request('/api/threads/child/continue', input, false)).status).toBe(401);
  await expect(api.continueChild({ ...input, branchId: 'foreign-branch' })).rejects.toMatchObject({ status: 400 });
  expect(models.resolveModel).not.toHaveBeenCalled(); expect(models.rebindModel).not.toHaveBeenCalled(); expect(admitSource).not.toHaveBeenCalled();
  // Durable exactly-once acceptance remains the Rust owner's independently tested responsibility.
});

it('startup collaboration re-admits the exact fixed result, preserves context CAS and launches the new execution without an old parent handoff', async () => {
  const child = execution();
  const errors: unknown[] = [];
  const checkpoint = { id: 'checkpoint:original', revision: 4, proposal: { through_id: 'compacted-head', summary: 'Original summary' } };
  const context = { effectiveSystemPrompt: 'Original child role', instructionSources: [], memoryCheckpoint: 'old-memory', resources: { snapshot: { id: 'new-fixed-resources' } } };
  const skill = { command: 'fixture-original-command' };
  const released = vi.fn(async () => {});
  const store = {
    pinBranch: vi.fn(async () => ({ workspaceId: 'workspace', branchId: 'old-result', root: 'fixed-result-root', revision: 7, release: released })),
    createBranchFromPin: vi.fn(async (_workspace: string, _branch: string) => ({ baseRoot: 'fixed-result-root' })),
    pinBranchHandoff: vi.fn(async () => ({ pinId: 'child-source-pin:execution:new', root: 'fixed-result-root' })),
  };
  const runtime = {
    onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {}, reconcileChildren: async () => [], reconcileProcessWaits: async () => [],
    children: async () => [], childExecutions: async () => [structuredClone(child)], unacceptedChildSources: async () => [], status: async () => ({ eventCursor: 7 }), events: async () => [],
    context: vi.fn(async () => checkpoint), childExecution: async () => structuredClone(child),
    readyChildSource: vi.fn(async (input: Parameters<AgentRuntimeClient['readyChildSource']>[0]) => {
      child.source = { kind: 'ready', handoff: null, pin: input.pin, selection: { mode: input.source.mode, workspace_id: input.source.workspaceId,
        execution_workspace_id: input.source.executionWorkspaceId, branch_id: input.source.branchId, revision: input.source.revision, live_root: null }, provenance: input.provenance };
      return structuredClone(child);
    }),
    prepareChild: vi.fn(async (_input: Parameters<AgentRuntimeClient['prepareChild']>[0]) => {
      child.receipt = { run_id: 'new-run', input_id: 'new-input', thread_id: identity.threadId, branch_id: identity.branchId, cursor: 9 };
      child.state = 'ready'; return structuredClone(child);
    }),
    releaseChildResources: vi.fn(async () => { child.resources_released = true; return structuredClone(child); }),
  };
  const kernel = { reconcileChildToolHandoffs() {}, claimChildSource: vi.fn(), releaseChildToolHandoff: vi.fn() };
  const prepareContext = Object.assign(vi.fn(async () => { throw new Error('Initial context must not replace the old checkpoint'); }), { forSource: vi.fn(async () => context) });
  const prepareSkillInput = vi.fn(async () => ({ status: 'ready', skill }));
  const continueRun = vi.fn(async () => {});
  const collaboration = new ThreadCollaboration({ kernel: kernel as never, storageAdapter: {} as never, resolveLiveSource: async () => { throw new Error('No live source'); }, sourceCaptureOwners: {} as never,
    runtime: runtime as unknown as AgentRuntimeClient, workingStates: { withBranchStore: async (_workspace, _purpose, work) => work(store as never, {} as never) },
    prepareContext: prepareContext as never, prepareSkillInput: prepareSkillInput as never, continueRun, recoverLaunches: async () => {}, onError: (_id, error) => errors.push(error) });
  try {
    await collaboration.recover(); await vi.waitFor(() => expect(continueRun).toHaveBeenCalledOnce());
    expect(store.pinBranch).toHaveBeenCalledWith('old-result', { revision: 7, signal: expect.any(AbortSignal) });
    expect(store.createBranchFromPin.mock.calls[0]![1]).toBe('child-source:execution:new');
    expect(runtime.prepareChild).toHaveBeenCalledWith(expect.objectContaining({ executionId: child.execution_id,
      expectedContextCheckpoint: checkpoint.id, context, inputPreparation: { expectedContextCheckpoint: null, skill } }), expect.any(AbortSignal));
    expect(prepareContext.forSource).toHaveBeenCalledWith(checkpoint, expect.objectContaining({ branchId: 'child-source:execution:new', revision: 0 }), expect.any(AbortSignal));
    expect(continueRun).toHaveBeenCalledWith('new-run', expect.any(AbortSignal));
    expect(kernel.claimChildSource).not.toHaveBeenCalled(); expect(kernel.releaseChildToolHandoff).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.releaseChildResources).toHaveBeenCalledOnce());
    expect(released).toHaveBeenCalledOnce(); expect(errors).toEqual([]);
  } finally { collaboration.stop(); }
});
