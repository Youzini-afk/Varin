import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { McpSamplingRejectedError } from '../mcp/errors.js';
import type { McpInteractionRequest, McpErrorInteractionItem } from '../mcp/authority.js';
import type { McpInteractionBinding, SourceMcpDeliveryParams, SourceMcpDeliveryReceipt, SourceMcpDeliveryResult, SourceMcpHolderBinding } from '../kernel/protocol.generated.js';
import type { ManagedMcpInteractionAction, ManagedMcpInteractionInspection, ManagedMcpInteractionSnapshot } from './managed-mcp-contract.js';
import { createManagedMcpInteractions, type ManagedMcpInteractionScope } from './managed-mcp-interactions.js';

const scope: ManagedMcpInteractionScope = { principal: { principalId: 'coordinator-principal', capabilities: ['filesystem:read'] },
  coordinatorHostId: 'coordinator-host', authorityId: 'original-source', resourceEpoch: 'target-epoch' };
const signal = () => new AbortController().signal;
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function binding(id = 'request'): McpInteractionBinding {
  return { operationId: 'a-operation', executionOwner: { kind: 'external', identity: 'target', epoch: 'target-epoch' },
    endpoint: { server: 'peer', resourceKey: 'original-daemon', configurationVersion: 'definition', credentialVersion: 'credential' },
    connectionId: 'actual-sdk-client', source: { kind: 'server_request', requestId: id, relation: { kind: 'rpc_response_stream', outgoingRequestId: 'parent-rpc' } } };
}
const id = (binding: McpInteractionBinding) => `mcp-interaction:${createHash('sha256').update(JSON.stringify([binding.connectionId, binding.source])).digest('hex')}`;
function receiver(selected = binding(), request: Record<string, unknown> = { message: 'Review', requestedSchema: { type: 'object', properties: {} } }) {
  const controller = new AbortController(), before: Array<() => void | Promise<void>> = [], settled: Array<(state: 'sent' | 'not_sent' | 'unknown') => void> = [];
  let done: (() => void) | undefined, lost: (() => void) | undefined, attached = 0, detached = 0, assertCount = 0;
  const input: McpInteractionRequest = { binding: selected, request, signal: controller.signal,
    assertLive: async () => { assertCount++; controller.signal.throwIfAborted(); },
    beforeResponse: (callback: () => void | Promise<void>) => { before.push(callback); }, onResponseSettled: (callback: (state: 'sent' | 'not_sent' | 'unknown') => void) => { settled.push(callback); },
    onComplete: (callback, unavailable) => { done = callback; lost = unavailable; attached++;
      return () => { if (done || lost) { detached++; done = undefined; lost = undefined; } }; } };
  // Controlled owner callbacks, not an SDK replacement: tests explicitly supply the SDK facts.
  const drive = async (answer: Promise<unknown>, send: () => Promise<'sent' | 'unknown'> = async () => 'sent') => {
    let value: unknown, error: unknown, state: 'sent' | 'not_sent' | 'unknown' = 'not_sent';
    try { value = await answer; } catch (caught) { error = caught; }
    try { for (const callback of before) await callback(); state = await send(); }
    catch { state = 'not_sent'; }
    for (const callback of settled) callback(state);
    return { value, error, state };
  };
  return { input, drive, controller, complete: () => done?.(), unavailable: () => lost?.(),
    registrations: () => ({ before: before.length, settled: settled.length, attached, detached, assertCount }) };
}
function fixture() {
  const rows = new Map<string, SourceMcpDeliveryReceipt>(), commands: SourceMcpDeliveryParams[] = [];
  let blockedOpen: Promise<void> | undefined, lostAck: SourceMcpDeliveryParams['action'] | undefined, deniedAction: SourceMcpDeliveryParams['action'] | undefined;
  let grantState: SourceMcpDeliveryResult['grantState'] = 'active', readDenied = false, phase: SourceMcpDeliveryResult['phase'] = 'ready';
  const key = (p: { principalId: string; coordinatorHostId: string; authorityId: string; resourceEpoch: string; deliveryId: string }) =>
    JSON.stringify([p.principalId, p.coordinatorHostId, p.authorityId, p.resourceEpoch, p.deliveryId]);
  const deny = (message: string): never => { throw Object.assign(new Error(message), { code: 'forbidden' }); };
  const kernel = { async sourceRequest(_method: string, p: SourceMcpDeliveryParams) {
    commands.push(structuredClone(p));
    if (p.action === 'open') await blockedOpen;
    if (deniedAction === p.action) { deniedAction = undefined; deny('native action denied'); }
    const address = key(p); let row = rows.get(address), dispatch = false;
    const created = !row;
    if (row && JSON.stringify(row.binding) !== JSON.stringify(p.binding)) deny('binding changed');
    if (!row) {
      if (p.action !== 'open') return deny('original unavailable');
      row = { deliveryId: p.deliveryId, binding: structuredClone(p.binding), kind: p.kind, requestHash: p.requestHash,
        revision: 1, responseHash: null, delivery: null, availability: 'live', completed: false, acknowledgedRevision: 0, released: false,
        ...(p.cleanupHolder ? { cleanupHolder: structuredClone(p.cleanupHolder) } : {}) };
      rows.set(address, row);
    }
    let changed = false;
    switch (p.action) {
      case 'open': if (row.kind !== p.kind || row.requestHash !== p.requestHash) deny('request changed'); break;
      case 'inspect': break;
      case 'begin':
        if (row.responseHash && row.responseHash !== p.responseHash) deny('response changed');
        if (!row.responseHash) {
          if (grantState !== 'active' || row.released || row.completed || row.availability !== 'live') deny('not live');
          row.responseHash = p.responseHash; row.delivery = 'sending'; dispatch = true; changed = true;
        } break;
      case 'settle':
        if (!row.responseHash) deny('unadmitted');
        if (row.delivery !== p.delivery) { row.delivery = p.delivery; changed = true; } break;
      case 'close': if (row.availability !== p.availability) { row.availability = p.availability; changed = true; } break;
      case 'complete': if (!row.completed) { row.completed = true; changed = true; } break;
      case 'ack': if (p.revision > row.revision) deny('future ack'); row.acknowledgedRevision = Math.max(row.acknowledgedRevision, p.revision); break;
      case 'release':
        if (row.revision !== p.revision || row.acknowledgedRevision < row.revision) deny('stale ack');
        row.released = true; break;
    }
    if (changed) row.revision++;
    if (lostAck === p.action) { lostAck = undefined; throw new Error('native ACK lost'); }
    return { receipt: structuredClone(row), dispatch, created, grantState, phase };
  } };
  const errors: Error[] = [], authorizations: ManagedMcpInteractionScope[] = [];
  const create = () => createManagedMcpInteractions({ kernel: kernel as never,
    authorizeRead: async selected => { authorizations.push(selected); if (readDenied) deny('read withdrawn'); }, onError: error => errors.push(error) });
  const owner = create(); owner.bind(scope);
  const request = (action: ManagedMcpInteractionAction, selected = scope, ownerSignal = signal()) => owner.request(selected, action, ownerSignal);
  const inspect = async (b: McpInteractionBinding = binding()) => await request({ kind: 'interaction_inspect', deliveryId: id(b), binding: b }) as ManagedMcpInteractionInspection;
  return { owner, create, request, inspect, commands, errors, authorizations, kernel,
    blockOpen: (work: Promise<void> | undefined) => { blockedOpen = work; }, loseAck: (action: typeof lostAck) => { lostAck = action; },
    denyOnce: (action: typeof deniedAction) => { deniedAction = action; },
    denyRead: () => { readDenied = true; }, revoke: () => { grantState = 'revoked'; }, phase: (next: typeof phase) => { phase = next; } };
}
const respond = (b = binding(), response: Extract<ManagedMcpInteractionAction, { kind: 'interaction_respond' }>['response'] = { kind: 'result', value: { action: 'accept' } }): ManagedMcpInteractionAction =>
  ({ kind: 'interaction_respond', deliveryId: id(b), binding: b, response });
