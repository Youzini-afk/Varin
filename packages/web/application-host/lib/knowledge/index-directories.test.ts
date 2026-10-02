import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIndexDirectoryManager, type IndexDirectoryManagerOptions } from './index-directories.js';
import { createProjectIndexScope } from './index-scope.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(overrides: Partial<IndexDirectoryManagerOptions> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'varin-index-directories-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const scope = createProjectIndexScope([]);
  const check = vi.fn(async () => undefined);
  const purge = vi.fn(async () => undefined);
  const options: IndexDirectoryManagerOptions = { dataDir,
    resolve: async (directory) => { await mkdir(directory, { recursive: true }); return { path: await realpath(directory), workspaceId: path.basename(directory) }; },
    apply: async (entries) => { scope.update(entries.filter((entry) => entry.state === 'active').map((entry) => entry.path),
      entries.filter((entry) => entry.state === 'paused').map((entry) => entry.path),
      entries.filter((entry) => entry.state === 'deleting' || entry.state === 'removed').map((entry) => entry.path)); },
    check, purge, ...overrides,
  };
  const manager = createIndexDirectoryManager(options);
  cleanups.push(() => manager.dispose());
  await manager.load();
  return { dataDir, manager, check, purge, scope, options };
}

describe('index directory management', () => {
  it('keeps a separately selected child active when its parent is removed from project folders', async () => {
    const f = await fixture();
    const parent = path.join(f.dataDir, 'parent');
    const child = path.join(parent, 'child');
    await f.manager.syncProjects([parent, child]); await f.manager.drain();
    await f.manager.syncProjects([child]); await f.manager.drain();
    expect(f.manager.snapshot().entries).toEqual([expect.objectContaining({ path: await realpath(child), state: 'active', project: true })]);
    expect(f.scope.get().directories).toEqual([await realpath(child)]);
  });
  it('does not start late filesystem work when paused during source resolution', async () => {
    const f = await fixture();
    const directory = path.join(f.dataDir, 'project');
    await f.manager.syncProjects([directory]); await f.manager.drain();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.options.resolve = async () => { await gate; return { path: directory, workspaceId: 'project' }; };
    await f.manager.act('check', directory, f.manager.snapshot().revision);
    await f.manager.act('pause', directory, f.manager.snapshot().revision);
    release(); await f.manager.drain();
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.manager.snapshot().entries[0]?.state).toBe('paused');
  });
  it('keeps unavailable project folders visible without blocking other project directories', async () => {
    const f = await fixture();
    const available = path.join(f.dataDir, 'available');
    const missing = path.join(f.dataDir, 'missing');
    const original = f.options.resolve;
    f.options.resolve = async (directory) => { if (directory === missing) throw new Error('Drive disconnected'); return original(directory); };
    await f.manager.syncProjects([missing, available]); await f.manager.drain();
    expect(f.manager.snapshot().entries.find((entry) => entry.path === missing)?.error).toBe('Drive disconnected');
    expect(f.check).toHaveBeenCalledTimes(1);
    f.options.resolve = original;
    await f.manager.act('check', missing, f.manager.snapshot().revision); await f.manager.drain();
    expect(f.manager.snapshot().entries.find((entry) => entry.path === missing)).toMatchObject({ workspaceId: 'missing', error: undefined });
    expect(f.check).toHaveBeenCalledTimes(2);
  });
  it('lists existing caches without resuming them and removes caches whose source directory no longer exists', async () => {
    const directory = path.join(tmpdir(), 'missing-index-source');
    const resolve = vi.fn(async () => { throw new Error('Source is gone'); });
    const f = await fixture({ resolve, cached: async () => [{ path: directory, workspaceId: 'old-root' }] });
    const listed = await f.manager.list();
    expect(listed.entries).toEqual([expect.objectContaining({ path: directory, state: 'paused' })]);
    expect(f.scope.get().directories).toEqual([]);
    await f.manager.act('remove', directory, listed.revision); await f.manager.drain();
    expect(resolve).not.toHaveBeenCalled();
    expect(f.purge).toHaveBeenCalledWith(directory);
    expect((await f.manager.list()).entries).toEqual([]);
  });
  it('persists pause, accepts one manual check, and keeps deleted project folders removed after restart', async () => {
    const f = await fixture();
    const project = path.join(f.dataDir, 'project');
    const manual = path.join(f.dataDir, 'references');
    await f.manager.syncProjects([project]); await f.manager.drain();
    expect(f.check).toHaveBeenCalledTimes(1);
    await f.manager.act('pause', project, f.manager.snapshot().revision);
    expect(f.scope.get().directories).toEqual([]);
    expect(f.scope.get().pausedDirectories).toEqual([await realpath(project)]);
    await f.manager.act('check', project, f.manager.snapshot().revision); await f.manager.drain();
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(f.manager.snapshot().entries[0]?.state).toBe('paused');
    await f.manager.act('add', manual, f.manager.snapshot().revision); await f.manager.drain();
    await f.manager.act('remove', project, f.manager.snapshot().revision); await f.manager.drain();
    expect(f.purge).toHaveBeenCalledWith(await realpath(project));
    expect(f.manager.snapshot().entries.map((entry) => entry.path)).toEqual([await realpath(manual)]);
    await f.manager.dispose();
    const reopened = createIndexDirectoryManager(f.options);
    cleanups.push(() => reopened.dispose());
    await reopened.load(); await reopened.syncProjects([project]); await reopened.drain();
    expect(reopened.snapshot().entries.map((entry) => entry.path)).toEqual([await realpath(manual)]);
  });

  it('keeps failed cleanup visible and retries without deleting the project folder selection', async () => {
    let failing = true;
    const f = await fixture({ purge: async () => { if (failing) throw new Error('Cache is locked'); } });
    const directory = path.join(f.dataDir, 'project');
    await f.manager.syncProjects([directory]); await f.manager.drain();
    await f.manager.act('remove', directory, f.manager.snapshot().revision); await f.manager.drain();
    expect(f.manager.snapshot().entries[0]).toMatchObject({ state: 'deleting', project: true, error: 'Cache is locked', busy: false });
    failing = false;
    await f.manager.act('remove', directory, f.manager.snapshot().revision); await f.manager.drain();
    expect(f.manager.snapshot().entries).toEqual([]);
    expect(f.manager.allEntries()[0]?.project).toBe(true);
  });

  it('rejects stale mutations and cancels an accepted background check when paused', async () => {
    const f = await fixture();
    const directory = path.join(f.dataDir, 'project');
    await f.manager.syncProjects([directory]); await f.manager.drain();
    const revision = f.manager.snapshot().revision;
    const oldSignal = f.scope.get().signal;
    await f.manager.act('pause', directory, revision);
    expect(oldSignal.aborted).toBe(true);
    await expect(f.manager.act('resume', directory, revision)).rejects.toThrow('changed elsewhere');
    expect(f.manager.snapshot().entries[0]?.state).toBe('paused');
  });
});
