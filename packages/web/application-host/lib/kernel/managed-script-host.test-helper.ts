/** Test-only cross-language driver. Original Host owners run here; Rust owns Catalog,
 * grants, Storage, subscriptions and guardian execution. Stdio only delivers test requests.
 * This does not implement, replace, or establish the product Kernel socket transport. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { SCRIPT_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostServiceOwnerIdentity } from '@varin/extension-host';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelScopedClient, type KernelClient, type KernelGrantHandle, type KernelProcessObserver } from './kernel-client.js';
import { extensionToolSchema } from './extension-tool-owner.js';
import { createScriptRuntime } from './script-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import { KERNEL_PROTOCOL_VERSION, type ExecutorOwner, type HostToolCall, type KernelProcessStreamEvent } from './protocol.generated.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { createNestedMemoryHostFixture } from './nested-memory-host.test-helper.js';

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let nextId = 0;
const requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
function request<T>(method: string, params: unknown, grant?: KernelGrantHandle): Promise<T> {
  const id = `host-rpc:${++nextId}`;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve: value => resolve(value as T), reject });
    write({ kind: 'fixture-request', id, method, params, ...(grant ? { grantId: grant.grantId } : {}) });
  });
}
const listeners = new Set<(event: unknown) => void>();
const exits = new Set<(error: Error) => void>();
const subscriptions = new Map<string, { observer: KernelProcessObserver; close(): Promise<void>; reject(error: Error): void; grant: KernelGrantHandle; processId: string }>();
const issued = new Set<KernelGrantHandle>();
const observed = { processSpawns: 0, processGrants: [] as string[][], calls: [] as string[] };
let epoch = '', storageRoot = '';
const transport = {
  get kernelEpoch() { return epoch; },
  get handshake() { return { storageRoot, hostId: 'managed-script-host' }; },
  subscribeExit(listener: (error: Error) => void) { exits.add(listener); return () => exits.delete(listener); },
  subscribeReady() { return () => {}; },
  onToolReleased() { return () => {}; },
  // Installed contributions and provider preparation are fixed fixture seams, with no
  // outstanding leases/controllers in these KernelClient registries.
  cancelRunPreparation() {},
  unregisterCredentialOwner() {},
  unregisterToolOwners() {},
  releaseRunPolicyOwners() {},
  onAgentRuntimeEvent(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  agentRuntimeRequest: (method: string, params: unknown) => request(method, params),
  assertGrantForScope(grant: KernelGrantHandle) { assert(issued.has(grant)); assert.equal(grant.kernelEpoch, epoch); return grant; },
  scoped(grant: KernelGrantHandle) { return new KernelScopedClient(transport as unknown as KernelClient, grant); },
  async issueGrant(params: Record<string, unknown>) {
    observed.processGrants.push(params.capabilities as string[]);
    const raw = await request<Record<string, unknown>>('authority.grant.issue', params);
    const handle: KernelGrantHandle = Object.freeze({ grantId: String(raw.grant_id), kernelEpoch: String(raw.kernel_epoch), hostGeneration: String(raw.host_generation),
      authorityInstanceId: null, workerId: null, workerGeneration: null, sessionId: null,
      threadId: raw.thread_id as string | null, runId: raw.run_id as string | null, operationId: raw.operation_id as string | null,
      owningWorkspace: raw.owning_workspace as string | null, executionWorkspace: raw.execution_workspace as string | null,
      capabilities: raw.capabilities as string[], pathScopes: raw.path_scopes as string[], storageIdentity: String(raw.storage_identity ?? '') });
    issued.add(handle); return handle;
  },
  retireGrant: (grantId: string) => request('authority.grant.retire', { target: { kind: 'grant', grantId } }),
  revokeGrant: (grantId: string) => request('authority.grant.revoke', { grantId }),
  fileRootRegister: (params: unknown, grant: KernelGrantHandle) => request('file.root.register', params, grant),
  processSpawn: (params: unknown, grant: KernelGrantHandle) => { observed.processSpawns++; return request('process.spawn', params, grant); },
  processWrite: (params: unknown, grant: KernelGrantHandle) => request('process.write', params, grant),
  processKill: (params: unknown, grant: KernelGrantHandle) => request('process.kill', params, grant),
  processInspect: (params: unknown, grant: KernelGrantHandle) => request('process.inspect', params, grant),
  processRelease: (params: unknown, grant: KernelGrantHandle) => request('process.release', params, grant),
  processInteractionInspect: (params: unknown, grant: KernelGrantHandle) => request('process.interaction.inspect', params, grant),
  async processSubscribe(params: { processId: string }, grant: KernelGrantHandle, observer: KernelProcessObserver) {
    const id = randomUUID(); let resolve!: () => void, reject!: (error: Error) => void;
    const closed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closed.catch(() => undefined);
    const handle = {
      closed,
      acknowledge: (stream: string, sequence: number) => request<void>('process.subscription.ack', { subscriptionId: id, stream, sequence }, grant),
      async close() { if (!subscriptions.delete(id)) return; await request('process.subscription.unsubscribe', { subscriptionId: id }, grant); resolve(); },
    };
    subscriptions.set(id, { observer, close: handle.close, reject, grant, processId: params.processId });
    await request('process.subscribe', { ...params, subscriptionId: id }, grant);
    return handle;
  },
};
const kernel = transport as unknown as KernelClient;
const runtime = new AgentRuntimeClient(kernel);
const scripts = createScriptRuntime({ kernel, runtime,
  resolveLiveSource: async selection => {
    // The fixture's live source is an explicitly registered physical directory. No Documents
    // UI or editor draft is simulated; Rust revalidates its original root and actual grant.
    assert(selection.liveRoot); assert.equal(selection.liveRoot.hostId, 'managed-script-host');

  },
  onError: error => write({ kind: 'fixture-diagnostic', message: error instanceof Error ? error.message : String(error) }),
});
const memory = createNestedMemoryHostFixture();
const owners = new Map<string, AbortController>();
const owner: HostServiceOwnerIdentity = { extensionId: 'varin.builtin.scripts', extensionVersion: '0.1.0', entrypointId: 'host', generation: 1 };
let configurationIdentity: string;

async function hostCall(frame: Record<string, unknown>) {
  const call = frame.call as HostToolCall;
  const binding = frame.binding as { ownerId: string; reference: string };
  const response = { v: 1, kind: 'host-tool-response', id: frame.id, kernelEpoch: frame.kernelEpoch };
  if (frame.phase === 'authorize') { write({ ...response, ok: true }); return; }
  const descriptor = SCRIPT_TOOL_DECLARATIONS.find(entry => entry.tool!.name === call.name);
  assert(descriptor);
  const [run, launch, operation] = await Promise.all([runtime.run(call.runId), runtime.launch(call.runId), runtime.operation(call.operationId)]);
  assert.equal(operation.run_id, run.id);
  assert.equal(operation.executor, call.name);
  assert(launch);
  assert(launch.selection.tools.some(schema => schema.name === call.name && schema.version === call.schemaVersion));
  const controller = new AbortController(); owners.set(String(frame.id), controller);
  const executionOwner: ExecutorOwner = { kind: 'external', identity: binding.reference, epoch: binding.ownerId };
  let receipt: ToolExecutionReceipt | undefined;
  observed.calls.push(call.name);
  try {
    await withToolInvocation({ owner, signal: controller.signal,
      authority: { invocationId: String(frame.id), runId: run.id, threadId: run.thread_id, operationId: call.operationId, callId: call.callId,
        executorOwner: executionOwner, origin: call.origin, source: launch.selection.source, toolName: call.name, operation: 'effect',
        configurationIdentity, arguments: call.arguments },
      onEffectReceipt: value => { receipt = value; },
    }, async invocation => scripts.capability(descriptor.id.slice('varin.script.'.length), parseVarinToolJson(call.arguments), { owner, invocation, signal: controller.signal }));
    assert(receipt, 'original trusted domain receipt required');
    write({ ...response, ok: true, completion: receipt.completion, executor_stopped: receipt.executor_stopped });
  } catch (error) {
    write({ ...response, ok: false, error: { code: error instanceof Error ? error.message : String(error) } });
  } finally { owners.delete(String(frame.id)); }
}

async function receive(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-response') {
    const waiting = requests.get(String(frame.id)); assert(waiting, 'original request correlation required'); requests.delete(String(frame.id));
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(new Error(String(frame.error)));
  } else if (frame.kind === 'fixture-initialize') {
    epoch = String(frame.epoch); storageRoot = String(frame.storageRoot);
    const resolveConfiguration = await scripts.prepareConfiguration(() => null);
    configurationIdentity = resolveConfiguration(SCRIPT_TOOL_DECLARATIONS[0])!;
    write({ kind: 'fixture-prepared', configurationIdentity,
      bindings: SCRIPT_TOOL_DECLARATIONS.map(descriptor => ({ providerKey: `script:${descriptor.id}`, extensionId: owner.extensionId, extensionVersion: owner.extensionVersion,
        serviceId: descriptor.id, serviceVersion: descriptor.version, artifactIntegrity: 'controlled-fixture-artifact',
        declarationHash: extensionToolSchema(descriptor).version, configurationIdentity, tool: extensionToolSchema(descriptor) })) });
  } else if (frame.kind === 'host-tool-request') {
    await hostCall(frame);
  } else if (frame.kind === 'host-tool-cancel') {
    const id = String(frame.id);
    owners.get(id)?.abort(new Error('Original invocation cancelled'));
  } else if (frame.kind === 'memory-request') {
    write(await memory.dispatch(frame));
  } else if (frame.kind === 'process-event') {
    const event = frame as unknown as KernelProcessStreamEvent;
    const entry = subscriptions.get(event.subscriptionId); if (!entry) return;
    assert.equal(event.grantId, entry.grant.grantId); assert.equal(event.kernelEpoch, epoch); assert.equal(event.processId, entry.processId);
    if (event.stream === 'closed') { subscriptions.delete(event.subscriptionId); entry.reject(new Error(event.error ?? 'closed')); }
    entry.observer(event, () => event.stream === 'closed' ? Promise.resolve()
      : request<void>('process.subscription.ack', { subscriptionId: event.subscriptionId, stream: event.stream, sequence: event.sequence }, entry.grant));
  } else if (frame.kind === 'fixture-tick') {
    for (const listener of listeners) listener({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', kernelEpoch: epoch, stream: 'durable', cursor: frame.cursor });
  } else if (frame.kind === 'fixture-finish') {
    await scripts.dispose(); memory.close();
    write({ kind: 'fixture-finished', observed, memoryWrites: memory.writes() });
  } else if (!['host-tool-binding-retain', 'host-tool-binding-activate', 'host-tool-binding-release', 'host-tool-binding-revoke'].includes(String(frame.kind))) {
    throw new Error(`Unexpected fixture frame kind: ${String(frame.kind)}`);
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line) as Record<string, unknown>;
  void receive(frame).catch(error => { write({ kind: 'fixture-failed', message: error instanceof Error ? error.stack : String(error) }); });
}
