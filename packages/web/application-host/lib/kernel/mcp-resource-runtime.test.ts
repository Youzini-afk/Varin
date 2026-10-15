import { expect, it, vi } from 'vitest';
import type { KernelClient } from './kernel-client.js';
import type { McpResourcePending, McpResourceNotifyParams, McpResourceListenerParams } from './protocol.generated.js';
import { createMcpResourceRuntime, type McpResourceRuntimeOptions } from './mcp-resource-runtime.js';

it('retries an ACK-uncertain immutable local fact without another notification and resumes only after the gap is confirmed', async () => {
  let pending: McpResourcePending = {
    revision: 1, operationId: 'original:subscribe', runId: 'original:run', threadId: 'original:thread', branchId: 'original:branch', cancelRequested: false,
    subscription: {
      binding: { operationId: 'original:subscribe', executionOwner: { kind: 'external', identity: 'original:executor', epoch: 'original:epoch' },
        endpoint: { server: 'original', resourceKey: 'original:resource', configurationVersion: 'original:configuration', credentialVersion: 'original:grant' }, schemaVersion: 'original:schema', uri: 'opaque:original' },
      sourceScope: 'global', mcpHolderReleased: true, acceptanceRef: { content_object: 'accepted-ack' }, listenerId: 'old-listener', availability: 'active', localReleased: false,
      remoteCleanup: 'not_requested', lastEventCursor: null, problem: null,
    },
  };
  const publications: McpResourceNotifyParams[] = [];
  const order: string[] = [];
  const errors: Error[] = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'runtime.mcp.resource.pending': return [structuredClone(pending)];
      case 'runtime.mcp.resource.notify':
        publications.push(structuredClone(params as McpResourceNotifyParams));
        if (publications.length === 1) { order.push('accepted-ack-lost'); throw new Error('Local response lost after commit'); }
        order.push('same-fact-confirmed'); return { cursor: 19 };
      case 'runtime.mcp.resource.listener': {
        const p = params as McpResourceListenerParams;
        expect(p.expectedListenerId).toBe(pending.subscription.listenerId);
        pending = { ...pending, revision: pending.revision + 1, subscription: { ...pending.subscription,
          listenerId: p.listenerId, availability: p.availability, localReleased: p.localReleased, remoteCleanup: p.remoteCleanup, problem: p.problem } };
        return structuredClone(pending);
      }
      default: throw new Error(`Unexpected request ${method}`);
    }
  });
  const recover = vi.fn(async () => {
    order.push('original-owner-recovered');
    return { endpoint: pending.subscription.binding.endpoint, listenerId: 'new-listener', acknowledgement: {}, detach: async () => ({ status: 'acknowledged' as const, acknowledgement: {} }) };
  });
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: { onReady: () => () => {}, onEvent: () => () => {} }, recover, onError: error => errors.push(error) });
  try {
    runtime.start();
    await vi.waitFor(() => expect(pending.subscription.listenerId).toBe('new-listener'), { timeout: 2000 });
    expect(errors).toHaveLength(1);
    expect(publications).toHaveLength(2);
    expect(publications[0]).toEqual(publications[1]);
    expect(publications[0]!.kind).toBe('gap');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['accepted-ack-lost', 'same-fact-confirmed', 'original-owner-recovered']);
  } finally { await runtime.dispose(); }
});

