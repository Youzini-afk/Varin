import { expect, it, vi } from 'vitest';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DelegatedExecution, LaunchSource } from './protocol.generated.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import { ThreadCollaboration } from './thread-collaboration.js';

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
      expect(input.operation).toEqual({ kind: 'child_release', execution: structuredClone(child) });
      trace.push('handoff-release'); return { released: true };
    }),
    release: vi.fn(async () => { trace.push('cleanup-authority-retired'); }),
  };
  const runtime = {
    coordinatorHostId: 'coordinator-A', onEvent: () => () => {}, onExit: () => () => {}, onReady: () => () => {},
    reconcileObservations: async () => [], children: async () => [], unacceptedChildDependencies: async () => [],
    childExecutions: async () => [structuredClone(child)], childExecution: async () => structuredClone(child),
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
  const open = () => new ThreadCollaboration({ kernel: kernel as never, runtime: runtime as unknown as AgentRuntimeClient,
    storageAdapter: {} as never, sourceCaptureOwners: {} as never, prepareContext: vi.fn() as never,
    resolveLiveSource: async () => { throw new Error('Must not reacquire a live source'); }, continueRun,
    recoverLaunches: async () => {}, onError: (_id, error) => errors.push(error) });
  const complete = () => {
    child.state = 'completed'; child.revision += 1;
    child.report = { outcome: 'succeeded', sender_thread_id: child.child_thread_id, run_id: child.receipt!.run_id, history_ids: [], detail: null };
    child.code_result = { kind: 'published', effect: 'confirmed', result: { publication_id: 'child-result:original-execution',
      workspace_id: source.workspace_id, branch_id: childSource.branch_id!, result_revision: 4,
      root: 'original-published-result', base_root: pin.root, record_id: 'original-result-record' } };
  };
  return { child, source, trace, errors, service, runtime, kernel, scoped, continueRun, open, complete };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

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
