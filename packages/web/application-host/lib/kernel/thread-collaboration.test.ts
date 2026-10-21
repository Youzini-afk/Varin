import { expect, it, vi } from 'vitest';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DelegatedExecution, LaunchSource } from './protocol.generated.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import { ThreadCollaboration } from './thread-collaboration.js';
import { preparationFailure } from './preparation-failure.js';
import { SourceAdmissionError } from './source-admission-error.js';
import { SourceCaptureError } from '../harness/working-state/source-preparation.js';

// Exercise the real discovery/cleanup coordinator and managed handoff wrapper.
// Preparation, context readers and native process transport are outside this test.
vi.mock('../agent-resources/activation.js', () => ({ parseExplicitSkillCommand: vi.fn() }));
vi.mock('./thread-resource-scope.js', () => ({ ResourceScopeError: class extends Error {} }));
vi.mock('./kernel-client.js', async () => await import('./kernel-error.js'));
vi.mock('./child-source-store.js', () => ({ prepareChildSourceStore: vi.fn(), prepareContinuationSourceStore: vi.fn() }));
vi.mock('./storage-adapter.js', () => ({ KernelWorkingStateRootStore: class {
  constructor() { throw new Error('Cleanup must not open a new source store'); }
} }));

function fixture(owner: 'local' | 'managed' = 'managed') {
  const source: LaunchSource = { mode: 'fixed_branch', resource_owner: owner === 'local' ? { kind: 'local' }
    : { kind: 'managed_host', hostId: 'storage-B', connectionId: 'original-connection', endpointIdentity: 'original-endpoint' },
    workspace_id: 'original-workspace', execution_workspace_id: 'original-workspace', branch_id: 'parent-source', revision: 3, live_root: null };
  const pin = { pin_id: 'original-handoff-pin', root: 'original-root', source };
  const childSource: LaunchSource = { ...source, mode: 'materialized', branch_id: 'child-source:original-execution', revision: 0 };
  const child: DelegatedExecution = {
    execution_id: 'original-execution', child_operation_id: 'original-execution', parent_run_id: 'parent-run',
    parent_thread_id: 'parent-thread', parent_branch_id: 'parent-branch', child_thread_id: 'child-thread', child_branch_id: 'child-branch',
    origin: { kind: 'model_step', request_id: 'original-request' }, call_id: 'original-call', project_id: null,
    trigger: { kind: 'dispatch' }, input: { task: 'Original work' }, configuration: {},
    selected_profile: { preset_id: null, catalog_identity: null, work_mode: 'isolated_write', tools: [], instructions: '' },
    launch: { credential_scope: null, child_dispatch: null, policy_models: [], mcp_binding: null, extension_bindings: [],
      connection_identity: 'original', provider_family: 'original', model: 'original', configuration_generation: 1,
      tool_schema_generation: 1, tools: [], policy: { name: 'default', version: '1' }, source },
    policy_target: { kind: 'default' }, source_basis: null,
    source: { kind: 'ready', handoff: { resource_authority: null, operation_id: 'original-handoff', source,
      root: { kind: 'fixed', pin } }, selection: childSource,
      pin: { ...pin, pin_id: 'original-child-pin', source: childSource }, provenance: { consistency: 'fixed-root', root: pin.root } },
    code_result: { kind: 'pending' }, state: 'ready', revision: 1, cursor: 1,
    receipt: { run_id: 'original-child-run', input_id: 'original-input', thread_id: 'child-thread', branch_id: 'child-branch', cursor: 1 },
    report: null, terminal_head: null, resources_released: false, cancel_requested: false,
  };
  const trace: string[] = [];
  const errors: unknown[] = [];
  const service = {
    bind: vi.fn(async (_input: Parameters<ManagedSourceClient['bind']>[0]) => ({ authorityId: 'cleanup-authority', resourceEpoch: 'original-B-epoch', source })),
    service: vi.fn(async (input: Parameters<ManagedSourceClient['service']>[0]) => {
      if (input.operation.kind === 'mcp' && input.operation.action.kind === 'child_release') {
        trace.push('mcp-dependencies-released');
        return { ok: true, value: { retire: false, dependenciesDrained: true } };
      }
      expect(input.operation).toEqual({ kind: 'child_release', execution: structuredClone(child) });
      trace.push('handoff-release'); return { released: true };
    }),
    release: vi.fn(async () => { trace.push('cleanup-authority-retired'); }),
    inspectScope: vi.fn(async () => []),
  };
  const runtime = {
    childPreparationProgress: vi.fn(async () => ({ updated: true })),
    thread: vi.fn(async () => ({bot_id:null})),
    launch: vi.fn(async () => ({ selection: child.launch })),
    operation: vi.fn(async () => ({ id: child.child_operation_id, run_id: child.parent_run_id, execution_owner: { kind: 'host', host_id: 'coordinator-A', incarnation: 'A-epoch' }, epoch: 2 })),
    coordinatorHostId: 'coordinator-A', onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {},
    reconcileObservations: async () => [], children: async () => [], unacceptedChildDependencies: async () => [],
    childExecutions: async () => [structuredClone(child)], childExecution: async () => structuredClone(child),
    failChild: vi.fn(async (_executionId: string, code: string, detail?: string) => {
      child.state = 'failed';
      child.code_result = {kind:'unavailable',code,effect:'none'};
      child.report = {outcome:'failed',sender_thread_id:child.child_thread_id,run_id:null,history_ids:[],detail:detail ?? code};
      return structuredClone(child);
    }),
    status: async () => ({ eventCursor: 0 }), events: async () => [],
    managedSource: vi.fn(async () => service), releaseMcpResourceSource: vi.fn(async () => { trace.push('observers-released'); }),
    retireSourceGrants: vi.fn(async (_runId: string) => { trace.push('run-grants-retired'); }),
    releaseChildResources: vi.fn(async (executionId: string) => {
      expect(executionId).toBe(child.execution_id); trace.push('resources-released'); child.resources_released = true;
      return structuredClone(child);
    }),
  };
  const scoped = { unpinBranch: vi.fn(async () => { trace.push('handoff-release'); }), deleteBranch: vi.fn(async () => {}) };
  const kernel = { reconcileChildToolHandoffs() {}, releaseChildToolHandoff: vi.fn(),
    claimChildSource: vi.fn(async () => ({ grantId: 'original-cleanup-grant' })), scoped: () => scoped,
    revokeGrant: vi.fn(async () => { trace.push('cleanup-authority-retired'); }) };
  const continueRun = vi.fn(async () => {});
  const prepareContext = vi.fn();
  const open = (reconcileDomainReceipts?: (signal: AbortSignal) => Promise<void>) => new ThreadCollaboration({ kernel: kernel as never, runtime: runtime as unknown as AgentRuntimeClient,
    storageAdapter: {} as never, sourceCaptureOwners: {} as never, prepareContext: prepareContext as never,
    resolveLiveSource: async () => { throw new Error('Must not reacquire a live source'); }, continueRun,
    ...(reconcileDomainReceipts ? { reconcileDomainReceipts } : {}),
    recoverLaunches: async () => {}, onError: (_id, error) => errors.push(error) });
  const complete = () => {
    child.state = 'completed'; child.revision += 1;
    child.report = { outcome: 'succeeded', sender_thread_id: child.child_thread_id, run_id: child.receipt!.run_id, history_ids: [], detail: null };
    child.code_result = { kind: 'published', effect: 'confirmed', result: { publication_id: 'child-result:original-execution',
      workspace_id: source.workspace_id, branch_id: childSource.branch_id!, result_revision: 4,
      root: 'original-published-result', base_root: pin.root, record_id: 'original-result-record' } };
  };
  return { child, source, trace, errors, service, runtime, kernel, scoped, continueRun, prepareContext, open, complete };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('keeps the original cause when a source owner wraps a preparation failure', () => {
  expect(preparationFailure(new SourceCaptureError('new-file.txt'), 'Preparing child source'))
    .toMatchObject({ code: 'source_changed', detail: expect.stringContaining('new-file.txt') });
  const failure = preparationFailure(new SourceAdmissionError('source_unavailable',
    {cause:new Error('Cannot capture workspace: D:/work/source no longer exists')}), 'Preparing child source');
  expect(failure.code).toBe('source_unavailable');
  expect(failure.detail).toContain('Preparing child source:');
  expect(failure.detail).toContain('D:/work/source no longer exists');
});

it('records the original context preparation error in the child report', async () => {
  const f = fixture('local');
  f.child.state = 'preparing'; f.child.receipt = null;
  f.prepareContext.mockRejectedValue(new Error('Cannot read selected instruction file: access denied'));
  const collaboration = f.open();
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(f.runtime.failChild).toHaveBeenCalledWith(f.child.execution_id, 'preparation_failed',
      'Preparing child context: Cannot read selected instruction file: access denied'));
    expect(f.child.report?.detail).toContain('Cannot read selected instruction file');
    expect(f.child.code_result).toMatchObject({kind:'unavailable',code:'preparation_failed'});
  } finally { collaboration.stop(); }
});
it.each(['local', 'managed'] as const)('%s child stays discoverable from launch through failed terminal retirement and reopen', async owner => {
  const f = fixture(owner);
  let collaboration = f.open();
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(f.trace).toContain('cleanup-authority-retired'));
    await tick();
    expect(f.continueRun).toHaveBeenCalledOnce();
    expect(f.child.resources_released).toBe(false);
    expect(f.runtime.retireSourceGrants).not.toHaveBeenCalled();
    expect(f.runtime.releaseMcpResourceSource).not.toHaveBeenCalled();
    f.complete();
    const report = structuredClone(f.child.report), source = structuredClone(f.child.source), result = structuredClone(f.child.code_result);
    f.runtime.retireSourceGrants.mockRejectedValueOnce(new Error('Original source retirement remains pending'));
    await collaboration.recover();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.child.resources_released).toBe(false);
    expect(f.runtime.releaseChildResources).not.toHaveBeenCalled();
    collaboration.stop();
    collaboration = f.open();
    await collaboration.recover();
    await vi.waitFor(() => expect(f.child.resources_released).toBe(true));
    await tick();
    expect(f.runtime.retireSourceGrants).toHaveBeenCalledTimes(2);
    expect(f.runtime.retireSourceGrants).toHaveBeenNthCalledWith(1, 'original-child-run');
    expect(f.runtime.retireSourceGrants).toHaveBeenNthCalledWith(2, 'original-child-run');
    expect(f.runtime.releaseChildResources).toHaveBeenCalledOnce();
    expect(f.trace.lastIndexOf('cleanup-authority-retired')).toBeLessThan(f.trace.indexOf('run-grants-retired'));
    expect(f.trace.indexOf('run-grants-retired')).toBeLessThan(f.trace.indexOf('resources-released'));
    expect(f.child.report).toEqual(report); expect(f.child.source).toEqual(source);
    expect(f.child.code_result).toEqual(result); expect(f.scoped.deleteBranch).not.toHaveBeenCalled();
    await collaboration.recover(); await tick();
    expect(f.runtime.retireSourceGrants).toHaveBeenCalledTimes(2);
    expect(f.continueRun).toHaveBeenCalledOnce();
    if (owner === 'managed') {
      expect(f.service.bind.mock.calls.every(([input]) => input.scope.kind === 'source_read' && input.scope.key === 'child:original-execution')).toBe(true);
      expect(f.kernel.claimChildSource).not.toHaveBeenCalled();
    }
  } finally { collaboration.stop(); }
});