it('reports a rejected local begin as not dispatched while keeping post-observe ACK uncertainty distinct', async () => {
  const endpoint = { server: 'original', resourceKey: 'resource', configurationVersion: 'config', credentialVersion: 'grant' };
  const owner = { kind: 'external' as const, identity: 'host', epoch: 'epoch' };
  const observeResource = vi.fn(async () => ({ endpoint, listenerId: 'listener', acknowledgement: { _meta: { accepted: true } },
    detach: async () => ({ status: 'acknowledged' as const, acknowledgement: {} }) }));
  const input = { call: { operationId: 'operation', runId: 'run' }, owner,
    lease: { resourceEndpoint: () => endpoint, observeResource }, service: { schemaVersion: 'version' },
    uri: 'opaque:uri', signal: new AbortController().signal, checkObservation: async () => {} } as unknown as Parameters<ReturnType<typeof createMcpResourceRuntime>['subscribe']>[0];
  let failBegin = true;
  const kernel = { agentRuntimeRequest: async (method: string) => {
    if (method === 'runtime.mcp.resource.begin') {
      if (failBegin) throw new Error('Original Goal no longer authorizes this observer');
      return { revision: 1, operationId: 'operation', runId: 'run', threadId: 'thread', branchId: 'branch', cancelRequested: false,
        subscription: { binding: { operationId: 'operation', executionOwner: owner, endpoint, schemaVersion: 'version', uri: input.uri },
          sourceScope: 'global', mcpHolderReleased: true, acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
    }
    if (method === 'runtime.mcp.resource.accept') throw new Error('Actual ACK publication is uncertain');
    throw new Error(`Unexpected ${method}`);
  } } as unknown as KernelClient;
  const runtime = createMcpResourceRuntime({ kernel, runtime: { onReady: () => () => {}, onEvent: () => () => {} }, recover: async () => { throw new Error('Unexpected recovery'); } });
  try {
    expect(await runtime.subscribe(input)).toEqual({ executor_stopped: true,
      completion: { kind: 'not_dispatched', reason: 'Original Goal no longer authorizes this observer' } });
    expect(observeResource).not.toHaveBeenCalled();
    failBegin = false;
    expect(await runtime.subscribe(input)).toMatchObject({ executor_stopped: true, completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
      content: { data: { operationId: 'operation', error: 'mcp_effect_unknown', reason: 'mcp_resource_ack_publication_uncertain' } } } });
    expect(observeResource).toHaveBeenCalledTimes(1);
  } finally { await runtime.dispose(); }
});

it('continues publishing the same received ACK after two local failures and observation cancellation without repeating subscribe', async () => {
  const endpoint = { server: 'original', resourceKey: 'resource', configurationVersion: 'config', credentialVersion: 'grant' };
  const owner = { kind: 'external' as const, identity: 'host', epoch: 'epoch' };
  let pending: McpResourcePending;
  const ack = { _meta: { retained: 'original' } };
  const detach = vi.fn(async () => ({ status: 'acknowledged' as const, acknowledgement: {} }));
  const observeResource = vi.fn(async () => ({ endpoint, listenerId: 'original-listener', acknowledgement: ack, detach }));
  const attempts: unknown[] = [];
  const kernel = { agentRuntimeRequest: async (method: string, params: unknown, signal?: AbortSignal) => {
    switch (method) {
      case 'runtime.mcp.resource.begin':
        pending = { revision: 1, operationId: 'operation', runId: 'run', threadId: 'thread', branchId: 'branch', cancelRequested: false,
          subscription: { binding: { operationId: 'operation', executionOwner: owner, endpoint, schemaVersion: 'version', uri: 'opaque:uri' },
            sourceScope: 'workspace', mcpHolderReleased: true, acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
        return structuredClone(pending);
      case 'runtime.mcp.resource.accept':
        attempts.push(structuredClone(params));
        if (attempts.length < 3) throw new Error('Local admission unavailable before commit');
        expect(signal?.aborted).toBe(false);
        expect(pending.cancelRequested).toBe(true);
        pending.revision++;
        pending.subscription.acceptanceRef = { content_object: 'original-ack' };
        return structuredClone(pending);
      case 'runtime.mcp.resource.release_source':
        pending.cancelRequested = true; pending.revision++;
        return [structuredClone(pending)];
      case 'runtime.mcp.resource.listener': {
        const p = params as McpResourceListenerParams;
        pending.revision++;
        Object.assign(pending.subscription, { listenerId: p.listenerId, availability: p.availability,
          localReleased: p.localReleased, remoteCleanup: p.remoteCleanup, problem: p.problem });
        return structuredClone(pending);
      }
      default: throw new Error(`Unexpected ${method}`);
    }
  } } as unknown as KernelClient;
  const runtime = createMcpResourceRuntime({ kernel, runtime: { onReady: () => () => {}, onEvent: () => () => {} },
    recover: async () => { throw new Error('A received ACK must not repeat remote subscription'); } });
  const input = { call: { operationId: 'operation', runId: 'run' }, owner,
    lease: { resourceEndpoint: () => endpoint, observeResource }, service: { schemaVersion: 'version' },
    uri: 'opaque:uri', signal: new AbortController().signal, checkObservation: async () => {} } as unknown as Parameters<typeof runtime.subscribe>[0];
  try {
    expect(await runtime.subscribe(input)).toMatchObject({ executor_stopped: true, completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown' } });
    await vi.waitFor(() => expect(attempts).toHaveLength(2));
    await runtime.releaseSource('run');
    expect(detach).toHaveBeenCalledTimes(1);
    expect(pending!.subscription).toMatchObject({ availability: 'closed', localReleased: true, acceptanceRef: null });
    await vi.waitFor(() => expect(pending.subscription.acceptanceRef).toEqual({ content_object: 'original-ack' }), { timeout: 2000 });
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toEqual(attempts[1]); expect(attempts[1]).toEqual(attempts[2]);
    expect(observeResource).toHaveBeenCalledTimes(1);
    expect(pending!.subscription).toMatchObject({ availability: 'closed', localReleased: true });
  } finally { await runtime.dispose(); }
});

it('does not regress acknowledged cleanup when an older acceptance snapshot arrives after source release', async () => {
  const endpoint = { server: 'original', resourceKey: 'resource', configurationVersion: 'config', credentialVersion: 'grant' };
  const owner = { kind: 'external' as const, identity: 'host', epoch: 'epoch' };
  let pending: McpResourcePending;
  let deliverAcceptance!: () => void;
  const heldAcceptance = new Promise<void>(resolve => { deliverAcceptance = resolve; });
  let committed!: () => void;
  const acceptanceCommitted = new Promise<void>(resolve => { committed = resolve; });
  const cleanupStates: string[] = [];
  const detach = vi.fn(async () => ({ status: 'acknowledged' as const, acknowledgement: { _meta: { original: true } } }));
  const observeResource = vi.fn(async () => ({ endpoint, listenerId: 'original-listener', acknowledgement: {}, detach }));
  const kernel = { agentRuntimeRequest: async (method: string, params: unknown) => {
    switch (method) {
      case 'runtime.mcp.resource.begin':
        pending = { revision: 1, operationId: 'operation', runId: 'run', threadId: 'thread', branchId: 'branch', cancelRequested: false,
          subscription: { binding: { operationId: 'operation', executionOwner: owner, endpoint, schemaVersion: 'version', uri: 'opaque:uri' },
            sourceScope: 'workspace', mcpHolderReleased: true, acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
        return structuredClone(pending);
      case 'runtime.mcp.resource.accept': {
        pending.revision++;
        Object.assign(pending.subscription, { acceptanceRef: { content_object: 'original-ack' }, listenerId: 'original-listener', availability: 'active', localReleased: false });
        const originalSnapshot = structuredClone(pending);
        committed();
        await heldAcceptance;
        return originalSnapshot;
      }
      case 'runtime.mcp.resource.release_source':
        pending.cancelRequested = true; pending.revision++;
        return [structuredClone(pending)];
      case 'runtime.mcp.resource.listener': {
        const p = params as McpResourceListenerParams;
        expect(p.expectedListenerId).toBe(pending.subscription.listenerId);
        pending.revision++;
        Object.assign(pending.subscription, { listenerId: p.listenerId, availability: p.availability,
          localReleased: p.localReleased, remoteCleanup: p.remoteCleanup, problem: p.problem });
        cleanupStates.push(p.remoteCleanup);
        return structuredClone(pending);
      }
      default: throw new Error(`Unexpected ${method}`);
    }
  } } as unknown as KernelClient;
  const runtime = createMcpResourceRuntime({ kernel, runtime: { onReady: () => () => {}, onEvent: () => () => {} },
    recover: async () => { throw new Error('Unexpected recovery'); } });
  const input = { call: { operationId: 'operation', runId: 'run' }, owner,
    lease: { resourceEndpoint: () => endpoint, observeResource }, service: { schemaVersion: 'version' },
    uri: 'opaque:uri', signal: new AbortController().signal, checkObservation: async () => {} } as unknown as Parameters<typeof runtime.subscribe>[0];
  try {
    const subscription = runtime.subscribe(input);
    await acceptanceCommitted;
    await runtime.releaseSource('run');
    await vi.waitFor(() => expect(pending.subscription.remoteCleanup).toBe('acknowledged'));
    expect(pending!.revision).toBe(5);
    deliverAcceptance();
    await subscription;
    expect(pending!.revision).toBe(6);
    expect(pending!.cancelRequested).toBe(true);
    expect(cleanupStates).toEqual(['not_requested', 'acknowledged', 'acknowledged']);
    expect(pending!.subscription).toMatchObject({ remoteCleanup: 'acknowledged', availability: 'closed', localReleased: true });
    expect(observeResource).toHaveBeenCalledTimes(1); expect(detach).toHaveBeenCalledTimes(1);
  } finally { deliverAcceptance(); await runtime.dispose(); }
});

function managedResource(accepted = false): McpResourcePending {
  return {
    revision: 1, operationId: 'managed:subscribe', runId: 'original:run', threadId: 'original:thread', branchId: 'original:branch', cancelRequested: false,
    subscription: {
      binding: { operationId: 'managed:subscribe', executionOwner: { kind: 'external', identity: 'original:executor', epoch: 'original:epoch' },
        endpoint: { server: 'original', resourceKey: 'original:resource', configurationVersion: 'original:configuration', credentialVersion: 'original:grant' },
        schemaVersion: 'original:schema', uri: 'opaque:original' },
      sourceScope: 'workspace', mcpHolderReleased: false, acceptanceRef: accepted ? { content_object: 'original-ack' } : null,
      listenerId: accepted ? 'original-listener' : null, availability: accepted ? 'active' : 'pending', localReleased: !accepted,
      remoteCleanup: 'not_requested', lastEventCursor: null, problem: null,
    },
  };
}
function resourcePort(initial: McpResourcePending) {
  let pending = structuredClone(initial);
  const request = vi.fn(async (method: string, params: unknown) => {
    switch (method) {
      case 'runtime.mcp.resource.pending': return pending.cancelRequested && pending.subscription.localReleased && pending.subscription.mcpHolderReleased ? [] : [structuredClone(pending)];
      case 'runtime.mcp.resource.begin':
      case 'runtime.mcp.resource.access': return structuredClone(pending);
      case 'runtime.operation.cancel': pending.cancelRequested = true; pending.revision++; return;
      case 'runtime.mcp.resource.release_source': pending.cancelRequested = true; pending.revision++; return [structuredClone(pending)];
      case 'runtime.mcp.resource.accept': {
        const p = params as { listenerId: string; content: unknown };
        pending.revision++;
        Object.assign(pending.subscription, { acceptanceRef: { content_object: 'original-ack' }, listenerId: p.listenerId,
          availability: pending.cancelRequested ? 'closed' : 'active', localReleased: pending.cancelRequested });
        return structuredClone(pending);
      }
      case 'runtime.mcp.resource.listener': {
        const p = params as McpResourceListenerParams;
        expect(p.binding).toEqual(pending.subscription.binding);
        expect(p.expectedListenerId).toBe(pending.subscription.listenerId);
        pending.revision++;
        Object.assign(pending.subscription, { listenerId: p.listenerId, availability: p.availability,
          localReleased: p.localReleased, remoteCleanup: p.remoteCleanup, problem: p.problem });
        return structuredClone(pending);
      }
      case 'runtime.mcp.resource.creation_failed': pending.revision++; return structuredClone(pending);
      case 'runtime.mcp.resource.holder_released':
        expect(params).toEqual({ binding: pending.subscription.binding });
        expect(pending.subscription).toMatchObject({ localReleased: true, availability: 'closed' });
        pending.subscription.mcpHolderReleased = true; pending.revision++;
        return structuredClone(pending);
      case 'runtime.mcp.resource.notify': return { cursor: 19 };
      default: throw new Error(`Unexpected ${method}`);
    }
  });
  return { request, current: () => pending };
}
const quietRuntime = { onReady: () => () => {}, onEvent: () => () => {} };

it('recovers an original managed subscribe receipt and retries its lost Catalog ACK without replaying creation', async () => {
  const port = resourcePort(managedResource());
  const acknowledgement = { _meta: { original: 'response' } };
  const { McpAuthorityError } = await import('../mcp/errors.js');
  const recoverCreation = vi.fn()
    .mockRejectedValueOnce(new McpAuthorityError('mcp_resource_creation_receipt_pending'))
    .mockResolvedValue({ kind: 'subscribed', listenerId: 'original-listener', acknowledgement });
  const attempts: unknown[] = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.accept') {
      attempts.push(structuredClone(params));
      if (attempts.length === 1) throw new Error('Original Catalog ACK publication failed');
    }
    return port.request(method, params);
  });
  const disconnect = vi.fn(), detach = vi.fn(async () => ({ status: 'shared' as const }));
  const recover = vi.fn(async () => ({ endpoint: port.current().subscription.binding.endpoint,
    listenerId: 'projection-listener', acknowledgement, disconnect, detach }));
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation });
  try {
    runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('projection-listener'), { timeout: 2000 });
    expect(recoverCreation).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toMatchObject({ listenerId: 'original-listener', content: acknowledgement });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(port.current().subscription.mcpHolderReleased).toBe(false);
    expect(request.mock.calls.some(([method]) => method === 'runtime.mcp.resource.begin')).toBe(false);
  } finally { await runtime.dispose(); }
  expect(disconnect).toHaveBeenCalledTimes(1); expect(detach).not.toHaveBeenCalled();
});

it('keeps an unknown original creation paused and preserves a SourceReachable wake during inspection', async () => {
  const port = resourcePort(managedResource());
  let finish!: () => void;
  const originalInspection = new Promise<null>(resolve => { finish = () => resolve(null); });
  const recoverCreation = vi.fn().mockReturnValueOnce(originalInspection).mockResolvedValueOnce(null)
    .mockResolvedValue({ kind: 'subscribed', listenerId: 'original-listener', acknowledgement: {} });
  const recover = vi.fn(async () => ({ endpoint: port.current().subscription.binding.endpoint, listenerId: 'projection',
    acknowledgement: {}, disconnect: vi.fn(), detach: async () => ({ status: 'shared' as const }) }));
  const cleanup = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: port.request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(recoverCreation).toHaveBeenCalledTimes(1));
    runtime.sourceReached(); finish();
    await vi.waitFor(() => expect(recoverCreation).toHaveBeenCalledTimes(2));
    await runtime.reconcile(); await runtime.reconcile();
    expect(recoverCreation).toHaveBeenCalledTimes(2);
    expect(port.current().subscription.acceptanceRef).toBeNull();
    expect(cleanup).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    runtime.sourceReached();
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('projection'));
    expect(recoverCreation).toHaveBeenCalledTimes(3);
  } finally { finish(); await runtime.dispose(); }
});

