import { expect, it, vi } from 'vitest';
import { createBinaryFileOwner, writeSourceBinary } from './binary-file-owner.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';

it('keeps a lost managed write response unknown and distinguishes rejection before dispatch', async () => {
  const source = { resource_owner: { kind: 'managed_host', hostId: 'remote' }, mode: 'live_root',
    workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: null, revision: null,
    live_root: { hostId: 'remote', rootId: 'root', canonicalRoot: '/workspace' } } as const;
  const authority = { runId: 'run', threadId: 'thread', operationId: 'operation', source, toolName: 'office_write' } as unknown as ToolInvocationAuthority;
  const service = vi.fn(async () => { throw new Error('response connection closed'); });
  let rejected = false;
  const runtime = { coordinatorHostId: 'local', launch: async () => ({ selection: { source } }), journalAnchor: async () => ({}),
    withManagedSourceAuthority: async (_run: string, _source: unknown, work: (value: unknown) => Promise<unknown>) => {
      if (rejected) throw new Error('source authority unavailable');
      return work({ client: { service }, binding: { authorityId: 'authority', resourceEpoch: 'epoch' } });
    } };
  const owner = createBinaryFileOwner({ runtime } as unknown as Parameters<typeof createBinaryFileOwner>[0]);
  const signal = new AbortController().signal;
  expect(await owner.write(authority, { path: 'report.docx', bytes: Buffer.from('document'), expectedRevision: null }, signal))
    .toMatchObject({ status: 'unknown', executorStopped: false, operationId: 'operation' });
  rejected = true;
  await expect(owner.write(authority, { path: 'report.docx', bytes: Buffer.from('document'), expectedRevision: null }, signal)).rejects.toThrow('source authority unavailable');
  expect(service).toHaveBeenCalledTimes(1);
});

it('preserves the original attachment in fresh and response-loss reconciled binary receipts', async () => {
  const attachment = { ref: 'attachment:original', filename: 'report.pdf', mimeType: 'application/pdf', byteLength: 3 };
  const applied = { status: 'applied', stateJson: JSON.stringify({ kind: 'regular-file', objectHash: 'sha256-original', byteLength: 3 }), attachment };
  const client = {
    fileOperationReconcile: vi.fn().mockResolvedValueOnce({ status: 'missing' }).mockResolvedValue({ status: 'reconciled', result: applied }),
    fileLeaseAcquire: vi.fn(async () => ({ status: 'acquired' })), fileLeaseRelease: vi.fn(async () => ({})),
    fileCapture: vi.fn(async () => ({ path: 'report.pdf', stateJson: JSON.stringify({ kind: 'missing' }) })),
    putBlob: vi.fn(async () => ({ ownerId: 'upload', hash: 'sha256-original', byteLength: 3 })),
    fileApply: vi.fn(async () => applied), releaseBlob: vi.fn(async () => ({})),
  };
  const request = { client, rootId: 'root', source: { mode: 'live_root', workspace_id: 'workspace' },
    operationId: 'write', tool: 'office_export', journal: {}, path: 'report.pdf', expectedRevision: null, bytes: Buffer.from('pdf') } as unknown as Parameters<typeof writeSourceBinary>[0];
  expect((await writeSourceBinary(request)).attachment).toEqual(attachment);
  expect((await writeSourceBinary({ ...request, bytes: Buffer.from('later source') })).attachment).toEqual(attachment);
  expect(client.fileApply).toHaveBeenCalledTimes(1);
  expect(client.putBlob).toHaveBeenCalledTimes(1);
  client.fileOperationReconcile.mockResolvedValue({ status: 'reconciled', result: { ...applied, attachment: { ...attachment, byteLength: 4 } } });
  expect(await writeSourceBinary(request)).toMatchObject({ status: 'unknown', executorStopped: false });
});
