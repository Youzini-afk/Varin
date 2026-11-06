import { describe, expect, test, vi } from 'vitest';
import type { DocumentsAPI, VarinDocumentReadResult } from '@varin/application-client';
import { DocumentsError } from '@varin/application-client';
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './workspace-text';

const resource = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resourceId: 'notes.txt' };
const missing: VarinDocumentReadResult = { status: 'missing', epoch: 1, resource };
const ready: VarinDocumentReadResult = {
  status: 'ready', epoch: 1, resource, content: 'original', revision: 'original-revision',
  encoding: 'utf-8', bom: true, byteLength: 8,
};

// The Host owns storage and conflict detection. Exercise the helper's requests and
// handling of those receipts, without implementing a second revisioned file store.
const fixture = () => {
  const read = vi.fn<DocumentsAPI['read']>().mockResolvedValue(missing);
  const write = vi.fn<DocumentsAPI['write']>().mockResolvedValue({ status: 'written', revision: 'saved', byteLength: 5 });
  const resolveWorkspace = vi.fn<DocumentsAPI['resolveWorkspace']>().mockResolvedValue({ workspaceId: resource.workspaceId, hostId: 'host', epoch: 1 });
  const api = { read, write, resolveWorkspace } as unknown as DocumentsAPI;
  return { api, read, write, resolveWorkspace };
};

describe('workspace text helpers', () => {
  test('distinguishes a missing file from valid empty text', async () => {
    const { api, read, resolveWorkspace } = fixture();
    expect(await readWorkspaceTextFile(api, '/repo', '/repo/notes.txt')).toBeNull();
    read.mockResolvedValueOnce({ ...ready, content: '', byteLength: 0 });
    expect(await readWorkspaceTextFile(api, '/repo', '/repo/notes.txt')).toBe('');
    expect(resolveWorkspace).toHaveBeenCalledWith({ path: '/repo' });
    expect(read).toHaveBeenLastCalledWith(resource);
  });

  test.each([missing, ready])('writes with the original revision and format: $status', async current => {
    const { api, read, write } = fixture();
    read.mockResolvedValue(current);
    expect(await writeWorkspaceTextFile(api, '/repo', '/repo/notes.txt', 'hello')).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith({
      token: { workspaceId: resource.workspaceId, epoch: 1, owner: { kind: 'workspace-text', id: 'varin-ui' } },
      resource, content: 'hello', encoding: 'utf-8', bom: current.status === 'ready',
      expectedRevision: current.status === 'ready' ? 'original-revision' : null,
      operationId: expect.any(String),
    });
  });

  test('returns a conflict without retrying an unconditional overwrite', async () => {
    const { api, read, write } = fixture();
    read.mockResolvedValue(ready);
    const current: Omit<Extract<VarinDocumentReadResult, { status: 'ready' }>, 'content'> = {
      status: 'ready', epoch: 1, resource, revision: 'external-edit', encoding: 'utf-8', bom: true, byteLength: 8,
    };
    write.mockResolvedValue({ status: 'conflict', current });
    expect(await writeWorkspaceTextFile(api, '/repo', '/repo/notes.txt', 'local edit')).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].expectedRevision).toBe('original-revision');
  });

  test('rejects paths outside the workspace before reading or writing', async () => {
    const { api, read, write } = fixture();
    await expect(readWorkspaceTextFile(api, '/repo', '/other/notes.txt')).rejects.toBeInstanceOf(DocumentsError);
    await expect(writeWorkspaceTextFile(api, '/repo', '/other/notes.txt', 'text')).rejects.toBeInstanceOf(DocumentsError);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