it('leaves final cleanup unconfirmed when the managed handoff authority itself fails to retire', async () => {
  const f = fixture(); f.complete();
  f.service.release.mockRejectedValueOnce(new Error('Original cleanup authority remains pending'));
  let collaboration = f.open();
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.runtime.retireSourceGrants).not.toHaveBeenCalled();
    expect(f.runtime.releaseChildResources).not.toHaveBeenCalled();
    collaboration.stop(); collaboration = f.open();
    await collaboration.recover();
    await vi.waitFor(() => expect(f.child.resources_released).toBe(true));
    expect(f.service.service).toHaveBeenCalledTimes(2);
  } finally { collaboration.stop(); }
});

it.each(['handoff', 'retirement'] as const)('does not advance a late %s response after its original Host owner stops', async stage => {
  const f = fixture(); f.complete();
  let finish!: () => void;
  const gate = stage === 'handoff' ? f.service.release : f.runtime.retireSourceGrants;
  gate.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
  let collaboration = f.open();
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    expect(f.child.resources_released).toBe(false);
    collaboration.stop(); finish(); await tick();
    expect(f.runtime.releaseChildResources).not.toHaveBeenCalled();
    if (stage === 'handoff') expect(f.runtime.retireSourceGrants).not.toHaveBeenCalled();
    collaboration = f.open();
    await collaboration.recover();
    await vi.waitFor(() => expect(f.child.resources_released).toBe(true));
    expect(f.runtime.retireSourceGrants).toHaveBeenCalledTimes(stage === 'handoff' ? 1 : 2);
    expect(f.errors).toEqual([]);
  } finally { finish?.(); collaboration.stop(); }
});

