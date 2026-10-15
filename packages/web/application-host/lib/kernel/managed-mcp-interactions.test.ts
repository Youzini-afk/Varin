import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { McpSamplingRejectedError } from '../mcp/errors.js';
import type { McpInteractionRequest, McpErrorInteraction } from '../mcp/authority.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedMcpInteractionAction, ManagedMcpInteractionBody, ManagedMcpInteractionInspection } from '../harness/managed-mcp-contract.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { McpInteractionRuntime } from './mcp-interaction-runtime.js';
import type { McpInteractionBinding, McpInteractionRecord, McpServerOwner } from './protocol.generated.js';
import { createManagedMcpInteractions } from './managed-mcp-interactions.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const address = { coordinatorHostId: 'a', authorityId: 'original-source', resourceEpoch: 'epoch' };
const owner: McpServerOwner = { resource_owner: { kind: 'managed_host', hostId: 'b', connectionId: 'connection', endpointIdentity: 'target' },
  configuration: { agent_dir: '/target/agent', config_cwd: '/target/work', project_trusted: true }, execution_scope: 'workspace',
  source_authority: { coordinator_host_id: 'a', authority_id: 'original-source', resource_epoch: 'epoch' } };
const binding = (operationId = 'call'): McpInteractionBinding => ({ operationId, executionOwner: { kind: 'external', identity: 'executor', epoch: 'executor-epoch' },
  endpoint: { server: 'server', resourceKey: 'resource', configurationVersion: 'config', credentialVersion: 'grant' }, connectionId: 'actual-sdk-connection',
  source: { kind: 'server_request', requestId: operationId, relation: { kind: 'rpc_response_stream', outgoingRequestId: operationId } } });