async function ackRelease(f: ReturnType<typeof fixture>, b = binding()) {
  const current = await f.inspect(b);
  await f.request({ kind: 'interaction_ack', deliveryId: id(b), binding: b, revision: current.receipt.revision });
  return f.request({ kind: 'interaction_release', deliveryId: id(b), binding: b, revision: current.receipt.revision });
}

it('binds each original principal/address and registers SDK hooks before opening or exposing bodies', async () => {
  const f = fixture(), original = receiver(), held = gate(); f.blockOpen(held.promise);
  const answer = f.owner.receive(scope, original.input, 'elicitation'), driven = original.drive(answer);
  expect(original.registrations()).toMatchObject({ before: 1, settled: 1, attached: 1 });
  expect(f.commands).toEqual([]);
  expect(await f.request({ kind: 'interaction_watch', after: 0 })).toMatchObject({ deliveries: [] });
  held.resolve(); await tick();
  for (const other of [{ ...scope, principal: { ...scope.principal, principalId: 'intruder' } },
    { ...scope, authorityId: 'other-source' }, { ...scope, resourceEpoch: 'other-epoch' }, { ...scope, coordinatorHostId: 'other-host' }]) {
    await expect(f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }, other)).rejects.toThrow('original unavailable');
  }
  await expect(f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: { ...binding(), operationId: 'another-operation' } })).rejects.toThrow('binding_changed');
  await f.request(respond()); expect((await driven).state).toBe('sent');
  expect(await ackRelease(f)).toMatchObject({ receipt: { released: true }, live: false, retire: false });
  expect(original.registrations().detached).toBe(1);
});

