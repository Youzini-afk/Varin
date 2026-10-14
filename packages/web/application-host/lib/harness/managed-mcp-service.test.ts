import { expect, it } from 'vitest';
import { createManagedMcpService } from './managed-mcp-service.js';
import type { ManagedSourceLocalScope } from './managed-remote-types.js';
import type { McpAuthorityLease, McpAuthorityScope, McpCompositionScope } from '../mcp/authority.js';

const original = (): ManagedSourceLocalScope => ({
  principal: { principalId: 'caller-a', capabilities: ['filesystem:read', 'terminal:use', 'process:control'] },
  coordinatorHostId: 'host-a', authorityId: 'authority', resourceEpoch: 'b-epoch',
  scope: { kind: 'run', runId: 'run', threadId: 'thread', epoch: 1 },
  source: { resource_owner: { kind: 'managed_host', hostId: 'host-b', connectionId: 'connection', endpointIdentity: 'endpoint' },
    workspace_id: 'original-workspace', execution_workspace_id: 'child-workspace', mode: 'materialized', branch_id: 'branch', revision: 4, live_root: null },
  physicalRoot: { hostId: 'host-b', canonicalRoot: '/b/physical-child', rootId: 'b-root' }, grant: {} as never,
});
function fixture(transportOwner?: Parameters<typeof createManagedMcpService>[0]["transportOwner"]) {
  const scopes: McpAuthorityScope[] = [];
  const calls: unknown[] = [];
  let trusted = true, releases = 0, scopeReleases = 0, snapshots = 0;
  let changed = () => {};
  const revoked = new AbortController();
  let tokenFailure = false;
  const signals: AbortSignal[] = [];
  let dispatch: () => Promise<unknown> = async () => ({ content: [] });
  const service = createManagedMcpService({ hostId: 'host-b', agentDir: '/b/agent', ...(transportOwner ? { transportOwner } : {}),
    admitSource: async () => {},
    admitWorkspaceRegistration: async id => { expect(id).toBe('original-workspace'); return { canonicalPath: '/b/original-project' }; },
    projectTrusted: () => trusted,
    compositions: { async observe(scope, listener) {
      scopes.push(scope); changed = listener;
      return { release() { scopeReleases++; }, async releaseAndDrain() { scopeReleases++; }, snapshot() {
        snapshots++;
        return { binding: { provenance: { servers: {} }, reference: 'original', generation: 1, tools: [{ name: 'write', server: 'project', schemaVersion: 'v1' }], servers: [], readiness: {}, serverSelections: [] },
          implementationIdentity: 'original-transport', revocationSignal: () => { if (tokenFailure) throw Object.assign(new Error('invalid config'), { code: 'mcp-config-invalid' }); return revoked.signal; },
          serviceRevocationSignal: () => revoked.signal,
          discoverServices: async () => [{ server: 'project', kind: 'resources', resourceKey: 'resource', schemaVersion: 's1' }],
          async requestService(_service: unknown, _request: unknown, options: Parameters<McpAuthorityLease['requestService']>[2]) { await options.beforeDispatch?.(); signals.push(options.signal); return dispatch(); }, release() { releases++; },
          async callTool(name: string, args: Record<string, unknown>, options: Parameters<McpAuthorityLease['callTool']>[2]) { await options.beforeDispatch?.(); calls.push({ name, args }); signals.push(options.signal); return dispatch(); },
        } as unknown as McpAuthorityLease;
      } } as McpCompositionScope;
    } },
  });
  return { service, scopes, calls, change: () => changed(), revoke: () => { trusted = false; }, dispatch: (run: typeof dispatch) => { dispatch = run; },
    signals, withdraw: () => { revoked.abort(); changed(); }, malformed: () => { tokenFailure = true; changed(); },
    counts: () => ({ releases, scopeReleases, snapshots }) };
}
it('selects only B project configuration and the admitted B physical cwd', async () => {
  const f = fixture(), scope = original();
  const reply = await f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' });
  expect(reply.ok).toBe(true);
  expect(f.scopes).toMatchObject([{ resourceOwner: scope.source.resource_owner, configurationScopes: ['project'],
    agentDir: '/b/agent', configCwd: '/b/original-project', executionCwd: '/b/physical-child', executionScope: 'workspace',
    environmentId: JSON.stringify(['host-b', 'caller-a', 'host-a', 'child-workspace', 'authority', 'b-epoch']), sessionId: 'managed:host-a:thread' }]);
  f.revoke();
  await f.service.releaseView({ principal: { ...scope.principal, capabilities: [] }, coordinatorHostId: scope.coordinatorHostId,
    authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch }, { kind: 'release', handleId: 'view', creationRequestId: 'creation' });
  await f.service.release(scope); expect(f.counts()).toEqual({ releases: 1, scopeReleases: 1, snapshots: 1 });
});
it('rejects read-only, wrong Host and insufficient principals before opening transports', async () => {
  const f = fixture();
  for (const scope of [
    { ...original(), physicalRoot: null },
    { ...original(), source: { ...original().source, mode: 'fixed_branch' as const } },
    { ...original(), principal: { principalId: 'caller-a', capabilities: ['filesystem:read'] } },
    { ...original(), source: { ...original().source, resource_owner: { kind: 'local' as const } } },
  ]) expect(await f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' })).toMatchObject({ ok: false, executorStopped: true });
  expect(f.scopes).toEqual([]);
});
it('coalesces the same view and does not let another principal or authority use its handle', async () => {
  const f = fixture(), scope = original();
  const [a, b] = await Promise.all([f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' }), f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' })]);
  expect(a).toEqual(b); expect(f.counts().snapshots).toBe(1);
  for (const foreign of [{ ...scope, authorityId: 'other' }, { ...scope, principal: { ...scope.principal, principalId: 'other' } }]) {
    expect(await f.service.request(foreign, { kind: 'call', handleId: 'view', name: 'write', schemaVersion: 'v1', arguments: {} })).toMatchObject({ ok: false, executorStopped: true });
  }
  expect(f.calls).toEqual([]); await f.service.release(scope);
});
it('rechecks current B trust and preserves unknown versus actual MCP response evidence', async () => {
  const f = fixture(), scope = original();
  await f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' });
  const call = { kind: 'call' as const, handleId: 'view', name: 'write', schemaVersion: 'v1', arguments: { text: 'original' } };
  f.dispatch(async () => { throw Object.assign(new Error('transport lost'), { code: 'mcp-call-failed', dispatched: true, settlement: 'unknown' }); });
  expect(await f.service.request(scope, call)).toMatchObject({ ok: false, executorStopped: false, error: { dispatched: true, settlement: 'unknown' } });
  f.dispatch(async () => { throw Object.assign(new Error('protocol response'), { code: 'mcp-call-failed', dispatched: true, settlement: 'rpc_response', protocolError: { code: -1 } }); });
  expect(await f.service.request(scope, call)).toMatchObject({ ok: false, executorStopped: true, error: { protocolError: { code: -1 } } });
  f.revoke(); expect(await f.service.request(scope, call)).toMatchObject({ ok: false, executorStopped: true, error: { dispatched: false } });
  expect(f.calls).toHaveLength(2); await f.service.release(scope);
});
it('waits for real composition changes and fences the original incarnation on close', async () => {
  const f = fixture(), scope = original();
  const opened = await f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' });
  if (!opened.ok) throw new Error('expected view');
  const { incarnation, revision } = opened.value as { incarnation: string; revision: number };
  const pending = f.service.request(scope, { kind: 'changed', incarnation, after: revision });
  f.change(); expect(await pending).toMatchObject({ ok: true, value: { incarnation, revision: revision + 1 } });
  const closed = f.service.request(scope, { kind: 'changed', incarnation, after: revision + 1 });
  await f.service.release(scope); expect(await closed).toMatchObject({ ok: false });
});

