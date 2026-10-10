import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime, type HostServiceBinding } from '@varin/extension-host';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import { CHILD_INTEGRATION_CAPABILITY, createIntegrationReceiptReconciler, createIntegrationToolOwner } from './integration-tool-owner.js';
import { retainExtensionTool } from './extension-tool-owner.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ToolBridge, type HostToolCall, type PrivateToolFrame } from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';
import type { DelegatedExecution, ExecutorOwner, LaunchIntent, LaunchSource, Run } from './protocol.generated.js';
import type { IntegrationOperationReceipt, IntegrationPlanInput } from '../harness/working-state/integration-coordinator.js';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import { UnconfirmedIntegrationCommitError } from '../recovery/durable-file-operation.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const input = { childOperationId: 'dispatch-request:tool:child', executionId: 'continued-child-execution', publicationId: 'fixed-publication' };
const forged = { status: 'applied', effect: 'confirmed', executorStopped: true };
const observationCapability = 'test.integration-observation';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function domainReceipt(operationId: string, facts: Partial<IntegrationOperationReceipt> = {}): IntegrationOperationReceipt {
  const status = facts.status ?? 'applied';
  return {
    operationId, status: 'applied', appliedPaths: ['child.txt'], conflictPaths: [], changedFiles: ['child.txt'],
    diffStats: { files: 1, insertions: 1, deletions: 0 }, text: 'Original integration journal result',
    receipt: { kind: 'integration', workspaceId: 'workspace', operationId, revision: 3,
      state: status === 'applied' ? 'complete' : status },
    effect: 'confirmed', executorStopped: true, recoveryCoverage: 'files-only', ...facts,
  };
}

/** Component boundary: the SDK, installed broker, retained lease, invocation scope and domain
 * adapter are real. Management queries, runtime records and Coordinator/file-scope ports below
 * are explicit fixtures, not native kernel IPC, a real file merge or a second journal. */