it('keeps one complete error body and completions arriving before the native open ACK', async () => {
  const f = fixture(), held = gate(); f.blockOpen(held.promise);
  const one = receiver({ ...binding(), source: { kind: 'rpc_error', outgoingRequestId: 'parent', method: 'tools/call', elicitationId: 'one' } });
  const two = receiver({ ...binding(), source: { kind: 'rpc_error', outgoingRequestId: 'parent', method: 'tools/call', elicitationId: 'two' } });
  const items = [one, two].map((source, index): McpErrorInteractionItem => ({ ...source.input,
    presentation: { mode: 'url', message: `Review ${index}`, url: `https://peer.invalid/${index}?private=opaque`, elicitationId: index ? 'two' : 'one' } }));
  const request = { code: -32042, message: 'Both URLs', data: { elicitations: items.map(item => item.presentation), private: 'entire error' } };
  f.owner.receiveError(scope, { request, items });
  expect(one.registrations().attached).toBe(1); expect(two.registrations().attached).toBe(1);
  one.complete(); held.resolve(); await tick();
  const body = await f.request({ kind: 'interaction_read', deliveryId: id(one.input.binding), binding: one.input.binding });
  expect(body).toMatchObject({ kind: 'error', request, items: [{ binding: one.input.binding }, { binding: two.input.binding }] });
  expect((await f.inspect(one.input.binding)).receipt.completed).toBe(true);
  await f.request({ kind: 'interaction_close', deliveryId: id(two.input.binding), binding: two.input.binding, availability: 'rpc_closed' });
  two.complete(); await tick(); expect((await f.inspect(two.input.binding)).receipt.completed).toBe(true);
  await ackRelease(f, one.input.binding); await ackRelease(f, two.input.binding);
  expect(two.registrations().detached).toBe(1);
});

it('latches one answer across duplicates and HTTP cancellation while only the SDK establishes sent', async () => {
  const f = fixture(), original = receiver(), sending = gate(), entered = gate();
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation'), async () => { entered.resolve(); await sending.promise; return 'sent'; });
  await tick(); const transport = new AbortController();
  const first = f.request(respond(), scope, transport.signal), same = f.request(respond());
  await entered.promise; transport.abort('A lost its HTTP response');
  await expect(f.request(respond(binding(), { kind: 'result', value: { action: 'decline' } }))).rejects.toThrow('response_changed');
  expect((await f.inspect()).receipt.delivery).toBe('sending');
  sending.resolve();
  expect(await first).toMatchObject({ receipt: { delivery: 'sent' } }); expect(await same).toEqual(await first);
  expect((await driven).state).toBe('sent'); expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(1);
  expect(original.registrations().assertCount).toBe(2);
  // Simulate a lost successful HTTP ACK: exact inspect recalls its fact without another responder call.
  expect(await f.inspect()).toMatchObject({ receipt: { delivery: 'sent' } });
  await ackRelease(f);
});

