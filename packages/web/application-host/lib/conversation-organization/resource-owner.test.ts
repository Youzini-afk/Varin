import { ResourceBridge, type PrivateResourceResponse } from '../kernel/resource-bridge.js';
import { expect, it, vi } from 'vitest';
import { createResourceOwner, type ResourceQuery } from '../kernel/resource-owner.js';
const query: ResourceQuery = { runId: 'run', origin: { kind: 'model_step', request_id: 'request' }, callId: 'call', resourceCheckpointId: 'checkpoint',
  request: { kind: 'organization', operationId: 'operation', action: 'create_bot_conversation', input: { botId: 'bot', key: 'key' } } };
it('validates the original frozen invocation before calling a lifecycle owner', async () => {
  const organization = vi.fn(async () => ({ result: { identity: { threadId: 'created' } } }));
  const resourceSnapshot = vi.fn(async () => ({ snapshot: { scope: { threadId: 'caller' } } }));
  const run = vi.fn(async () => ({ thread_id: 'caller', principal_id: 'alice', state: 'running', cancel_requested: false }));
  const organizationInvocation=vi.fn(async()=>run());
  const owner = createResourceOwner({ runtime: { resourceSnapshot, run, organizationInvocation } as never, resources: {} as never, organization });
  const result = await owner(query, new AbortController().signal);
  expect(result).toMatchObject({ status: 'ready', result: { identity: { threadId: 'created' } } });
  expect(organizationInvocation).toHaveBeenCalledWith({runId:'run',origin:query.origin,callId:'call',operationId:'operation'},expect.any(AbortSignal));
  expect(resourceSnapshot).not.toHaveBeenCalled();
  expect(organization).toHaveBeenCalledWith(query.request, expect.objectContaining({ principal_id: 'alice' }), expect.any(AbortSignal));
  organizationInvocation.mockRejectedValue(new Error('Original invocation revoked'));
  expect(await owner(query, new AbortController().signal)).toMatchObject({ status: 'denied' });
  expect(organization).toHaveBeenCalledTimes(1);
});
it('rejects mismatched or cancelled original work without creating another Bot conversation', async () => {
  const organization = vi.fn(async () => ({}));
  const run = vi.fn(async () => ({ thread_id: 'other', state: 'running', cancel_requested: false }));
  const organizationInvocation=vi.fn(async()=>{throw new Error('Original invocation belongs to another Run');});
  const owner = createResourceOwner({ runtime: { resourceSnapshot: async () => ({ snapshot: { scope: { threadId: 'caller' } } }), run,organizationInvocation } as never, resources: {} as never, organization });
  expect(await owner(query, new AbortController().signal)).toMatchObject({ status: 'denied' });
  run.mockResolvedValue({ thread_id: 'caller', state: 'running', cancel_requested: true });
  organizationInvocation.mockImplementation(async()=>await run() as never);
  expect(await owner(query, new AbortController().signal)).toMatchObject({ status: 'cancelled' });
  expect(organization).not.toHaveBeenCalled();
});

it('passes the organization request through the real private ResourceBridge parser', async () => {
  const replies: PrivateResourceResponse[] = [];
  const lifecycle = vi.fn(async () => ({ result: { accepted: true } }));
  const owner = createResourceOwner({ runtime: { resourceSnapshot: async () => ({ snapshot: { scope: { threadId: 'caller' } } }), run: async () => ({ thread_id: 'caller', state: 'running', cancel_requested: false }),organizationInvocation:async()=>({thread_id:'caller',state:'running',cancel_requested:false}) } as never, resources: {} as never, organization: lifecycle });
  const bridge = new ResourceBridge(() => 'epoch', async reply => { replies.push(reply); }, () => { throw new Error('Transport failed'); });
  bridge.setOwner(owner);
  expect(bridge.consume({ v: 1, kind: 'resource-request', id: 'request', kernelEpoch: 'epoch', query })).toBe(true);
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]?.result).toMatchObject({ status: 'ready', result: { accepted: true } });
  expect(lifecycle).toHaveBeenCalledTimes(1);
  bridge.consume({ v: 1, kind: 'resource-request', id: 'forged', kernelEpoch: 'epoch', query: { ...query, request: { ...query.request, principalId: 'other' } } });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expect(replies[1]?.result.status).toBe('invalid'); expect(lifecycle).toHaveBeenCalledTimes(1); bridge.close();
});