function fixture() {
  const bodies = new Map<string, ManagedMcpInteractionBody>(), receipts = new Map<string, ManagedMcpInteractionInspection>();
  const records = new Map<string, McpInteractionRecord>(), requests = new Map<string, McpInteractionRequest>();
  const runIds = new Map<string, string>(), holds = new Map<string, Promise<void>>();
  const replies = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const calls: Array<{ kind: string; id?: string; revision?: number }> = [], errors: Error[] = [], groups: McpErrorInteraction[] = [];
  let sourceRevision = 1, watchWake: (() => void) | undefined, eventWake: (() => void) | undefined;
  let loseResponse = false, ackFailures = 0, settleFailures = 0, releaseFailures = 0, watchFailures = 0;
  const closeRecord = (row: McpInteractionRecord, availability: McpInteractionRecord['availability']) => {
    if (row.availability === 'live' || row.availability === 'rpc_closed' && row.mode === 'url'
      && row.choice === 'accept' && !row.completionReported && row.delivery !== 'not_sent') row.availability = availability;
  };
  const changed = () => { sourceRevision++; watchWake?.(); };
  const service = vi.fn(async (input: { operation: { action: ManagedMcpInteractionAction } }, signal?: AbortSignal) => {
    const action = input.operation.action;
    calls.push({ kind: action.kind, ...('deliveryId' in action ? { id: action.deliveryId } : {}), ...('revision' in action ? { revision: action.revision } : {}) });
    const held = 'deliveryId' in action ? holds.get(`${action.kind}:${action.deliveryId}`) : undefined;
    if (held) await held;
    const current = 'deliveryId' in action ? receipts.get(action.deliveryId)! : undefined;
    let value: unknown;
    switch (action.kind) {
      case 'interaction_watch':
        if (action.incarnation === 'original-incarnation' && action.after === sourceRevision) await new Promise<void>(resolve => {
          watchWake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        signal?.throwIfAborted(); if (watchFailures > 0) { watchFailures--; throw new Error('Source watch disconnected'); } value = { incarnation: 'original-incarnation', revision: sourceRevision, deliveries: [...receipts.values()] }; break;
      case 'interaction_read': value = bodies.get(action.deliveryId); break;
      case 'interaction_inspect': value = current; break;
      case 'interaction_respond': {
        const record = records.get(action.deliveryId)!;
        expect(record.delivery).toBe('sending'); // A's beforeResponse barrier preceded the only POST.
        current!.receipt.responseHash = hash(action.response); current!.receipt.delivery = 'sent'; current!.receipt.revision++;
        changed(); if (loseResponse) { loseResponse = false; throw new Error('Response committed but reply lost'); }
        value = current; break;
      }
      case 'interaction_close':
        current!.receipt.availability = action.availability; current!.receipt.revision++; value = current; changed(); break;
      case 'interaction_ack':
        if (ackFailures-- > 0) throw new Error('ACK unavailable');
        if (current!.receipt.delivery === 'sent' && current!.receipt.responseHash !== null) expect(records.get(action.deliveryId)!.delivery).toBe('sent');
        if (current!.receipt.completed) expect(records.get(action.deliveryId)!.completionReported).toBe(true);
        expect(action.revision).toBe(current!.receipt.revision); current!.receipt.acknowledgedRevision = action.revision; value = current; break;
      case 'interaction_release':
        if (releaseFailures-- > 0) throw new Error('Release unavailable');
        expect(action.revision).toBe(current!.receipt.acknowledgedRevision);
        current!.receipt.released = true; value = { ...current!, retire: false }; break;
    }
    return { ok: true as const, value: structuredClone(value), executorStopped: true as const };
  });
  const client = { service, release: vi.fn() } as unknown as ManagedSourceClient;
  const open = async (input: McpInteractionRequest, kind: 'elicitation' | 'sampling') => {
    const id = `mcp-interaction:${hash([input.binding.connectionId, input.binding.source])}`;
    calls.push({ kind: 'runtime.mcp.interaction.open', id });
    const publication = holds.get(`catalog_open:${id}`);
    if (publication) await publication;
    // The real receiver awaits Catalog publication before offering review. A late
    // managed request becomes a closed historical row, then rejects its answer.
    const availability = receipts.get(id)!.receipt.availability === 'live' ? 'live' : 'owner_unavailable';
    const row: McpInteractionRecord = { id, binding: input.binding, revision: 1, runId: runIds.get(input.binding.operationId) ?? 'run', threadId: 'thread', branchId: 'branch', mode: kind === 'sampling' ? 'sampling' : input.request.mode === 'url' ? 'url' : 'form',
      availability, choice: null, delivery: 'not_started', completionReported: false, deliveryReleased: false, problem: null };
    records.set(id, row); requests.set(id, input);
    input.beforeResponse(async () => { await input.assertLive(); row.delivery = 'sending'; });
    input.onResponseSettled((state: 'sent' | 'unknown' | 'not_sent') => { if (row.choice !== null) row.delivery = state; });
    input.onComplete(() => { row.completionReported = true; });
    input.signal.addEventListener('abort', () => { closeRecord(row, input.signal.reason === 'rpc_closed' ? 'rpc_closed' : 'connection_lost'); replies.get(id)?.reject(new Error('Closed')); });
    if (availability !== 'live') throw new Error('Original owner closed before publication');
    return new Promise<Record<string, unknown>>((resolve, reject) => { replies.set(id, { resolve, reject }); });
  };
  const receiver = vi.fn((input: McpInteractionRequest) => open(input, 'elicitation'));
  const samplingReceiver = vi.fn((input: McpInteractionRequest) => open(input, 'sampling'));
  const errorReceiver = vi.fn((group: McpErrorInteraction) => {
    groups.push(group);
    for (const item of group.items) {
      const id = `mcp-interaction:${hash([item.binding.connectionId, item.binding.source])}`;
      records.set(id, { id, binding: item.binding, revision: 1, runId: 'run', threadId: 'thread', branchId: 'branch', mode: 'url', availability: 'live',
        choice: null, delivery: null, completionReported: false, deliveryReleased: false, problem: null });
      item.onComplete(() => { records.get(id)!.completionReported = true; });
    }
  });
  const kernel = { agentRuntimeRequest: vi.fn(async (method: string, params: { operationId?: string; interactionId?: string; delivery?: 'sent' | 'unknown' | 'not_sent'; availability?: McpInteractionRecord['availability'] }) => {
    calls.push({ kind: method, ...(params.interactionId ? { id: params.interactionId } : {}) });
    const row = records.get(params.interactionId!);
    switch (method) {
      case 'runtime.operation.inspect': return { id: params.operationId, run_id: runIds.get(params.operationId!), execution_owner: binding(params.operationId).executionOwner };
      case 'runtime.mcp.interaction.pending': return structuredClone([...records.values()].filter(record => !record.deliveryReleased));
      case 'runtime.mcp.interaction.context': return { record: structuredClone(row), owner: structuredClone(owner) };
      case 'runtime.mcp.interaction.inspect': return structuredClone(row);
      case 'runtime.mcp.interaction.close': closeRecord(row!, params.availability!); break;
      case 'runtime.mcp.interaction.response.settle': if (settleFailures-- > 0) throw new Error('Catalog durable settlement unavailable'); row!.delivery = params.delivery!; break;
      case 'runtime.mcp.interaction.complete': row!.completionReported = true; break;
      case 'runtime.mcp.interaction.delivery.released': row!.deliveryReleased = true; break;
      default: throw new Error(`Unexpected ${method}`);
    }
    return structuredClone(row);
  }) } as unknown as KernelClient;
  const runtime = { coordinatorHostId: 'a', managedSource: vi.fn(async () => client), onReady: () => () => {},
    onEvent: (wake: () => void) => { eventWake = wake; return () => {}; } } as unknown as AgentRuntimeClient;
  const published = async (actual: McpInteractionBinding) => {
    const id = `mcp-interaction:${hash([actual.connectionId, actual.source])}`;
    await holds.get(`catalog_open:${id}`);
    expect(records.get(id)?.binding).toEqual(actual);
  };
  const adapter = createManagedMcpInteractions({ kernel, runtime,
    interactions: { receiver, samplingReceiver, errorReceiver, published } as unknown as McpInteractionRuntime, onError: error => errors.push(error) });
  const add = (actual = binding(), kind: 'elicitation' | 'sampling' = 'elicitation', runId = 'run') => {
    runIds.set(actual.operationId, runId);
    const id = `mcp-interaction:${hash([actual.connectionId, actual.source])}`;
    const body: ManagedMcpInteractionBody = { kind, deliveryId: id, binding: actual, request: { message: 'Original private body' } };
    bodies.set(id, body); receipts.set(id, { live: true, receipt: { deliveryId: id, binding: actual, kind, requestHash: hash(stable(body)), revision: 1,
      responseHash: null, delivery: null, availability: 'live', completed: false, acknowledgedRevision: 0, released: false } }); changed(); return id;
  };
  const ensure = (actual = binding()) => adapter.ensure({ client, address, origin: { operationId: actual.operationId, executionOwner: actual.executionOwner },
    server: { server: 'server', resource_key: 'resource', definition_version: 'config', owner }, endpoint: actual.endpoint });
  return { adapter, records, receipts, requests, replies, calls, errors, groups, receiver, samplingReceiver, errorReceiver, bodies, add, ensure, changed,
    hold(kind: ManagedMcpInteractionAction['kind'] | 'catalog_open', id: string) {
      let release!: () => void;
      const key = `${kind}:${id}`;
      holds.set(key, new Promise<void>(resolve => { release = () => { holds.delete(key); resolve(); }; }));
      return release;
    },
    wake: () => eventWake?.(), answer(id: string, value: Record<string, unknown> = { action: 'accept' }) { records.get(id)!.choice = 'accept'; replies.get(id)!.resolve(value); },
    loseResponse() { loseResponse = true; }, failAck() { ackFailures++; }, failSettle() { settleFailures++; }, failRelease() { releaseFailures++; }, failWatch() { watchFailures++; changed(); } };
}

it('registers the real Source scope, delivers concurrent original calls, and begins A delivery before one response POST', async () => {
  const f = fixture();
  try {
    const first = f.add(), second = f.add(binding('second'));
    await f.ensure(); await f.ensure(binding('second'));
    await vi.waitFor(() => expect(f.receiver).toHaveBeenCalledTimes(2));
    expect(f.requests.get(first)!.binding).not.toEqual(f.requests.get(second)!.binding);
    f.answer(first); f.answer(second, { action: 'decline' });
    await vi.waitFor(() => expect([...f.records.values()].every(row => row.deliveryReleased)).toBe(true));
    expect(f.calls.filter(call => call.kind === 'interaction_respond')).toHaveLength(2);
    expect(f.calls.filter(call => call.kind === 'interaction_read')).toHaveLength(2);
  } finally { await f.adapter.dispose(); }
});

it('inspects a lost response and retries ACK/release without posting the approved answer twice', async () => {
  const f = fixture(); f.loseResponse(); f.failAck(); f.failRelease();
  try {
    const id = f.add(); await f.ensure(); await vi.waitFor(() => expect(f.requests.has(id)).toBe(true));
    f.answer(id);
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true), { timeout: 3000 });
    expect(f.calls.filter(call => call.kind === 'interaction_respond')).toHaveLength(1);
    expect(f.records.get(id)?.delivery).toBe('sent');
    expect(f.calls.filter(call => call.kind === 'interaction_ack').length).toBeGreaterThan(1);
    expect(f.calls.filter(call => call.kind === 'interaction_release')).toHaveLength(2);
  } finally { await f.adapter.dispose(); }
});