it('retains cancelled unaccepted cleanup when original inspection is uncertain, then publishes the ACK before release', async () => {
  const initial = managedResource(); initial.cancelRequested = true;
  const port = resourcePort(initial);
  const order: string[] = [];
  const recoverCreation = vi.fn().mockRejectedValueOnce(new Error('Original source response lost'))
    .mockResolvedValue({ kind: 'subscribed', listenerId: 'original-listener', acknowledgement: { original: true } });
  const cleanup = vi.fn(async () => { order.push('target-release'); return { status: 'unknown' as const }; });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.accept') order.push('accept');
    if (method === 'runtime.mcp.resource.holder_released') order.push('holder-ack');
    return port.request(method, params);
  });
  const recover = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(recoverCreation).toHaveBeenCalledTimes(1));
    await runtime.reconcile(); await runtime.reconcile();
    expect(cleanup).not.toHaveBeenCalled();
    expect(port.current().subscription.mcpHolderReleased).toBe(false);
    runtime.sourceReached();
    await vi.waitFor(() => expect(port.current().subscription.mcpHolderReleased).toBe(true));
    expect(order).toEqual(['accept', 'target-release', 'holder-ack']);
    expect(port.current().subscription).toMatchObject({ availability: 'closed', localReleased: true, remoteCleanup: 'unknown' });
    expect(recover).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); }
});

