import { createRequire } from 'node:module';
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { insideDirectory } from '../index-scope.js';
import { pathInRoots } from '../../workspace/path-scope.js';

const require = createRequire(import.meta.url);
const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');

/** Caller holds the workspace maintenance gate and has closed every live
 * semantic generation. Knowledge/memory databases are never touched here. */
export async function purgeSemanticWorkspaceCache(input: {
  semanticDirectory: string; workspaceId: string; resourceRoot: string; removedDirectory: string;
  preserveDirectories?: readonly string[];
}): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.workspaceId)) throw new Error('Invalid semantic workspace identity');
  const base = path.resolve(input.semanticDirectory, 'workspace');
  const target = path.resolve(base, input.workspaceId);
  if (target === base || !insideDirectory(base, target)) throw new Error('Index cache escaped its managed directory');
  let canonical: string;
  try { canonical = await realpath(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const canonicalBase = await realpath(base);
  if (canonical === canonicalBase || !insideDirectory(canonicalBase, canonical)) throw new Error('Index cache points outside its managed directory');
  const preserved = input.preserveDirectories ?? [];
  if (preserved.some((directory) => insideDirectory(directory, input.resourceRoot))) return;
  const wholeWorkspace = insideDirectory(input.removedDirectory, input.resourceRoot);
  if (wholeWorkspace && !preserved.some((directory) => insideDirectory(input.resourceRoot, directory))) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  if (!wholeWorkspace && !insideDirectory(input.resourceRoot, input.removedDirectory)) return;
  const prefix = wholeWorkspace ? '.' : path.relative(input.resourceRoot, input.removedDirectory).split(path.sep).join('/');
  for (const space of await readdir(target, { withFileTypes: true })) {
    if (!space.isDirectory()) continue;
    const spaceDirectory = path.join(target, space.name);
    if ((await lstat(spaceDirectory)).isSymbolicLink()) throw new Error('Index space must not be a symbolic link');
    const counts = new Map<string, number>();
    for (const generation of await readdir(spaceDirectory, { withFileTypes: true })) {
      if (!generation.isDirectory()) continue;
      const generationDirectory = path.join(spaceDirectory, generation.name);
      if ((await lstat(generationDirectory)).isSymbolicLink()) throw new Error('Index generation must not be a symbolic link');
      const filename = path.join(generationDirectory, 'index.tdb');
      try { if (!(await lstat(filename)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      // Existing native databases recover their stored vector dimension; this
      // maintenance path needs no model/provider and performs no embedding.
      const db = new TriviumDB(filename, { accessMode: 'readWrite', loadTextIndex: false, payloadCacheMb: 0 });
      try {
        const documents = db.indexedLookup({ type: 'document' }, Math.max(1, db.nodeCount()));
        const removed = documents.flatMap((id) => {
          const payload = db.getPayload(id) as { documentId?: string } | null;
          return payload?.documentId && pathInRoots(payload.documentId, [prefix])
            && !preserved.some((directory) => insideDirectory(directory, path.resolve(input.resourceRoot, payload.documentId!))) ? [payload.documentId] : [];
        });
        for (const documentId of removed) {
          const ids = db.indexedLookup({ documentId }, Math.max(1, db.nodeCount()));
          db.commitTransaction(ids.map((id) => ({ type: 'delete' as const, id })));
        }
        if (removed.length) db.compact();
        db.flush();
        counts.set(generation.name, db.indexedLookup({ type: 'document' }, Math.max(1, db.nodeCount())).length);
      } finally { db.close(); }
    }
    const checkpointFile = path.join(spaceDirectory, 'current.json');
    let checkpoint: Record<string, unknown>;
    try { checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const count = counts.get(String(checkpoint.generation));
    if (count === undefined) continue;
    const temporary = `${checkpointFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...checkpoint, publishedDocuments: count, coverage: count ? 'partial' : 'empty' })}\n`, { flag: 'wx' });
    await rename(temporary, checkpointFile);
  }
}

