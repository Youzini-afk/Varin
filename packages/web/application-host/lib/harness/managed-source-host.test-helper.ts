/** Original managed Source client/authenticated Router/target service over the
 * existing Rust↔Host stdio fixture. No HTTP or product IPC listener is started. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Router, type Express } from 'express';
import { KernelClient, KernelClientError } from '../kernel/kernel-client.js';
import type { ChildSourceHandoff, DelegatedExecution, FileObservationBinding, FollowupFilePreparation, FollowupPendingResult, HostToolCall, KernelHandshakeResult, LaunchSource } from '../kernel/protocol.generated.js';
import { toolOperationId } from '../kernel/protocol.generated.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { createLiveSourceOwner } from '../kernel/live-source.js';
import { createThreadSourcePreparer } from '../kernel/thread-sources.js';
import { DocumentsFileObservationOwner } from '../kernel/file-observation-owner.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from '../kernel/storage-adapter.js';
import { createManagedChildSourceService, releaseManagedUnacceptedSource, withManagedChildSource } from '../kernel/managed-source-collaboration.js';
import { resourceThreadSource as resourceThreadSourceForFixture } from '../kernel/thread-context.js';
import { savedSourceLaunch } from '../kernel/source-launch.js';
import { routerTransport } from '../extensions/direct-router.test-helper.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import { createManagedRemoteTargetRegistry, type ManagedSourceClient } from './managed-remote-client.js';
import { registerManagedRemoteRoutes } from './managed-remote-routes.js';
import { createManagedSourceService } from './managed-source-service.js';
import type { ManagedSourceAddress, ManagedSourceCapabilities, ManagedSourceReceipt } from './managed-remote-types.js';

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let serial = 0;
let coordinatorKernel: KernelClient | undefined;
let targetKernel: KernelClient | undefined;
let coordinatorResult: { resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
const HOST_A = 'managed-coordinator', HOST_B = 'managed-target';
const workspaceId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const threadId = 'thread:managed-review';

function kernelFor(target: 'a' | 'b', storageRoot: string, epoch: string): KernelClient {
  const hostId = target === 'a' ? HOST_A : HOST_B;
  const kernel = new KernelClient({ hostId, hostGeneration: `${hostId}-generation`, storageRoot, buildVersion: '0.9.25' });
  // This is the established test-only delivery seam. Constructor has no I/O;
  // a completed handshake prevents every call from entering startInternal.
  const state = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  state.epoch = epoch; state.started = true;
  state.handshakeResult = { hostId, storageRoot, kernelEpoch: epoch } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: (method: string, params: unknown,
    options: { grant?: { grantId: string }; signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted();
    const id = `managed:${target}:${++serial}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ kind: 'fixture-request', target, id, method, params,
        ...(options.grant ? { grantId: options.grant.grantId } : {}) });
    });
  } });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => write({ kind: 'fixture-frame', target, frame: value }) });
  return kernel;
}

function data(receipt: ManagedSourceReceipt): Record<string, unknown> {
  const original = receipt.result as { completion?: { kind: string; outcome?: string; content?: { data: unknown } } };
  assert.equal(original.completion?.kind, 'result', JSON.stringify(receipt));
  assert.equal(original.completion?.outcome, 'succeeded', JSON.stringify(receipt));
  assert.equal(receipt.executorStopped, true, JSON.stringify(receipt));
  const body = original.completion?.content?.data;
  assert(body && typeof body === 'object' && !Array.isArray(body), JSON.stringify(receipt));
  return body as Record<string, unknown>;
}

async function childSources(runtime: AgentRuntimeClient, service: ManagedSourceClient,
  owner: import('./managed-remote-types.js').ManagedHostSourceOwner, bRoot: string, foreign: ManagedSourceClient) {
  const fixedThread = 'thread:managed-fixed', fixedRun = 'run:managed-fixed';
  const prepared = await service.prepare({ coordinatorHostId: HOST_A, input: { runtime: 'agent', threadId: fixedThread,
    branchId: 'main', key: 'fixed-child-baseline', resourceOwner: owner, workspaceId, mode: 'fixed_branch',
    content: { mode: 'saved-files' }, captureScopes: [] } });
  const parent = await service.bind({ coordinatorHostId: HOST_A, source: { ...prepared.source, tools: ['file_read'] },
    scope: { kind: 'run', threadId: fixedThread, runId: fixedRun, epoch: 1 }, purpose: 'source', retention: 'run' });
  const addressOf = (binding: { authorityId: string; resourceEpoch: string }): ManagedSourceAddress => ({ coordinatorHostId: HOST_A,
    authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch });
  const parentAddress = addressOf(parent);
  const origin = { kind: 'model_step' as const, request_id: 'request:managed-child' };
  const unacceptedDispatch = toolOperationId(origin, 'unaccepted-dispatch');
  const unaccepted = await service.service({ ...parentAddress, requestId: randomUUID(), operation: { kind: 'native_resource',
    context: { run_id: fixedRun, operation_id: unacceptedDispatch, origin }, authorizeOnly: false,
    action: { kind: 'child_source_handoff', delegation: { work_mode: 'read_only', process: false,
      configured_preset: false, selection_ref: null } } } }) as ChildSourceHandoff;
  assert.equal(unaccepted.root.kind, 'fixed');
  assert(unaccepted.root.kind === 'fixed');
  await releaseManagedUnacceptedSource(runtime, { operation_id: unacceptedDispatch, parent_thread_id: fixedThread,
    parent_run_id: fixedRun, source: parent.source, pin_id: unaccepted.root.pin.pin_id }, new AbortController().signal);
  const dispatch = toolOperationId(origin, 'dispatch');
  const childTools = ['file_read', 'file_write', 'process_spawn', 'process_read'];
  const handoff = await service.service({ ...parentAddress, requestId: randomUUID(), operation: { kind: 'native_resource',
    context: { run_id: fixedRun, operation_id: dispatch, origin }, authorizeOnly: false,
    action: { kind: 'child_source_handoff', delegation: { work_mode: 'isolated_write', process: true,
      configured_preset: true, selection_ref: { preset: 'controlled-process-worker', catalog: 'controlled-dispatch' } } } } }) as ChildSourceHandoff;
  assert.equal(handoff.root.kind, 'fixed');
  assert.deepEqual(await service.handoff({ coordinatorHostId: HOST_A, operationId: dispatch, parentRunId: fixedRun,
    parentThreadId: fixedThread, source: parent.source }), handoff);
  const capabilities = await service.capabilities({ coordinatorHostId: HOST_A, mode: 'materialized', enabledTools: childTools });
  // Catalog envelopes are controlled inputs in this owner fixture. Every source,
  // handoff, pin, captured byte, candidate and publication is original B Storage.
  const child: DelegatedExecution = { execution_id: dispatch, child_operation_id: dispatch,
    parent_run_id: fixedRun, parent_thread_id: fixedThread, parent_branch_id: 'main', origin, call_id: 'dispatch',
    child_thread_id: `thread:child:${dispatch}`, child_branch_id: `branch:child:${dispatch}`, project_id: null,
    trigger: { kind: 'dispatch' }, input: { task: 'Change the private source' }, configuration: {},
    selected_profile: { preset_id: 'controlled-process-worker', catalog_identity: 'controlled-dispatch', work_mode: 'isolated_write', tools: childTools, instructions: '' },
    launch: { extension_bindings: [], policy_models: [], mcp_binding: null, credential_scope: null,
      connection_identity: 'controlled', provider_family: 'controlled', model: 'controlled', configuration_generation: 1,
      tool_schema_generation: 1, tools: capabilities.tools, policy: { name: 'controlled', version: '1' }, source: parent.source, child_dispatch: null },
    policy_target: { kind: 'default' }, source_basis: null, source: { kind: 'pending', handoff }, code_result: { kind: 'pending' },
    state: 'accepted', revision: 1, cursor: 1, receipt: null, report: null, terminal_head: null, resources_released: false, cancel_requested: false };
  const signal = new AbortController().signal;
  const preparedChild = await withManagedChildSource(runtime, child, signal, (client, address) =>
    client.service({ ...address, requestId: randomUUID(), operation: { kind: 'child_prepare', execution: child } }));
  assert.equal(preparedChild.source.mode, 'materialized'); assert.equal(preparedChild.source.branch_id, `child-source:${dispatch}`);
  assert.deepEqual(preparedChild.source.resource_owner, owner);
  const childRun = 'run:managed-private-child';
  const { runId: _run, ...selection } = savedSourceLaunch(childRun, preparedChild.source, childTools);
  const privateBinding = await service.bind({ coordinatorHostId: HOST_A, source: { ...selection, tools: [...selection.tools] },
    scope: { kind: 'run', threadId: child.child_thread_id, runId: childRun, epoch: 1 }, purpose: 'source', retention: 'run' });
  const privateAddress = addressOf(privateBinding), privateRoot = privateBinding.physicalRoot;
  assert(privateRoot); assert.notEqual(privateRoot.canonicalRoot, bRoot);
  assert.equal(await readFile(join(privateRoot.canonicalRoot, 'source.txt'), 'utf8'), 'B_CHANGED_SOURCE\n');
  const invocation = (name: string, args: unknown): HostToolCall => {
    const callId = randomUUID(); return { runId: childRun, operationId: toolOperationId(origin, callId), origin,
      callId, name, schemaVersion: '1', arguments: args };
  };
  const original = data(await service.execute({ ...privateAddress, call: invocation('file_read', { path: 'source.txt' }) }));
  assert.equal(data(await service.execute({ ...privateAddress, call: invocation('file_write', { path: 'source.txt',
    readVersion: original.readVersion, content: 'CHILD_PRIVATE_RESULT\n' }) })).status, 'applied');
  assert.equal(await readFile(join(bRoot, 'source.txt'), 'utf8'), 'B_CHANGED_SOURCE\n');
  const childProcess = invocation('process_spawn', { cwd: '', command: process.execPath, mode: 'pipe',
    args: ['-e', 'process.stdout.write("CHILD_LINEAGE_OUTPUT")'] });
  const acceptedProcess = await service.execute({ ...privateAddress, call: childProcess });
  assert.equal((acceptedProcess.result as { completion: { kind: string } }).completion.kind, 'job_accepted');
  let childTerminal = await service.observe({ ...privateAddress, operationId: childProcess.operationId });
  const terminalDeadline = Date.now() + 15_000;
  while (!childTerminal.executorStopped) {
    assert(Date.now() < terminalDeadline, 'Original child process tree has not exited');
    await new Promise(resolve => setTimeout(resolve, 10));
    childTerminal = await service.observe({ ...privateAddress, operationId: childProcess.operationId });
  }
  const terminal = (childTerminal as ManagedSourceReceipt & { process: { writerActive: boolean; treeConfirmed: boolean; status: string } }).process;
  assert.equal(terminal.writerActive, false); assert.equal(terminal.treeConfirmed, true); assert.equal(terminal.status, 'exited');
  child.source = { kind: 'ready', handoff, selection: privateBinding.source, pin: preparedChild.pin, provenance: preparedChild.provenance };
  child.receipt = { thread_id: child.child_thread_id, branch_id: child.child_branch_id, run_id: childRun, input_id: 'input:child', cursor: 2 };
  child.code_result = { kind: 'settling', publication_id: `child-result:${dispatch}` };
  const candidate = await service.service({ ...privateAddress, requestId: randomUUID(), operation: { kind: 'child_result_prepare', execution: child } });
  assert(candidate); assert.notEqual(candidate.root, candidate.baseRoot);
  child.code_result = { kind: 'candidate', candidate };
  // Original frozen result recovery must not recreate a missing working copy.
  await rename(privateRoot.canonicalRoot, `${privateRoot.canonicalRoot}-moved`);
  for (const purpose of ['source', 'result'] as const) {
    await assert.rejects(foreign.bind({ coordinatorHostId: HOST_A, source: { ...selection, tools: [...selection.tools] },
      scope: { kind: 'run', threadId: child.child_thread_id, runId: childRun, epoch: 1 }, purpose, retention: 'run' }),
    /another authenticated owner/);
  }
  const resultOnly = await service.bind({ coordinatorHostId: HOST_A, source: { ...selection, tools: [...selection.tools] },
    scope: { kind: 'run', threadId: child.child_thread_id, runId: childRun, epoch: 1 }, purpose: 'result', retention: 'run' });
  assert.equal(resultOnly.physicalRoot, null);
  const resultAddress = addressOf(resultOnly);
  assert.deepEqual(await service.service({ ...resultAddress, requestId: randomUUID(), operation: { kind: 'child_result_read', execution: child } }), candidate);
  const published = await service.service({ ...resultAddress, requestId: randomUUID(), operation: { kind: 'child_result_publish', execution: child } });
  assert.equal(published.root, candidate.root); assert.equal(published.baseRoot, candidate.baseRoot);
  await assert.rejects(readFile(join(privateRoot.canonicalRoot, 'source.txt')));
  // Use the native Catalog projection shape, including cleared copy lineage.
  const continuationSource: LaunchSource = { ...privateBinding.source, mode: 'fixed_branch',
    revision: published.resultRevision, environment_run_id: null, live_root: null };
  const continuation: DelegatedExecution = { ...child, execution_id: `${dispatch}:continuation`, source: null, receipt: null,
    trigger: { kind: 'user_continuation', key: 'next', previous_execution_id: dispatch, previous_run_id: childRun,
      previous_run_revision: 1, expected_head: null }, code_result: { kind: 'pending' },
    source_basis: { kind: 'working_result', source: continuationSource, root: published.root,
      provenance: { consistency: 'fixed-root', root: published.root },
      result: { publication_id: candidate.publicationId, workspace_id: workspaceId, branch_id: candidate.branchId,
        result_revision: published.resultRevision, root: published.root, base_root: published.baseRoot,
        record_id: `working-result:${candidate.branchId}@${published.resultRevision}` } } };
  await withManagedChildSource(runtime, continuation, signal, async (client, address) => {
    const next = await client.service({ ...address, requestId: randomUUID(), operation: { kind: 'child_prepare', execution: continuation } });
    assert.equal(next.pin.root, published.root); assert.equal(next.source.mode, 'materialized');
    const continuationRun = 'run:managed-private-continuation';
    const { runId: _nextRun, ...nextSelection } = savedSourceLaunch(continuationRun, next.source, childTools);
    const nextBinding = await client.bind({ coordinatorHostId: HOST_A, source: { ...nextSelection, tools: [...nextSelection.tools] },
      scope: { kind: 'run', threadId: child.child_thread_id, runId: continuationRun, epoch: 1 }, purpose: 'source', retention: 'run' });
    assert(nextBinding.physicalRoot); assert.notEqual(nextBinding.physicalRoot.canonicalRoot, privateRoot.canonicalRoot);
    const processOutput = await client.service({ ...addressOf(nextBinding), requestId: randomUUID(), operation: { kind: 'native_resource',
      context: { run_id: continuationRun, origin, operation_id: toolOperationId(origin, 'observe-continued-process') }, authorizeOnly: false,
      action: { kind: 'process_observation', process_id: childProcess.operationId, source_run_id: childRun, read: [0, 4096],
        lineage: { process_id: childProcess.operationId, source_run_id: childRun, target_run_id: continuationRun,
          source: privateBinding.source, target: nextBinding.source, executions: [continuation.execution_id] } } } }) as {
          chunks: Array<{ bytesBase64: string }>; process: { status: string; exitCode: number; writerActive: boolean } };
    assert.equal(processOutput.process.writerActive, false); assert.equal(processOutput.process.status, 'exited');
    assert.equal(processOutput.process.exitCode, 0);
    assert.equal(Buffer.concat(processOutput.chunks.map(chunk => Buffer.from(chunk.bytesBase64, 'base64'))).toString('utf8'), 'CHILD_LINEAGE_OUTPUT');
    const nextReleased = await client.releaseScope({ coordinatorHostId: HOST_A, threadId: child.child_thread_id,
      runId: continuationRun, mode: 'retire' });
    assert.deepEqual((nextReleased as { pendingAuthorities: unknown[] }).pendingAuthorities, []);
    await client.service({ ...address, requestId: randomUUID(), operation: { kind: 'child_release', execution: continuation } });
  });
  await withManagedChildSource(runtime, child, signal, (client, address) =>
    client.service({ ...address, requestId: randomUUID(), operation: { kind: 'child_release', execution: child } }));
  for (const [threadId, runId] of [[child.child_thread_id, childRun], [fixedThread, fixedRun]]) {
    const released = await service.releaseScope({ coordinatorHostId: HOST_A, threadId: threadId!, runId: runId!, mode: 'retire' });
    assert.deepEqual((released as { pendingAuthorities: unknown[] }).pendingAuthorities, []);
  }
  return { dispatch, unacceptedDispatch, continuationId: continuation.execution_id, parentBranch: parent.source.branch_id,
    childBranch: preparedChild.source.branch_id, resultRoot: published.root };
}

async function run(frame: Record<string, unknown>) {
  assert.equal(typeof frame.runId, 'string'); const runId = frame.runId as string;
  const root = String(frame.root), storageRootA = String(frame.storageRootA), storageRootB = String(frame.storageRootB);
  const aRoot = join(root, 'a-project'), bRoot = join(root, 'b-project');
  await Promise.all([mkdir(aRoot, { recursive: true }), mkdir(bRoot, { recursive: true })]);
  await writeFile(join(aRoot, 'source.txt'), 'A_PRIVATE_SOURCE\n');
  await writeFile(join(bRoot, 'source.txt'), 'B_ORIGINAL_SOURCE\n');
  const a = kernelFor('a', storageRootA, String(frame.epochA)), b = kernelFor('b', storageRootB, String(frame.epochB));
  coordinatorKernel = a; targetKernel = b;
  const documents = await Promise.all(([['a', HOST_A, aRoot], ['b', HOST_B, bRoot]] as const).map(async ([name, hostId, directory]) => {
    const dataDir = join(root, `${name}-documents`);
    await mkdir(join(dataDir, 'documents'), { recursive: true });
    // Seed the current persisted registry format to reproduce an ID collision
    // across two real Host registries, not a coordinator-local path alias.
    await writeFile(join(dataDir, 'documents', 'workspaces.json'), JSON.stringify({ schemaVersion: 1, hostId,
      workspaces: [{ workspaceId, canonicalPath: directory, kind: 'directory' }] }));
    return createDocumentAuthority({ hostId, dataDir, isTrusted: async path => path === directory,
      isAllowedRoot: async path => path === directory });
  }));
  const [aDocuments, bDocuments] = documents;
  assert(aDocuments && bDocuments);
  assert.equal((await aDocuments.resolveWorkspace({ path: aRoot })).workspaceId, workspaceId);
  assert.equal((await bDocuments.resolveWorkspace({ path: bRoot })).workspaceId, workspaceId);
  const aLive = createLiveSourceOwner({ documents: aDocuments, kernel: a });
  const bLive = createLiveSourceOwner({ documents: bDocuments, kernel: b });
  const localRoot = await aLive.prepare(workspaceId, workspaceId, threadId);
  assert.equal(localRoot.canonicalRoot, aRoot);
  const storage = new KernelStorageAdapter({ client: b, hostId: HOST_B, storageRoot: storageRootB,
    resolveWorkspaceRoot: async id => (await bDocuments.admitWorkspaceRegistration(id)).canonicalPath });
  const capture = { documents: bDocuments, inspectInventory: async () => ({ kind: 'directory' as const }) };
  const localPreparer = createThreadSourcePreparer({ documents: bDocuments, liveSources: bLive,
    workingStates: createKernelWorkspaceWorkingStateAccess(storage), inspectInventory: capture.inspectInventory,
    sourceTools: async mode => (await b.sourceRequest<ManagedSourceCapabilities>('source.capabilities', { mode, managed: false })).tools.map(tool => tool.name),
  });
  const sourceOwner = createManagedSourceService({ kernel: b, hostId: HOST_B, documents: bDocuments,
    validateLiveSource: bLive.validate, prepareSource: localPreparer, serviceOperation: createManagedChildSourceService({ storage, capture }) });
  const remote = createManagedRemoteExecutionService({ hostId: HOST_B, client: b, sourceOwner,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never });
  const permissions = ['filesystem:read', 'filesystem:write', 'terminal:use', 'process:control'];
  const router = Router();
  registerManagedRemoteRoutes(router as unknown as Express, { service: remote, resolveAuthContext: async request => {
    const token = request.headers.authorization;
    if (token !== 'Bearer managed-fixture' && token !== 'Bearer other-principal') return null;
    const clientId = token === 'Bearer managed-fixture' ? 'source-principal' : 'other-principal';
    return { type: 'client', clientId, client: { id: clientId, capabilities: [...permissions] } };
  } });
  const transport = routerTransport(router);
  let discardExecuteResponse = false;
  let discardFileResponse = frame.scenario === 'file-followup';
  const controlledFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const result = await transport(new URL(String(url)), init);
    if (discardFileResponse && String(url).endsWith('/sources/fileObservation')) {
      discardFileResponse = false; await result.body?.cancel();
      throw new Error('Original accepted file response was disconnected');
    }
    if (discardExecuteResponse && String(url).endsWith('/sources/execute')) {
      discardExecuteResponse = false; await result.body?.cancel();
      throw new Error('Original accepted response was disconnected');
    }
    return result;
  }) as typeof fetch;
  const registry = (clientToken = 'managed-fixture') => createManagedRemoteTargetRegistry({ coordinatorHostId: HOST_A,
    kernel: a, resources: {} as never, readSettings: async () => ({ desktopHosts: [{ id: 'b', label: 'Target B',
      apiUrl: 'https://managed-b.invalid', clientToken }] }), fetch: controlledFetch });
  const targets = registry();
  a.setManagedSourceOwner(owner => targets.source(owner), () => HOST_A);
  const runtime = new AgentRuntimeClient(a); runtime.bindManagedSources(targets);
  const owner = (await targets.sourceTargets()).targets[0]!.resourceOwner;
  const service = await targets.source(owner);
  const prepared = await service.prepare({ coordinatorHostId: HOST_A, input: { runtime: 'agent', threadId,
    branchId: 'main', key: 'original-source', resourceOwner: owner, workspaceId, mode: 'live_root',
    content: { mode: 'saved-files' }, captureScopes: [] } });
  assert.equal(prepared.source.mode, 'live_root'); assert.equal(prepared.source.liveRoot?.canonicalRoot, bRoot);
  const selected = { ...prepared.source, tools: ['file_read', 'file_write', 'file_search', 'process_spawn', 'process_read', 'process_inspect'] };
  const binding = await service.bind({ coordinatorHostId: HOST_A, source: selected,
    scope: { kind: 'run', threadId, runId, epoch: 1 }, purpose: 'source', retention: 'run' });
  const address: ManagedSourceAddress = { coordinatorHostId: HOST_A, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  if (frame.scenario === 'file-followup') {
    const observer = new DocumentsFileObservationOwner(bDocuments, bLive.validate, () => {});
    b.setFileObservationOwner(observer);
    const fixture = <T=unknown>(method:string,params:unknown={}) => (a as unknown as {requestRaw<T>(method:string,params:unknown):Promise<T>}).requestRaw<T>(method,params);
    await fixture('fixture.file.launch',{source: binding.source});
    const input = {key:'managed-file',runId,repeat:'each' as const,trigger:{kind:'file' as const,path:'source.txt',condition:'changed' as const},instruction:'Explain original target change'};
    await assert.rejects(runtime.registerFollowup(input),/disconnected|Managed|file|request/i);
    const pending = await a.agentRuntimeRequest<FollowupPendingResult,'runtime.followup.registrations.pending'>('runtime.followup.registrations.pending',{threadId,branchId:'main'});
    assert(JSON.stringify(pending).includes('managed-file'));
    const handoff=await a.agentRuntimeRequest<FollowupFilePreparation,'runtime.followup.registration.prepare'>('runtime.followup.registration.prepare',{...input,coordinatorHostId:HOST_A});
    assert(handoff.scope&&handoff.source);
    // A concurrent caller can lose its bind reply before A adopts the first.
    await service.bind({coordinatorHostId:HOST_A,scope:handoff.scope,source:resourceThreadSourceForFixture(handoff.source)!,purpose:'read',retention:'caller'});
    await writeFile(join(bRoot,'source.txt'),'B_AFTER_LOST_ACCEPT\n');
    let d=await runtime.registerFollowup(input);
    assert.equal(d.sources[0]!.file!.baseline!.kind,'regular-file');
    const initial=d.sources[0]!.file!.baseline;
    const closedHandoff=await service.inspectReadScope({coordinatorHostId:HOST_A,scope:handoff.scope,source:handoff.source});
    assert.equal(closedHandoff.closed,true);assert.equal(closedHandoff.authorities.length,2);assert(closedHandoff.authorities.every(item=>item.phase==='retired'&&!item.current));
    const native=await fixture<{kind:string;outcome:string}>('fixture.file.native',{binding});
    assert.equal(native.kind,'result');assert.equal(native.outcome,'succeeded');
    assert.deepEqual(await runtime.registerFollowup(input),d,'committed prepare returns original without rebinding closed scope');
    const key=(binding:FileObservationBinding)=>({followupId:binding.followupId,generation:binding.generation,sourceIndex:binding.sourceIndex,receiptId:binding.receiptId,observationRevision:binding.observationRevision});
    const observe=async()=>{const binding=(await runtime.fileFollowups()).bindings.find(item=>item.followupId===input.key)!;assert.equal(binding.target!.physicalRoot,null);return runtime.observeFileFollowup({...key(binding),reopen:false});};
    const changed=await observe(); d=changed.followup;
    assert.notDeepEqual(d.sources[0]!.file!.current,initial,'lost first accept preserves first baseline');
    assert(d.occurrence||d.pending_occurrences>0,'A original followup owns change occurrence');
    const before=await fixture<{reads:number}>('fixture.file.stats');
    await observe(); await observe();
    assert.equal((await fixture<{reads:number}>('fixture.file.stats')).reads,before.reads,'unchanged target does not rehash');
    d=await runtime.controlFollowup({followupId:d.id,expectedRevision:d.revision,action:'pause'});
    await writeFile(join(bRoot,'source.txt'),'B_WHILE_PAUSED\n');
    const paused=await fixture<{reads:number}>('fixture.file.stats'); await observe();
    assert.equal((await fixture<{reads:number}>('fixture.file.stats')).reads,paused.reads,'paused A does not read B');
    d=await runtime.controlFollowup({followupId:d.id,expectedRevision:d.revision,action:'resume'});
    d=(await observe()).followup;
    const oldWatch=d.sources[0]!.file!.watch_id; observer.reset();
    d=(await observe()).followup;
    assert.notEqual(d.sources[0]!.file!.watch_id,oldWatch);assert.equal(d.sources[0]!.file!.gap,true);
    d=await runtime.controlFollowup({followupId:d.id,expectedRevision:d.revision,action:'cancel'});
    const release=(await runtime.fileFollowups()).bindings.find(item=>item.followupId===d.id)!;
    assert.equal((await runtime.releaseFileFollowup(key(release))).released,true);
    assert.equal(observer.has(release.receiptId,d.sources[0]!.file!.watch_id),false);
    assert.equal((await runtime.registerFollowup(input)).state,'cancelled');
    // Before adoption, the original command can find and close the scope even
    // when no register request or bind reply ever reached A.
    const abandoned={...input,key:'abandoned-file'};
    const prep=await a.agentRuntimeRequest<FollowupFilePreparation,'runtime.followup.registration.prepare'>('runtime.followup.registration.prepare',{...abandoned,coordinatorHostId:HOST_A});
    assert.equal(prep.followup,null); assert(prep.scope&&prep.source);
    const orphan=await service.bind({coordinatorHostId:HOST_A,scope:prep.scope,source:resourceThreadSourceForFixture(prep.source)!,purpose:'read',retention:'caller'});
    await a.agentRuntimeRequest('runtime.followup.registration.cancel',{key:abandoned.key,runId});
    const closed=await service.inspectReadScope({coordinatorHostId:HOST_A,scope:prep.scope,source:prep.source});
    assert.equal(closed.closed,true);assert(closed.authorities.every(item=>!item.current));
    await assert.rejects(service.bind({coordinatorHostId:HOST_A,scope:prep.scope,source:resourceThreadSourceForFixture(prep.source)!,purpose:'read',retention:'caller'}));
    assert.equal(closed.authorities.find(item=>item.authorityId===orphan.authorityId)?.phase,'retired');
    await runtime.registerFollowup({...input,key:'delete-file'});
    await service.release({...address,mode:'retire'});
    await assert.rejects(fixture('fixture.file.delete',{fail:true}),/unavailable/);
    assert((await runtime.fileFollowups()).bindings.some(item=>item.followupId==='delete-file'&&item.action==='release'));
    assert.deepEqual(await fixture('fixture.file.delete'),{removed:true});
    observer.stop(); await Promise.all(documents.map(item=>item.dispose()));
    write({kind:'fixture-result',ok:true,reads:(await fixture<{reads:number}>('fixture.file.stats')).reads});return;
  }
  const coordinated = new Promise<Record<string, unknown>>((resolve, reject) => { coordinatorResult = { resolve, reject }; });
  write({ kind: 'fixture-coordinator-tool', binding, source: selected });
  const coordinatedResult = await coordinated;
  assert.equal(coordinatedResult.ok, true);
  assert(JSON.stringify(coordinatedResult.result).includes('B_ORIGINAL_SOURCE'));
  assert(!JSON.stringify(coordinatedResult.result).includes('A_PRIVATE_SOURCE'));
  let calls = 0;
  const call = (name: string, args: unknown): HostToolCall => {
    const callId = `call-${++calls}`, origin = { kind: 'model_step' as const, request_id: 'request:managed-review' };
    return { runId, operationId: toolOperationId(origin, callId), origin, callId, name, schemaVersion: '1', arguments: args };
  };
  const execute = async (name: string, args: unknown) => {
    const invocation = call(name, args);
    await service.authorize({ ...address, call: invocation });
    return service.execute({ ...address, call: invocation });
  };
  const read = data(await execute('file_read', { path: 'source.txt' }));
  assert(JSON.stringify(read).includes('B_ORIGINAL_SOURCE')); assert(!JSON.stringify(read).includes('A_PRIVATE_SOURCE'));
  assert.equal(typeof read.readVersion, 'string');
  const changed = data(await execute('file_write', { path: 'source.txt', readVersion: read.readVersion, content: 'B_CHANGED_SOURCE\n' }));
  assert.equal(changed.status, 'applied');
  assert.equal(await readFile(join(aRoot, 'source.txt'), 'utf8'), 'A_PRIVATE_SOURCE\n');
  assert.equal(await readFile(join(bRoot, 'source.txt'), 'utf8'), 'B_CHANGED_SOURCE\n');
  const search = data(await execute('file_search', { query: 'B_CHANGED_SOURCE', maxResults: 10 }));
  assert(JSON.stringify(search).includes('source.txt'), JSON.stringify(search));
  const spawn = call('process_spawn', { cwd: '', command: process.execPath, mode: 'pipe', args: ['-e',
    'const fs=require("node:fs");fs.appendFileSync("spawn-count","1");process.stdout.write("B_PROCESS_OUTPUT");setInterval(()=>{},1000);'] });
  await service.authorize({ ...address, call: spawn });
  discardExecuteResponse = true;
  await assert.rejects(service.execute({ ...address, call: spawn }), /accepted response was disconnected/);
  let receipt = await service.observe({ ...address, operationId: spawn.operationId });
  assert.equal(receipt.accepted, true); assert.equal(receipt.executorStopped, false);
  const end = Date.now() + 15_000;
  while (await readFile(join(bRoot, 'spawn-count'), 'utf8').catch(() => '') !== '1') {
    assert(Date.now() < end, 'Original B process did not start'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (;;) {
    const output = data(await execute('process_read', { processId: spawn.operationId, cursor: 0, maxBytes: 4096 }));
    assert(Array.isArray(output.chunks), JSON.stringify(output));
    const bytes = Buffer.concat(output.chunks.map(chunk => {
      assert(chunk && typeof chunk === 'object' && typeof chunk.bytesBase64 === 'string', JSON.stringify(output));
      return Buffer.from(chunk.bytesBase64, 'base64');
    }));
    if (bytes.toString('utf8').includes('B_PROCESS_OUTPUT')) break;
    assert(Date.now() < end, `Original B process output is unavailable: ${JSON.stringify(output)}`); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const rebound = await service.bind({ coordinatorHostId: HOST_A, source: selected,
    scope: { kind: 'run', threadId, runId, epoch: 2 }, purpose: 'source', retention: 'run' });
  await assert.rejects(service.execute({ ...address, call: call('file_read', { path: 'source.txt' }) }));
  receipt = await service.observe({ ...address, operationId: spawn.operationId });
  assert.equal(receipt.accepted, true); assert.equal(receipt.executorStopped, false);
  await assert.rejects(service.observe({ coordinatorHostId: HOST_A, authorityId: rebound.authorityId,
    resourceEpoch: rebound.resourceEpoch, operationId: spawn.operationId }), /another source authority/);
  const other = await registry('other-principal').source(owner);
  await assert.rejects(other.cancel({ ...address, operationId: spawn.operationId }), /another authenticated owner/);
  permissions.splice(0);
  const cleanup = await targets.source(owner);
  await assert.rejects(cleanup.resolve({ coordinatorHostId: HOST_A, path: bRoot }), /capability is unavailable/);
  const stopping = await cleanup.cancel({ ...address, operationId: spawn.operationId });
  receipt = stopping;
  const stopEnd = Date.now() + 15_000;
  while (!receipt.executorStopped) {
    assert(Date.now() < stopEnd, 'Original B process tree stop is unconfirmed');
    await new Promise(resolve => setTimeout(resolve, 10));
    receipt = await cleanup.observe({ ...address, operationId: spawn.operationId });
  }
  assert.equal(receipt.operationId, spawn.operationId); assert.equal(receipt.accepted, true);
  assert.equal(await readFile(join(bRoot, 'spawn-count'), 'utf8'), '1');
  await assert.rejects(readFile(join(aRoot, 'spawn-count')));
  const release = await cleanup.releaseScope({ coordinatorHostId: HOST_A, threadId, runId, mode: 'retire' });
  assert.deepEqual((release as { pendingAuthorities: unknown[] }).pendingAuthorities, []);
  permissions.push('filesystem:read', 'filesystem:write', 'terminal:use', 'process:control');
  const child = await childSources(runtime, service, owner, bRoot, other);
  await storage.dispose();
  await Promise.all(documents.map(value => value.dispose()));
  write({ kind: 'fixture-result', ok: true, checks: ['same-workspace-target-isolation', 'target-file-read-write-search',
    'lost-accepted-response-recall', 'epoch-fence-with-live-original-process', 'cross-authority-denied',
    'cross-principal-denied', 'withdrawn-access-still-stops-original', 'actual-tree-stop-once',
    'fixed-handoff-private-materialized-child', 'foreign-child-source-and-result-denied', 'frozen-result-with-missing-environment',
    'published-result-continuation', 'original-process-continuation-lineage', 'original-child-pin-release',
    'original-unaccepted-child-pin-release'], operationId: spawn.operationId, child });
}

createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame.kind === 'fixture-target-frame') {
    assert(targetKernel); (targetKernel as unknown as {consumeFrame(value:unknown):void}).consumeFrame(frame.frame);return;
  }
  if (frame.kind === 'fixture-coordinator-frame') {
    assert(coordinatorKernel);
    (coordinatorKernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(frame.frame); return;
  }
  if (frame.kind === 'fixture-coordinator-result') {
    assert(coordinatorResult);
    if (frame.ok) coordinatorResult.resolve(frame); else coordinatorResult.reject(new Error(String(frame.error)));
    coordinatorResult = undefined; return;
  }
  if (frame.kind === 'fixture-response') {
    const waiter = pending.get(String(frame.id)); assert(waiter); pending.delete(String(frame.id));
    if (frame.ok) waiter.resolve(frame.result);
    else {
      const error = frame.error && typeof frame.error === 'object' ? frame.error as Record<string, unknown> : {};
      waiter.reject(new KernelClientError({ code: String(error.code ?? frame.code ?? 'operation-error'),
        message: String(error.message ?? frame.error ?? 'Original kernel request failed') }));
    }
    return;
  }
  assert.equal(frame.kind, 'fixture-init');
  void run(frame).catch(error => write({ kind: 'fixture-error', message: String(error), stack: error instanceof Error ? error.stack : undefined }));
});