it('handoff cleanup does not retire a materialized source while its original result remains unsettled', async () => {
  const f = fixture('local'); f.complete();
  if (f.child.source?.kind !== 'ready') throw new Error('Expected the original source');
  f.child.source.selection.mode = 'materialized'; f.child.code_result = { kind: 'pending' };
  const collaboration = f.open();
  try {
    // The existing settlement owner can return pending while an accepted writer drains.
    // Exercise the cleanup boundary with that unchanged durable result.
    await (collaboration as unknown as { releaseHandoff(child: DelegatedExecution, signal: AbortSignal): Promise<void> })
      .releaseHandoff(structuredClone(f.child), new AbortController().signal);
    expect(f.scoped.unpinBranch).toHaveBeenCalledOnce();
    expect(f.runtime.retireSourceGrants).not.toHaveBeenCalled();
    expect(f.runtime.releaseChildResources).not.toHaveBeenCalled();
    expect(f.scoped.deleteBranch).not.toHaveBeenCalled();
    expect(f.child.code_result).toEqual({ kind: 'pending' });
  } finally { collaboration.stop(); }
});

it('failed preparation without a Run still releases the original handoff and unused child source', async () => {
  const f = fixture('local'); f.complete(); f.child.receipt = null;
  f.child.report!.outcome = 'cancelled';
  f.child.code_result = { kind: 'unavailable', code: 'cancelled', effect: 'none' };
  const collaboration = f.open();
  try {
    await collaboration.releaseCancelledThreads(new Set([f.child.child_thread_id]));
    expect(f.child.resources_released).toBe(true);
    expect(f.scoped.deleteBranch).toHaveBeenCalledWith({ operationId: 'child-unused-source-delete:original-execution',
      branchId: 'child-source:original-execution' }, expect.any(AbortSignal));
    expect(f.runtime.retireSourceGrants).not.toHaveBeenCalled();
    expect(f.trace.indexOf('cleanup-authority-retired')).toBeLessThan(f.trace.indexOf('resources-released'));
  } finally { collaboration.stop(); }
});