it('does not send after cancellation wins the original beforeResponse race', async () => {
  const f = fixture(), original = receiver(); let writes = 0;
  const answer = f.owner.receive(scope, original.input, 'elicitation'); await tick();
  const response = f.request(respond()); await tick(); original.controller.abort('cancelled');
  const driven = original.drive(answer, async () => { writes++; return 'sent'; });
  expect(await response).toMatchObject({ receipt: { availability: 'cancelled', responseHash: null, delivery: null } });
  expect((await driven).state).toBe('not_sent'); expect(writes).toBe(0); await ackRelease(f);
});

it('a lost begin ACK never grants a second send and actual SDK not_sent replaces Sending', async () => {
  const f = fixture(), original = receiver(); let writes = 0; f.loseAck('begin');
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation'), async () => { writes++; return 'sent'; });
  await tick();
  expect(await f.request(respond())).toMatchObject({ receipt: { delivery: 'not_sent' } });
  expect((await driven).state).toBe('not_sent'); expect(writes).toBe(0);
  expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(1); await ackRelease(f);
});

it('retains URL completion past rpc_closed and preserves the actual sampling rejection class', async () => {
  const f = fixture(), original = receiver(binding('url'), { mode: 'url', url: 'https://peer.invalid/flow?private=body', message: 'Review', elicitationId: 'url' });
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation'));
  await tick(); await f.request(respond(original.input.binding)); await driven;
  original.controller.abort('rpc_closed'); await tick(); original.complete(); await tick();
  expect(await f.inspect(original.input.binding)).toMatchObject({ live: true, receipt: { completed: true, availability: 'rpc_closed', delivery: 'sent' } });
  await ackRelease(f, original.input.binding);
  const sampling = receiver(binding('sampling'), { messages: [], maxTokens: 32 });
  const sampled = sampling.drive(f.owner.receive(scope, sampling.input, 'sampling'));
  await tick(); await f.request(respond(sampling.input.binding, { kind: 'sampling_rejected' }));
  expect((await sampled).error).toBeInstanceOf(McpSamplingRejectedError); await ackRelease(f, sampling.input.binding);
});

it('withdraws body/watch access but permits exact receipt ACK cleanup without exposing bodies', async () => {
  const f = fixture(), original = receiver();
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation')); await tick();
  await f.request(respond()); await driven;
  const snapshot = await f.request({ kind: 'interaction_watch', after: 0 }) as ManagedMcpInteractionSnapshot;
  expect(snapshot.deliveries).toHaveLength(1); expect(JSON.stringify(snapshot)).not.toContain('requestedSchema');
  const waiting = f.request({ kind: 'interaction_watch', incarnation: snapshot.incarnation, after: snapshot.revision });
  await tick(); f.denyRead(); original.complete();
  await expect(waiting).rejects.toThrow('read withdrawn'); f.revoke();
  await expect(f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() })).rejects.toThrow('read withdrawn');
  expect(await f.inspect()).toMatchObject({ receipt: { delivery: 'sent' } });
  await ackRelease(f);
});

it('recalls old-heap Sending as Unknown without reconstructing bodies or replaying responses', async () => {
  const f = fixture(), original = receiver(), sending = gate<'sent' | 'unknown'>(), entered = gate();
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation'), async () => { entered.resolve(); return sending.promise; });
  await tick(); const response = f.request(respond()); await entered.promise;
  const reopened = f.create(); reopened.bind(scope);
  const inspect: ManagedMcpInteractionAction = { kind: 'interaction_inspect', deliveryId: id(binding()), binding: binding() };
  expect(await reopened.request(scope, inspect, signal())).toMatchObject({ live: false, receipt: { delivery: 'unknown', availability: 'connection_lost' } });
  await expect(reopened.request(scope, { ...inspect, kind: 'interaction_read' }, signal())).rejects.toThrow('original_transport_unavailable');
  await expect(reopened.request(scope, respond(), signal())).rejects.toThrow('original_transport_unavailable');
  expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(1);
  sending.resolve('unknown'); await driven; await response; await ackRelease(f);
});

