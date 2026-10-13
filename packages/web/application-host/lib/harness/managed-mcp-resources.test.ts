import { expect, it } from 'vitest';
import type { McpAuthorityService, McpResourceChange, McpResourceRelease } from '@varin/pi-host/mcp-authority';
import type { McpResourceBinding, SourceMcpCreationOutcome, SourceMcpHolder } from '../kernel/protocol.generated.js';
import { createManagedMcpResources } from './managed-mcp-resources.js';
import type { ManagedMcpResourceAction } from './managed-mcp-contract.js';

const binding: McpResourceBinding = { operationId: 'a-subscription', executionOwner: { kind: 'external', identity: 'b', epoch: 'b-kernel' },
  endpoint: { server: 'peer', resourceKey: 'original-daemon', configurationVersion: 'definition', credentialVersion: 'credential' },
  schemaVersion: 'resource-schema', uri: 'opaque:original' };
const service: McpAuthorityService = { server: 'peer', kind: 'resources', resourceKey: 'original-daemon', schemaVersion: binding.schemaVersion, subscribe: true };
const scope = { principal: { principalId: 'a-principal', capabilities: [] }, coordinatorHostId: 'a', authorityId: 'original-source', resourceEpoch: 'b-kernel' };
const subscribe: Extract<ManagedMcpResourceAction, { kind: 'resource_subscribe' }> = { kind: 'resource_subscribe', handleId: 'view', binding, service };
const watch = (after = 0): Extract<ManagedMcpResourceAction, { kind: 'resource_watch' }> => ({ kind: 'resource_watch', binding, listenerId: 'original-listener', after });
const acknowledgement = { _meta: { original: true }, vendor: { opaque: ['field', 42] } };
const signal = () => new AbortController().signal;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function until(check: () => boolean) { for (let i = 0; !check(); i++) { if (i > 100) throw new Error('Controlled callback was not reached'); await Promise.resolve(); } }
function fixture() {
  let grantState = 'active';
  let holder: SourceMcpHolder | undefined, outcome: SourceMcpCreationOutcome | null = null;
  let views = 0, subscriptions = 0, detaches = 0, sealed = false, settleFailures = 0, lostSettleReply = false, lostBeginReply = false;
  let creationSignal: AbortSignal | undefined;
  let change: ((event: McpResourceChange) => void) | undefined;
  let run = async () => acknowledgement;
  let detach = async (): Promise<McpResourceRelease> => ({ status: 'acknowledged', acknowledgement: { _meta: { unsubscribed: true } } });
  const calls: Array<{ method: string; action: string }> = [];
  const kernel = { async sourceRequest(method: string, params: any) {
    calls.push({ method, action: params.action });
    expect(params.principalId).toBe(scope.principal.principalId);
    expect(params.authorityId).toBe(scope.authorityId);
    expect(params.binding.purpose).toBe('resource_observer');
    if (holder && JSON.stringify(holder.binding) !== JSON.stringify(params.binding)) throw new Error('binding changed');
    if (method === 'source.mcp.holder') {
      if (!holder && params.action === 'inspect') throw new Error('holder absent');
      holder ??= { binding: params.binding, released: false, creationReceipt: null };
      if (params.action === 'release' || params.action === 'release_unstarted' && !holder.creationReceipt) holder.released = true;
      return { holder: structuredClone(holder), authority: { phase: holder.released ? 'draining' : 'retaining' }, grantState };
    }
    expect(method).toBe('source.mcp.creation_receipt');
    if (holder?.creationReceipt && params.requestHash !== holder.creationReceipt.requestHash) throw new Error('request changed');
    if (params.action === 'begin' && !holder?.creationReceipt) {
      if (holder?.released) throw new Error('holder released');
      holder = { binding: params.binding, released: false, creationReceipt: { requestHash: params.requestHash, outcomeRef: null } };
      if (lostBeginReply) throw new Error('begin reply lost');
      return { dispatch: true, holder: structuredClone(holder), outcome: null };
    }
    if (!holder) throw new Error('holder absent');
    if (params.action === 'settle') {
      if (settleFailures > 0) { settleFailures--; throw new Error('Storage unavailable'); }
      if (outcome && JSON.stringify(outcome) !== JSON.stringify(params.outcome)) throw new Error('outcome changed');
      outcome = structuredClone(params.outcome);
      holder.creationReceipt!.outcomeRef = { objectHash: 'sha256-body', byteLength: JSON.stringify(outcome).length };
      if (lostSettleReply) { lostSettleReply = false; throw new Error('Storage reply lost'); }
    }
    return { dispatch: false, holder: structuredClone(holder), outcome: holder.released ? null : structuredClone(outcome) };
  } };
  const view = async (_scope: unknown, _id: string, active: AbortSignal) => {
    views++; active.throwIfAborted(); if (sealed) throw new Error('view sealed');
    return { beforeDispatch: async () => { active.throwIfAborted(); if (sealed) throw new Error('view sealed'); }, lease: {
      resourceEndpoint: () => binding.endpoint,
      async observeResource(originalService: McpAuthorityService, uri: string, options: any) {
        expect(originalService).toEqual(service); expect(uri).toBe(binding.uri); expect(options.interaction).toBeUndefined();
        await options.beforeDispatch(); creationSignal = options.signal; change = options.onChange; subscriptions++;
        const ack = await run();
        return { endpoint: binding.endpoint, listenerId: 'original-listener', acknowledgement: ack,
          detach() { detaches++; return detach(); } };
      },
    } };
  };
  const create = () => createManagedMcpResources({ kernel, view } as never);
  return { resources: create(), create, calls, revokeGrant: () => { grantState = 'revoked'; }, emit: (event: McpResourceChange) => change?.(event),
    counts: () => ({ views, subscriptions, detaches }), holder: () => holder, outcome: () => outcome, creationSignal: () => creationSignal,
    seal: () => { sealed = true; }, run: (next: typeof run) => { run = next; }, detach: (next: typeof detach) => { detach = next; },
    failSettle: (count = 1) => { settleFailures = count; }, loseSettleReply: () => { lostSettleReply = true; }, loseBeginReply: () => { lostBeginReply = true; } };
}

