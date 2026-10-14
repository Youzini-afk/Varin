import { expect, it, vi } from 'vitest';
import { recallManagedScheduleReceipt, type ManagedScheduleReceiptQuery } from './managed-schedule-receipt.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceInspection, ManagedSourceReceipt, ManagedSourceControlRequest } from '../harness/managed-remote-types.js';
const query: ManagedScheduleReceiptQuery = { kind: 'schedule_receipt', phase: 'observe', runId: 'run-A', threadId: 'thread-A', operationId: 'original-call',
  source: { resource_owner: { kind: 'managed_host', hostId: 'B', connectionId: 'paired-B', endpointIdentity: 'endpoint-B' },
    workspace_id: 'workspace-B', execution_workspace_id: 'workspace-B', mode: 'live_root', branch_id: null, revision: null, live_root: { hostId: 'B', rootId: 'root-B', canonicalRoot: '/B/project' } } };
const authority = (id = 'original-grant'): ManagedSourceInspection => ({ purpose: 'source', phase: 'retired', operationId: null,
  scope: { kind: 'run', threadId: query.threadId, runId: query.runId, epoch: 1 }, mcpHolders: [], mcpDeliveries: [], mcpChildren: [],
  binding: { authorityId: id, resourceEpoch: 'old-B-epoch', executionOwner: { kind: 'external', identity: `source:${id}`, epoch: 'old-B-epoch' },
    source: structuredClone(query.source), physicalRoot: null, capabilities: { tools: [], grantCapabilities: [], clientCapabilities: [], unavailable: [] } } });
const original = (): ManagedSourceReceipt => ({ operationId: query.operationId, resourceEpoch: 'old-B-epoch', executionOwner: authority().binding.executionOwner,
  accepted: true, executorStopped: true, result: { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: { original: 'body' }, parts: [] } } } });
function port(items = [authority()]) {
  return { inspectScope: vi.fn(async () => items), observe: vi.fn(async (_address: ManagedSourceControlRequest) => original()),
    releaseReceipt: vi.fn(async () => ({ operationId: query.operationId, resourceEpoch: 'old-B-epoch', executionOwner: authority().binding.executionOwner, released: true })) } satisfies Pick<ManagedSourceClient, 'inspectScope' | 'observe' | 'releaseReceipt'>;
}
it('recalls retired old-epoch original body without admission or mutation and releases directly after its body is gone', async () => {
  const client = port();
  expect(await recallManagedScheduleReceipt(client, 'A', query)).toEqual(original());
  expect(client.observe).toHaveBeenCalledWith({ coordinatorHostId: 'A', authorityId: 'original-grant', resourceEpoch: 'old-B-epoch', operationId: 'original-call' });
  client.observe.mockRejectedValue(new Error('body already released'));
  expect(await recallManagedScheduleReceipt(client, 'A', { ...query, phase: 'release' })).toEqual({ operationId: query.operationId, released: true });
  expect(client.observe).toHaveBeenCalledTimes(1);
});
it('lets Storage select the exact original grant among same-Run views, but does not hide unavailability', async () => {
  const client = port([authority('other-grant'), authority()]);
  client.observe.mockImplementation(async address => { if (address.authorityId !== 'original-grant') throw new Error('unauthorized'); return original(); });
  expect(await recallManagedScheduleReceipt(client, 'A', query)).toEqual(original());
  client.observe.mockRejectedValue(new Error('source offline'));
  await expect(recallManagedScheduleReceipt(client, 'A', query)).rejects.toThrow('remains unavailable');
});
it('rejects changed receipt owner, changed Run scope and pending release; foreign sources are never touched', async () => {
  const client = port(); client.observe.mockResolvedValue({ ...original(), resourceEpoch: 'new-B-epoch' });
  await expect(recallManagedScheduleReceipt(client, 'A', query)).rejects.toThrow('owner changed');
  const changed = authority(); changed.scope = { kind: 'run', threadId: 'other', runId: query.runId, epoch: 1 };
  client.inspectScope.mockResolvedValue([changed]);
  await expect(recallManagedScheduleReceipt(client, 'A', query)).rejects.toThrow('scope changed');
  client.inspectScope.mockResolvedValue([authority()]); client.releaseReceipt.mockResolvedValue({ ...original(), released: false });
  await expect(recallManagedScheduleReceipt(client, 'A', { ...query, phase: 'release' })).rejects.toThrow('release is pending');
  const foreign = authority(); foreign.binding.source.workspace_id = 'other-workspace'; client.inspectScope.mockResolvedValue([foreign]); client.observe.mockClear();
  expect(await recallManagedScheduleReceipt(client, 'A', query)).toBeNull(); expect(client.observe).not.toHaveBeenCalled();
});
