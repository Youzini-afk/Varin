import { expect, it } from 'vitest';
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
          content: await work(),
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
    completion: { content: 'original callback' },
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
  finish('late original result');
  await tick();
  expect(f.released).toEqual([]);
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
      completion: { content: 'late original result' },
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
  ).toMatchObject({ completion: { content: { text: body } } });
  expect(
    f.frames.find((frame) => frame.kind === 'host-tool-receipt'),
  ).toMatchObject({ receipt: { completion: { content: { text: body } } } });
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