it('persists the complete original ACK once and retains its SDK observer after the Run view seals', async () => {
  const f = fixture();
  expect(await f.resources.subscribe(scope, subscribe, signal())).toEqual({ listenerId: 'original-listener', acknowledgement, revision: 0 });
  expect(f.outcome()).toEqual({ kind: 'subscribed', listenerId: 'original-listener', acknowledgement });
  expect(await f.resources.subscribe(scope, subscribe, signal())).toMatchObject({ acknowledgement });
  f.seal();
  const requests = f.calls.length;
  f.emit({ kind: 'updated', notification: { uri: binding.uri, opaque: 1 } });
  f.emit({ kind: 'unresolved_association' });
  f.emit({ kind: 'updated', notification: { uri: binding.uri, opaque: 2 } });
  expect(f.calls).toHaveLength(requests); // The SDK callback performs no network or body I/O.
  const watched = await f.resources.watch(scope, watch(), signal());
  expect(f.calls.at(-1)).toEqual({ method: 'source.mcp.holder', action: 'inspect' });
  expect(watched).toEqual({ listenerId: 'original-listener', revision: 3, changes: [
    { revision: 2, change: { kind: 'unresolved_association' } },
    { revision: 3, change: { kind: 'updated', notification: { uri: binding.uri, opaque: 2 } } },
  ] });
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ live: true, revision: 3, listenerId: 'original-listener' });
  expect(f.counts()).toEqual({ views: 1, subscriptions: 1, detaches: 0 });
  await f.resources.close(scope);
});

it('keeps a late ACK after requester loss and lets inspect join original creation without resubscribing', async () => {
  const f = fixture(), ack = gate(), request = new AbortController();
  f.run(async () => { await ack.promise; return acknowledgement; });
  const creating = f.resources.subscribe(scope, subscribe, request.signal);
  await until(() => f.counts().subscriptions === 1); request.abort();
  expect(f.creationSignal()?.aborted).toBe(false);
  let inspected = false;
  const inspection = f.resources.inspect(scope, binding, true).then(result => { inspected = true; return result; });
  await Promise.resolve(); await Promise.resolve(); expect(inspected).toBe(false); expect(f.holder()?.released).toBe(false);
  ack.resolve(); await creating;
  expect(await inspection).toMatchObject({ live: true, receipt: { outcome: { kind: 'subscribed', acknowledgement } } });
  expect(f.counts().subscriptions).toBe(1); await f.resources.close(scope);
});