it('routes the actual managed service callback only under its exact original contribution scope', async () => {
  const { createManagedMcpService } = await import('./managed-mcp-service.js');
  const f = fixture();
  const local: import('./managed-remote-types.js').ManagedSourceLocalScope = { ...scope,
    principal: { ...scope.principal, capabilities: ['filesystem:read', 'terminal:use', 'process:control'] },
    scope: { kind: 'run', runId: 'run', threadId: 'thread', epoch: 1 },
    source: { resource_owner: { kind: 'managed_host', hostId: 'target', connectionId: 'connection', endpointIdentity: 'endpoint' },
      workspace_id: 'workspace', execution_workspace_id: 'child', mode: 'materialized', branch_id: 'branch', revision: 4, live_root: null },
    physicalRoot: { hostId: 'target', canonicalRoot: '/target/child', rootId: 'root' }, grant: {} as never };
  let originalScope!: import('../mcp/authority.js').McpAuthorityScope, forwarded: unknown;
  const service = createManagedMcpService({ hostId: 'target', agentDir: '/target/agent', kernel: {
    sourceRequest: async (method: string, params: SourceMcpDeliveryParams) => method === 'source.authority.inspect'
      ? { purpose: 'mcp_owner', source: local.source } : f.kernel.sourceRequest(method, params),
  } as never,
    admitSource: async () => {}, admitWorkspaceRegistration: async () => ({ canonicalPath: '/target/project' }), projectTrusted: () => true,
    compositions: { async observe(selected) { originalScope = selected;
      return { release() {}, async releaseAndDrain() {}, snapshot() {
        return { binding: { tools: [], servers: [], readiness: {}, serverSelections: [], provenance: { servers: {} }, reference: 'original', generation: 1 },
          implementationIdentity: 'original-sdk', release() {}, revocationSignal: signal,
          async callTool(_name: string, _args: unknown, options: { beforeDispatch?: () => Promise<void>; interaction?: unknown }) {
            await options.beforeDispatch?.(); forwarded = options.interaction; return { content: [] };
          } } as unknown as import('../mcp/authority.js').McpAuthorityLease;
      } } as import('../mcp/authority.js').McpCompositionScope;
    } },
  });
  expect(await service.request(local, { kind: 'snapshot', handleId: 'view', creationRequestId: 'creation' })).toMatchObject({ ok: true });
  for (const foreign of [
    { ...originalScope, sourceAuthority: { ...originalScope.sourceAuthority!, authority_id: 'another-source' } },
    { ...originalScope, resourceOwner: { kind: 'local' as const } },
    { ...originalScope, environmentId: originalScope.environmentId.replace('coordinator-principal', 'another-principal') },
  ]) {
    const rejected = receiver(binding('foreign'));
    expect(() => service.receiveInteraction(foreign, rejected.input)).toThrow('original_interaction_owner_unavailable');
    expect(rejected.registrations()).toMatchObject({ before: 0, settled: 0, attached: 0 });
  }
  const actual = receiver(), driven = actual.drive(service.receiveInteraction(originalScope, actual.input)); await tick();
  expect(await service.request(local, { kind: 'interaction_watch', after: 0 })).toMatchObject({ ok: true, value: { deliveries: [{ live: true }] } });
  expect(await service.request(local, { kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }))
    .toMatchObject({ ok: true, value: { kind: 'elicitation', request: actual.input.request } });
  expect(await service.request(local, respond())).toMatchObject({ ok: true, value: { receipt: { delivery: 'sent' } } }); await driven;
  const origin = { operationId: 'actual-origin', executionOwner: binding().executionOwner };
  expect(await service.request(local, { kind: 'call', handleId: 'view', name: 'tool', schemaVersion: 'version', arguments: {}, interaction: origin })).toMatchObject({ ok: true });
  expect(forwarded).toEqual(origin);
  await service.release(local);
  expect(() => service.receiveInteraction(originalScope, receiver(binding('late')).input)).toThrow('original_interaction_owner_unavailable');
  expect(await service.request(local, { kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }))
    .toMatchObject({ ok: true, value: { kind: 'elicitation', request: actual.input.request } });
  const inspected = await service.request(local, { kind: 'interaction_inspect', deliveryId: id(binding()), binding: binding() });
  if (!inspected.ok) throw new Error('Expected original receipt');
  const revision = (inspected.value as ManagedMcpInteractionInspection).receipt.revision;
  await service.request(local, { kind: 'interaction_ack', deliveryId: id(binding()), binding: binding(), revision });
  expect(await service.request(local, { kind: 'interaction_release', deliveryId: id(binding()), binding: binding(), revision }))
    .toMatchObject({ ok: true, value: { receipt: { released: true }, retire: false } });
});

