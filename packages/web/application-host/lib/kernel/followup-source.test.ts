import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { registerThreadFollowup } from './thread-followups.js';
import { registerUserFollowup } from './followup-source.js';
import type { KernelClient } from './kernel-client.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceBindRequest, ManagedSourceReleaseRequest } from '../harness/managed-remote-types.js';
import type { Followup, FollowupFilePreparation, FollowupRegisterAdmissionParams, LaunchSource, ThreadSummary } from './protocol.generated.js';

const owner = { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'configured-b', endpointIdentity: 'b-endpoint' };
const identity = { runtime: 'agent' as const, threadId: 'thread-a', branchId: 'branch-a' };
const input = { ...identity, key: 'original-key', runId: 'original-run', instruction: 'Read the original result.',
  trigger: { kind: 'file' as const, path: 'results/output.txt', condition: 'ready' as const } };
const source = (mode: LaunchSource['mode'], environmentRunId?: string): LaunchSource => ({
  resource_owner: owner, workspace_id: 'same-workspace', execution_workspace_id: 'same-execution', mode,
  branch_id: mode === 'live_root' ? null : 'files-b', revision: mode === 'live_root' ? null : 7,
  live_root: mode === 'live_root' ? { hostId: 'host-b', rootId: 'root-b', canonicalRoot: '/same-folder' } : null,
  ...(environmentRunId === undefined ? {} : { environment_run_id: environmentRunId }),
});

/** Production User admission and client methods, with explicit in-memory RPC and
 * managed transport boundaries. No KernelClient/default transport is constructed. */
function fixture(selected: LaunchSource) {
  const binds: Array<{ input: ManagedSourceBindRequest; signal: AbortSignal | undefined }> = [];
  const releases: Array<{ input: ManagedSourceReleaseRequest; signal: AbortSignal | undefined }> = [];
  const registered: FollowupRegisterAdmissionParams[] = [];
  const identities: unknown[] = [];
  const preparations: unknown[] = [];
  const inspected: unknown[] = [];
  const prepared: Extract<FollowupFilePreparation, { followup: null }> = { followup: null, authority: null,
    scope: { kind: 'source_read', threadId: identity.threadId, branchId: identity.branchId, key: 'file-followup:original-key' },
    source: selected.mode === 'materialized' ? { ...selected, environment_run_id: selected.environment_run_id ?? input.runId } : selected };
  const inspection: Awaited<ReturnType<ManagedSourceClient['inspectReadScope']>> = { closed: false, authorities: [] };
  let onBound = () => {};
  let onInspected = () => {};
  let onConnected = () => {};
  let bindFailure: Error | undefined;
  let registerFailure: Error | undefined;
  let accepted: Followup | null = null;
  let adoptRegistration = true;
  let releaseFailure: Error | undefined;
  const client = {
    async inspectReadScope(request: unknown) { inspected.push(request); onInspected(); return inspection; },
    async bind(request: ManagedSourceBindRequest, signal?: AbortSignal) {
      assert.ok(preparations.length > 0, 'A must record its original command before B acquires a caller');
      binds.push({ input: structuredClone(request), signal });
      const address = { authorityId: `caller-${binds.length}`, resourceEpoch: 'epoch-b' };
      inspection.authorities.push({ ...address, phase: 'ready', current: true }); onBound();
      if (bindFailure) throw bindFailure;
      return address;
    },
    async release(request: ManagedSourceReleaseRequest, signal?: AbortSignal) {
      releases.push({ input: request, signal }); if (releaseFailure) throw releaseFailure;
    },
  } as unknown as ManagedSourceClient;
  const forbidden = () => { throw new Error('A must not acquire local file authority'); };
  const kernel = {
    handshake: { hostId: 'host-a' }, subscribeExit() {}, onToolReleased() {},
    cancelRunPreparation() {}, unregisterCredentialOwner() {}, unregisterToolOwners() {}, releaseRunPolicyOwners() {},
    issueGrant: forbidden, retireGrant: forbidden, revokeGrant: forbidden,
    async agentRuntimeRequest(method: string, request: FollowupRegisterAdmissionParams) {
      if (method === 'runtime.run.inspect') return { id: input.runId, thread_id: identity.threadId, branch_id: identity.branchId, state: 'completed' };
      if (method === 'runtime.launch.inspect') return { selection: { source: selected } };
      if (method === 'runtime.followup.registration.prepare') {
        preparations.push(structuredClone(request));
        return accepted ? { followup: accepted, authority: null, scope: null, source: null } satisfies FollowupFilePreparation : prepared;
      }
      assert.equal(method, 'runtime.followup.register'); registered.push(structuredClone(request));
      if (adoptRegistration && !prepared.authority && request.fileAuthority?.kind === 'managed_host') {
        const { coordinatorHostId, authorityId, resourceEpoch } = request.fileAuthority;
        prepared.authority = { coordinatorHostId, authorityId, resourceEpoch };
      }
      if (registerFailure) throw registerFailure;
      accepted = { id: 'same-definition' } as Followup;
      return accepted;
    },
  } as unknown as KernelClient;
  const runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, async () => forbidden());
  runtime.bindManagedSources({ source: async (selectedOwner, signal) => {
    assert.deepEqual(selectedOwner, owner); signal?.throwIfAborted(); onConnected(); return client;
  } });
  const publicOwner = { runtime, requireIdentity: async (selectedIdentity: unknown) => {
    identities.push(selectedIdentity);
    return { main_branch_id: identity.branchId, title: 'Original thread', revision: 1, created_at_ms: 0, updated_at_ms: 0,
      pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
      bot_id: null, thread_id: identity.threadId, branches: [{ branch_id: identity.branchId, head: null, active_run_id: null, latest_run: null }],
      parent_thread_id: null, observer_project_ids: [] } satisfies ThreadSummary;
  } };
  return { kernel, runtime, binds, releases, registered, identities, preparations, prepared, inspected, inspection,
    register: (signal?: AbortSignal) => registerThreadFollowup(publicOwner, input, signal),
    onBound(callback: () => void) { onBound = callback; },
    onInspected(callback: () => void) { onInspected = callback; }, onConnected(callback: () => void) { onConnected = callback; },
    failBind(error?: Error) { bindFailure = error; },
    failRegistration(error?: Error, adopt = true) { registerFailure = error; adoptRegistration = adopt; },
    failRelease(error?: Error) { releaseFailure = error; } };
}