it.each(['before settlement', 'after settlement'] as const)('recalls known ACK after Storage failure %s and never reacquires a view on reopen', async failure => {
  const f = fixture(); if (failure === 'before settlement') f.failSettle(); else f.loseSettleReply();
  await expect(f.resources.subscribe(scope, subscribe, signal())).rejects.toMatchObject({ code: 'mcp_resource_creation_receipt_pending', dispatched: true });
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ live: true, receipt: { outcome: { kind: 'subscribed', acknowledgement } } });
  const reopened = f.create(); f.seal();
  expect(await reopened.inspect(scope, binding)).toMatchObject({ live: false, revision: 0, listenerId: 'original-listener' });
  expect(await reopened.subscribe(scope, subscribe, signal())).toMatchObject({ listenerId: 'original-listener', acknowledgement });
  await expect(reopened.watch(scope, watch(), signal())).rejects.toThrow('original_observer_unavailable');
  expect(f.counts()).toEqual({ views: 1, subscriptions: 1, detaches: 0 });
  await reopened.close(scope); await f.resources.close(scope);
});

it('does not replay when native admission survived but the begin reply was lost', async () => {
  const f = fixture(); f.loseBeginReply();
  await expect(f.resources.subscribe(scope, subscribe, signal())).rejects.toThrow('begin reply lost');
  expect(await f.resources.inspect(scope, binding, true)).toMatchObject({ live: false, released: false, receipt: { outcome: null } });
  const reopened = f.create();
  await expect(reopened.subscribe(scope, subscribe, signal())).rejects.toThrow('original_creation_unknown');
  expect(f.counts()).toEqual({ views: 0, subscriptions: 0, detaches: 0 });
  await reopened.release(scope, binding); await f.resources.close(scope);
});

it('rejects changed services and full URI/schema bindings, including inspect/watch/release after reopen', async () => {
  const f = fixture();
  await expect(f.resources.subscribe(scope, { ...subscribe, service: { ...service, schemaVersion: 'changed' } }, signal())).rejects.toThrow('service_changed');
  expect(f.holder()).toBeUndefined();
  await f.resources.subscribe(scope, subscribe, signal());
  for (const changed of [{ ...binding, uri: 'opaque:other' }, { ...binding, schemaVersion: 'new-schema' }]) {
    await expect(f.resources.inspect(scope, changed)).rejects.toThrow('holder_changed');
    const reopened = f.create();
    await expect(reopened.inspect(scope, changed)).rejects.toThrow('request changed');
    await expect(reopened.watch(scope, { ...watch(), binding: changed }, signal())).rejects.toThrow('creation_changed');
    await expect(reopened.release(scope, changed)).rejects.toThrow('creation_changed');
    expect(f.holder()?.released).toBe(false);
  }
  expect(f.counts().subscriptions).toBe(1); await f.resources.close(scope);
});

it('fences a delayed first subscribe before acquiring a view and reports absent remote cleanup honestly', async () => {
  const f = fixture();
  expect(await f.resources.inspect(scope, binding, true)).toMatchObject({ receipt: null, released: true, live: false, listenerId: null });
  expect(await f.resources.release(scope, binding)).toEqual({ retire: true, controlsDrained: true, release: { status: 'unknown' } });
  await expect(f.resources.subscribe(scope, subscribe, signal())).rejects.toThrow('holder released');
  expect(f.counts()).toEqual({ views: 0, subscriptions: 0, detaches: 0 });
});

it('longpolls the exact listener cursor, cancels locally, and treats an actual SDK gap as unavailable', async () => {
  const f = fixture(); await f.resources.subscribe(scope, subscribe, signal());
  await expect(f.resources.watch(scope, { ...watch(), listenerId: 'replacement' }, signal())).rejects.toThrow('identity_unavailable');
  await expect(f.resources.watch(scope, watch(1), signal())).rejects.toThrow('cursor_invalid');
  const cancelled = new AbortController(), waiting = f.resources.watch(scope, watch(), cancelled.signal);
  await Promise.resolve(); cancelled.abort(new Error('projection disconnected'));
  await expect(waiting).rejects.toThrow('projection disconnected');
  expect(f.counts().detaches).toBe(0); expect(f.holder()?.released).toBe(false);
  const changed = f.resources.watch(scope, watch(), signal());
  await Promise.resolve(); f.emit({ kind: 'updated', notification: { uri: binding.uri } });
  expect(await changed).toMatchObject({ revision: 1, changes: [{ revision: 1, change: { kind: 'updated' } }] });
  const gap = f.resources.watch(scope, watch(1), signal());
  await Promise.resolve(); f.emit({ kind: 'gap' }); f.emit({ kind: 'updated', notification: { uri: binding.uri, afterLostClient: true } });
  expect(await gap).toEqual({ listenerId: 'original-listener', revision: 2, changes: [{ revision: 2, change: { kind: 'gap' } }] });
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ live: false, revision: 2 });
  await expect(f.resources.watch(scope, watch(2), signal())).rejects.toThrow('original_observer_unavailable');
  expect(f.counts().subscriptions).toBe(1); await f.resources.close(scope);
});