it('reopen projects original delivery facts before ACK and closes the old receiver without reading or replaying its body', async () => {
  const f = fixture(); f.failSettle();
  try {
    const id = f.add(), receipt = f.receipts.get(id)!;
    receipt.receipt.responseHash = hash({ kind: 'result', value: { action: 'accept' } }); receipt.receipt.delivery = 'sent';
    f.records.set(id, { id, binding: receipt.receipt.binding, revision: 4, runId: 'run', threadId: 'thread', branchId: 'branch', mode: 'sampling',
      availability: 'connection_lost', choice: 'accept', delivery: 'unknown', completionReported: false, deliveryReleased: false, problem: null });
    f.adapter.start();
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true), { timeout: 3000 });
    expect(f.records.get(id)?.delivery).toBe('sent');
    expect(f.receiver).not.toHaveBeenCalled(); expect(f.samplingReceiver).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.kind === 'interaction_read' || call.kind === 'interaction_respond')).toBe(false);
    expect(f.calls.filter(call => call.kind === 'runtime.mcp.interaction.response.settle')).toHaveLength(2);
  } finally { await f.adapter.dispose(); }
});

it('keeps a reviewed sampling rejection on the actual response contract', async () => {
  const f = fixture();
  try {
    const id = f.add(binding(), 'sampling'); await f.ensure();
    await vi.waitFor(() => expect(f.samplingReceiver).toHaveBeenCalledTimes(1));
    f.records.get(id)!.choice = 'decline'; f.replies.get(id)!.reject(new McpSamplingRejectedError());
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true));
    expect(f.calls.filter(call => call.kind === 'interaction_respond')).toHaveLength(1);
  } finally { await f.adapter.dispose(); }
});

