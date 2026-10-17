import { KERNEL_PROTOCOL_VERSION } from './protocol.generated.js';
import { EventEmitter } from 'node:events';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createThreadsHttpAPI, type ThreadIdentity } from '@varin/application-client';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient, type KernelGrantIssueInput, type KernelScopedClient } from './kernel-client.js';
import { KernelStorageAdapter } from './storage-adapter.js';
import { ThreadAdapter } from './thread-adapter.js';
import { ThreadCollaboration } from './thread-collaboration.js';
import { registerThreadRoutes } from './thread-routes.js';
import type { DelegatedExecution, LaunchSource } from './protocol.generated.js';

const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:child', branchId: 'branch:child' };
const source: LaunchSource = { mode: 'fixed_branch', resource_owner: { kind: 'local' as const }, workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'old-result', revision: 7, live_root: null };
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
    if (method === 'runtime.thread.inspect') return { thread_id: params.threadId, parent_thread_id: null, observer_project_ids: [],
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
  await expect(api.executions(parentFork, 'original-dispatch')).rejects.toMatchObject({ status: 400 });
  await expect(api.readExecutionReport(parentFork, accepted.execution_id, 'new-report')).rejects.toMatchObject({ status: 400 });
  const parent = { ...parentFork, branchId: 'branch:parent' };
  expect(await api.executions(parent, 'original-dispatch')).toEqual([accepted]);
  expect(await api.readExecutionReport(parent, accepted.execution_id, 'new-report')).toMatchObject({ execution_id: accepted.execution_id, text: 'new' });
  for (const extra of [{ childOperationId: 'another' }, { configuration: {} }, { source: {} }, { actor: 'agent' }]) {
    expect((await request('/api/threads/child/continue', { ...input, ...extra })).status).toBe(400);
  }
  expect((await request('/api/threads/child/continue', input, false)).status).toBe(401);
  await expect(api.continueChild({ ...input, branchId: 'foreign-branch' })).rejects.toMatchObject({ status: 400 });
  expect(models.resolveModel).not.toHaveBeenCalled(); expect(models.rebindModel).not.toHaveBeenCalled(); expect(admitSource).not.toHaveBeenCalled();
  // Durable exactly-once acceptance remains the Rust owner's independently tested responsibility.
});

