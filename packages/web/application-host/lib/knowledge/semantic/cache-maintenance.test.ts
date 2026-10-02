import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { purgeSemanticWorkspaceCache } from './cache-maintenance.js';

const { TriviumDB } = createRequire(import.meta.url)('triviumdb') as typeof import('triviumdb');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('semantic cache deletion', () => {
  it('removes a folder from all vector spaces, preserves its sibling and source files, and can delete the full cache', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'varin-index-cache-delete-'));
    directories.push(dataDir);
    const semanticDirectory = path.join(dataDir, 'knowledge', 'host', 'semantic');
    const workspaceId = 'workspace-test';
    const resourceRoot = path.join(dataDir, 'source');
    await mkdir(resourceRoot);
    await writeFile(path.join(resourceRoot, 'source.txt'), 'keep source');
    for (const space of ['previous-model', 'current-model']) {
      const base = path.join(semanticDirectory, 'workspace', workspaceId, space);
      await mkdir(path.join(base, 'g1'), { recursive: true });
      const db = new TriviumDB(path.join(base, 'g1', 'index.tdb'), { dim: 3 });
      try {
        db.createIndex('type'); db.createIndex('documentId');
        for (const folder of ['delete-me', 'keep-me']) {
          db.insert([0, 0, 0], { type: 'document', documentId: `${folder}/file.ts` });
          db.insert([1, 0, 0], { type: 'block', documentId: `${folder}/file.ts`, body: folder });
        }
        db.flush();
      } finally { db.close(); }
      await writeFile(path.join(base, 'current.json'), JSON.stringify({ generation: 'g1', publishedDocuments: 2, coverage: 'complete' }));
    }
    await purgeSemanticWorkspaceCache({ semanticDirectory, workspaceId, resourceRoot, removedDirectory: path.join(resourceRoot, 'delete-me') });
    for (const space of ['previous-model', 'current-model']) {
      const base = path.join(semanticDirectory, 'workspace', workspaceId, space);
      const db = new TriviumDB(path.join(base, 'g1', 'index.tdb'), { accessMode: 'readOnly' });
      try {
        expect(db.dim()).toBe(3);
        expect(db.indexedLookup({ documentId: 'delete-me/file.ts' }, 20)).toEqual([]);
        expect(db.indexedLookup({ documentId: 'keep-me/file.ts' }, 20)).toHaveLength(2);
      } finally { db.close(); }
      expect(JSON.parse(await readFile(path.join(base, 'current.json'), 'utf8')).publishedDocuments).toBe(1);
    }
    expect(await readFile(path.join(resourceRoot, 'source.txt'), 'utf8')).toBe('keep source');
    await purgeSemanticWorkspaceCache({ semanticDirectory, workspaceId, resourceRoot, removedDirectory: resourceRoot,
      preserveDirectories: [path.join(resourceRoot, 'keep-me')] });
    const preservedDb = new TriviumDB(path.join(semanticDirectory, 'workspace', workspaceId, 'current-model', 'g1', 'index.tdb'), { accessMode: 'readOnly' });
    try { expect(preservedDb.indexedLookup({ documentId: 'keep-me/file.ts' }, 20)).toHaveLength(2); }
    finally { preservedDb.close(); }
    await purgeSemanticWorkspaceCache({ semanticDirectory, workspaceId, resourceRoot, removedDirectory: resourceRoot });
    await expect(stat(path.join(semanticDirectory, 'workspace', workspaceId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(resourceRoot, 'source.txt'), 'utf8')).toBe('keep source');
  });
});