it('release fences delivery first and joins actual SDK detach rather than claiming an abort stopped it', async () => {
  const f = fixture(), detached = gate();
  f.detach(async () => { await detached.promise; return { status: 'unknown', protocolError: { code: -32042 }, interactionProblem: 'original-cleanup' }; });
  await f.resources.subscribe(scope, subscribe, signal());
  const waiting = f.resources.watch(scope, watch(), signal());
  const interrupted = expect(waiting).rejects.toThrow('original_observer_unavailable');
  let drained = false;
  const release = f.resources.release(scope, binding).then(result => { drained = true; return result; });
  await until(() => f.counts().detaches === 1);
  expect(f.holder()?.released).toBe(true); expect(drained).toBe(false);
  f.emit({ kind: 'updated', notification: { uri: binding.uri, late: true } });
  await interrupted; detached.resolve();
  expect(await release).toEqual({ retire: true, controlsDrained: true, release: { status: 'unknown', protocolError: { code: -32042 }, interactionProblem: 'original-cleanup' } });
  expect(f.counts().detaches).toBe(1);
});

it('a release racing original creation waits for its ACK and final detach', async () => {
  const f = fixture(), ack = gate(), detached = gate();
  f.run(async () => { await ack.promise; return acknowledgement; });
  f.detach(async () => { await detached.promise; return { status: 'shared' }; });
  const creating = f.resources.subscribe(scope, subscribe, signal());
  await until(() => f.counts().subscriptions === 1);
  let drained = false;
  const releasing = f.resources.release(scope, binding).then(value => { drained = true; return value; });
  await until(() => !!f.holder()?.released);
  expect(f.creationSignal()?.aborted).toBe(false); expect(drained).toBe(false);
  ack.resolve(); await until(() => f.counts().detaches === 1); expect(drained).toBe(false);
  detached.resolve(); await creating;
  expect(await releasing).toMatchObject({ controlsDrained: true, release: { status: 'shared' } });
  expect(f.outcome()).toMatchObject({ kind: 'subscribed', acknowledgement });
});

it('close drains original SDK ownership while preserving durable recovery and a known pending settlement', async () => {
  const f = fixture(), detached = gate();
  f.failSettle(2); f.detach(async () => { await detached.promise; return { status: 'shared' }; });
  await expect(f.resources.subscribe(scope, subscribe, signal())).rejects.toThrow('receipt_pending');
  let closed = false;
  const closing = f.resources.close(scope).then(() => { closed = true; });
  await until(() => f.counts().detaches === 1); expect(closed).toBe(false);
  detached.resolve(); await expect(closing).rejects.toThrow('receipt_pending');
  expect(f.holder()?.released).toBe(false);
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ live: false, receipt: { outcome: { kind: 'subscribed', acknowledgement } } });
  await f.resources.close(scope);
  expect(await f.create().inspect(scope, binding)).toMatchObject({ live: false, released: false, receipt: { outcome: { kind: 'subscribed', acknowledgement } } });
  expect(f.counts().detaches).toBe(1);
});

it('retains full original protocol failure evidence without repeating subscribe or inventing cleanup ACK', async () => {
  const f = fixture();
  f.run(async () => { throw Object.assign(new Error('original failure'), { code: 'mcp-resource-subscribe-unavailable', dispatched: true,
    settlement: 'rpc_response', protocolError: { code: -32042, data: { opaque: 'original' } }, interactionProblem: 'unsupported' }); });
  for (let i = 0; i < 2; i++) await expect(f.resources.subscribe(scope, subscribe, signal())).rejects.toMatchObject({ code: 'mcp-resource-subscribe-unavailable', dispatched: true, settlement: 'rpc_response' });
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ live: false, receipt: { outcome: { kind: 'failed', error: {
    protocolError: { code: -32042, data: { opaque: 'original' } }, interactionProblem: 'unsupported' } } } });
  expect(await f.resources.release(scope, binding)).toMatchObject({ controlsDrained: true, release: { status: 'unknown' } });
  expect(f.counts().subscriptions).toBe(1);
});

