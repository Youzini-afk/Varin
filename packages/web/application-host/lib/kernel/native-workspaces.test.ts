import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeWorkspaceOwner } from './native-workspaces.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import type { KernelClient } from './kernel-client.js';
import type { ProjectEntry } from '@varin/application-client';
import { nativeGitRoots } from './native-git-roots.js';

it('reuses project authority for internal Git data and admits linked external administration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-git-roots-'));
  try {
    const project = path.join(root, 'project'), external = path.join(root, 'external-admin');
    await mkdir(path.join(project, 'repo', '.git', 'objects'), { recursive: true });
    await mkdir(path.join(project, 'linked'), { recursive: true });
    await mkdir(path.join(external, 'objects'), { recursive: true });
    await writeFile(path.join(project, 'linked', '.git'), `gitdir: ${external}\n`);
    const resolveWorkspace = vi.fn(async ({ path: directory }: { path: string }) => ({ workspaceId: directory }));
    const roots = await nativeGitRoots(project, { resolveWorkspace,
      admitWorkspaceRegistration: async (workspaceId: string) => ({ canonicalPath: await realpath(workspaceId) }) } as never);
    expect(roots).toContain(await realpath(external));
    expect(resolveWorkspace.mock.calls.every(([input]) => input.path.startsWith(external))).toBe(true);
    expect(roots.some(directory => directory.startsWith(project))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('automatically prepares one project workspace for concurrent first tasks and reuses its native source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-project-source-'));
  try {
    let project = { id: 'project', path: directory } as ProjectEntry;
    let finish!: () => void;
    const entered = Promise.withResolvers<void>();
    const adopting = new Promise<void>(resolve => { finish = resolve; });
    let dependenciesReady = false;
    const view = { binding: { generation: 1 }, mount: { state: 'ready', path: '/mounted/project' }, rootId: 'mounted-root' };
    const actor = {
      getOperation: vi.fn(async () => null), inspectWorkspaceBackend: async () => ({ dependenciesReady, detail: 'WinFsp is not installed', helpUrl: 'https://winfsp.dev/rel/' }),
      fileRootRegister: async () => ({ rootId: 'original-root' }),
      adoptWorkspace: vi.fn(async () => { entered.resolve(); await adopting; }),
      openWorkspace: vi.fn(async () => view), mountWorkspace: vi.fn(async () => view), bindWorkspace: async () => view,
    };
    const kernel = { handshake: { kernelEpoch: 'epoch', hostId: 'host' },
      issueGrant: async (input: object) => input, revokeGrant: async () => {}, scoped: () => actor } as unknown as KernelClient;
    const documents = { resolveWorkspace: async () => ({ workspaceId: 'original' }),
      admitWorkspaceRegistration: async () => ({ canonicalPath: directory }) };
    const owner = createNativeWorkspaceOwner({ kernel, documents: documents as never, projects: async () => [project],
      update: async (_id, value) => { project = { ...project, versionedWorkspace: value }; } });
    const live = { prepare: vi.fn(async () => { throw new Error('Physical fallback must not run'); }) };
    const prepare = createThreadSourcePreparer({ documents: documents as never, nativeWorkspaces: owner,
      liveSources: live as never, workingStates: {} as never, inspectInventory: async () => { throw new Error('No old capture'); },
      sourceTools: async () => ['file_read'] });
    const input = { runtime: 'agent' as const, resourceOwner: { kind: 'local' as const }, threadId: 'thread:a', branchId: 'branch:a',
      key: 'first', workspaceId: 'original', mode: 'live_root' as const, content: { mode: 'saved-files' as const }, captureScopes: [] };
    await expect(prepare(input)).rejects.toMatchObject({ code: 'workspace_backend_unavailable', message: expect.stringContaining('WinFsp') });
    expect(actor.adoptWorkspace).not.toHaveBeenCalled();
    dependenciesReady = true;
    const first = prepare(input);
    await entered.promise;
    const second = prepare({ ...input, threadId: 'thread:b', branchId: 'branch:b' });
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a.source.mode).toBe('native_workspace');
    expect(a.source).toEqual(b.source);
    expect(a.path).toBe('/mounted/project');
    expect(actor.adoptWorkspace).toHaveBeenCalledTimes(1);
    expect(actor.openWorkspace).toHaveBeenCalledTimes(1);
    expect(project.versionedWorkspace?.state).toBe('ready');
    expect((await prepare({ ...input, key: 'next-task' })).source).toEqual(a.source);
    expect(actor.adoptWorkspace).toHaveBeenCalledTimes(1);
    expect(live.prepare).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