it('keeps parent definitions and Host handoff after pre-MCP continueLaunch failure, then transfers only after saved child binding commits', async () => {
  const f = fixture();
  f.child.launch.mcp_binding = { reference: 'parent-binding', generation: 1, tools: [], routes: {}, resources: {},
    provenance: { servers: { project: { definition_version: 'original-definition', resource_key: 'parent-resource',
      owner: { resource_owner: f.source.resource_owner, execution_scope: 'workspace',
        configuration: { agent_dir: '/b-agent', config_cwd: '/b-project', project_trusted: true },
        source_authority: { coordinator_host_id: 'coordinator-A', authority_id: 'parent-mcp', resource_epoch: 'parent-epoch' } } } } } };
  f.continueRun.mockRejectedValueOnce(new Error('Credential rebind unavailable before MCP preparation'));
  let collaboration = f.open();
  try {
    await collaboration.recover();
    await vi.waitFor(() => expect(f.errors).toHaveLength(1)); await tick();
    expect(f.trace).not.toContain('mcp-dependencies-released');
    expect(f.kernel.releaseChildToolHandoff).not.toHaveBeenCalled();
    expect(f.child.resources_released).toBe(false);
    collaboration.stop();
    f.continueRun.mockImplementationOnce(async () => {
      f.runtime.launch.mockResolvedValue({ selection: { ...f.child.launch, source: f.child.source!.kind === 'ready' ? f.child.source!.selection : null,
        mcp_binding: { ...f.child.launch.mcp_binding!, reference: 'actual-child-binding' } } });
    });
    collaboration = f.open(); await collaboration.recover();
    await vi.waitFor(() => expect(f.trace).toContain('mcp-dependencies-released')); await tick();
    expect(f.continueRun).toHaveBeenCalledTimes(2);
    // Independent extension pins remain until actual startRun or terminal cleanup.
    expect(f.kernel.releaseChildToolHandoff).not.toHaveBeenCalled();
    expect(f.runtime.releaseMcpResourceSource).not.toHaveBeenCalled();
    expect(f.child.resources_released).toBe(false);
  } finally { collaboration.stop(); }
});

it('retries original domain receipts on Source recovery and retains a wake arriving during the prior pass', async () => {
  const f = fixture(); f.runtime.childExecutions = async () => [];
  let finish!: () => void;
  const reconcile = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const collaboration = f.open(reconcile);
  try {
    await collaboration.recover(); expect(reconcile).toHaveBeenCalledTimes(1);
    collaboration.sourceReached(); await tick(); expect(reconcile).toHaveBeenCalledTimes(1);
    finish(); await tick(); await tick(); expect(reconcile).toHaveBeenCalledTimes(2);
    collaboration.sourceReached(); await tick(); expect(reconcile).toHaveBeenCalledTimes(3);
    collaboration.stop(); collaboration.sourceReached(); await tick(); expect(reconcile).toHaveBeenCalledTimes(3);
  } finally { collaboration.stop(); }
});