it('retries managed cleanup and a lost holder ACK without duplicate target release, including after Host reopen', async () => {
  const initial = managedResource(true); initial.cancelRequested = true; initial.subscription.localReleased = true;
  const port = resourcePort(initial);
  const cleanup = vi.fn().mockRejectedValueOnce(new Error('Original release response lost')).mockResolvedValue({ status: 'unknown' });
  let blockHolderAck = true;
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.holder_released' && blockHolderAck) throw new Error('Catalog holder ACK unavailable');
    return port.request(method, params);
  });
  const recover = vi.fn();
  const create = () => createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, cleanup });
  let runtime = create();
  try {
    runtime.start();
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'runtime.mcp.resource.holder_released').length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(port.current().subscription).toMatchObject({ localReleased: true, mcpHolderReleased: false, remoteCleanup: 'unknown' });
    expect(recover).not.toHaveBeenCalled();
    await runtime.dispose();
    blockHolderAck = false;
    runtime = create(); runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.mcpHolderReleased).toBe(true));
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(port.current().subscription.remoteCleanup).toBe('unknown');
    expect(recover).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); }
});

it('disconnects managed projections on gaps and disposal but uses one original cleanup hook for explicit unsubscribe', async () => {
  const port = resourcePort(managedResource(true));
  const callbacks: Array<(change: import('../mcp/authority.js').McpResourceChange) => void> = [];
  const disconnects = [vi.fn(), vi.fn(), vi.fn()];
  const detach = vi.fn(async () => ({ status: 'shared' as const }));
  const recover = vi.fn<McpResourceRuntimeOptions['recover']>(async (_op, _signal, change) => {
    const index = callbacks.length; callbacks.push(change);
    return { endpoint: port.current().subscription.binding.endpoint, listenerId: `projection:${index}`,
      acknowledgement: {}, disconnect: disconnects[index]!, detach };
  });
  const cleanup = vi.fn<NonNullable<McpResourceRuntimeOptions['cleanup']>>(async () => ({ status: 'shared' as const }));
  const create = () => createMcpResourceRuntime({ kernel: { agentRuntimeRequest: port.request } as unknown as KernelClient,
    runtime: quietRuntime, recover, cleanup });
  let runtime = create();
  try {
    runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('projection:0'));
    callbacks[0]!({ kind: 'gap' });
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('projection:1'));
    callbacks[0]!({ kind: 'updated', notification: { stale: true } });
    expect(disconnects[0]).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    expect(disconnects[1]).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled(); expect(detach).not.toHaveBeenCalled();
    runtime = create(); runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('projection:2'));
    const signal = new AbortController().signal;
    const owner = { kind: 'external' as const, identity: 'control:executor', epoch: 'control:epoch' };
    const result = await runtime.unsubscribe({ call: { operationId: 'unsubscribe', runId: 'original:run' }, owner,
      operationId: port.current().operationId, signal } as Parameters<typeof runtime.unsubscribe>[0]);
    expect(result).toMatchObject({ completion: { kind: 'result', outcome: 'succeeded', content: { data: { remoteCleanup: 'shared', localReleased: true } } } });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]![2]).toEqual({ interaction: { operationId: 'unsubscribe', executionOwner: owner }, signal });
    expect(disconnects[2]).toHaveBeenCalledTimes(1); expect(detach).not.toHaveBeenCalled();
    expect(port.request.mock.calls.filter(([method, params]) => method === 'runtime.mcp.resource.notify' && (params as McpResourceNotifyParams).kind === 'updated')).toHaveLength(0);
  } finally { await runtime.dispose(); }
});

