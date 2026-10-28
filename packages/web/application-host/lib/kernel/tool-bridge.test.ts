import { expect, it } from 'vitest';
import type { McpBinding, SourceMcpChildBinding } from './protocol.generated.js';
import { HostToolAdmissionError } from './tool-admission.js';
import { leafHostComposition } from './host-composition.test-helper.js';
import {
  ToolBridge,
  type HostToolLease,
  type LiveHostToolBinding,
  type PrivateToolFrame,
  type HostToolCall,
} from './tool-bridge.js';
const schema = {
  name: 'query',
  version: '1',
  description: 'Fixture query',
  schema: { type: 'object' },
  output_schema: null,
  metadata: null,
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const call: HostToolCall = {
  outputVisibleBytes: 32768,
  runId: 'run',
  origin: { kind: 'model_step', request_id: 'request' },
  operationId: 'request:tool:call',
  callId: 'call',
  name: 'query',
  schemaVersion: '1',
  arguments: {},
};
function fixture(childModels?: ConstructorParameters<typeof ToolBridge>[5]) {
  let epoch: string | null = 'epoch';
  const frames: PrivateToolFrame[] = [],
    released: string[] = [],
    effects: string[] = [],
    childReleaseErrors: unknown[] = [];
  let acknowledge = true;
  const bridge = new ToolBridge(
    () => epoch,
    async (frame) => {
      frames.push(frame);
      if (frame.kind === 'host-tool-receipt' && acknowledge)
        queueMicrotask(() =>
          bridge.consume({
            v: 1,
            kind: 'host-tool-receipt-ack',
            kernelEpoch: epoch,
            id: frame.id,
            accepted: true,
          }),
        );
    },
    () => {
      throw new Error('transport failed');
    },
    () => {},
    error => { childReleaseErrors.push(error); },
    childModels,
  );
  const lease = (
    identity: string,
    work: () => Promise<unknown> = async () => identity,
    revoked = new AbortController(),
  ): HostToolLease => ({
    implementationIdentity: identity,
    binding: {
      reference: 'owner',
      generation: 1,
      resources: { query: 'resource' },
      tools: [schema],
    },
    available: () => !revoked.signal.aborted,
    authorize: async () => {
      revoked.signal.throwIfAborted();
    },
    revocationSignal: () => revoked.signal,
    execute: async () => {
      effects.push(identity);
      return {
        completion: {
          kind: 'result',
          outcome: 'succeeded',
          effect: 'confirmed',
          content: { data: await work(), parts: [] },
        },
        executor_stopped: true,
      };
    },
    release: () => released.push(identity),
  });
  const hold = (
    kind: string,
    owner: LiveHostToolBinding,
    holder = owner.ownerId,
  ) =>
    bridge.consume({
      v: 1,
      kind: `host-tool-binding-${kind}`,
      kernelEpoch: epoch,
      runId: 'run',
      ownerId: owner.ownerId,
      holderId: holder,
    });
  const request = (
    owner: LiveHostToolBinding,
    id: string,
    phase: string,
    invocation = call,
  ) =>
    bridge.consume({
      v: 1,
      kind: 'host-tool-request',
      kernelEpoch: epoch,
      id,
      phase,
      binding: {
        ownerId: owner.ownerId,
        reference: 'owner',
        generation: 1,
        holderId: owner.ownerId,
      },
      call: invocation,
    });
  return {
    bridge,
    frames,
    released,
    effects,
    childReleaseErrors,
    lease,
    hold,
    request,
    setEpoch: (value: string | null) => {
      epoch = value;
    },
    setAcknowledge: (value: boolean) => {
      acknowledge = value;
    },
  };
}
it('retained v1 executes its first call after v2 publication and drains only after its actual callback and ACK', async () => {
  const f = fixture();
  let finish!: (v: unknown) => void;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const old = f.bridge.register(
    'run',
    f.lease('v1', () => work),
  );
  f.hold('retain', old);
  const next = f.bridge.register('run', f.lease('v2'), false);
  f.hold('retain', next);
  f.hold('activate', next);
  f.request(old, 'authorize', 'authorize');
  await tick();
  f.request(old, 'execute', 'execute');
  await tick();
  f.hold('release', old);
  expect(f.effects).toEqual(['v1']);
  expect(f.released).toEqual([]);
  finish('original callback');
  await tick();
  await tick();
  expect(f.released).toEqual(['v1']);
  expect(
    f.frames.find(
      (frame) => frame.kind === 'host-tool-response' && frame.id === 'execute',
    ),
  ).toMatchObject({
    completion: { content: { data: 'original callback', parts: [] } },
    executor_stopped: true,
  });
  f.bridge.unregister('run');
  expect(f.released).toEqual(['v1', 'v2']);
});

it('waits for its own durable no-effect receipt while another invocation can complete', async () => {
  const f = fixture();
  f.setAcknowledge(false);
  const read = f.lease('read');
  read.execute = async () => ({ completion: { kind: 'result', outcome: 'succeeded', effect: 'none',
    content: { data: { observed: true }, parts: [] } }, executor_stopped: true });
  const owner = f.bridge.register('run', read);
  f.hold('retain', owner);
  f.request(owner, 'read-authorize', 'authorize'); await tick();
  f.request(owner, 'read-execute', 'execute'); await tick();
  const receipt = f.frames.find(frame => frame.kind === 'host-tool-receipt');
  expect(receipt).toBeDefined();
  expect(f.frames.some(frame => frame.kind === 'host-tool-response' && frame.id === 'read-execute')).toBe(false);
  f.setAcknowledge(true);
  const other = { ...call, callId: 'other', operationId: 'request:tool:other' };
  f.request(owner, 'other-authorize', 'authorize', other); await tick();
  f.request(owner, 'other-execute', 'execute', other); await tick();
  expect(f.frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'other-execute')).toMatchObject({ completion: { effect: 'none', outcome: 'succeeded' } });
  expect(f.frames.some(frame => frame.kind === 'host-tool-response' && frame.id === 'read-execute')).toBe(false);
  f.bridge.consume({ v: 1, kind: 'host-tool-receipt-ack', kernelEpoch: 'epoch', id: receipt!.id, accepted: true });
  await tick();
  expect(f.frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'read-execute')).toMatchObject({ completion: { effect: 'none', outcome: 'succeeded' }, executor_stopped: true });
  f.bridge.unregister('run');
});
it('cancel/Run release/reset leaves original callback and lost-ACK evidence alive across transport epochs without reinvoking', async () => {
  const f = fixture();
  f.setAcknowledge(false);
  let finish!: (v: unknown) => void;
  const work = new Promise((resolve) => {
    finish = resolve;
  });
  const owner = f.bridge.register(
    'run',
    f.lease('original', () => work),
  );
  f.hold('retain', owner);
  f.request(owner, 'authorize', 'authorize');
  await tick();
  f.request(owner, 'execute', 'execute');
  await tick();
  f.bridge.consume({
    v: 1,
    kind: 'host-tool-cancel',
    id: 'execute',
    kernelEpoch: 'epoch',
    runId: 'run',
  });
  await tick();
  expect(
    f.frames.find(
      (frame) => frame.kind === 'host-tool-response' && frame.id === 'execute',
    ),
  ).toMatchObject({
    executor_stopped: false,
    completion: { effect: 'unknown' },
  });
  f.bridge.unregister('run');
  f.bridge.reset();
  f.setEpoch(null);
  expect(f.released).toEqual([]);
  const originalOwner = { kind: 'external' as const, identity: owner.binding.reference, epoch: owner.ownerId };
  expect(f.bridge.callbackEnded('run', originalOwner, call.operationId)).toBe(false);
  finish('late original result');
  await tick();
  expect(f.released).toEqual([]);
  expect(f.bridge.callbackEnded('run', originalOwner, call.operationId)).toBe(true);
  expect(f.bridge.callbackEnded('run', { ...originalOwner, epoch: 'replacement' }, call.operationId)).toBeUndefined();
  expect(f.effects).toEqual(['original']);
  f.setEpoch('replacement');
  f.bridge.reconnect();
  await tick();
  const receipt = f.frames.find((frame) => frame.kind === 'host-tool-receipt');
  expect(receipt).toMatchObject({
    kernelEpoch: 'replacement',
    executionOwner: { epoch: owner.ownerId },
    receipt: {
      executor_stopped: true,
      completion: { content: { data: 'late original result', parts: [] } },
    },
  });
  f.bridge.reconnect();
  await tick();
  expect(
    f.frames
      .filter((frame) => frame.kind === 'host-tool-receipt')
      .map((frame) => frame.id),
  ).toEqual([receipt!.id, receipt!.id]);
  f.bridge.consume({
    v: 1,
    kind: 'host-tool-receipt-ack',
    id: receipt!.id,
    kernelEpoch: 'epoch',
    accepted: true,
  });
  expect(f.released).toEqual([]);
  f.bridge.consume({
    v: 1,
    kind: 'host-tool-receipt-ack',
    id: receipt!.id,
    kernelEpoch: 'replacement',
    accepted: true,
  });
  expect(f.released).toEqual(['original']);
  expect(f.effects).toEqual(['original']);
});
it('real PolicyAction origin passes unchanged; forged ModelStep pairing and another owner cannot authorize it', async () => {
  const f = fixture(),
    owner = f.bridge.register('run', f.lease('policy'));
  f.hold('retain', owner);
  const policy: HostToolCall = {
    ...call,
    origin: { kind: 'policy_action', action_id: 'action', node_id: 'node' },
    operationId: 'action:node:node',
    callId: 'node',
  };
  f.request(owner, 'forged', 'authorize', {
    ...policy,
    origin: { kind: 'model_step', request_id: 'made-up' },
  });
  await tick();
  expect(f.frames).toEqual([]);
  f.request(owner, 'authorize', 'authorize', policy);
  await tick();
  f.request(owner, 'execute', 'execute', policy);
  await tick();
  await tick();
  expect(
    f.frames.find((frame) => frame.kind === 'host-tool-receipt'),
  ).toMatchObject({ call: policy });
  expect(f.effects).toEqual(['policy']);
  f.bridge.close();
});
it('explicit revocation wakes native queue registration without using waiter cancellation as stop evidence', async () => {
  const f = fixture(),
    revoked = new AbortController(),
    owner = f.bridge.register('run', f.lease('revoked', undefined, revoked));
  f.hold('retain', owner);
  f.request(owner, 'authorize', 'authorize');
  await tick();
  revoked.abort();
  await tick();
  expect(
    f.frames.find((frame) => frame.kind === 'host-tool-revoked'),
  ).toMatchObject({ ownerId: owner.ownerId, operationId: call.operationId });
  f.request(owner, 'recheck', 'authorize');
  await tick();
  expect(
    f.frames.find(
      (frame) => frame.kind === 'host-tool-response' && frame.id === 'recheck',
    ),
  ).toMatchObject({ ok: false });
  expect(f.effects).toEqual([]);
  f.bridge.close();
});
it('large complete result and original receipt use the existing transport data payload without a frame-sized substitute', async () => {
  const f = fixture(),
    body = 'original-body-'.repeat(1_400_000);
  const owner = f.bridge.register(
    'run',
    f.lease('large', async () => ({ text: body })),
  );
  f.hold('retain', owner);
  f.request(owner, 'authorize', 'authorize');
  await tick();
  f.request(owner, 'execute', 'execute');
  await tick();
  await tick();
  expect(
    f.frames.find(
      (frame) => frame.kind === 'host-tool-response' && frame.id === 'execute',
    ),
  ).toMatchObject({ completion: { content: { data: { text: body }, parts: [] } } });
  expect(
    f.frames.find((frame) => frame.kind === 'host-tool-receipt'),
  ).toMatchObject({ receipt: { completion: { content: { data: { text: body }, parts: [] } } } });
  f.bridge.close();
});
it('the composition registration pins an acknowledged candidate through select replacement and restoration', async () => {
  const f = fixture(),
    candidate = f.bridge.register('run', f.lease('candidate'), false);
  f.hold('retain', candidate);
  f.hold('release', candidate);
  expect(f.released).toEqual([]);
  f.hold('retain', candidate);
  f.hold('activate', candidate);
  f.request(candidate, 'authorize', 'authorize');
  await tick();
  f.request(candidate, 'execute', 'execute');
  await tick();
  await tick();
  expect(f.effects).toEqual(['candidate']);
  f.bridge.discard('run', candidate);
  f.hold('release', candidate);
  expect(f.released).toEqual([]); // The activated selected directory still owns it.
  f.bridge.unregister('run');
  expect(f.released).toEqual(['candidate']);
});

