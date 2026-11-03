import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdmittedDirectoryReader } from './source-reader.js';

// Model the full-width file IDs exposed by NTFS while keeping all path changes
// and content reads on the real filesystem. Adjacent IDs must not collapse into
// the same rounded Number during admission.
const identities = vi.hoisted(() => new Map<bigint, bigint>());
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (target: Parameters<typeof actual.stat>[0], options?: { bigint?: boolean }) => {
    const observed = await actual.stat(target, { bigint: true });
    const identity = observed.isDirectory() ? identities.get(observed.ino) : undefined;
    const result = await actual.stat(target, options);
    if (identity !== undefined) result.ino = options?.bigint ? identity : Number(identity);
    return result;
  } };
});

const roots: string[] = [];
afterEach(async () => {
  identities.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('keeps distinct full-width admitted root identities distinct across replacement and restoration', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'varin-resource-identity-')); roots.push(parent);
  const root = path.join(await realpath(parent), 'admitted'), original = path.join(parent, 'original');
  await mkdir(root); await writeFile(path.join(root, 'AGENTS.md'), 'original');
  const firstId = 1n << 60n, nextId = firstId + 1n;
  expect(Number(firstId)).toBe(Number(nextId));
  identities.set((await stat(root, { bigint: true })).ino, firstId);
  const reader = await createAdmittedDirectoryReader({ domainId: 'user', viewId: 'original', root });
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'ready', content: 'original' });

  await rename(root, original); await mkdir(root); await writeFile(path.join(root, 'AGENTS.md'), 'replacement');
  identities.set((await stat(root, { bigint: true })).ino, nextId);
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'stale' });
  expect(await reader.list('')).toMatchObject({ status: 'stale' });

  await rm(root, { recursive: true }); await rename(original, root);
  expect(await reader.read('AGENTS.md')).toMatchObject({ status: 'ready', content: 'original' });
});