it('preserves the original creation ACK during explicit source retirement before releasing its holder', async () => {
  const port = resourcePort(managedResource());
  const order: string[] = [];
  let finish!: () => void;
  const receipt = new Promise<{ kind: 'subscribed'; listenerId: string; acknowledgement: Record<string, unknown> }>(resolve => {
    finish = () => resolve({ kind: 'subscribed', listenerId: 'original-listener', acknowledgement: { original: true } });
  });
  const recoverCreation = vi.fn(() => receipt);
  const cleanup = vi.fn(async () => { order.push('target-release'); return { status: 'unknown' as const }; });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.accept') order.push('accept');
    if (method === 'runtime.mcp.resource.holder_released') order.push('holder-ack');
    return port.request(method, params);
  });
  const recover = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    const retirement = runtime.releaseSource('original:run');
    await vi.waitFor(() => expect(recoverCreation).toHaveBeenCalledTimes(1));
    expect(cleanup).not.toHaveBeenCalled();
    expect(port.current().subscription.mcpHolderReleased).toBe(false);
    finish(); await retirement;
    expect(order).toEqual(['accept', 'target-release', 'holder-ack']);
    expect(port.current().subscription).toMatchObject({ mcpHolderReleased: true, localReleased: true, remoteCleanup: 'unknown' });
    expect(recover).not.toHaveBeenCalled();
  } finally { finish(); await runtime.dispose(); }
});

