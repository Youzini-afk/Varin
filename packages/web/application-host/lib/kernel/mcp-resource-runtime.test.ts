import { expect, it, vi } from 'vitest';
import type { KernelClient } from './kernel-client.js';
import type { McpResourcePending, McpResourceNotifyParams, McpResourceListenerParams } from './protocol.generated.js';
import { createMcpResourceRuntime } from './mcp-resource-runtime.js';

it('retries an ACK-uncertain immutable local fact without another notification and resumes only after the gap is confirmed', async () => {
  let pending: McpResourcePending = {
    revision: 1, operationId: 'original:subscribe', runId: 'original:run', threadId: 'original:thread', branchId: 'original:branch', cancelRequested: false,
    subscription: {
      binding: { operationId: 'original:subscribe', executionOwner: { kind: 'external', identity: 'original:executor', epoch: 'original:epoch' },
        endpoint: { server: 'original', resourceKey: 'original:resource', configurationVersion: 'original:configuration', credentialVersion: 'original:grant' }, schemaVersion: 'original:schema', uri: 'opaque:original' },
      sourceScope: 'global', acceptanceRef: { content_object: 'accepted-ack' }, listenerId: 'old-listener', availability: 'active', localReleased: false,
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
          sourceScope: 'global', acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
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
            sourceScope: 'workspace', acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
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
            sourceScope: 'workspace', acceptanceRef: null, listenerId: null, availability: 'pending', localReleased: true, remoteCleanup: 'not_requested', lastEventCursor: null, problem: null } };
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
