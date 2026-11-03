import { expect, it, vi } from 'vitest';
import { createManagedSourceService } from './managed-source-service.js';

it('cold source file metadata checks the paired read capability and exact target registration without creating a Thread', async () => {
  const resolveWorkspace = vi.fn(async () => ({ hostId: 'B', workspaceId: 'workspace:B' }));
  const admitWorkspaceRegistration = vi.fn(async () => ({ hostId: 'B', workspaceId: 'workspace:B', canonicalPath: '/B/selected' }));
  const draftSourceFiles = vi.fn(async () => ({ entries: [{ path: 'empty', relativePath: 'empty', name: 'empty', type: 'directory' as const }], nextCursor: null }));
  const draftSourceSkills = vi.fn();
  const service = createManagedSourceService({ kernel: { subscribeExit: () => () => {} } as never, hostId: 'B',
    documents: { resolveWorkspace, admitWorkspaceRegistration } as never, prepareSource: vi.fn(), validateLiveSource: vi.fn(), draftSourceFiles, draftSourceSkills });
  const request = { coordinatorHostId: 'A', path: '/B/picked', type: 'directory' as const, limit: 3 };
  await expect(service.files({ principalId: 'paired', capabilities: [] }, request)).rejects.toMatchObject({ code: 'source_authority_denied' });
  expect(resolveWorkspace).not.toHaveBeenCalled();
  const result = await service.files({ principalId: 'paired', capabilities: ['filesystem:read'] }, request);
  expect(result.entries[0]!.type).toBe('directory');
  expect(draftSourceFiles).toHaveBeenCalledWith({ ...request, source: { resourceOwner: { kind: 'local' }, path: '/B/selected' } }, undefined);
  expect(draftSourceSkills).not.toHaveBeenCalled();
  admitWorkspaceRegistration.mockResolvedValueOnce({ hostId: 'A', workspaceId: 'workspace:B', canonicalPath: '/B/selected' });
  await expect(service.files({ principalId: 'paired', capabilities: ['filesystem:read'] }, request)).rejects.toMatchObject({ code: 'source_changed' });
  expect(draftSourceFiles).toHaveBeenCalledTimes(1);
});