it('closes the current managed listener when source retirement races its in-flight incarnation publication', async () => {
  const port = resourcePort(managedResource(true));
  let finish!: () => void;
  const activeReply = new Promise<void>(resolve => { finish = resolve; });
  let publishingActive = false;
  const closedListeners: Array<string | null> = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.listener') {
      const change = params as McpResourceListenerParams;
      if (change.availability === 'active') { publishingActive = true; await activeReply; }
      if (change.availability === 'closed') closedListeners.push(change.listenerId);
    }
    return port.request(method, params);
  });
  const disconnect = vi.fn(), detach = vi.fn(async () => ({ status: 'shared' as const }));
  const recover = vi.fn(async () => ({ endpoint: port.current().subscription.binding.endpoint,
    listenerId: 'new-projection', acknowledgement: {}, disconnect, detach }));
  const cleanup = vi.fn<NonNullable<McpResourceRuntimeOptions['cleanup']>>(async () => ({ status: 'shared' as const }));
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(publishingActive).toBe(true));
    const retirement = runtime.releaseSource('original:run');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(port.current().subscription.mcpHolderReleased).toBe(false);
    finish(); await retirement;
    expect(closedListeners.length).toBeGreaterThan(0);
    expect(new Set(closedListeners)).toEqual(new Set(['new-projection']));
    expect(port.current().subscription).toMatchObject({ listenerId: 'new-projection', availability: 'closed', mcpHolderReleased: true });
    expect(cleanup).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1); expect(detach).not.toHaveBeenCalled();
  } finally { finish(); await runtime.dispose(); }
});

