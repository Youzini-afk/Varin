import { expect, it, vi } from 'vitest';
import { createBinaryFileOwner } from './binary-file-owner.js';
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
