import { describe, expect, test } from 'bun:test';
import type {
  DocumentsAPI,
  VarinDocumentReadResult,
  VarinResourceReference,
} from '@varin/application-client';
import { DocumentsError } from '@varin/application-client';
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './workspace-text';

const resource = (resourceId: string): VarinResourceReference => ({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId,
});

const createDocuments = () => {
  const files = new Map<string, { content: string; revision: string }>();
  let revisionSeq = 1;
  const keyOf = (ref: VarinResourceReference) => `${ref.workspaceId}\0${ref.resourceId}`;
  const api: DocumentsAPI = {
    clearDirtyBuffers: async () => ({ cleared: true }),
    publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
    resolveWorkspace: async () => ({ workspaceId: resource('').workspaceId, hostId: 'host-1', epoch: 1 }),
    resolveResourceIdentity: async (ref) => ({ coordinationId: `host-1\0${keyOf(ref)}`, aliases: [ref] }),
    read: async (ref) => {
      const file = files.get(keyOf(ref));
      if (!file) return { status: 'missing', epoch: 1, resource: ref };
      return {
        status: 'ready',
        epoch: 1,
        resource: ref,
        revision: file.revision,
        content: file.content,
        encoding: 'utf-8',
        bom: false,
        byteLength: file.content.length,
      } satisfies VarinDocumentReadResult;
    },
    write: async (request) => {
      const key = keyOf(request.resource);
      const current = files.get(key);
      if (request.expectedRevision === null) {
        if (current) {
          return {
            status: 'conflict',
            current: {
              status: 'ready',
              epoch: 1,
              resource: request.resource,
              revision: current.revision,
              encoding: 'utf-8',
              bom: false,
              byteLength: current.content.length,
            },
          };
        }
      } else if (!current || current.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          current: current
            ? {
                status: 'ready',
                epoch: 1,
                resource: request.resource,
                revision: current.revision,
                encoding: 'utf-8',
                bom: false,
                byteLength: current.content.length,
              }
            : { status: 'missing', epoch: 1, resource: request.resource },
        };
      }
      const revision = `d1_${revisionSeq++}`;
      files.set(key, { content: request.content, revision });
      return { status: 'written', revision, byteLength: request.content.length };
    },
    move: async () => ({ status: 'missing', resource: resource('x') }),
    delete: async (request) => ({ status: 'deleted', resource: request.resource }),
    watch: () => ({ close: () => undefined }),
    listRecoveryJournals: async () => [],
    readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
    writeRecoveryJournal: async () => ({ status: 'missing', journalId: '' }),
    deleteRecoveryJournal: async () => ({ status: 'missing' }),
  };
  return { api, files };
};

describe('workspace text helpers', () => {
  test('reads missing files as null and writes create-if-missing', async () => {
    const { api, files } = createDocuments();
    expect(await readWorkspaceTextFile(api, '/repo', '/repo/notes.txt')).toBeNull();
    expect(await writeWorkspaceTextFile(api, '/repo', '/repo/notes.txt', 'hello')).toBe(true);
    expect(files.get(`${resource('notes.txt').workspaceId}\0notes.txt`)?.content).toBe('hello');
    expect(await readWorkspaceTextFile(api, '/repo', '/repo/notes.txt')).toBe('hello');
  });

  test('rejects paths outside the workspace root', async () => {
    const { api } = createDocuments();
    try {
      await readWorkspaceTextFile(api, '/repo', '/other/notes.txt');
      throw new Error('expected path-escape');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentsError);
    }
  });

  test('does not overwrite a concurrent external edit after a revision conflict', async () => {
    const { api, files } = createDocuments();
    const key = `${resource('notes.txt').workspaceId}\0notes.txt`;
    files.set(key, { content: 'original', revision: 'd1_external-1' });
    const write = api.write;
    let injected = false;
    api.write = async (request) => {
      if (!injected) {
        injected = true;
        files.set(key, { content: 'external edit', revision: 'd1_external-2' });
      }
      return write(request);
    };

    expect(await writeWorkspaceTextFile(api, '/repo', '/repo/notes.txt', 'local edit')).toBe(false);
    expect(files.get(key)?.content).toBe('external edit');
  });
});