it('reattaches in the same Host after the original subscribe response is lost and its creation ACK is recovered', async () => {
  const port = resourcePort(managedResource());
  const { binding } = port.current().subscription;
  const { McpAuthorityError } = await import('../mcp/errors.js');
  const observeResource = vi.fn(async () => { throw new McpAuthorityError('mcp_resource_original_response_lost', true); });
  const recoverCreation = vi.fn(async () => ({ kind: 'subscribed' as const, listenerId: 'original-listener', acknowledgement: {} }));
  const disconnect = vi.fn(), detach = vi.fn(async () => ({ status: 'shared' as const }));
  const recover = vi.fn(async () => ({ endpoint: binding.endpoint, listenerId: 'recovered-projection', acknowledgement: {}, disconnect, detach }));
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: port.request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation });
  const input = { call: { operationId: binding.operationId, runId: 'original:run' }, owner: binding.executionOwner,
    lease: { resourceEndpoint: () => binding.endpoint, observeResource }, service: { schemaVersion: binding.schemaVersion },
    uri: binding.uri, signal: new AbortController().signal, checkObservation: async () => {} } as unknown as Parameters<typeof runtime.subscribe>[0];
  try {
    // Admit the real original subscribe before the startup reconciliation completes.
    const initial = runtime.subscribe(input); runtime.start();
    await expect(initial).rejects.toThrow('mcp_resource_original_response_lost');
    await vi.waitFor(() => expect(port.current().subscription.listenerId).toBe('recovered-projection'));
    expect(observeResource).toHaveBeenCalledTimes(1); expect(recoverCreation).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(1);
    expect(port.current().subscription).toMatchObject({ availability: 'active', localReleased: false, mcpHolderReleased: false });
  } finally { await runtime.dispose(); }
  expect(disconnect).toHaveBeenCalledTimes(1); expect(detach).not.toHaveBeenCalled();
});

