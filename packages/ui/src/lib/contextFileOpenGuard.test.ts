import { describe, expect, test } from 'vitest';

import type { DocumentsAPI, VarinDocumentReadResult, VarinResourceReference } from '@varin/application-client';
import { validateContextFileOpen } from './contextFileOpenGuard';

const resource = (resourceId: string): VarinResourceReference => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const documentsApi = (content: string | null): DocumentsAPI => ({
  clearDirtyBuffers: async () => ({ cleared: true }),
  publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
  resolveWorkspace: async () => ({ workspaceId: resource('').workspaceId, hostId: 'host-1', epoch: 1 }),
  resolveResourceIdentity: async (ref) => ({ coordinationId: `host-1\0${ref.workspaceId}\0${ref.resourceId}`, aliases: [ref] }),
  read: async (ref) => {
    if (content === null) return { status: 'missing', epoch: 1, resource: ref };
    return {
      status: 'ready',
      epoch: 1,
      resource: ref,
      revision: 'd1_1',
      content,
      encoding: 'utf-8',
      bom: false,
      byteLength: content.length,
    } satisfies VarinDocumentReadResult;
  },
  write: async () => ({ status: 'written', revision: 'd1_1', byteLength: 0 }),
  move: async () => ({ status: 'missing', resource: resource('x') }),
  delete: async (request) => ({ status: 'deleted', resource: request.resource }),
  watch: () => ({ close: () => undefined }),
  listRecoveryJournals: async () => [],
  readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
  writeRecoveryJournal: async () => ({ status: 'missing', journalId: '' }),
  deleteRecoveryJournal: async () => ({ status: 'missing' }),
});

describe('validateContextFileOpen', () => {
  test('allows known binaries through without reading text', async () => {
    const documents = documentsApi('should not be used');
    expect(await validateContextFileOpen(documents, '/repo/docs/report.pdf', { directory: '/repo' })).toEqual({ ok: true });
    expect(await validateContextFileOpen(documents, '/repo/docs/report.docx', { directory: '/repo' })).toEqual({ ok: true });
    expect(await validateContextFileOpen(documents, '/repo/docs/pixel.png', { directory: '/repo' })).toEqual({ ok: true });
    expect(await validateContextFileOpen(documents, '/repo/bin/archive.zip', { directory: '/repo' })).toEqual({ ok: true });
  });

  test('rejects text payloads that look binary', async () => {
    expect(await validateContextFileOpen(documentsApi('%PDF-1.7\nbinary'), '/repo/mystery.bin.bak', { directory: '/repo' })).toEqual({
      ok: false,
      reason: 'binary',
    });
  });

  test('allows ordinary text files', async () => {
    expect(await validateContextFileOpen(documentsApi('hello\nworld\n'), '/repo/notes.txt', { directory: '/repo' })).toEqual({ ok: true });
  });

  test('does not impose the retired 5000-line editor limit', async () => {
    expect(await validateContextFileOpen(documentsApi('line\n'.repeat(5_001)), '/repo/generated.txt', { directory: '/repo' })).toEqual({ ok: true });
  });
});