it.each(['user_continuation', 'message_request', 'followup', 'calendar'] as const)('startup %s re-admits the exact fixed result and context without claiming the old handoff or promoting Agent input', async kind => {
  const child = execution();
  if (kind === 'message_request') child.trigger = { kind, message_id: 'message:original', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  if (kind === 'calendar') child.trigger = { kind, definition_id: 'calendar:original', occurrence_id: 'occurrence:original', input_id: 'input:original', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  if (kind === 'followup') child.trigger = { kind, followup_id: 'followup:original', occurrence_id: 'occurrence:original', input_id: 'input:original', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  const errors: unknown[] = [];
  let emit = (_event: import('./protocol.generated.js').AgentRuntimeStreamEvent) => {};
  let calendarHeld = kind === 'calendar';
  const checkpoint = { id: 'checkpoint:original', revision: 4, proposal: { through_id: 'compacted-head', summary: 'Original summary' } };
  const context = { effectiveSystemPrompt: 'Original child role', instructionSources: [], memoryCheckpoint: 'old-memory', resources: { snapshot: { id: 'new-fixed-resources' } } };
  const skill = { command: 'fixture-original-command' };
  // Keep the real branch adapter/store. Only their native Storage ports are
  // controlled, with a newer head that must not replace the selected revision.
  const branches = new Map([['old-result', {
    branchId: 'old-result', workspaceId: 'workspace', root: 'later-head-root', baseRoot: 'old-base',
    writeRevision: 8, headRevision: 7, parentRef: 'original-parent',
    captureScopes: [] as string[], draftBasePaths: [] as string[], createdAt: 1, updatedAt: 2,
  }]]);
  const scoped = {
    readBranch: vi.fn(async (input: Parameters<KernelScopedClient['readBranch']>[0]) => {
      const branch = branches.get(input.branchId);
      if (!branch) throw new Error(`Unexpected branch ${input.branchId}`);
      return { ...branch, view: input.revision === undefined ? 'current' : 'revision', revision: input.revision ?? branch.headRevision,
        root: input.revision === 0 ? branch.baseRoot : input.revision === 7 ? 'fixed-result-root' : branch.root,
        entries: [], nextCursor: null };
    }),
    pinBranch: vi.fn(async (input: Parameters<KernelScopedClient['pinBranch']>[0]) => {
      const branch = branches.get(input.branchId);
      if (!branch) throw new Error(`Unexpected pin branch ${input.branchId}`);
      return { ...branch, pinId: input.pinId ?? 'predecessor-query-pin', view: 'revision',
        revision: input.revision, writeRevision: input.revision,
        root: input.revision === 7 ? 'fixed-result-root' : branch.baseRoot };
    }),
    putBlob: vi.fn(async (bytes: Buffer) => ({ hash: 'source-provenance-object', byteLength: bytes.length, ownerId: 'source-provenance-upload' })),
    createBranch: vi.fn(async (input: Parameters<KernelScopedClient['createBranch']>[0]) => {
      branches.set(input.branchId, { branchId: input.branchId, workspaceId: input.workspaceId,
        root: input.baseRef!, baseRoot: input.baseRef!, writeRevision: 0, headRevision: 0,
        parentRef: input.parentRef!, captureScopes: input.captureScopes!, draftBasePaths: input.draftBasePaths!, createdAt: 3, updatedAt: 3 });
      return { created: true, branchId: input.branchId, root: input.baseRef, writeRevision: 0, headRevision: 0 };
    }),
    unpinBranch: vi.fn(async (_input: Parameters<KernelScopedClient['unpinBranch']>[0]) => ({ released: true })),
    fileRootRegister: vi.fn(),
  };
  const documents = { admitWorkspaceRegistration: vi.fn(async (workspaceId: string) => ({ workspaceId,
    hostId: 'host', kind: 'directory' as const, canonicalPath: '/removed/original' })) };
  const runtime = {
    onEvent: (listener: typeof emit) => { emit = listener; return () => {}; }, onExit: () => () => {}, onReady: () => () => {}, reconcileObservations: async () => [],
    children: async () => [], childExecutions: async () => [structuredClone(child)], unacceptedChildDependencies: async () => [], status: async () => ({ eventCursor: 7 }), events: async () => [],
    context: vi.fn(async () => checkpoint), childExecution: async () => structuredClone(child), launch: async () => null,
    readyChildSource: vi.fn(async (input: Parameters<AgentRuntimeClient['readyChildSource']>[0]) => {
      child.source = { kind: 'ready', handoff: null, pin: input.pin, selection: { mode: input.source.mode, resource_owner: input.source.resourceOwner, workspace_id: input.source.workspaceId,
        execution_workspace_id: input.source.executionWorkspaceId, branch_id: input.source.branchId, revision: input.source.revision, live_root: null }, provenance: input.provenance };
      return structuredClone(child);
    }),
    prepareChild: vi.fn(async (_input: Parameters<AgentRuntimeClient['prepareChild']>[0]) => {
      if (calendarHeld) throw new KernelClientError({ code: 'activation-held', message: 'Definition paused', retryable: true });
      child.receipt = { run_id: 'new-run', input_id: 'new-input', thread_id: identity.threadId, branch_id: identity.branchId, cursor: 9 };
      child.state = 'ready'; return structuredClone(child);
    }),
    releaseChildResources: vi.fn(async () => { child.resources_released = true; return structuredClone(child); }),
    releaseMcpResourceSource: vi.fn(async () => {}),
    failChild: vi.fn(async () => structuredClone(child)),
  };
  const kernel = { reconcileChildToolHandoffs() {}, claimChildSource: vi.fn(), releaseChildToolHandoff: vi.fn(),
    issueGrant: vi.fn(async (input: KernelGrantIssueInput) => ({ ...input, storageIdentity: 'storage' })),
    revokeGrant: vi.fn(async () => {}), scoped: vi.fn(() => scoped) };
  const resolveWorkspaceRoot = vi.fn(async () => { throw new Error('Fixed continuation must not reopen the former live directory'); });
  const storageAdapter = new KernelStorageAdapter({ client: kernel as unknown as KernelClient,
    hostId: 'host', storageRoot: '/unused', resolveWorkspaceRoot });
  const prepareContext = Object.assign(vi.fn(async () => { throw new Error('Initial context must not replace the old checkpoint'); }), { forSource: vi.fn(async () => context) });
  const prepareSkillInput = vi.fn(async () => ({ status: 'ready', skill }));
  const continueRun = vi.fn(async () => {});
  const collaboration = new ThreadCollaboration({ kernel: kernel as never, storageAdapter, resolveLiveSource: async () => { throw new Error('No live source'); }, sourceCaptureOwners: { documents } as never,
    runtime: runtime as unknown as AgentRuntimeClient,
    prepareContext: prepareContext as never, prepareSkillInput: prepareSkillInput as never, continueRun, recoverLaunches: async () => {}, onError: (_id, error) => errors.push(error) });
  try {
    await collaboration.recover();
    if (kind === 'calendar') {
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(runtime.prepareChild).toHaveBeenCalledOnce(); });
      expect(runtime.releaseChildResources).not.toHaveBeenCalled(); expect(runtime.failChild).not.toHaveBeenCalled();
      calendarHeld = false;
      emit({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', kernelEpoch: 'same-epoch', stream: 'durable', cursor: 8 });
    }
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(continueRun).toHaveBeenCalledOnce(); });
    expect(scoped.pinBranch).toHaveBeenNthCalledWith(1, expect.objectContaining({ branchId: 'old-result', revision: 7 }), expect.any(AbortSignal));
    expect(scoped.createBranch).toHaveBeenCalledOnce();
    expect(scoped.createBranch).toHaveBeenCalledWith({ operationId: 'branch-create:child-source:execution:new',
      branchId: 'child-source:execution:new', workspaceId: 'workspace', entries: [], baseRef: 'fixed-result-root', parentRef: 'old-result@7',
      draftBasePaths: [], captureScopes: [], sourceProvenance: { objectHash: 'source-provenance-object', ownerId: 'source-provenance-upload' } });
    expect(JSON.parse(scoped.putBlob.mock.calls[0]![0].toString('utf8'))).toEqual(child.source_basis!.provenance);
    expect(scoped.pinBranch).toHaveBeenNthCalledWith(2, expect.objectContaining({ branchId: 'child-source:execution:new',
      pinId: 'child-source-pin:execution:new', revision: 0 }), expect.any(AbortSignal));
    expect(scoped.readBranch.mock.calls.every(([input]) => input.includeEntries === false)).toBe(true);
    expect(runtime.readyChildSource).toHaveBeenCalledOnce();
    expect(runtime.readyChildSource).toHaveBeenCalledWith({ executionId: child.execution_id,
      source: { mode: 'materialized', liveRoot: null, resourceOwner: { kind: 'local' as const }, workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'child-source:execution:new', revision: 0 },
      pin: { pin_id: 'child-source-pin:execution:new', root: 'fixed-result-root', source: { ...source, branch_id: 'child-source:execution:new', revision: 0 } },
      provenance: child.source_basis!.provenance }, expect.any(AbortSignal));
    expect(runtime.prepareChild).toHaveBeenCalledWith(expect.objectContaining({ executionId: child.execution_id,
      expectedContextCheckpoint: checkpoint.id, context, ...(kind === 'user_continuation' ? { inputPreparation: { expectedContextCheckpoint: null, skill } } : {}) }), expect.any(AbortSignal));
    if (kind !== 'user_continuation') {
      expect(prepareSkillInput).not.toHaveBeenCalled();
      expect(runtime.prepareChild.mock.calls[0]![0]).not.toHaveProperty('inputPreparation');
    }
    expect(prepareContext.forSource).toHaveBeenCalledWith(checkpoint, expect.objectContaining({ branchId: 'child-source:execution:new', revision: 0 }), expect.any(AbortSignal));
    expect(continueRun).toHaveBeenCalledWith('new-run', expect.any(AbortSignal));
    expect(kernel.claimChildSource).not.toHaveBeenCalled(); expect(kernel.releaseChildToolHandoff).not.toHaveBeenCalled();
    expect(runtime.releaseMcpResourceSource).not.toHaveBeenCalled();
    expect(runtime.releaseChildResources).not.toHaveBeenCalled();
    expect(scoped.unpinBranch).toHaveBeenCalledOnce();
    expect(scoped.unpinBranch).toHaveBeenCalledWith({ operationId: 'branch-query-unpin:old-result:predecessor-query-pin',
      branchId: 'old-result', pinId: 'predecessor-query-pin' });
    expect(kernel.issueGrant).toHaveBeenCalledOnce();
    expect(kernel.issueGrant).toHaveBeenCalledWith({ grantId: expect.stringMatching(/^child-branch:/), threadId: identity.threadId,
      owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }, expect.any(AbortSignal));
    expect(kernel.revokeGrant).toHaveBeenCalledWith(kernel.issueGrant.mock.calls[0]![0].grantId);
    expect(scoped.unpinBranch.mock.invocationCallOrder[0]).toBeLessThan(kernel.revokeGrant.mock.invocationCallOrder[0]!);
    expect(documents.admitWorkspaceRegistration).toHaveBeenCalledTimes(2);
    expect(documents.admitWorkspaceRegistration).toHaveBeenCalledWith('workspace', expect.any(AbortSignal));
    expect(documents.admitWorkspaceRegistration.mock.invocationCallOrder[0]).toBeLessThan(kernel.issueGrant.mock.invocationCallOrder[0]!);
    expect(documents.admitWorkspaceRegistration.mock.invocationCallOrder[1]).toBeLessThan(runtime.readyChildSource.mock.invocationCallOrder[0]!);
    expect(scoped.fileRootRegister).not.toHaveBeenCalled(); expect(resolveWorkspaceRoot).not.toHaveBeenCalled();
    expect(runtime.failChild).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  } finally { collaboration.stop(); }
});

it.each(['dispatch', 'user_continuation', 'message_request', 'followup', 'calendar'] as const)('source-free %s prepares real null context and launches without a file handoff or branch', async kind => {
  const child = execution();
  child.source = { kind: 'absent' }; child.source_basis = null; child.code_result = { kind: 'not_applicable' };
  child.selected_profile.tools = []; child.launch.tools = []; child.input = { text: 'Continue capability work' };
  if (kind === 'dispatch') child.trigger = { kind };
  if (kind === 'calendar') child.trigger = { kind, definition_id: 'calendar', occurrence_id: 'occurrence', input_id: 'input', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  if (kind === 'message_request') child.trigger = { kind, message_id: 'request', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  if (kind === 'followup') child.trigger = { kind, followup_id: 'followup', occurrence_id: 'occurrence', input_id: 'input', previous_execution_id: 'original-dispatch', previous_run_id: 'old-run', previous_run_revision: 9, expected_head: 'old-head' };
  const checkpoint = { id: 'old-context', revision: 4, proposal: { through_id: 'old-head', summary: 'Retained summary' } };
  const context = { effectiveSystemPrompt: 'Capability worker', instructionSources: [], memoryCheckpoint: 'old-memory' };
  const prepareContext = Object.assign(vi.fn(async () => context), { forSource: vi.fn(async () => context) });
  const errors: unknown[] = [];
  const runtime = {
    onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {}, reconcileObservations: async () => [],
    children: async () => [], childExecutions: async () => [structuredClone(child)], unacceptedChildDependencies: async () => [],
    status: async () => ({ eventCursor: 1 }), events: async () => [], context: async () => checkpoint, launch: async () => null,
    thread: async () => ({ bot_id: null }),
    childExecution: async () => structuredClone(child), readyChildSource: vi.fn(),
    prepareChild: vi.fn(async (_input: Parameters<AgentRuntimeClient['prepareChild']>[0]) => {
      child.receipt = { run_id: 'source-free-run', input_id: 'input', thread_id: child.child_thread_id, branch_id: child.child_branch_id, cursor: 2 };
      child.state = 'ready'; return structuredClone(child);
    }),
    releaseChildResources: vi.fn(async () => { child.resources_released = true; return structuredClone(child); }),
    failChild: vi.fn(),
  };
  const kernel = { reconcileChildToolHandoffs() {}, claimChildSource: vi.fn(), releaseChildToolHandoff: vi.fn(), issueGrant: vi.fn() };
  const continueRun = vi.fn(async () => {});
  const collaboration = new ThreadCollaboration({ kernel: kernel as never, runtime: runtime as unknown as AgentRuntimeClient,
     storageAdapter: {} as never, sourceCaptureOwners: {} as never,
    resolveLiveSource: async () => { throw new Error('No file source was selected'); }, prepareContext: prepareContext as never,
    continueRun, recoverLaunches: async () => {}, onError: (_id, error) => errors.push(error) });
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(continueRun).toHaveBeenCalledOnce());
    expect(runtime.releaseChildResources).not.toHaveBeenCalled();
    expect(continueRun).toHaveBeenCalledWith('source-free-run', expect.any(AbortSignal));
    expect(runtime.prepareChild).toHaveBeenCalledWith(expect.objectContaining({ source: null,
      expectedContextCheckpoint: kind === 'dispatch' ? null : checkpoint.id }), expect.any(AbortSignal));
    if (kind === 'dispatch') expect(prepareContext).toHaveBeenCalledWith(identity, null, expect.objectContaining({ threadRole: 'worker', childProfile: child.selected_profile }), expect.any(AbortSignal));
    else expect(prepareContext.forSource).toHaveBeenCalledWith(checkpoint, null, expect.any(AbortSignal));
    expect(runtime.readyChildSource).not.toHaveBeenCalled(); expect(kernel.claimChildSource).not.toHaveBeenCalled();
    expect(kernel.issueGrant).not.toHaveBeenCalled(); expect(runtime.failChild).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  } finally { collaboration.stop(); }
});


it('cancels child settlement observation while the original language process still drains', async () => {
  const child = execution();
  child.source = { kind: 'ready', handoff: null,
    selection: { ...source, mode: 'materialized' },
    pin: { pin_id: 'source-pin', root: 'fixed-result-root', source },
    provenance: { consistency: 'fixed-root', root: 'fixed-result-root' } };
  child.receipt = { run_id: 'original-child-run', input_id: 'input', thread_id: identity.threadId, branch_id: identity.branchId, cursor: 8 };
  let stopped!: () => void;
  let drained = false;
  const drain = new Promise<void>(resolve => { stopped = () => { drained = true; resolve(); }; });
  const releaseLanguageSource = vi.fn(async (_runId: string) => drain);
  const readRun = vi.fn();
  const runtime = { onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {}, run: readRun };
  const collaboration = new ThreadCollaboration({ kernel: { releaseLanguageSource } as unknown as KernelClient,
    runtime: runtime as unknown as AgentRuntimeClient, storageAdapter: {} as never, sourceCaptureOwners: {} as never,
    resolveLiveSource: async () => { throw new Error('No live source'); }, prepareContext: vi.fn() as never,
    continueRun: vi.fn(), recoverLaunches: vi.fn(), onError: vi.fn() });
  const controller = new AbortController();
  try {
    // Exercise the existing settlement boundary without replacing the source or
    // process owner. Its caller owns cancellation, not the retained drain.
    const settlement = (collaboration as unknown as { settle(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> })
      .settle(child, controller.signal);
    expect(releaseLanguageSource).toHaveBeenCalledWith('original-child-run');
    controller.abort();
    await expect(settlement).rejects.toMatchObject({ name: 'AbortError' });
    expect(drained).toBe(false);
    expect(readRun).not.toHaveBeenCalled();
    stopped(); await drain;
    expect(readRun).not.toHaveBeenCalled();
  } finally { stopped(); collaboration.stop(); }
});

it('Bot Sleep joins its original child owner, while Delete retries original resource release before removal', async () => {
  const child = execution();
  child.source = { kind: 'absent' }; child.source_basis = null; child.code_result = { kind: 'not_applicable' };
  child.state = 'ready'; child.receipt = { run_id: 'child-run', input_id: 'input', thread_id: child.child_thread_id, branch_id: child.child_branch_id, cursor: 9 };
  const other = { ...structuredClone(child), execution_id: 'other-execution', child_thread_id: 'thread:other' };
  let allowed = true; let finish!: () => void;
  const running = new Promise<void>(resolve => { finish = resolve; });
  let releasingFails = true;
  const runtime = {
    onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {}, reconcileObservations: async () => [],
    children: async () => [], childExecutions: async () => [structuredClone(child), other], unacceptedChildDependencies: async () => [],
    status: async () => ({ eventCursor: 1 }), events: async () => [], childExecution: async () => structuredClone(child), launch: async () => null,
    releaseMcpResourceSource: vi.fn(async () => {}),
    releaseChildResources: vi.fn(async () => {
      if (releasingFails) throw new Error('Original child release is not confirmed');
      child.resources_released = true; return structuredClone(child);
    }),
  };
  const continueRun = vi.fn(async () => running);
  const collaboration = new ThreadCollaboration({ kernel: { reconcileChildToolHandoffs() {}, releaseChildToolHandoff() {} } as never,
    runtime: runtime as unknown as AgentRuntimeClient, storageAdapter: {} as never, sourceCaptureOwners: {} as never,
    resolveLiveSource: vi.fn(), prepareContext: vi.fn() as never, continueRun, recoverLaunches: async () => {},
    canExecuteThread: async id => id === child.child_thread_id && allowed, onError: vi.fn() });
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(continueRun).toHaveBeenCalledOnce());
    allowed = false;
    let drained = false;
    const stop = collaboration.suspendThreads(new Set([child.child_thread_id])).then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    finish(); await stop;
    expect(child.cancel_requested).toBe(false);
    expect(child.report).toBeNull();
    child.report = { outcome: 'cancelled', sender_thread_id: child.child_thread_id, run_id: child.receipt.run_id, history_ids: [], detail: 'User deleted this Bot' };
    await expect(collaboration.releaseCancelledThreads(new Set([child.child_thread_id]))).rejects.toThrow('Original child release is not confirmed');
    expect(child.resources_released).toBe(false);
    releasingFails = false;
    await collaboration.releaseCancelledThreads(new Set([child.child_thread_id]));
    expect(child.resources_released).toBe(true);
    expect(other.resources_released).toBe(false);
  } finally { finish(); collaboration.stop(); }
});