it('interrupts entered RPCs with the original target token and projects only explicit revocation', async () => {
  const f = fixture(), scope = original();
  const opened = await f.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' });
  if (!opened.ok) throw new Error('expected view');
  const { incarnation } = opened.value as { incarnation: string };
  f.malformed();
  expect(await f.service.request(scope, { kind: 'changed', incarnation, after: 0 })).toMatchObject({
    ok: true, value: { revocations: { view: { tools: [], services: [] } } },
  });
  // A previously obtained token remains authoritative even when current config is malformed.
  f.withdraw();
  expect(await f.service.request(scope, { kind: 'changed', incarnation, after: 1 })).toMatchObject({
    ok: true, value: { revocations: { view: { tools: [{ name: 'write', schemaVersion: 'v1' }] } } },
  });
  await f.service.release(scope);
  const live = fixture();
  await live.service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' });
  await live.service.request(scope, { kind: 'discover_services', handleId: 'view', server: 'project' });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }); live.dispatch(() => pending);
  const work = [live.service.request(scope, { kind: 'call', handleId: 'view', name: 'write', schemaVersion: 'v1', arguments: {} }),
    live.service.request(scope, { kind: 'service', handleId: 'view', service: { server: 'project', kind: 'resources', resourceKey: 'resource', schemaVersion: 's1' }, request: { operation: 'resources/list' } })];
  while (live.signals.length < 2) await Promise.resolve();
  live.withdraw(); expect(live.signals.map(signal => signal.aborted)).toEqual([true, true]);
  finish(); await Promise.all(work); await live.service.release(scope);
});