test('User admission freezes live, fixed and original materialized B sources without duplicating acknowledged scope cleanup', async () => {
  for (const selected of [source('live_root'), source('fixed_branch'), source('fixed_branch', 'fixed-environment'),
    source('materialized'), source('materialized', 'ancestor-environment')]) {
    const f = fixture(selected); const signal = new AbortController().signal;
    assert.equal((await f.register(signal)).id, 'same-definition');
    assert.equal((await f.register(signal)).id, 'same-definition'); assert.equal(f.identities.length, 2);
    assert.equal(f.preparations.length, 2); assert.equal(f.binds.length, 1); assert.equal(f.registered.length, 1);
    for (const [index, bind] of f.binds.entries()) {
      assert.equal(bind.signal, signal);
      assert.deepEqual(bind.input, { coordinatorHostId: 'host-a',
        scope: { kind: 'source_read', threadId: identity.threadId, branchId: identity.branchId, key: 'file-followup:original-key' },
        source: { resourceOwner: owner, workspaceId: 'same-workspace', executionWorkspaceId: 'same-execution', tools: [], mode: selected.mode,
          ...(selected.mode === 'live_root' ? { liveRoot: selected.live_root } : { branchId: 'files-b', revision: 7 }),
          ...(selected.mode === 'materialized' ? { environmentRunId: selected.environment_run_id ?? input.runId }
            : selected.environment_run_id ? { environmentRunId: selected.environment_run_id } : {}) },
        purpose: 'read', retention: 'caller' });
      const address = { coordinatorHostId: 'host-a', authorityId: `caller-${index + 1}`, resourceEpoch: 'epoch-b' };
      assert.deepEqual(f.registered[index], { key: input.key, runId: input.runId, trigger: input.trigger, instruction: input.instruction,
        fileAuthority: { kind: 'managed_host', ...address } });
    }
    assert.equal(f.releases.length, 0);
  }
});

test('unknown submitted registration retains its original authority; pre-submission cancellation retires its caller', async () => {
  const unknown = fixture(source('materialized')); unknown.failRegistration(new Error('reply lost after submission'));
  await assert.rejects(unknown.register(), /reply lost/);
  assert.equal(unknown.registered.length, 1); assert.equal(unknown.releases.length, 0);
  unknown.failRegistration(); await unknown.register();
  assert.deepEqual(unknown.registered.map(value => value.key), ['original-key', 'original-key']);
  assert.deepEqual(unknown.registered[0]?.fileAuthority, unknown.registered[1]?.fileAuthority);
  assert.equal(unknown.binds.length, 1); assert.equal(unknown.releases.length, 0);
  const cancelled = fixture(source('live_root')); const caller = new AbortController(); cancelled.onBound(() => caller.abort());
  await assert.rejects(cancelled.register(caller.signal), { name: 'AbortError' }); assert.equal(cancelled.registered.length, 0);
  assert.deepEqual(cancelled.releases, [{ input: { coordinatorHostId: 'host-a', authorityId: 'caller-1', resourceEpoch: 'epoch-b', mode: 'retire' }, signal: undefined }]);
});

