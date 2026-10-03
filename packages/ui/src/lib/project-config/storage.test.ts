import { describe, expect, test } from 'vitest';
import type {
  DocumentsAPI,
  FilesAPI,
  VarinDocumentReadResult,
  VarinResourceReference,
} from '@varin/application-client';
import { createProjectIdFromPath } from '@/lib/projectId';
import {
  createVarinProjectConfigStore,
  VarinProjectConfigError,
  type VarinProjectConfigRuntime,
} from './storage';
import type { VarinProjectRef } from './types';

interface StoredFile {
  content: string;
  revision: string;
}

const HOME = '/home/user';
const REPO = '/repo';
const HOME_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const REPO_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const project: VarinProjectRef = { id: createProjectIdFromPath(REPO), path: REPO };

const createRuntime = () => {
  const files = new Map<string, StoredFile>();
  let revision = 1;
  let beforeWrite: ((request: Parameters<DocumentsAPI['write']>[0]) => void | Promise<void>) | null = null;
  const keyOf = (resource: VarinResourceReference) => `${resource.workspaceId}\0${resource.resourceId}`;
  const resourceForPath = (path: string): VarinResourceReference => {
    if (path === HOME || path.startsWith(`${HOME}/`)) {
      return { workspaceId: HOME_WORKSPACE, resourceId: path.slice(HOME.length).replace(/^\//, '') };
    }
    return { workspaceId: REPO_WORKSPACE, resourceId: path.slice(REPO.length).replace(/^\//, '') };
  };
  const documents: DocumentsAPI = {
    clearDirtyBuffers: async () => ({ cleared: true }),
    publishDirtyBuffers: async (request) => ({ ...request, updatedAt: '2026-08-28T00:00:00.000Z' }),
    resolveWorkspace: async ({ path }) => ({
      workspaceId: path === HOME ? HOME_WORKSPACE : REPO_WORKSPACE,
      hostId: 'host-1',
      epoch: 1,
    }),
    resolveResourceIdentity: async (resource) => ({ coordinationId: `host-1\0${keyOf(resource)}`, aliases: [resource] }),
    read: async (resource) => {
      const current = files.get(keyOf(resource));
      if (!current) return { status: 'missing', epoch: 1, resource };
      return {
        status: 'ready',
        epoch: 1,
        resource,
        revision: current.revision,
        content: current.content,
        encoding: 'utf-8',
        bom: false,
        byteLength: current.content.length,
      } satisfies VarinDocumentReadResult;
    },
    write: async (request) => {
      await beforeWrite?.(request);
      const key = keyOf(request.resource);
      const current = files.get(key);
      if (request.expectedRevision === null ? Boolean(current) : current?.revision !== request.expectedRevision) {
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
      const nextRevision = `d1_${revision++}`;
      files.set(key, { content: request.content, revision: nextRevision });
      return { status: 'written', revision: nextRevision, byteLength: request.content.length };
    },
    move: async ({ from }) => ({ status: 'missing', resource: from }),
    delete: async (request) => {
      const key = keyOf(request.resource);
      const current = files.get(key);
      if (!current) return { status: 'missing', resource: request.resource };
      if (current.revision !== request.expectedRevision) {
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
      files.delete(key);
      return { status: 'deleted', resource: request.resource };
    },
    watch: () => ({ close: () => undefined }),
    listRecoveryJournals: async () => [],
    readRecoveryJournal: async (journalId) => ({ status: 'missing', journalId }),
    writeRecoveryJournal: async () => ({ status: 'missing', journalId: '' }),
    deleteRecoveryJournal: async () => ({ status: 'missing' }),
  };
  const fileApi: FilesAPI = {
    getHomeDirectory: async () => HOME,
    listDirectory: async (directory) => ({ directory, entries: [] }),
    search: async () => [],
    createDirectory: async (path) => ({ success: true, path }),
  };
  const runtime: VarinProjectConfigRuntime = {
    documents,
    files: fileApi,
    currentDirectory: REPO,
  };
  return {
    files,
    resourceForPath,
    runtime,
    setBeforeWrite: (value: typeof beforeWrite) => {
      beforeWrite = value;
    },
  };
};

describe('Varin project configuration store', () => {
  test('keeps actions under the same project identity after changing the default folder', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    const named = { ...project, id: 'project_named' };
    await store.update(named, { waitForWorktreeSetup: true });
    const relocated = { ...named, path: `${REPO}/another-folder` };
    expect(await store.getPaths(relocated)).toEqual(await store.getPaths(named));
    expect((await store.read(relocated)).waitForWorktreeSetup).toBe(true);
  });
  test('refuses to overwrite a malformed canonical file', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    const paths = await store.getPaths(project);
    const resource = harness.resourceForPath(paths.canonicalConfig);
    harness.files.set(`${resource.workspaceId}\0${resource.resourceId}`, { content: '{broken', revision: 'd1_bad' });

    for (const operation of [
      () => store.read(project),
      () => store.update(project, { waitForWorktreeSetup: true }),
    ]) {
      try {
        await operation();
        throw new Error('expected malformed project configuration');
      } catch (error) {
        expect(error).toBeInstanceOf(VarinProjectConfigError);
        expect((error as VarinProjectConfigError).reason).toBe('malformed');
      }
    }
    expect(harness.files.get(`${resource.workspaceId}\0${resource.resourceId}`)?.content).toBe('{broken');
  });

  test('preserves unknown canonical fields across a Varin update', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    const paths = await store.getPaths(project);
    const canonical = harness.resourceForPath(paths.canonicalConfig);
    const canonicalKey = `${canonical.workspaceId}\0${canonical.resourceId}`;
    harness.files.set(canonicalKey, {
      content: JSON.stringify({
        setupWorktree: ['bun install'],
        waitForWorktreeSetup: true,
        projectNotes: 'keep me',
        futureField: { enabled: true },
      }),
      revision: 'd1_existing',
    });

    expect(await store.update(project, { projectNotes: 'updated' })).toBe(true);
    const updated = await store.read(project);
    expect(updated.projectNotes).toBe('updated');
    expect(updated.futureField).toEqual({ enabled: true });
  });

  test('serializes in-process patches so independent fields are preserved', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    expect(await Promise.all([
      store.update(project, { projectNotes: 'note' }),
      store.update(project, { waitForWorktreeSetup: true }),
    ])).toEqual([true, true]);
    const config = await store.read(project);
    expect(config.projectNotes).toBe('note');
    expect(config.waitForWorktreeSetup).toBe(true);
  });

  test('serializes read-modify-write mutations so concurrent list appends are preserved', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    const append = (id: string) => store.mutate(project, (config) => ({
      projectPlanFiles: [
        { id, path: `/plans/${id}.md`, createdAt: id === 'first' ? 1 : 2 },
        ...(config.projectPlanFiles ?? []),
      ],
    }));

    expect(await Promise.all([append('first'), append('second')])).toEqual([true, true]);
    expect((await store.read(project)).projectPlanFiles?.map((entry) => entry.id).sort()).toEqual(['first', 'second']);
  });

  test('surfaces an external revision conflict without overwriting the external edit', async () => {
    const harness = createRuntime();
    const store = createVarinProjectConfigStore(() => harness.runtime);
    expect(await store.update(project, { projectNotes: 'original' })).toBe(true);
    const paths = await store.getPaths(project);
    const canonical = harness.resourceForPath(paths.canonicalConfig);
    const key = `${canonical.workspaceId}\0${canonical.resourceId}`;
    let injected = false;
    harness.setBeforeWrite(() => {
      if (injected) return;
      injected = true;
      harness.files.set(key, {
        content: JSON.stringify({ projectNotes: 'external edit' }),
        revision: 'd1_external',
      });
    });

    expect(await store.update(project, { waitForWorktreeSetup: true })).toBe(false);
    expect(JSON.parse(harness.files.get(key)?.content ?? '{}')).toEqual({ projectNotes: 'external edit' });
  });
});
