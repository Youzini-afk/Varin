import { expect, it, vi } from 'vitest';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { ManagedSourceLocalScope } from './managed-remote-types.js';
import { createManagedAttachmentImport } from './managed-attachment-import.js';

it.each(['external', 'run'] as const)('attributes %s attachment imports and cleanup to the original execution owner', async kind => {
  const issueGrant = vi.fn(async (input: Parameters<KernelClient['issueGrant']>[0]) => ({ ...input, grantId: input.grantId }));
  const putRecord = vi.fn(async (_input: { payloadJson: string }) => ({}));
  const retireGrant = vi.fn(async () => undefined);
  const kernel = { issueGrant, retireGrant, scoped: () => ({
    getRecord: vi.fn(async () => null), putRecord,
    listRecords: vi.fn(async () => ({ records: [], nextCursor: null })),
  }) } as unknown as KernelClient;
  const scope = {
    principal: { principalId: 'paired', capabilities: ['filesystem:read'] },
    coordinatorHostId: 'coordinator', authorityId: 'original-authority', resourceEpoch: 'epoch',
    scope: kind === 'external'
      ? { kind, conversationId: 'external:conversation', transportId: 'external-process:original' }
      : { kind, threadId: 'native-thread', runId: 'native-run' },
    source: { workspace_id: 'workspace', execution_workspace_id: 'execution' },
    operationId: kind === 'external' ? 'external-process:original' : null,
  } as ManagedSourceLocalScope;
  const owner = createManagedAttachmentImport(kernel);
  const request = { coordinatorHostId: 'coordinator', authorityId: 'original-authority', resourceEpoch: 'epoch',
    operationId: 'attachment-delivery',
    attachment: { ref: 'attachment:original', filename: 'original.txt', mimeType: 'text/plain', byteLength: 0 },
    contentHash: `sha256-${'0'.repeat(64)}` };
  await expect(owner.begin(scope, request)).resolves.toEqual({ retained: true, complete: false });
  const grant = issueGrant.mock.calls[0]![0];
  if (kind === 'external') {
    expect(grant).toMatchObject({ threadId: 'external:conversation', externalTransportId: 'external-process:original', operationId: 'external-process:original' });
    expect(grant).not.toHaveProperty('runId');
  } else {
    expect(grant).toMatchObject({ threadId: 'native-thread', runId: 'native-run', operationId: expect.stringMatching(/^attachment-import:/) });
    expect(grant).not.toHaveProperty('externalTransportId');
  }
  expect(JSON.parse(putRecord.mock.calls[0]![0].payloadJson)).toMatchObject({ operationId: 'attachment-delivery', authorityId: 'original-authority' });
  await owner.cleanup({ ...scope, operationId: scope.operationId ?? null });
  const cleanupGrant = issueGrant.mock.calls[1]![0];
  if (kind === 'external') expect(cleanupGrant).toMatchObject({ externalTransportId: 'external-process:original', operationId: 'external-process:original' });
  else expect(cleanupGrant).not.toHaveProperty('operationId');
  expect(retireGrant).toHaveBeenCalledTimes(2);
});