it('keeps accepted child owners through parent completion and channel reset, then releases by child facts', async () => {
  const f = fixture();
  const original = {
    ...f.lease('original'),
    slot: 'extension:example.query@1',
    extensionBinding: {
      providerKey: 'example:host:example.query@1',
      extensionId: 'example',
      extensionVersion: '1.0.0',
      serviceId: 'example.query',
      serviceVersion: 1,
      artifactIntegrity: 'original-artifact',
      composition: leafHostComposition({ extensionId: 'example', extensionVersion: '1.0.0', artifactIntegrity: 'original-artifact' }),
      declarationHash: schema.version,
      configurationIdentity: null,
      tool: schema,
    },
  };
  f.bridge.register('run', original);
  for (const operation of ['accepted-child', 'uncommitted-child']) {
    f.bridge.consume({
      v: 1,
      kind: 'host-tool-child-retain',
      kernelEpoch: 'epoch',
      id: operation,
      parentRunId: 'run',
      childOperationId: operation,
      executionOwner: { kind: 'kernel' },
      executionEpoch: 7,
      mcpBinding: null,
      modelBinding: null,
      extensionBindings: [original.extensionBinding],
    });
  }
  await tick();
  expect(
    f.frames.filter((frame) => frame.kind === 'host-tool-response'),
  ).toEqual([
    expect.objectContaining({ id: 'accepted-child', ok: true }),
    expect.objectContaining({ id: 'uncommitted-child', ok: true }),
  ]);
  f.bridge.unregister('run');
  f.bridge.reconcileChildren([
    { operation_id: 'accepted-child', report: null },
  ]);
  expect(f.released).toEqual([]);
  f.setEpoch('replacement');
  f.bridge.reset();
  f.bridge.reconcileChildren([
    { operation_id: 'accepted-child', report: null },
  ]);
  expect(f.released).toEqual([]);
  f.bridge.releaseChild('run', 'accepted-child');
  expect(f.released).toEqual(['original']);
  expect(f.effects).toEqual([]);
  f.bridge.releaseChild('run', 'accepted-child');
  expect(f.released).toEqual(['original']);
});


