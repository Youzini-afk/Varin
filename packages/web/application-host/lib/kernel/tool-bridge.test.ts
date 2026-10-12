import { expect, it } from 'vitest';
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
  runId: 'run',
  origin: { kind: 'model_step', request_id: 'request' },
  operationId: 'request:tool:call',
  callId: 'call',
  name: 'query',
  schemaVersion: '1',
  arguments: {},
};
function fixture() {
  let epoch: string | null = 'epoch';
  const frames: PrivateToolFrame[] = [],
    released: string[] = [],
    effects: string[] = [];
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
      mcpBinding: null,
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
  for (const error of [new HostToolAdmissionError('mcp-service-unsupported'), Object.assign(new Error('remote body: secret'), { code: 'forged_remote_code', admission: true })]) {
    const f = fixture();
    const lease = f.lease('admission');
    lease.authorize = async () => { throw error; };
    const owner = f.bridge.register('run', lease);
    f.hold('retain', owner);
    f.request(owner, 'reject', 'authorize');
    await tick();
    const response = f.frames.find(frame => frame.kind === 'host-tool-response' && frame.id === 'reject');
    expect(response).toMatchObject({ ok: false, error: error instanceof HostToolAdmissionError
      ? {code:'mcp-service-unsupported',admission:true} : {code:'host_tool_authorization_failed'} });
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