it('rejects changed endpoint or executor facts without reading a body or creating an A review', async () => {
  const f = fixture();
  try {
    const actual = binding(); actual.endpoint.credentialVersion = 'different-grant'; f.add(actual);
    await f.ensure();
    await vi.waitFor(() => expect(f.errors.some(error => error.message === 'mcp_interaction_original_binding_changed')).toBe(true));
    expect(f.receiver).not.toHaveBeenCalled(); expect(f.calls.some(call => call.kind === 'interaction_read')).toBe(false);
  } finally { await f.adapter.dispose(); }
});

it('publishes a full multi-URL error body once and retains completion received before projection', async () => {
  const f = fixture();
  try {
    const items = ['first', 'second'].map(elicitationId => {
      const actual = { ...binding(), source: { kind: 'rpc_error' as const, outgoingRequestId: 42, method: 'tools/call', elicitationId } };
      const id = f.add(actual); const inspection = f.receipts.get(id)!; inspection.receipt.kind = 'error'; inspection.receipt.completed = true;
      return { deliveryId: id, binding: actual, presentation: { mode: 'url' as const, message: elicitationId, url: `https://original.invalid/${elicitationId}`, elicitationId } };
    });
    const body: ManagedMcpInteractionBody = { kind: 'error', request: { code: -32042, message: 'Original shared error', data: { elicitations: items.map(item => item.presentation) } }, items };
    for (const item of items) { f.bodies.set(item.deliveryId, body); f.receipts.get(item.deliveryId)!.receipt.requestHash = hash(stable(body)); }
    f.changed(); await f.ensure();
    await vi.waitFor(() => expect([...f.records.values()].filter(row => row.deliveryReleased)).toHaveLength(2));
    expect(f.errorReceiver).toHaveBeenCalledTimes(1); expect(f.groups[0]!.items).toHaveLength(2);
    expect(f.groups[0]!.request).toEqual(body.request);
    expect(f.calls.some(call => call.kind === 'interaction_respond')).toBe(false);
  } finally { await f.adapter.dispose(); }
});