it('reports only branded local admission markers and keeps unknown or forged remote errors opaque', async () => {
  for (const error of [new HostToolAdmissionError('mcp-service-unsupported'), new HostToolAdmissionError('mcp_task_not_found', 'No MCP task exists for operationId missing.'),
    Object.assign(new Error('remote body: secret'), { code: 'forged_remote_code', admission: true })]) {
    const f = fixture();
    const lease = f.lease('admission');
    lease.authorize = async () => { throw error; };
    const owner = f.bridge.register('run', lease);
    f.hold('retain', owner);
    f.request(owner, 'reject', 'authorize');
    await tick();
    const response = f.frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'reject');
    expect(response).toMatchObject({ ok: false, error: error instanceof HostToolAdmissionError
      ? {code:error.code,admission:true,...(error.message === error.code ? {} : {message:error.message})} : {code:'host_tool_authorization_failed'} });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(JSON.stringify(response)).not.toContain('forged_remote_code');
    expect(f.effects).toEqual([]);
    f.bridge.unregister('run');
  }
});

it('delivers a recovered domain receipt without a broker lease and repeats only unacknowledged original frames after epoch replacement', async () => {
  let epoch = 'first'; const frames: PrivateToolFrame[] = [];
  const bridge = new ToolBridge(() => epoch, async frame => { frames.push(frame); }, () => { throw new Error('unexpected transport failure'); });
  const original = { call, executionOwner: { kind: 'external' as const, identity: 'original-provider', epoch: 'original-owner' },
    receipt: { executor_stopped: true, completion: { kind: 'result' as const, outcome: 'succeeded' as const, effect: 'confirmed' as const,
      content: { data: { collectionId: 'original-collection' }, parts: [] } } } };
  await bridge.publishRecoveredReceipt(original);
  expect(frames[0]).toMatchObject({ kind: 'host-tool-receipt', call, executionOwner: original.executionOwner, receipt: original.receipt, kernelEpoch: 'first' });
  await expect(bridge.publishRecoveredReceipt({ ...original, receipt: { ...original.receipt,
    completion: { ...original.receipt.completion, content: { data: { collectionId: 'changed' }, parts: [] } } } })).rejects.toThrow('changed');
  const sent = frames[0]; if (sent?.kind !== 'host-tool-receipt') throw new Error('Expected original receipt frame');
  const id = sent.id;
  epoch = 'replacement'; bridge.reset(); bridge.reconnect(); await tick();
  expect(frames.at(-1)).toMatchObject({ id, kernelEpoch: 'replacement', call, executionOwner: original.executionOwner });
  bridge.consume({ v: 1, kind: 'host-tool-receipt-ack', kernelEpoch: 'first', id, accepted: true });
  const before = frames.length; bridge.reconnect(); await tick(); expect(frames.length).toBe(before + 1);
  bridge.consume({ v: 1, kind: 'host-tool-receipt-ack', kernelEpoch: 'replacement', id, accepted: true });
  const confirmed = frames.length; bridge.reconnect(); await tick(); expect(frames).toHaveLength(confirmed);
  expect(bridge.callbackEnded(call.runId, original.executionOwner, call.operationId)).toBeUndefined();
});