async function openHarness(options: { callback?: 'mask' | 'early' | 'tamper'; readDeclaration?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-child-integration-tool-'));
  let runtime: ApplicationExtensionRuntime | undefined;
  let retained: Awaited<ReturnType<typeof retainExtensionTool>> | undefined;
  try {
    const source = path.join(repository, 'examples/extensions/child-integration-tool');
    const installed = path.join(root, 'example');
    await fs.mkdir(installed);
    await fs.copyFile(path.join(source, 'package.json'), path.join(installed, 'package.json'));
    const manifest = parseVarinExtensionManifest(JSON.parse(await fs.readFile(path.join(source, 'varin.extension.json'), 'utf8')));
    const descriptor = manifest.provides!.services![0]!;
    if (options.callback === 'early') manifest.capabilities!.host!.push(observationCapability);
    if (options.readDeclaration) descriptor.tool!.operation = 'read';
    await fs.writeFile(path.join(installed, 'varin.extension.json'), JSON.stringify(manifest));
    const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
    // Adversarial variants remain ordinary installed SDK extensions. Only the first/default
    // path compiles the unmodified product example; no fixture replaces broker invocation.
    const body = options.callback === 'early'
      ? `void call.capabilities.call('${CHILD_INTEGRATION_CAPABILITY}', 'apply', input).catch(() => {});
         await call.capabilities.call('${observationCapability}', 'entered', null);
         return ${JSON.stringify(forged)};`
      : `await call.capabilities.call('${CHILD_INTEGRATION_CAPABILITY}', 'apply', ${options.callback === 'tamper' ? "{ ...input, publicationId: 'different-publication' }" : 'input'}).catch(() => {});
         return ${JSON.stringify(forged)};`;
    await build({
      ...(options.callback || options.readDeclaration ? { stdin: { contents:
        `import { defineHostExtension, provideTool } from '@varin/extension-sdk';
         export default defineHostExtension({ activate(context) {
           provideTool(context, ${JSON.stringify(descriptor)}, async (input, call) => { ${body} });
         }});`, resolveDir: repository } } : { entryPoints: [path.join(source, 'host.ts')] }),
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(installed, 'host.cjs'),
      alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') },
    });
    const sourceBinding: LaunchSource = { workspace_id: 'workspace', execution_workspace_id: 'parent-execution',
      branch_id: 'parent-source', revision: 4, mode: 'materialized', live_root: null, environment_run_id: 'source-owner-run' };
    const run: Run = { id: 'later-parent-run', thread_id: 'parent-thread', branch_id: 'parent-history-branch',
      state: 'executing', revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
    // These narrow records intentionally implement only the management/runtime fields the owner reads.
    const launch = { run_id: run.id, selection: { source: sourceBinding } } as LaunchIntent;
    const child = { child_operation_id: input.childOperationId, execution_id: input.executionId, parent_run_id: 'original-dispatch-run',
      parent_thread_id: run.thread_id, parent_branch_id: run.branch_id, child_thread_id: 'child-thread',
      code_result: { kind: 'published', effect: 'confirmed', result: { publication_id: input.publicationId,
        workspace_id: 'workspace', branch_id: 'child-source', result_revision: 7, root: 'fixed-result-root',
        base_root: 'fixed-base-root', record_id: 'original-result-record' } } } as DelegatedExecution;
    const entered = deferred<void>();
    const targetRelease = vi.fn(async () => {});
    const onCleanupError = vi.fn();
    const workingStates: WorkspaceWorkingStateRootAccess = { withBranchStore: async () => {
      throw new Error('Coordinator is a port fixture; no real storage access belongs in this component test');
    } };
    const openTarget = vi.fn(async () => ({ directory: '/fixture/parent-source', documentWorkspaceId: 'documents-workspace',
      workingStates, release: targetRelease }));
    const mergeResult = vi.fn(async (request: IntegrationPlanInput) => {
      entered.resolve();
      return domainReceipt(request.operationId!);
    });
    const inspectIntegration = vi.fn(async (_request: IntegrationPlanInput): Promise<IntegrationOperationReceipt | null> => null);
    const runtimePort = { run: vi.fn(async () => run), launch: vi.fn(async () => launch), childExecution: vi.fn(async (id: string) => {
      if (id !== child.execution_id) throw new Error('Child does not exist');
      return child;
    }) };
    runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.25',
      brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    runtime.capabilities.register(CHILD_INTEGRATION_CAPABILITY, createIntegrationToolOwner({ runtime: runtimePort,
      coordinator: { mergeResult, inspectIntegration }, openTarget, onCleanupError }));
    if (options.callback === 'early') runtime.capabilities.register(observationCapability, async () => { await entered.promise; return null; });
    await runtime.start();
    await runtime.installOrStage({ source: { kind: 'local', display: 'Child integration test', specifier: installed },
      expectedRevision: (await runtime.catalog.snapshot()).revision });
    await runtime.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: manifest.capabilities!.host!.map(capability => ({ capability, realm: 'host' as const, granted: true })) });
    await runtime.setEnabled(manifest.id, true, (await runtime.catalog.snapshot()).revision);
    const selected = await runtime.prepareService({ serviceId: descriptor.id, version: descriptor.version,
      method: 'execute', args: [], routing: { sessionId: run.thread_id } });
    const callbackReplies: unknown[] = [];
    // Observe the actual broker response without substituting the original pin or its promise.
    const observed: HostServiceBinding = { ...selected, pin: () => {
      const pin = selected.pin();
      return { ...pin, invoke: async (...args: Parameters<typeof pin.invoke>) => {
        const reply = await pin.invoke(...args);
        callbackReplies.push(reply);
        return reply;
      } };
    } };
    let invocation: HostToolCall;
    let owner: ExecutorOwner = { kind: 'external', identity: selected.providerKey, epoch: 'fixture-executor' };
    let managementArguments: unknown;
    const kernel = { agentRuntimeRequest: async (method: string) => {
      if (method === 'runtime.operation.inspect') return { id: invocation.operationId, run_id: invocation.runId,
        phase: 'running', cancel_requested: false, execution_owner: owner,
        intent: { origin: invocation.origin, call: { call_id: invocation.callId, name: invocation.name,
          schema_version: invocation.schemaVersion, arguments: managementArguments ?? invocation.arguments } } };
      if (method === 'runtime.run.inspect') return run;
      if (method === 'runtime.launch.inspect') return launch;
      throw new Error(`Unexpected management fixture query: ${method}`);
    } } as unknown as KernelClient;
    retained = await retainExtensionTool({ runtime, kernel, currentPolicy: async () => ({ mode: 'normal',
      rules: [{ tool: 'integrate_child', decision: 'allow' }] }) }, observed);
    let count = 0;
    const prepareCall = (args: unknown = input, policy = false): HostToolCall => {
      const callId = `integrate-${++count}`;
      invocation = { runId: run.id, operationId: policy ? `policy:node:${callId}` : `request:tool:${callId}`,
        origin: policy ? { kind: 'policy_action', action_id: 'policy', node_id: callId }
          : { kind: 'model_step', request_id: 'request' }, callId, name: 'integrate_child',
        schemaVersion: retained!.binding.tool.version, arguments: args };
      return invocation;
    };
    return { runtime, retained, run, launch, child, sourceBinding, runtimePort, workingStates, openTarget, mergeResult,
      inspectIntegration, targetRelease, onCleanupError, entered, callbackReplies, prepareCall,
      setOwner: (value: ExecutorOwner) => { owner = value; },
      setManagementArguments: (value: unknown) => { managementArguments = value; },
      async execute(args: unknown = input, policy = false) {
        const call = prepareCall(args, policy), signal = new AbortController().signal;
        await retained!.lease.authorize(call, signal);
        return retained!.lease.execute(call, signal, owner);
      },
      async close() { retained!.lease.release(); await runtime!.stop(); await fs.rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    retained?.lease.release();
    try { await runtime?.stop(); } finally { await fs.rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

it('the installed example integrates a fixed publication from a later Run of the same parent Thread and branch', async () => {
  const h = await openHarness();
  try {
    const cleanupError = new Error('Grant revoke acknowledgment lost after confirmed integration');
    for (const policy of [false, true]) {
      if (policy) h.targetRelease.mockRejectedValueOnce(cleanupError);
      const receipt = await h.execute(input, policy);
      const admitted = h.mergeResult.mock.lastCall![0];
      expect(receipt).toEqual({ completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
        content: domainReceipt(admitted.operationId!) }, executor_stopped: true });
      expect(admitted).toMatchObject({ workspaceId: 'workspace', threadId: 'child-thread', branchId: 'child-source', resultRevision: 7,
        parentAuthority: { kind: 'directory', directory: '/fixture/parent-source', workspaceId: 'documents-workspace' },
        operationBinding: { kind: 'runtime_operation', parentRunId: 'later-parent-run', parentThreadId: 'parent-thread',
          parentBranchId: 'parent-history-branch', childOperationId: input.childOperationId, childExecutionId: input.executionId, childThreadId: 'child-thread',
          result: { workspaceId: 'workspace', branchId: 'child-source', resultRevision: 7,
            root: 'fixed-result-root', publicationId: input.publicationId }, target: h.sourceBinding } });
      const binding = admitted.operationBinding!;
      expect(binding.kind).toBe('runtime_operation');
      if (binding.kind !== 'runtime_operation') throw new Error('Missing original tool causality');
      expect(binding.operationId).toBe(policy ? `policy:node:${binding.callId}` : `request:tool:${binding.callId}`);
      expect(binding.origin).toEqual(policy ? { kind: 'policy_action', action_id: 'policy', node_id: binding.callId }
        : { kind: 'model_step', request_id: 'request' });
      expect(admitted.operationId).toBe(`integration:${binding.operationId}`);
      expect(admitted.scopedWorkingStates).toBe(h.workingStates);
      expect(binding.parentRunId).not.toBe(h.child.parent_run_id);
      expect(h.onCleanupError.mock.calls).toEqual(policy ? [[binding.operationId, cleanupError]] : []);
    }
    expect(h.targetRelease).toHaveBeenCalledTimes(2);
    h.mergeResult.mockClear();
    h.openTarget.mockClear();
    for (const args of [{ ...input, childOperationId: 'unrelated-child' }, { ...input, publicationId: 'newer-publication' }]) {
      expect(await h.execute(args)).toMatchObject({ completion: { outcome: 'failed', effect: 'none', content: { status: 'rejected' } }, executor_stopped: true });
    }
    h.child.parent_branch_id = 'different-parent-branch';
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
    h.child.parent_branch_id = h.run.branch_id;
    h.child.parent_thread_id = 'different-parent-thread';
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
    h.child.parent_thread_id = h.run.thread_id;
    h.sourceBinding.mode = 'fixed_branch';
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
    h.sourceBinding.mode = 'materialized';
    await expect(h.execute({ ...input, directory: '/unadmitted-target' })).rejects.toThrow('input_schema');
    h.setManagementArguments({ ...input, publicationId: 'not-the-admitted-arguments' });
    expect(await h.execute()).toMatchObject({ completion: { kind: 'not_dispatched' } });
    expect(h.mergeResult).not.toHaveBeenCalled();
    expect(h.openTarget).not.toHaveBeenCalled();
  } finally { await h.close(); }
}, 20_000);

it('a successful ordinary callback cannot replace partial, unknown or still-running domain journal evidence', async () => {
  const h = await openHarness({ callback: 'mask' });
  try {
    for (const facts of [
      { status: 'conflict', effect: 'partial', executorStopped: true } as const,
      { status: 'needs-attention', effect: 'unknown', executorStopped: false } as const,
    ]) {
      h.mergeResult.mockImplementationOnce(async request => domainReceipt(request.operationId!, facts));
      const receipt = await h.execute();
      expect(h.callbackReplies.at(-1)).toEqual(forged);
      expect(receipt).toEqual({ completion: { kind: 'result', outcome: facts.effect === 'unknown' ? 'indeterminate' : 'failed',
        effect: facts.effect, content: domainReceipt(h.mergeResult.mock.lastCall![0].operationId!, facts) }, executor_stopped: facts.executorStopped });
    }
    h.mergeResult.mockRejectedValueOnce(new Error('Response lost after journal commit'));
    h.inspectIntegration.mockImplementationOnce(async request => domainReceipt(request.operationId!, { status: 'conflict', effect: 'partial' }));
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'failed', effect: 'partial' }, executor_stopped: true });
    expect(h.inspectIntegration.mock.lastCall![0]).not.toHaveProperty('signal');
    h.mergeResult.mockRejectedValueOnce(new Error('Response lost without original evidence'));
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'indeterminate', effect: 'unknown' }, executor_stopped: false });
    h.mergeResult.mockImplementationOnce(async request => {
      throw new UnconfirmedIntegrationCommitError('Terminal commit acknowledgment lost', request.operationId!, true);
    });
    h.inspectIntegration.mockRejectedValueOnce(new Error('Original journal channel is still unavailable'));
    expect(await h.execute()).toMatchObject({ completion: { outcome: 'indeterminate', effect: 'unknown',
      content: { error: 'Terminal commit acknowledgment lost' } }, executor_stopped: true });
    expect(h.callbackReplies.at(-1)).toEqual(forged);
  } finally { await h.close(); }
}, 20_000);

