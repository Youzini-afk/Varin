import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceRegistry, type WorkspaceRegistryOptions } from './workspace-registry.js';

const hostId = 'registry-test-host';
const base = path.resolve(path.parse(process.cwd()).root, 'registry-tests');
const entry = (canonicalPath: string, kind?: 'directory' | 'file') => ({
  workspaceId: randomUUID(), canonicalPath, ...(kind ? { kind } : {}),
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = (entries: ReturnType<typeof entry>[] = []) => {
  let serialized = JSON.stringify({ schemaVersion: 1, hostId, workspaces: entries });
  let staged = '';
  const fs = {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => serialized),
    writeFile: vi.fn(async (_file: string, content: string) => { staged = content; }),
    rename: vi.fn(async () => { serialized = staged; }),
    unlink: vi.fn(async () => undefined),
  };
  const registry = createWorkspaceRegistry({
    hostId,
    filePath: path.join(base, 'registry.json'),
    fsPromises: fs as unknown as WorkspaceRegistryOptions['fsPromises'],
  });
  return { registry, fs };
};

describe('workspace registry lookup and publication', () => {
  it('resolves the nearest directory including filesystem roots without treating file roots as directories', async () => {
    const root = entry(path.parse(base).root);
    const project = entry(base);
    const nested = entry(path.join(base, 'nested'));
    const file = entry(path.join(nested.canonicalPath, 'paper.pdf'), 'file');
    const { registry } = fixture([root, project, nested, file]);
    expect(await registry.get(project.workspaceId)).toMatchObject(project);
    expect(await registry.resolve({ workspaceId: nested.workspaceId })).toMatchObject(nested);
    expect(await registry.findExact(path.join(base, 'nested', '..', 'nested'))).toMatchObject(nested);
    expect(await registry.findExact(file.canonicalPath, 'file')).toMatchObject(file);
    expect(await registry.findExact(file.canonicalPath, 'directory')).toBeNull();
    expect(await registry.findContaining(path.join(file.canonicalPath, 'child'))).toMatchObject(nested);
    expect(await registry.findContaining(path.join(base + '-other', 'child'))).toMatchObject(root);
    expect(await registry.findContaining(root.canonicalPath)).toMatchObject(root);
    const exposed = await registry.get(project.workspaceId);
    exposed!.canonicalPath = 'caller-owned change';
    expect((await registry.get(project.workspaceId))?.canonicalPath).toBe(base);
  });

  it('shares one cold load between concurrent callers and persists a concurrent same-root registration once', async () => {
    const existing = entry(base);
    const { registry, fs } = fixture([existing]);
    const load = deferred();
    const originalRead = fs.readFile.getMockImplementation()!;
    fs.readFile.mockImplementation(async () => { await load.promise; return originalRead(); });
    const reads = Array.from({ length: 24 }, () => registry.get(existing.workspaceId));
    load.resolve();
    expect((await Promise.all(reads)).every(result => result?.workspaceId === existing.workspaceId)).toBe(true);
    expect(fs.readFile).toHaveBeenCalledTimes(1);

    const addedPath = path.join(base, 'new');
    const created = await Promise.all(Array.from({ length: 16 }, () => registry.resolve({ canonicalPath: addedPath, create: true })));
    expect(new Set(created.map(result => result?.workspaceId)).size).toBe(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(await registry.findExact(addedPath)).toEqual(created[0]);
    expect((await registry.list()).length).toBe(2);
  });

  it('does not publish an uncommitted candidate and leaves all lookup indexes intact after a failed rename', async () => {
    const existing = entry(base);
    const { registry, fs } = fixture([existing]);
    await registry.get(existing.workspaceId);
    const started = deferred();
    const finish = deferred();
    fs.rename.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      throw new Error('rename failed');
    });
    const addedPath = path.join(base, 'candidate');
    const pending = registry.resolve({ canonicalPath: addedPath, create: true });
    const rejected = expect(pending).rejects.toThrow('rename failed');
    await started.promise;
    expect(await registry.findExact(addedPath)).toBeNull();
    expect(await registry.findContaining(path.join(addedPath, 'child'))).toMatchObject(existing);
    finish.resolve();
    await rejected;
    expect(await registry.findExact(addedPath)).toBeNull();
    expect((await registry.list()).length).toBe(1);
    const created = await registry.resolve({ canonicalPath: addedPath, create: true });
    expect(await registry.get(created!.workspaceId)).toEqual(created);
    expect(await registry.findContaining(path.join(addedPath, 'child'))).toEqual(created);
  });

  it('retries a failed shared load and preserves exact-path kind selection', async () => {
    const directory = entry(base, 'directory');
    const file = entry(base, 'file');
    const { registry, fs } = fixture([directory, file]);
    fs.readFile.mockRejectedValueOnce(Object.assign(new Error('temporarily inaccessible'), { code: 'EACCES' }));
    const first = await Promise.allSettled([registry.list(), registry.get(directory.workspaceId)]);
    expect(first.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(await registry.findExact(base, 'file')).toMatchObject(file);
    expect(await registry.findExact(base, 'directory')).toMatchObject(directory);
    expect(fs.readFile).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform === 'win32')('uses canonical Windows case and namespace aliases without merging different targets', async () => {
    const project = entry(base);
    const { registry } = fixture([project]);
    expect(await registry.findExact(base.toUpperCase())).toMatchObject(project);
    expect(await registry.findExact(path.toNamespacedPath(base))).toMatchObject(project);
    expect(await registry.findContaining(path.join(base.toUpperCase(), 'child'))).toMatchObject(project);
    expect(await registry.findExact(base + '-other')).toBeNull();
  });
});
