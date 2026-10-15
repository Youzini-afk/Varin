import { expect, it, vi } from 'vitest';
// These tests exercise the real coordinator request/lease lifecycle. Tool schema
// compilation and the SDK transport are separate owners, unused by this empty cut.
vi.mock('../mcp/authority.js', async () => ({ McpAuthorityError: (await import('../mcp/errors.js')).McpAuthorityError }));
vi.mock('../models/schema.js', () => ({ compileToolJsonSchema: vi.fn() }));
import { createManagedMcpLease } from './managed-mcp-lease.js';
import type { McpChildDerivationReceipt } from './protocol.generated.js';

function fixture() {
  const origin = { kind: 'continuation' as const, previous_run_id: 'previous' };
  const receipt = { proof: { origin }, provenance: { servers: {} } } as McpChildDerivationReceipt;
  const snapshot = { incarnation: 'B-live', revision: 0, implementationIdentity: 'original-view',
    revocations: { tools: [], services: [] }, binding: { provenance: { servers: {} }, tools: [], servers: [], readiness: {}, serverSelections: [] } };
  const prepared = { snapshot, receipt }, released = { value: false };
  const calls: Array<{ requestId: string; operation: { action: { kind: string; handleId?: string; creationRequestId?: string } } }> = [];
  let loseDerive = false, loseRelease = false, live = true;
  const service = vi.fn(async request => {
    calls.push(request);
    const action = request.operation.action;
    if (action.kind === 'derive') {
      if (loseDerive) { loseDerive = false; throw new Error('derive response lost after commit'); }
      return { ok: true, value: prepared };
    }
    if (action.kind === 'derivation_inspect') return { ok: true, value: {
      live, reference: { released: released.value }, proof: released.value ? null : receipt.proof,
      ...(live ? { prepared } : {}),
    } };
    if (action.kind === 'release') {
      if (loseRelease) { loseRelease = false; throw new Error('release response lost'); }
      return { ok: true, value: undefined };
    }
    throw new Error(`Unexpected ${action.kind}`);
  });
  const input = { coordinatorHostId: 'A', owner: { kind: 'managed_host', hostId: 'B', connectionId: 'connection', endpointIdentity: 'endpoint' },
    lifetime: new AbortController().signal, access: { client: { service }, binding: { authorityId: 'child', resourceEpoch: 'epoch' } },
    observeRevocations: () => () => {}, derivation: { executionId: 'execution', origin } } as unknown as Parameters<typeof createManagedMcpLease>[0];
  return { input, calls, service, prepared, released, loseDerive: () => { loseDerive = true; }, loseRelease: () => { loseRelease = true; }, expire: () => { live = false; } };
}
it('joins the exact prepared snapshot through inspect after lost derive ACK without replaying its settled service request', async () => {
  const f = fixture(); f.loseDerive();
  const selected = await createManagedMcpLease(f.input);
  expect(f.calls.map(call => call.operation.action.kind)).toEqual(['derive', 'derivation_inspect']);
  expect(f.calls[0]!.requestId).toBe(f.calls[0]!.operation.action.creationRequestId);
  expect(selected.receipt).toBe(f.prepared.receipt);
  await selected.lease.releaseAndDrain();
  expect(f.calls.at(-1)!.operation.action).toEqual({ kind: 'release', handleId: 'mcp-child-view:execution', creationRequestId: 'mcp-child-prepare:execution' });
});
it('restores only the original live view after proof release, without snapshot or derive', async () => {
  const f = fixture(); f.released.value = true;
  const { derivation: _derivation, ...input } = f.input;
  const selected = await createManagedMcpLease({ ...input, restoration: { executionId: 'execution' } });
  expect(f.calls.map(call => call.operation.action.kind)).toEqual(['derivation_inspect']);
  expect(selected.receipt).toBeUndefined(); expect(selected.snapshot).toBe(f.prepared.snapshot);
  await selected.lease.releaseAndDrain();
});
it('an unavailable saved live view fails closed and drains only its original handle', async () => {
  const f = fixture(); f.expire();
  const { derivation: _derivation, ...input } = f.input;
  await expect(createManagedMcpLease({ ...input, restoration: { executionId: 'execution' } })).rejects.toThrow('mcp_child_original_view_unavailable');
  expect(f.calls.map(call => call.operation.action.kind)).toEqual(['derivation_inspect', 'release']);
});
it('does not mistake a released proof for a lost uncommitted derivation response', async () => {
  const f = fixture(); f.loseDerive(); f.released.value = true;
  await expect(createManagedMcpLease(f.input)).rejects.toThrow('derive response lost');
  expect(f.calls.map(call => call.operation.action.kind)).toEqual(['derive', 'derivation_inspect', 'release']);
});
it('a lost view-release ACK remains retryable using the identical handle and request creation identity', async () => {
  const f = fixture(), selected = await createManagedMcpLease(f.input); f.loseRelease();
  await expect(selected.lease.releaseAndDrain()).rejects.toThrow('release response lost');
  await selected.lease.releaseAndDrain();
  const releases = f.calls.filter(call => call.operation.action.kind === 'release');
  expect(releases).toHaveLength(2); expect(releases[0]!.operation.action).toEqual(releases[1]!.operation.action);
});