test('successful registration cannot be replaced by an extra retirement failure and same-key retry returns its definition', async () => {
  const f = fixture(source('fixed_branch')); f.failRelease(new Error('retirement reply unknown'));
  const accepted = await f.register(); assert.equal(f.registered.length, 1);
  assert.deepEqual(await f.register(), accepted);
  assert.deepEqual(f.registered.map(value => value.key), ['original-key']);
  assert.equal(f.preparations.length, 2); assert.equal(f.binds.length, 1);
  assert.equal(f.releases.length, 0);
});

test('the prepared original scope recovers a lost bind or adoption reply and a closed scope cannot bind', async () => {
  const lostBind = fixture(source('materialized')); lostBind.failBind(new Error('B bind reply lost'));
  await assert.rejects(lostBind.register(), /bind reply lost/);
  assert.equal(lostBind.preparations.length, 1); assert.equal(lostBind.registered.length, 0); assert.equal(lostBind.releases.length, 0);
  lostBind.failBind(); await lostBind.register();
  assert.equal(lostBind.binds.length, 1); assert.equal(lostBind.inspected.length, 2);
  assert.equal(lostBind.registered[0]?.fileAuthority?.kind, 'managed_host');
  assert.deepEqual(lostBind.registered[0]?.fileAuthority,
    { kind: 'managed_host', coordinatorHostId: 'host-a', authorityId: 'caller-1', resourceEpoch: 'epoch-b' });
  const unadopted = fixture(source('live_root')); unadopted.failRegistration(new Error('A submission never arrived'), false);
  await assert.rejects(unadopted.register(), /never arrived/); assert.equal(unadopted.prepared.authority, null);
  unadopted.failRegistration(); await unadopted.register();
  assert.equal(unadopted.binds.length, 1); assert.deepEqual(unadopted.registered[0]?.fileAuthority, unadopted.registered[1]?.fileAuthority);
  const closed = fixture(source('fixed_branch')); closed.inspection.closed = true;
  await assert.rejects(closed.register(), /cancelled/);
  assert.equal(closed.binds.length, 0); assert.equal(closed.registered.length, 0);
});

test('cancelling a retry before submission does not retire a borrowed original authority', async () => {
  const adopted = fixture(source('fixed_branch'));
  adopted.prepared.authority = { coordinatorHostId: 'host-a', authorityId: 'original', resourceEpoch: 'epoch-b' };
  const caller = new AbortController(); adopted.onConnected(() => caller.abort());
  await assert.rejects(adopted.register(caller.signal), { name: 'AbortError' });
  assert.equal(adopted.inspected.length, 0); assert.equal(adopted.registered.length, 0); assert.equal(adopted.releases.length, 0);
  const candidate = fixture(source('fixed_branch'));
  candidate.inspection.authorities.push({ authorityId: 'original', resourceEpoch: 'epoch-b', phase: 'ready', current: true });
  const retry = new AbortController(); candidate.onInspected(() => retry.abort());
  await assert.rejects(candidate.register(retry.signal), { name: 'AbortError' });
  assert.equal(candidate.binds.length, 0); assert.equal(candidate.registered.length, 0); assert.equal(candidate.releases.length, 0);
});

test('non-file registration does not bind a Source and invalid file paths never reach admission', async () => {
  const f = fixture(source('fixed_branch'));
  const timer = { key: 'timer', runId: input.runId, instruction: input.instruction, trigger: { kind: 'at' as const, atMs: 0 } };
  await registerUserFollowup(f.kernel, f.runtime, timer);
  assert.deepEqual(f.registered, [timer]); assert.equal(f.binds.length, 0);
  for (const path of ['../outside', '/absolute', '.', '']) {
    await assert.rejects(registerUserFollowup(f.kernel, f.runtime, { ...input, trigger: { ...input.trigger, path } }), /relative source path/);
  }
  assert.equal(f.registered.length, 1); assert.equal(f.binds.length, 0);
});