it('does not turn a generic SDK error into delivery of a historical reviewed answer', async () => {
  const f = fixture();
  try {
    const id = f.add(), receipt = f.receipts.get(id)!;
    receipt.live = false; receipt.receipt.availability = 'connection_lost';
    f.records.set(id, { id, binding: receipt.receipt.binding, revision: 4, runId: 'run', threadId: 'thread', branchId: 'branch', mode: 'form',
      availability: 'connection_lost', choice: 'accept', delivery: 'unknown', completionReported: false, deliveryReleased: false, problem: null });
    f.adapter.start();
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true));
    expect(f.records.get(id)?.delivery).toBe('not_sent');
    expect(f.calls.some(call => call.kind === 'interaction_respond' || call.kind === 'interaction_read')).toBe(false);
  } finally { await f.adapter.dispose(); }
});

it('shutdown aborts only the A projection and never posts or releases an undecided original request', async () => {
  const f = fixture();
  const id = f.add(); await f.ensure(); await vi.waitFor(() => expect(f.requests.has(id)).toBe(true));
  await f.adapter.dispose(); await new Promise(resolve => setTimeout(resolve, 1));
  expect(f.requests.get(id)!.signal.aborted).toBe(true);
  expect(f.calls.some(call => call.kind === 'interaction_respond' || call.kind === 'interaction_release')).toBe(false);
  expect(f.records.get(id)?.deliveryReleased).toBe(false);
});

it('retains an accepted URL completion across the finite RPC ending and releases only after its original completion', async () => {
  const f = fixture();
  try {
    const id = f.add(); const body = f.bodies.get(id)!;
    body.request.mode = 'url'; f.receipts.get(id)!.receipt.requestHash = hash(stable(body));
    await f.ensure(); await vi.waitFor(() => expect(f.requests.has(id)).toBe(true)); f.answer(id);
    await vi.waitFor(() => expect(f.records.get(id)?.delivery).toBe('sent'));
    const receipt = f.receipts.get(id)!.receipt; receipt.availability = 'rpc_closed'; receipt.revision++; f.changed();
    await vi.waitFor(() => expect(f.records.get(id)?.availability).toBe('rpc_closed'));
    expect(f.records.get(id)?.deliveryReleased).toBe(false);
    expect(f.calls.some(call => call.kind === 'interaction_release')).toBe(false);
    receipt.completed = true; receipt.revision++; f.changed();
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true));
    expect(f.calls.filter(call => call.kind === 'interaction_respond')).toHaveLength(1);
  } finally { await f.adapter.dispose(); }
});

it('a watch disconnect fences the original unanswered projection; reconnection does not replay it', async () => {
  const f = fixture();
  try {
    const id = f.add(); await f.ensure(); await vi.waitFor(() => expect(f.requests.has(id)).toBe(true));
    f.failWatch();
    await vi.waitFor(() => expect(f.requests.get(id)!.signal.aborted).toBe(true));
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true), { timeout: 2000 });
    expect(f.receiver).toHaveBeenCalledTimes(1);
    expect(f.calls.some(call => call.kind === 'interaction_respond')).toBe(false);
    expect(f.records.get(id)?.delivery).toBe('not_sent');
  } finally { await f.adapter.dispose(); }
});