it('does not retransmit a definitively rejected recovered receipt on another wake or reconnect', async () => {
  const frames: PrivateToolFrame[] = [];
  const bridge = new ToolBridge(() => 'epoch', async frame => { frames.push(frame); }, () => {});
  const input = { call, executionOwner: { kind: 'external' as const, identity: 'provider', epoch: 'original' },
    receipt: { executor_stopped: true, completion: { kind: 'result' as const, outcome: 'failed' as const, effect: 'none' as const,
      content: { data: { error: 'Original failed transaction' }, parts: [] } } } };
  await bridge.publishRecoveredReceipt(input);
  const frame = frames[0]; if (frame?.kind !== 'host-tool-receipt') throw new Error('Expected receipt');
  bridge.consume({ v: 1, kind: 'host-tool-receipt-ack', kernelEpoch: 'epoch', id: frame.id, accepted: false });
  bridge.reconnect(); await tick();
  await expect(bridge.publishRecoveredReceipt(input)).rejects.toThrow('rejected');
  expect(frames).toHaveLength(1);
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function childFixture(managed = true, childModels?: ConstructorParameters<typeof ToolBridge>[5]) {
  const f = fixture(childModels);
  const binding: McpBinding = {
    reference: 'original-mcp', generation: 4,
    provenance: { servers: { original: {
      owner: { resource_owner: managed
        ? { kind: 'managed_host', hostId: 'target', connectionId: 'original-connection', endpointIdentity: 'original-endpoint' }
        : { kind: 'local' },
      configuration: { agent_dir: '/original', config_cwd: '/original', project_trusted: true },
      execution_scope: 'workspace',
      source_authority: managed ? { coordinator_host_id: 'coordinator', authority_id: 'authority', resource_epoch: 'source-epoch' } : null },
      definition_version: 'original-definition', resource_key: 'original-resource',
    } } },
    resources: { original: 'original-resource' }, tools: [schema], routes: { query: { kind: 'direct' } },
  };
  const lease: HostToolLease = { ...f.lease('original-mcp'), binding };
  const original: SourceMcpChildBinding = {
    parentRunId: 'run', operationId: 'child-operation', executionOwner: { kind: 'kernel' }, executionEpoch: 7,
  };
  const frame = (operationId = original.operationId, id = operationId) => ({
    v: 1, kind: 'host-tool-child-retain', id, kernelEpoch: 'epoch', parentRunId: 'run',
    childOperationId: operationId, executionOwner: original.executionOwner, executionEpoch: original.executionEpoch,
    mcpBinding: structuredClone(binding), extensionBindings: [], modelBinding: null,
  });
  return { ...f, binding, lease, original, frame };
}

it('acknowledges only the exact asynchronous child dependency while independent children retain concurrently', async () => {
  const f = childFixture();
  const slow = deferred<{ release(): Promise<void> }>();
  const calls: { binding: SourceMcpChildBinding; selection: McpBinding }[] = [];
  const released: string[] = [];
  f.lease.retainChild = async (binding, selection) => {
    calls.push({ binding, selection });
    if (binding.operationId === 'child-operation') return slow.promise;
    return { release: async () => { released.push(binding.operationId); } };
  };
  f.bridge.register('run', f.lease);
  const request = f.frame();
  f.bridge.consume(request);
  request.mcpBinding.provenance.servers.original!.definition_version = 'mutated-after-consume';
  f.bridge.consume(f.frame('child-operation', 'duplicate-request'));
  f.bridge.consume(f.frame('independent-child'));
  await tick();
  expect(calls).toEqual([
    { binding: f.original, selection: f.binding },
    { binding: { ...f.original, operationId: 'independent-child' }, selection: f.binding },
  ]);
  expect(f.frames).toEqual([expect.objectContaining({ id: 'independent-child', ok: true })]);
  const replacement = { ...f.lease, implementationIdentity: 'replacement' };
  delete replacement.retainChild;
  f.bridge.register('run', replacement);
  expect(f.released).toEqual([]);
  slow.resolve({ release: async () => { released.push('child-operation'); } });
  await tick();
  expect(f.frames.filter(frame => frame.kind === 'host-tool-response').map(frame => frame.id))
    .toEqual(['independent-child', 'child-operation', 'duplicate-request']);
  expect(f.frames.every(frame => frame.kind === 'host-tool-response' && frame.ok)).toBe(true);
  await f.bridge.releaseChild('run', 'child-operation');
  expect(f.released).toEqual([]);
  await f.bridge.releaseChild('run', 'independent-child');
  expect(released).toEqual(['child-operation', 'independent-child']);
  expect(f.released).toEqual(['original-mcp']);
  f.bridge.close();
});

it('requires the managed retention hook but retains purely local MCP without one', async () => {
  for (const managed of [true, false]) {
    const f = childFixture(managed);
    f.bridge.register('run', f.lease);
    f.bridge.consume(f.frame());
    await tick();
    expect(f.frames).toEqual([expect.objectContaining({ ok: !managed })]);
    f.bridge.unregister('run');
    expect(f.released).toEqual(managed ? ['original-mcp'] : []);
    await f.bridge.releaseChild('run', 'child-operation');
    expect(f.released).toEqual(['original-mcp']);
  }
});

it('validates exact original schemas, routes, provenance and execution identity before retaining a child', async () => {
  const f = childFixture();
  let retains = 0;
  f.lease.retainChild = async () => { retains++; return { release: async () => {} }; };
  f.bridge.register('run', f.lease);
  const variants = [
    (frame: ReturnType<typeof f.frame>) => { frame.mcpBinding.tools[0]!.description = 'changed'; },
    (frame: ReturnType<typeof f.frame>) => { frame.mcpBinding.routes.query = { kind: 'discovery', argument: 'other' }; },
    (frame: ReturnType<typeof f.frame>) => { frame.mcpBinding.provenance.servers.original!.definition_version = 'changed'; },
    (frame: ReturnType<typeof f.frame>) => { frame.mcpBinding.resources.original = 'changed'; },
  ];
  for (const [index, change] of variants.entries()) {
    const frame = f.frame(`invalid-${index}`); change(frame); f.bridge.consume(frame);
  }
  f.bridge.consume({ ...f.frame('invalid-owner'), executionOwner: { kind: 'kernel', identity: 'invented' } });
  f.bridge.consume({ ...f.frame('invalid-execution-epoch'), executionEpoch: -1 });
  f.bridge.consume({ ...f.frame('stale-channel'), kernelEpoch: 'old' });
  await tick();
  expect(retains).toBe(0);
  expect(f.frames).toHaveLength(variants.length);
  expect(f.frames.every(frame => frame.kind === 'host-tool-response' && !frame.ok)).toBe(true);
  f.bridge.consume(f.frame()); await tick();
  f.bridge.consume({ ...f.frame('child-operation', 'wrong-operation-epoch'), executionEpoch: 8 });
  f.bridge.consume({ ...f.frame('child-operation', 'wrong-owner'), executionOwner: { kind: 'external', identity: 'invented', epoch: 'invented' } });
  await tick();
  expect(retains).toBe(1);
  expect(f.frames.slice(-2).every(frame => frame.kind === 'host-tool-response' && !frame.ok)).toBe(true);
  await f.bridge.releaseChild('run', 'child-operation');
  f.bridge.close();
});

it('does not revive a pending child or discard its late asynchronous release after cancellation and lifecycle changes', async () => {
  for (const action of ['release', 'cancel', 'unregister', 'reset', 'close', 'channel'] as const) {
    const f = childFixture();
    const retain = deferred<{ release(): Promise<void> }>();
    const release = deferred<void>();
    let releases = 0;
    f.lease.retainChild = async () => retain.promise;
    f.bridge.register('run', f.lease);
    f.bridge.consume(f.frame()); await tick();
    if (action === 'release') void f.bridge.releaseChild('run', 'child-operation');
    if (action === 'cancel') f.bridge.consume({ v: 1, kind: 'host-tool-cancel', kernelEpoch: 'epoch', id: 'child-operation', runId: 'run' });
    if (action === 'unregister') f.bridge.unregister('run');
    if (action === 'reset') f.bridge.reset();
    if (action === 'close') f.bridge.close();
    if (action === 'channel') f.setEpoch('replacement');
    retain.resolve({ release: async () => { releases++; await release.promise; } });
    await tick();
    expect(releases, action).toBe(1);
    expect(f.frames, action).toEqual([]);
    expect(f.released, action).toEqual([]);
    release.resolve(); await tick();
    expect(f.frames, action).toEqual(action === 'channel' ? [] : [expect.objectContaining({ ok: false })]);
    f.bridge.unregister('run');
    expect(f.released, action).toEqual(['original-mcp']);
    await f.bridge.releaseChild('run', 'child-operation');
    expect(releases, action).toBe(1);
  }
});

it('keeps original accepted child release duties through reset and rejects failed release without taking down the channel', async () => {
  const f = childFixture();
  let fail = true, releases = 0;
  const releaseFailure = new Error('original target unavailable');
  f.lease.retainChild = async () => ({ release: async () => {
    releases++; if (fail) throw releaseFailure;
  } });
  f.bridge.register('run', f.lease); f.bridge.consume(f.frame()); await tick();
  expect(f.frames).toEqual([expect.objectContaining({ ok: true })]);
  f.bridge.unregister('run'); f.setEpoch('replacement'); f.bridge.reset();
  f.bridge.reconcileChildren([{ operation_id: 'child-operation', report: null }]);
  expect(releases).toBe(0); expect(f.released).toEqual([]);
  await expect(f.bridge.releaseChild('run', 'child-operation')).rejects.toThrow('host_tool_child_release_failed');
  expect(f.childReleaseErrors).toHaveLength(1);
  expect((f.childReleaseErrors[0] as AggregateError).errors).toEqual([releaseFailure]);
  expect(f.released).toEqual([]);
  fail = false;
  await f.bridge.releaseChild('run', 'child-operation');
  expect(releases).toBe(2); expect(f.released).toEqual(['original-mcp']);
  await f.bridge.releaseChild('run', 'child-operation');
  expect(releases).toBe(2);
});

it('a rejected hook unpins every selected candidate and never acknowledges original retention', async () => {
  const f = childFixture();
  const retain = deferred<{ release(): Promise<void> }>();
  f.lease.retainChild = async () => retain.promise;
  const extension: HostToolLease = {
    ...f.lease, implementationIdentity: 'original-extension', slot: 'extension:helper',
    extensionBinding: { providerKey: 'extension:helper', extensionId: 'helper', extensionVersion: '1',
      serviceId: 'helper', serviceVersion: 1, artifactIntegrity: 'artifact',
      composition: leafHostComposition({ extensionId: 'helper', extensionVersion: '1', artifactIntegrity: 'artifact' }),
      declarationHash: schema.version, configurationIdentity: null, tool: schema },
    release: () => { f.released.push('original-extension'); },
  };
  delete extension.retainChild;
  f.bridge.register('run', f.lease); f.bridge.register('run', extension);
  f.bridge.consume({ ...f.frame(), extensionBindings: [extension.extensionBinding] }); await tick();
  f.bridge.register('run', { ...extension, implementationIdentity: 'new-extension', release: () => {} });
  const replacement = { ...f.lease, implementationIdentity: 'replacement' };
  delete replacement.retainChild;
  f.bridge.register('run', replacement);
  expect(f.released).toEqual([]);
  retain.reject(new Error('original retention unavailable')); await tick();
  expect(f.frames).toEqual([expect.objectContaining({ ok: false })]);
  expect(f.released).toEqual(['original-mcp', 'original-extension']);
  expect(f.childReleaseErrors).toEqual([]);
  f.bridge.close();
});


it('retains a failed late cleanup handle and returns a failure ACK until its original release succeeds', async () => {
  const f = childFixture();
  const retain = deferred<{ release(): Promise<void> }>();
  let fail = true, releases = 0;
  f.lease.retainChild = async () => retain.promise;
  f.bridge.register('run', f.lease); f.bridge.consume(f.frame()); await tick();
  f.bridge.unregister('run');
  retain.resolve({ release: async () => { releases++; if (fail) throw new Error('original cleanup unavailable'); } });
  await tick();
  expect(f.frames).toEqual([expect.objectContaining({ ok: false, error: { code: 'host_tool_child_release_failed' } })]);
  expect(f.childReleaseErrors.length).toBeGreaterThan(0);
  expect(f.released).toEqual([]);
  fail = false;
  await f.bridge.releaseChild('run', 'child-operation');
  expect(releases).toBe(2); expect(f.released).toEqual(['original-mcp']);
});

it('cannot replace a child dependency with another valid owner after its original release failed', async () => {
  const f = childFixture();
  let fail = true, replacements = 0;
  f.lease.retainChild = async () => ({ release: async () => { if (fail) throw new Error('offline'); } });
  f.bridge.register('run', f.lease); f.bridge.consume(f.frame()); await tick();
  await expect(f.bridge.releaseChild('run', 'child-operation')).rejects.toThrow('host_tool_child_release_failed');
  const replacement = structuredClone(f.binding); replacement.reference = 'replacement';
  f.bridge.register('run', { ...f.lease, binding: replacement, implementationIdentity: 'replacement',
    retainChild: async () => { replacements++; return { release: async () => {} }; } });
  f.bridge.consume({ ...f.frame('child-operation', 'replacement-attempt'), mcpBinding: replacement });
  await tick();
  expect(f.frames.at(-1)).toMatchObject({ id: 'replacement-attempt', ok: false });
  expect(replacements).toBe(0); expect(f.released).toEqual([]);
  fail = false; await f.bridge.releaseChild('run', 'child-operation');
  expect(f.released).toEqual(['original-mcp']); f.bridge.close();
});

it('mixed child failure releases only its acquired model handoff and cannot erase a different original selection', async () => {
  const { CredentialBridge } = await import('./credential-bridge.js');
  const { ExistingHostCredentialOwner } = await import('./credential-owner.js');
  const { modelCredentialBindingIdentity } = await import('./model-binding-lifetime.js');
  const model = { configuration: { providerId: 'model', providerFamily: 'openai-completions', model: 'original',
    endpoint: 'https://model.invalid/chat/completions', allowAnonymous: false, credentialEnvironment: null,
    maxOutputTokens: null, configurationGeneration: 1 },
    credential_scope: { reference: 'model', authority: 'original', account: 'account', generation: 1 } };
  let disposed = 0;
  const credentials = new CredentialBridge(() => 'epoch', async () => {}, () => {});
  const identity = modelCredentialBindingIdentity(model.configuration);
  const owner = new ExistingHostCredentialOwner({ providerId: 'model', providerFamily: 'openai-completions',
    endpoint: model.configuration.endpoint, bindingIdentity: identity, currentScope: async () => model.credential_scope,
    runtime: { getAuth: async () => undefined }, release: () => { disposed++; } });
  await credentials.register('run', owner); owner.release();
  const f = childFixture(true, { retain: (binding, model, selection) => credentials.retainChildModel(binding, model, selection),
    release: (run, operation) => credentials.releaseChildModel(run, operation), reconcile: children => credentials.reconcileChildModels(children) });
  f.lease.retainChild = async () => { throw new Error('MCP original retain failed'); };
  f.bridge.register('run', f.lease);
  try {
    f.bridge.consume({ ...f.frame('pure', 'pure-accepted'), mcpBinding: null, modelBinding: model }); await tick();
    expect(f.frames.at(-1)).toMatchObject({ id: 'pure-accepted', ok: true });
    f.bridge.consume({ ...f.frame('pure', 'changed-selection'), modelBinding: model }); await tick();
    expect(f.frames.at(-1)).toMatchObject({ id: 'changed-selection', ok: false });
    f.bridge.consume({ ...f.frame('mixed', 'mixed-failure'), modelBinding: model }); await tick();
    expect(f.frames.at(-1)).toMatchObject({ id: 'mixed-failure', ok: false });
    credentials.unregister('run');
    expect(disposed).toBe(0);
    await f.bridge.releaseChild('run', 'pure');
    expect(disposed).toBe(1);
    await f.bridge.releaseChild('run', 'mixed');
    expect(disposed).toBe(1);
  } finally { f.bridge.close(); credentials.close(); }
});
