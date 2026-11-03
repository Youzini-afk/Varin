import { expect, it, vi } from 'vitest';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { MaterialRetention, LaunchSource } from './protocol.generated.js';
import { releaseDeletedAttachmentSources } from './attachment-retention.js';
import { withManagedAttachmentResult } from './managed-attachment-result.js';

const source: LaunchSource = { resource_owner: { kind: 'managed_host', hostId: 'original-host', connectionId: 'original-connection', endpointIdentity: 'original-endpoint' },
  mode: 'live_root', workspace_id: 'original-workspace', execution_workspace_id: 'original-execution', branch_id: null, revision: null,
  live_root: { hostId: 'original-host', rootId: 'original-root', canonicalRoot: '/original-root' } };
function fixture() {
  const actor = { listRecords: vi.fn(async (_input: { workspaceId: string; recordType: string; cursor?: number }): Promise<{ records: Array<{ recordId: string; recordType: string; threadId: string; state: string; payloadJson: string }>; nextCursor: number | null }> => ({ records: [], nextCursor: null })), releaseRecord: vi.fn() };
  const kernel = { issueGrant: vi.fn(async input => ({ grantId: input.grantId })), revokeGrant: vi.fn(async () => ({})),
    scoped: () => actor, recordWorkspaces: vi.fn(async () => ({ workspaceIds: ['original-workspace', 'thread-materials:root'] })) };
  const client = { releaseScope: vi.fn(async () => ({ pendingAuthorities: [] as string[] })),
    bind: vi.fn(async () => ({ authorityId: 'result-authority', resourceEpoch: 'current-target-generation', source })),
    service: vi.fn(async () => undefined), release: vi.fn(async () => ({ phase: 'retired' })) };
  const runtime = { coordinatorHostId: 'coordinator', managedSource: vi.fn(async () => client) };
  const plan: MaterialRetention = { sources: [], inheritances: [], attachments: [], threads: [{ threadId: 'deleted', rootThreadId: 'root', release: true }],
    attachmentPreparations: [], attachmentSources: [{ threadId: 'deleted', runId: 'original-run', epoch: 7, source }] };
  return { kernel, actor, client, runtime, plan, cleanup: () => releaseDeletedAttachmentSources(kernel as unknown as KernelClient, runtime as unknown as AgentRuntimeClient, plan) };
}
it('cleans only original source records and reopens exact result authority after actual remote scope drain', async () => {
  const f = fixture();
  expect(await f.cleanup()).toEqual({ pending: false });
  expect(f.actor.listRecords.mock.calls.every(([input]) => input.workspaceId === 'original-workspace')).toBe(true);
  expect(f.client.releaseScope).toHaveBeenCalledWith({ coordinatorHostId: 'coordinator', threadId: 'deleted', runId: 'original-run', mode: 'retire' }, undefined);
  expect(f.client.bind).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'run', threadId: 'deleted', runId: 'original-run', epoch: 7 },
    purpose: 'result', retention: 'caller', deferMaterialization: true }));
  expect(f.client.service).toHaveBeenCalledWith(expect.objectContaining({ authorityId: 'result-authority', resourceEpoch: 'current-target-generation', operation: { kind: 'attachment_cleanup' } }), undefined);
  expect(f.client.release).toHaveBeenCalledWith(expect.objectContaining({ authorityId: 'result-authority', mode: 'retire' }));
});
it('keeps cleanup pending for a live remote owner or an offline original Host', async () => {
  const f = fixture(); f.client.releaseScope.mockResolvedValue({ pendingAuthorities: ['still-running-process'] });
  expect(await f.cleanup()).toEqual({ pending: true }); expect(f.client.bind).not.toHaveBeenCalled();
  f.runtime.managedSource.mockRejectedValue(new Error('Host offline'));
  expect(await f.cleanup()).toEqual({ pending: true }); expect(f.client.service).not.toHaveBeenCalled();
});
it('reads immutable original result bytes without reactivating source execution and drains the result lease on errors', async () => {
  const f = fixture();
  const scope = f.plan.attachmentSources[0]!;
  expect(await withManagedAttachmentResult(f.runtime as unknown as AgentRuntimeClient, scope, 'receipt-read', async () => 'fixed bytes')).toBe('fixed bytes');
  await expect(withManagedAttachmentResult(f.runtime as unknown as AgentRuntimeClient, scope, 'receipt-read', async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
  expect(f.client.release).toHaveBeenCalledTimes(2);
});

it('drains every original Run before deleting Thread-owned remote records without a runId', async () => {
  const f = fixture();
  f.plan.attachmentSources.push({ ...f.plan.attachmentSources[0]!, runId: 'still-running-run' });
  f.client.releaseScope.mockResolvedValueOnce({ pendingAuthorities: [] }).mockResolvedValueOnce({ pendingAuthorities: ['live-process'] });
  expect(await f.cleanup()).toEqual({ pending: true });
  expect(f.client.releaseScope).toHaveBeenCalledTimes(2);
  expect(f.client.bind).not.toHaveBeenCalled(); expect(f.client.service).not.toHaveBeenCalled();
});

it('collects every source record before deleting across offset-based pages', async () => {
  const f = fixture(); f.plan.attachmentSources = [];
  const rows = Array.from({ length: 260 }, (_, index) => ({ recordId: `capture:${index}`, recordType: 'attachment.capture', threadId: 'deleted', state: 'temporary', payloadJson: JSON.stringify({ managedSource: false }) }));
  f.actor.listRecords.mockImplementation(async (input: { recordType: string; cursor?: number }) => {
    if (input.recordType !== 'attachment.capture') return { records: [], nextCursor: null };
    const cursor = input.cursor ?? 0, next = cursor + 128;
    return { records: rows.slice(cursor, next), nextCursor: next < rows.length ? next : null };
  });
  f.actor.releaseRecord.mockImplementation(async (_operation: string, _workspace: string, id: string) => { rows.splice(rows.findIndex(row => row.recordId === id), 1); });
  await f.cleanup(); expect(rows).toHaveLength(0); expect(f.actor.releaseRecord).toHaveBeenCalledTimes(260);
});

it('does not delete another coordinator’s managed records with the same Thread identity', async () => {
  const f = fixture(); f.plan.attachmentSources = [];
  const base = { recordType: 'attachment.capture', threadId: 'deleted', state: 'temporary' };
  const records = [
    { ...base, recordId: 'native', payloadJson: JSON.stringify({ managedSource: false }) },
    { ...base, recordId: 'foreign-managed', payloadJson: JSON.stringify({ managedSource: true }) },
    { ...base, recordId: 'attachment-managed-capture:foreign', payloadJson: JSON.stringify({ managedSource: false }) },
    { ...base, recordId: 'attachment.capture:foreign', payloadJson: JSON.stringify({ managedSource: false }) },
    { ...base, recordId: 'foreign-formal', payloadJson: JSON.stringify({ managedSource: false, captureId: 'foreign-scope' }) },
    { ...base, recordId: 'unproven', payloadJson: '{}' },
  ];
  f.actor.listRecords.mockImplementation(async input => ({ records: input.recordType === 'attachment.capture' ? records : [], nextCursor: null }));
  await f.cleanup();
  expect(f.actor.releaseRecord.mock.calls.map(call => call[2])).toEqual(['native']);
});

it('discards only exact terminal unpublished capture slots while its original Thread and other Run work remain live', async () => {
  const f = fixture(); f.plan.threads[0]!.release = false; f.plan.attachmentSources = [];
  f.plan.attachmentPreparations = [{ threadId: 'deleted', runId: 'original-run', epoch: 7, source, operationId: 'failed-send',
    attachments: [{ ref: 'attachment:original-slot', path: 'selected/data.bin' }] }];
  expect(await f.cleanup()).toEqual({ pending: false });
  expect(f.client.releaseScope).not.toHaveBeenCalled();
  expect(f.client.bind).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'run', threadId: 'deleted', runId: 'original-run', epoch: 7 }, purpose: 'result', retention: 'caller' }));
  expect(f.client.service).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: 'attachment_discard', operationId: 'failed-send', ref: 'attachment:original-slot', path: 'selected/data.bin' } }), undefined);
  f.client.service.mockRejectedValueOnce(new Error('Original capture writer still draining'));
  expect(await f.cleanup()).toEqual({ pending: true });
  expect(f.client.releaseScope).not.toHaveBeenCalled();
  f.runtime.managedSource.mockRejectedValueOnce(new Error('Source Host offline'));
  expect(await f.cleanup()).toEqual({ pending: true });
});