it('retries only the original factual settlement after its native ACK is lost', async () => {
  const f = fixture(), original = receiver(); f.loseAck('settle');
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation')); await tick();
  expect(await f.request(respond())).toMatchObject({ receipt: { delivery: 'sent' } }); await driven;
  expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(1);
  expect(f.commands.filter(command => command.action === 'settle')).toHaveLength(2);
  expect(f.errors).toHaveLength(1); await ackRelease(f);
});

it('fences a recalled unanswered receipt instead of attaching a new heap responder or completion', async () => {
  const f = fixture(), original = receiver();
  const originalDriven = original.drive(f.owner.receive(scope, original.input, 'elicitation')); await tick();
  expect(() => f.owner.receive(scope, receiver().input, 'elicitation')).toThrow('conflict');
  const reopened = f.create(); reopened.bind(scope);
  const replay = receiver(); let writes = 0;
  const replayAnswer = reopened.receive(scope, replay.input, 'elicitation');
  replay.complete(); // A synchronous completion must not gain authority before open is confirmed.
  const replayDriven = replay.drive(replayAnswer, async () => { writes++; return 'sent'; });
  expect(await replayDriven).toMatchObject({ error: { code: 'mcp_interaction_original_transport_unavailable' }, state: 'not_sent' });
  await tick();
  expect(replay.registrations().detached).toBe(1);
  expect((await f.inspect()).receipt).toMatchObject({ completed: false, responseHash: null, delivery: null });
  await expect(reopened.request(scope, respond(), signal())).rejects.toThrow('original_transport_unavailable');
  expect(await reopened.request(scope, { kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }, signal()))
    .toMatchObject({ kind: 'elicitation', request: original.input.request });
  expect(await reopened.request(scope, { kind: 'interaction_inspect', deliveryId: id(binding()), binding: binding() }, signal()))
    .toMatchObject({ live: false, receipt: { completed: false, availability: 'connection_lost' } });
  expect(writes).toBe(0);
  expect(f.commands.filter(command => command.action === 'begin' || command.action === 'complete')).toHaveLength(0);
  original.controller.abort('connection_lost'); await originalDriven; await ackRelease(f);
});

it('fails an uncertain original open ACK closed without replaying its response', async () => {
  const f = fixture(), original = receiver(); let writes = 0; f.loseAck('open');
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation'), async () => { writes++; return 'sent'; });
  expect(await driven).toMatchObject({ error: { code: 'mcp_interaction_original_transport_unavailable' }, state: 'not_sent' });
  expect(f.commands.filter(command => command.action === 'open')).toHaveLength(2);
  expect(await f.inspect()).toMatchObject({ live: false, receipt: { availability: 'connection_lost', responseHash: null, delivery: null } });
  expect(await f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }))
    .toMatchObject({ kind: 'elicitation', request: original.input.request });
  await expect(f.request(respond())).rejects.toThrow('original_transport_unavailable');
  expect(writes).toBe(0); expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(0);
  expect(await ackRelease(f)).toMatchObject({ receipt: { released: true } });
  await expect(f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }))
    .rejects.toThrow('original_transport_unavailable');
});

it('keeps a cross-Operation unsubscribe owner separate from its original subscription holder', async () => {
  const f = fixture(), subscribed = binding('subscribe');
  const holder: SourceMcpHolderBinding = { operationId: subscribed.operationId, executionOwner: subscribed.executionOwner,
    endpoint: subscribed.endpoint, purpose: 'resource_observer' };
  const control = { ...binding('unsubscribe'), operationId: 'unsubscribe-operation',
    executionOwner: { kind: 'external' as const, identity: 'later-run', epoch: 'later-owner-epoch' } };
  const unregister = f.owner.registerCleanup(scope, control, holder);
  expect(() => f.owner.registerCleanup(scope, control, { ...holder, operationId: 'another-subscription' })).toThrow('cleanup_changed');
  const selected = receiver(control), foreign = receiver({ ...control, executionOwner: subscribed.executionOwner, source: binding('other').source });
  const selectedDriven = selected.drive(f.owner.receive(scope, selected.input, 'elicitation'));
  const foreignDriven = foreign.drive(f.owner.receive(scope, foreign.input, 'elicitation'));
  await tick();
  expect(f.commands.find(command => command.action === 'open' && command.deliveryId === id(control)))
    .toMatchObject({ binding: control, cleanupHolder: holder });
  expect(f.commands.find(command => command.action === 'open' && command.deliveryId === id(foreign.input.binding)))
    .not.toHaveProperty('cleanupHolder');
  unregister();
  await f.owner.close(scope); await Promise.all([selectedDriven, foreignDriven]);
  await ackRelease(f, control); await ackRelease(f, foreign.input.binding);
});