it('connects actual A projections to B and reattaches from the current cursor without replay or SDK recreation', async () => {
  const { createManagedMcpResourceObserver } = await import('../kernel/managed-mcp-resource-observer.js');
  const f = fixture(), actions: string[] = [], first: McpResourceChange[] = [], second: McpResourceChange[] = [];
  const client = { async service(input: { operation: { action: ManagedMcpResourceAction } }, active: AbortSignal) {
    const action = input.operation.action; actions.push(action.kind);
    if (action.kind === 'resource_watch') return { ok: true, value: await f.resources.watch(scope, action, active), executorStopped: true };
    if (action.kind === 'resource_release') return { ok: true, value: await f.resources.release(scope, action.binding), executorStopped: true };
    throw new Error('Unexpected projection action');
  } };
  const created = await f.resources.subscribe(scope, subscribe, signal());
  const original = createManagedMcpResourceObserver({ client: client as never, address: scope, binding, ...created, onChange: event => first.push(event) });
  f.emit({ kind: 'updated', notification: { uri: binding.uri, original: true } });
  await until(() => first.length === 1);
  original.disconnect!(); f.seal();
  f.emit({ kind: 'updated', notification: { uri: binding.uri, missed: true } });
  const inspection = await f.resources.inspect(scope, binding);
  expect(inspection).toMatchObject({ live: true, revision: 2 });
  expect(actions).not.toContain('resource_release'); expect(f.counts().detaches).toBe(0);
  const replacement = createManagedMcpResourceObserver({ client: client as never, address: scope, binding,
    ...created, revision: inspection.revision, onChange: event => second.push(event) });
  expect(replacement.listenerId).not.toBe(original.listenerId);
  await Promise.resolve(); expect(second).toEqual([]);
  f.emit({ kind: 'updated', notification: { uri: binding.uri, fresh: true } });
  await until(() => second.length === 1);
  expect(first).toEqual([{ kind: 'updated', notification: { uri: binding.uri, original: true } }]);
  expect(second).toEqual([{ kind: 'updated', notification: { uri: binding.uri, fresh: true } }]);
  expect(await replacement.detach()).toEqual({ status: 'acknowledged', acknowledgement: { _meta: { unsubscribed: true } } });
  expect(f.counts()).toEqual({ views: 1, subscriptions: 1, detaches: 1 });
  expect(f.holder()?.released).toBe(true);
});

it('treats an untyped error after entering the SDK as uncertain dispatch, preserving pre-dispatch failures', async () => {
  const entered = fixture(); entered.run(async () => { throw new Error('unexpected SDK failure'); });
  await expect(entered.resources.subscribe(scope, subscribe, signal())).rejects.toMatchObject({ dispatched: true, settlement: 'unknown' });
  const before = fixture(); before.seal();
  await expect(before.resources.subscribe(scope, subscribe, signal())).rejects.toMatchObject({ dispatched: false, settlement: 'unknown' });
  await entered.resources.close(scope); await before.resources.close(scope);
});

it('direct original grant revocation fences watch delivery while receipts and cleanup remain available', async () => {
  const f = fixture(); await f.resources.subscribe(scope, subscribe, signal());
  const reading = f.resources.watch(scope, watch(), signal());
  while (f.calls.at(-1)?.method !== 'source.mcp.holder') await Promise.resolve();
  await Promise.resolve(); f.revokeGrant(); f.emit({ kind: 'updated', notification: { uri: binding.uri } });
  await expect(reading).rejects.toThrow('original_owner_revoked');
  await expect(f.resources.watch(scope, watch(), signal())).rejects.toThrow('original_owner_revoked');
  expect(await f.resources.inspect(scope, binding)).toMatchObject({ receipt: { outcome: { kind: 'subscribed' } } });
  expect(await f.resources.release(scope, binding)).toMatchObject({ controlsDrained: true });
});