it('seals ordinary views without draining the retained original daemon, then drains on final release', async () => {
  let nativeDrains = 0;
  const f = fixture(() => ({ adapt: value => value, drain: async () => { nativeDrains++; }, executorsStopped: () => nativeDrains > 0 }));
  const scope = original();
  await f.service.request(scope, { kind: 'snapshot', handleId: 'original-view', creationRequestId: 'open' });
  expect(await f.service.release(scope, { retainMcpHolders: true })).toEqual({ executorStopped: false, taskControlsDrained: false });
  expect(nativeDrains).toBe(0); expect(f.counts().releases).toBe(1);
  expect(await f.service.request(scope, { kind: 'snapshot', handleId: 'late', creationRequestId: 'late' })).toMatchObject({ ok: false });
  expect(await f.service.release(scope)).toEqual({ executorStopped: true, taskControlsDrained: true });
  expect(nativeDrains).toBe(1);
});

it('starts forced native Source stop before a pending resource ACK and still joins its actual drain', async () => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
  };
  const acknowledgement = gate(), subscribed = gate(), nativeStopped = gate();
  const scope = original();
  const endpoint = { server: 'peer', resourceKey: 'original-daemon', configurationVersion: 'config', credentialVersion: 'credential' };
  const declaration = { server: 'peer', kind: 'resources' as const, resourceKey: endpoint.resourceKey, schemaVersion: 'schema', subscribe: true };
  const binding: import('../kernel/protocol.generated.js').McpResourceBinding = { operationId: 'observe',
    executionOwner: { kind: 'external', identity: 'coordinator', epoch: 'coordinator-epoch' }, endpoint, schemaVersion: 'schema', uri: 'opaque:original' };
  let holder: import('../kernel/protocol.generated.js').SourceMcpHolder | undefined;
  let outcome: import('../kernel/protocol.generated.js').SourceMcpCreationOutcome | undefined;
  let nativeDrains = 0, stopped = false, closed = false;
  const kernel = { async sourceRequest(method: string, params: Record<string, unknown>) {
    if (method === 'source.mcp.creation_receipt') {
      if (params.action === 'begin') {
        holder = { binding: params.binding as import('../kernel/protocol.generated.js').SourceMcpHolderBinding,
          released: false, creationReceipt: { requestHash: String(params.requestHash), outcomeRef: null } };
        return { dispatch: true, holder, outcome: null };
      }
      if (params.action === 'settle') {
        outcome = params.outcome as import('../kernel/protocol.generated.js').SourceMcpCreationOutcome;
        holder!.creationReceipt!.outcomeRef = { objectHash: 'original-ack', byteLength: 1 };
      }
      return { dispatch: false, holder, outcome };
    }
    if (method === 'source.mcp.holder') return { holder, grantState: 'active', authority: { phase: 'ready' } };
    throw new Error(`Unexpected ${method}`);
  } };
  const service = createManagedMcpService({ hostId: 'host-b', agentDir: '/b/agent',
    kernel: kernel as unknown as import('../kernel/kernel-client.js').KernelClient,
    admitWorkspaceRegistration: async () => ({ canonicalPath: '/b/original-project' }),
    projectTrusted: () => true, admitSource: async () => {},
    transportOwner: () => ({ adapt: transport => transport, async drain() { nativeDrains++; await nativeStopped.promise; stopped = true; },
      executorsStopped: () => stopped }),
    compositions: { async observe() { return {
      release() {}, async releaseAndDrain() {}, snapshot() { return {
        binding: { reference: 'original', generation: 1, provenance: { servers: {} }, tools: [], servers: [], readiness: {}, serverSelections: [] },
        implementationIdentity: 'original-transport', release() {}, resourceEndpoint: () => endpoint,
        async observeResource(_service: unknown, _uri: string, options: Parameters<McpAuthorityLease['observeResource']>[2]) {
          await options.beforeDispatch?.(); subscribed.resolve(); await acknowledgement.promise;
          return { listenerId: 'original-observer', endpoint, acknowledgement: { original: true },
            async detach() { return { status: 'acknowledged' as const, acknowledgement: {} }; } };
        },
      } as unknown as McpAuthorityLease; },
    } as unknown as McpCompositionScope; } },
  });
  expect((await service.request(scope, { kind: 'snapshot', handleId: 'view', creationRequestId: 'create' })).ok).toBe(true);
  const creation = service.request(scope, { kind: 'resource_subscribe', handleId: 'view', binding, service: declaration });
  await subscribed.promise;
  expect(await service.release(scope, { retainMcpHolders: true })).toEqual({ executorStopped: false, taskControlsDrained: false });
  expect(nativeDrains).toBe(0);
  const closing = service.release(scope).then(result => { closed = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const stopRequestedBeforeAck = nativeDrains, closedBeforeAck = closed;
  acknowledgement.resolve(); await creation;
  await new Promise<void>(resolve => setImmediate(resolve));
  const closedBeforeNativeStop = closed;
  nativeStopped.resolve();
  expect(await closing).toEqual({ executorStopped: true, taskControlsDrained: true });
  expect(stopRequestedBeforeAck).toBe(1);
  expect(closedBeforeAck).toBe(false);
  expect(closedBeforeNativeStop).toBe(false);
  expect(holder?.released).toBe(false);
  expect(outcome).toMatchObject({ kind: 'subscribed', acknowledgement: { original: true } });
});