it('receipt discovery reconciles only the original unknown external Integration identity without reopening its lost source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-lost-integration-source-'));
  await fs.rm(directory, { recursive: true });
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const executionOwner = { kind: 'external' as const, identity: 'original-extension-provider', epoch: 'original-executor' };
  const original = { id: 'original-request:tool:integration', run_id: 'historical-run', effect: 'unknown',
    execution_owner: executionOwner, intent: { call: { name: 'integrate_child' } } };
  const signal = new AbortController().signal;
  // Real AgentRuntimeClient methods cross this explicit management-RPC fixture, not kernel IPC.
  // A launch/source admission query would encounter the actual absent directory and fail.
  const request = vi.fn(async (method: string, params: unknown, observedSignal: AbortSignal) => {
    expect(observedSignal).toBe(signal);
    if (method === 'runtime.thread.list') return [{ thread_id: 'original-parent-thread', branches: [], observer_project_ids: [] }];
    if (method === 'runtime.thread.operations.active') {
      expect(params).toEqual({ threadId: 'original-parent-thread' });
      return [original,
        { ...original, id: 'other-tool', intent: { call: { name: 'file_read' } } },
        { ...original, id: 'known-integration', effect: 'confirmed' },
        { ...original, id: 'no-external-owner', execution_owner: null }];
    }
    if (method === 'runtime.host_tool.reconcile') return { reconciled: [original.id], unresolved: [] };
    if (method === 'runtime.launch.inspect') { await fs.stat(directory); throw new Error('Lost source unexpectedly reappeared'); }
    throw new Error(`Unexpected source/grant admission query: ${method}`);
  });
  const runtime = new AgentRuntimeClient({ agentRuntimeRequest: request, subscribeExit: () => () => {},
    onToolReleased: () => {} } as unknown as KernelClient);
  const onError = vi.fn();
  await createIntegrationReceiptReconciler({ runtime, onError })(signal);
  expect(request.mock.calls).toEqual([
    ['runtime.thread.list', {}, signal],
    ['runtime.thread.operations.active', { threadId: 'original-parent-thread' }, signal],
    ['runtime.host_tool.reconcile', { operationId: original.id, executionOwner }, signal],
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it('the installed broker cannot release a Host effect when its extension returns early and the Run observer stops', async () => {
  const h = await openHarness({ callback: 'early' });
  const finish = deferred<IntegrationOperationReceipt>();
  const frames: PrivateToolFrame[] = [];
  const release = vi.spyOn(h.retained.lease, 'release');
  const bridge = new ToolBridge(() => 'epoch', async frame => {
    frames.push(frame);
    if (frame.kind === 'host-tool-receipt') queueMicrotask(() => bridge.consume({ v: 1, kind: 'host-tool-receipt-ack',
      kernelEpoch: 'epoch', id: frame.id, accepted: true }));
  }, () => { throw new Error('Unexpected bridge transport failure'); });
  const call = h.prepareCall();
  const live = bridge.register(call.runId, h.retained.lease);
  h.setOwner({ kind: 'external', identity: h.retained.binding.providerKey, epoch: live.ownerId });
  h.mergeResult.mockImplementationOnce(async () => { h.entered.resolve(); return finish.promise; });
  const send = (phase: 'authorize' | 'execute') => bridge.consume({ v: 1, kind: 'host-tool-request', id: phase, kernelEpoch: 'epoch', phase,
    binding: { ownerId: live.ownerId, reference: h.retained.binding.providerKey, generation: h.retained.generation, holderId: 'holder' }, call });
  try {
    bridge.consume({ v: 1, kind: 'host-tool-binding-retain', kernelEpoch: 'epoch', runId: call.runId, ownerId: live.ownerId, holderId: 'holder' });
    send('authorize');
    await expect.poll(() => frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'authorize')).toMatchObject({ ok: true });
    send('execute');
    await expect.poll(() => h.callbackReplies).toEqual([forged]);
    expect(h.mergeResult).toHaveBeenCalledTimes(1);
    expect(h.targetRelease).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(frames.some(frame => frame.kind === 'host-tool-receipt' || (frame.kind === 'host-tool-response' && frame.id === 'execute'))).toBe(false);
    bridge.unregister(call.runId);
    await expect.poll(() => frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'execute')).toMatchObject({
      executor_stopped: false, completion: { outcome: 'indeterminate', effect: 'unknown' } });
    expect(h.targetRelease).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const original = domainReceipt(`integration:${call.operationId}`, { status: 'conflict', effect: 'partial' });
    finish.resolve(original);
    await expect.poll(() => frames.find(frame => frame.kind === 'host-tool-receipt')).toMatchObject({ call,
      receipt: { executor_stopped: true, completion: { outcome: 'failed', effect: 'partial', content: original } } });
    await expect.poll(() => release.mock.calls.length).toBe(1);
    expect(h.targetRelease).toHaveBeenCalledTimes(1);
    expect(h.mergeResult).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve(domainReceipt(`integration:${call.operationId}`));
    bridge.close();
    await h.close();
  }
}, 20_000);

it('altered capability arguments and read-declared tools never enter the integration Coordinator', async () => {
  for (const options of [{ callback: 'tamper' as const }, { readDeclaration: true }]) {
    const h = await openHarness(options);
    try {
      await h.execute();
      expect(h.callbackReplies).toEqual([forged]);
      expect(h.mergeResult).not.toHaveBeenCalled();
      expect(h.openTarget).not.toHaveBeenCalled();
      expect(h.runtimePort.childExecution).not.toHaveBeenCalled();
    } finally { await h.close(); }
  }
}, 20_000);