it.each([
  { code: 'original-not-dispatched', dispatched: false, settlement: 'unknown' as const },
  { code: 'original-protocol-failure', dispatched: true, settlement: 'rpc_response' as const, protocolError: { code: -32602, message: 'Invalid original URI' } },
  { code: 'original-session-expired', dispatched: true, settlement: 'session_expired' as const },
])('persists original creation failure $code before cleanup and retries only its immutable receipt', async error => {
  const port = resourcePort(managedResource());
  const attempts: unknown[] = [];
  const order: string[] = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.mcp.resource.creation_failed') {
      attempts.push(structuredClone(params)); order.push('finite-receipt');
      if (attempts.length === 1) throw new Error('Original finite failure receipt ACK lost');
    }
    if (method === 'runtime.mcp.resource.holder_released') order.push('holder-ack');
    return port.request(method, params);
  });
  const recoverCreation = vi.fn(async () => ({ kind: 'failed' as const, error }));
  const cleanup = vi.fn(async () => { order.push('target-release'); return { status: 'unknown' as const }; });
  const recover = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.mcpHolderReleased).toBe(true), { timeout: 2000 });
    expect(recoverCreation).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toEqual({ binding: port.current().subscription.binding, error });
    expect(order).toEqual(['finite-receipt', 'finite-receipt', 'target-release', 'holder-ack']);
    expect(recover).not.toHaveBeenCalled();
    expect(port.current().subscription).toMatchObject({ acceptanceRef: null, localReleased: true, remoteCleanup: 'unknown' });
  } finally { await runtime.dispose(); }
});

it('keeps dispatched unknown creation unresolved even when explicit cancellation later releases the holder', async () => {
  const port = resourcePort(managedResource());
  const recoverCreation = vi.fn(async () => ({ kind: 'failed' as const,
    error: { code: 'original-creation-unresolved', dispatched: true, settlement: 'unknown' as const } }));
  const cleanup = vi.fn(async () => ({ status: 'unknown' as const }));
  const recover = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: port.request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(recoverCreation).toHaveBeenCalledTimes(1));
    await runtime.reconcile();
    expect(cleanup).not.toHaveBeenCalled();
    expect(port.current().subscription).toMatchObject({ acceptanceRef: null, mcpHolderReleased: false });
    await runtime.releaseSource('original:run');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(port.current().subscription).toMatchObject({ localReleased: true, mcpHolderReleased: true, remoteCleanup: 'unknown' });
    expect(port.request.mock.calls.some(([method]) => ['runtime.mcp.resource.creation_failed', 'runtime.mcp.resource.accept'].includes(method))).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  } finally { await runtime.dispose(); }
});

it('finishes an original stopped Unknown cleanup duty after receipt GC without rewriting its finite receipt', async () => {
  const initial = managedResource();
  initial.subscription.availability = 'closed';
  initial.subscription.remoteCleanup = 'unknown';
  const port = resourcePort(initial);
  const recoverCreation = vi.fn(async () => ({ kind: 'cleanup_pending' as const }));
  const cleanup = vi.fn(async () => ({ status: 'unknown' as const }));
  const recover = vi.fn();
  const runtime = createMcpResourceRuntime({ kernel: { agentRuntimeRequest: port.request } as unknown as KernelClient,
    runtime: quietRuntime, recover, recoverCreation, cleanup });
  try {
    runtime.start();
    await vi.waitFor(() => expect(port.current().subscription.mcpHolderReleased).toBe(true));
    expect(port.current().cancelRequested).toBe(false);
    expect(port.current().subscription).toMatchObject({ acceptanceRef: null, availability: 'closed', localReleased: true, remoteCleanup: 'unknown' });
    expect(recoverCreation).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1); expect(recover).not.toHaveBeenCalled();
    expect(port.request.mock.calls.some(([method]) => ['runtime.mcp.resource.creation_failed', 'runtime.mcp.resource.accept'].includes(method))).toBe(false);
    expect(port.request.mock.calls.filter(([method]) => method === 'runtime.mcp.resource.holder_released')).toHaveLength(1);
  } finally { await runtime.dispose(); }
});