it('isolates blocked original delivery work and joins only the retiring Run, retaining wakes during its flight', async () => {
  const f = fixture(), blocked = binding('blocked');
  const first = f.add(blocked, 'elicitation', 'blocked-run');
  const open = f.hold('interaction_read', first);
  let inspect: (() => void) | undefined;
  try {
    await f.ensure(blocked);
    await vi.waitFor(() => expect(f.calls.filter(call => call.kind === 'interaction_read' && call.id === first)).toHaveLength(1));
    const second = f.add(); await f.ensure();
    await vi.waitFor(() => expect(f.requests.has(second)).toBe(true));
    f.records.get(second)!.availability = 'cancelled';
    let otherReleased = false;
    const otherRelease = f.adapter.releaseSource('run').then(() => { otherReleased = true; });
    await vi.waitFor(() => expect(otherReleased).toBe(true)); await otherRelease;
    expect(f.records.get(second)?.deliveryReleased).toBe(true);
    expect(f.requests.has(first)).toBe(false);
    expect(f.calls.filter(call => call.kind === 'interaction_read' && call.id === first)).toHaveLength(1);

    // The original Run must still join its own pre-Catalog body read.
    let originalReleased = false;
    const originalRelease = f.adapter.releaseSource('blocked-run').then(() => { originalReleased = true; });
    await vi.waitFor(() => expect(f.calls.some(call => call.kind === 'runtime.operation.inspect')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(originalReleased).toBe(false);
    open(); await originalRelease;
    await vi.waitFor(() => expect(f.requests.has(first)).toBe(true));

    inspect = f.hold('interaction_inspect', first);
    const before = f.calls.filter(call => call.kind === 'interaction_inspect' && call.id === first).length;
    f.adapter.wake();
    await vi.waitFor(() => expect(f.calls.filter(call => call.kind === 'interaction_inspect' && call.id === first)).toHaveLength(before + 1));
    // This close arrived after the active pass loaded its live Catalog row.
    f.records.get(first)!.availability = 'cancelled';
    let closed = false;
    const closing = f.adapter.releaseSource('blocked-run').then(() => { closed = true; });
    f.adapter.wake(); f.adapter.wake();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(f.calls.filter(call => call.kind === 'interaction_inspect' && call.id === first)).toHaveLength(before + 1);
    inspect(); await closing;
    expect(f.records.get(first)?.deliveryReleased).toBe(true);
    expect(f.receiver).toHaveBeenCalledTimes(2);
    expect(f.calls.some(call => call.kind === 'interaction_respond')).toBe(false);
  } finally { open(); inspect?.(); await f.adapter.dispose(); }
});

it('cleans up a late managed request after asynchronous Catalog publication preserves its closed original RPC', async () => {
  const f = fixture(), id = f.add();
  const publish = f.hold('catalog_open', id);
  try {
    await f.ensure();
    await vi.waitFor(() => expect(f.receiver).toHaveBeenCalledTimes(1));
    expect(f.records.has(id)).toBe(false);
    const inspection = f.receipts.get(id)!;
    inspection.live = false; inspection.receipt.availability = 'rpc_closed'; inspection.receipt.revision++; f.changed();
    let released = false;
    const releasing = f.adapter.releaseSource('run').then(() => { released = true; });
    await vi.waitFor(() => expect(f.calls.some(call => call.kind === 'runtime.operation.inspect')).toBe(true));
    expect(released).toBe(false);
    expect(f.calls.some(call => call.kind === 'interaction_ack' || call.kind === 'interaction_release')).toBe(false);
    publish(); await releasing;
    await vi.waitFor(() => expect(f.records.get(id)?.deliveryReleased).toBe(true));
    expect(f.records.get(id)).toMatchObject({ choice: null, delivery: 'not_sent', availability: 'owner_unavailable' });
    expect(f.receiver).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.kind === 'interaction_read')).toHaveLength(1);
    expect(f.calls.some(call => call.kind === 'interaction_respond' || call.kind === 'runtime.mcp.interaction.response.begin')).toBe(false);
  } finally { publish(); await f.adapter.dispose(); }
});