it.each([false, true])('retains authorized original bodies until exact ACK after owner close (failed drain: %s)', async failedDrain => {
  const f = fixture(), original = receiver();
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation')); await tick();
  await f.request(respond()); await driven;
  const before = await f.inspect();
  await f.request({ kind: 'interaction_ack', deliveryId: id(binding()), binding: binding(), revision: before.receipt.revision });
  original.complete(); await tick();
  if (failedDrain) f.denyOnce('close');
  const closing = f.owner.close(scope);
  if (failedDrain) await expect(closing).rejects.toThrow('native action denied');
  else await closing;
  expect(await f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() }))
    .toMatchObject({ kind: 'elicitation', request: original.input.request });
  const snapshot = await f.request({ kind: 'interaction_watch', after: 0 }) as ManagedMcpInteractionSnapshot;
  expect(snapshot).toMatchObject({ deliveries: [{ live: false, receipt: { delivery: 'sent', completed: true, released: false } }] });
  const watching = new AbortController(); let unchangedReturned = false;
  const unchanged = f.request({ kind: 'interaction_watch', incarnation: snapshot.incarnation, after: snapshot.revision }, scope, watching.signal);
  void unchanged.then(() => { unchangedReturned = true; }, () => {});
  await tick(); expect(unchangedReturned).toBe(false);
  watching.abort(new Error('watch cancelled')); await expect(unchanged).rejects.toThrow('watch cancelled');
  await expect(f.request(respond())).rejects.toMatchObject({ dispatched: true, settlement: 'rpc_response' });
  await expect(f.request({ kind: 'interaction_release', deliveryId: id(binding()), binding: binding(), revision: before.receipt.revision }))
    .rejects.toThrow('acknowledgement_changed');
  if (failedDrain) await f.owner.close(scope);
  expect((await f.inspect()).receipt).toMatchObject({ responseHash: before.receipt.responseHash, delivery: 'sent', availability: 'owner_unavailable' });
  f.revoke();
  await expect(f.request({ kind: 'interaction_read', deliveryId: id(binding()), binding: binding() })).rejects.toThrow('owner_revoked');
  await expect(f.request({ kind: 'interaction_watch', after: 0 })).rejects.toThrow('owner_revoked');
  expect(await ackRelease(f)).toMatchObject({ live: false, receipt: { released: true, delivery: 'sent' } });
});


it('preserves original delivery flags when a replay callback settles not_sent', async () => {
  const f = fixture(), original = receiver();
  const driven = original.drive(f.owner.receive(scope, original.input, 'elicitation')); await tick();
  await f.request(respond()); await driven;
  const reopened = f.create(); reopened.bind(scope);
  const replay = receiver(); let writes = 0;
  expect(await replay.drive(reopened.receive(scope, replay.input, 'elicitation'), async () => { writes++; return 'sent'; }))
    .toMatchObject({ state: 'not_sent' });
  await expect(reopened.request(scope, respond(), signal()))
    .rejects.toMatchObject({ dispatched: true, settlement: 'rpc_response' });
  const inspection = await reopened.request(scope, { kind: 'interaction_inspect', deliveryId: id(binding()), binding: binding() }, signal()) as ManagedMcpInteractionInspection;
  expect(inspection).toMatchObject({ live: false, receipt: { delivery: 'sent', availability: 'connection_lost' } });
  expect(writes).toBe(0); expect(f.commands.filter(command => command.action === 'begin')).toHaveLength(1);
  await reopened.request(scope, { kind: 'interaction_ack', deliveryId: id(binding()), binding: binding(), revision: inspection.receipt.revision }, signal());
  await reopened.request(scope, { kind: 'interaction_release', deliveryId: id(binding()), binding: binding(), revision: inspection.receipt.revision }, signal());
  await ackRelease(f);
});
