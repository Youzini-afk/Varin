import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResourceFileCommand, ResourceFileResult, ResourceFileEntry } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { resolveWorkspacePath, normalizePathIdentity, normalizeWorkspaceRelativePath } from './path-safety.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';

export interface ResourceWorkspaceRequest { root?: string; workspaceId?: string; command: ResourceFileCommand; taskSource?: { runId: string; source: import('../kernel/protocol.generated.js').LaunchSource } }
export interface ResourceWorkspaceUpload { root: string; workspaceId: string; path: string; key: string; byteLength: number }
export interface ResourceFilesOwner {
  request(input: ResourceWorkspaceRequest, signal?: AbortSignal): Promise<ResourceFileResult>;
  upload(input: ResourceWorkspaceUpload, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ kind: 'done' }>;
}
const checked = (value: unknown): string => { if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path'); return value; };

/** User operations share Documents admission and native file transactions with the editor. */
export function createResourceFilesOwner(documents: DocumentAuthority, files: KernelFileResourceBackend,
  fileTarget?: import('../kernel/thread-file-target.js').ThreadFileTargetResolver): ResourceFilesOwner {
  const resolve = async (root: string, workspaceId?: string, signal?: AbortSignal) => {
    const workspace = await documents.resolveWorkspace({ path: checked(root) });
    const registered = await documents.admitWorkspaceRegistration(workspace.workspaceId, signal);
    if (workspaceId && workspaceId !== workspace.workspaceId) throw new Error('The file location changed; reopen it');
    const physical = await documents.inspectWorkspace(workspace.workspaceId);
    const identity: RecoveryIdentity = { authorityId: registered.hostId, filesystemProfile: process.platform,
      workspaceId: workspace.workspaceId, canonicalRoot: physical.root };
    return { identity, root: physical.root };
  };
  const target = (root: string, name: string) => resolveWorkspacePath(checked(name), { root, allowMissing: true });
  const entryTarget = async (root: string, name: string) => {
    const relativePath = normalizeWorkspaceRelativePath(checked(name));
    if (!relativePath) return target(root, '');
    const parent = await target(root, path.posix.dirname(relativePath));
    return { ...parent, relativePath, absolutePath: path.join(parent.absolutePath, path.posix.basename(relativePath)) };
  };
  const mutate = <T>(identity: RecoveryIdentity, id: string, paths: string[], action: () => Promise<T>) =>
    documents.runMutationForScope(identity.workspaceId, { kind: 'user-files', id }, action,
      { resourceOperations: paths.map(resourceId => ({ resourceId, scope: 'subtree' })) });

  return {
    async request(input, signal) {
      signal?.throwIfAborted();
      const command = input.command;
      if (!command || typeof command.kind !== 'string') throw new Error('File operation is required');
      if (command.kind === 'locations') {
        const locations = process.platform === 'win32'
          ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async drive => { const root = `${drive}:/`; try { return (await fs.stat(root)).isDirectory() ? root : null; } catch { return null; } }))).filter((item): item is string => item !== null) : ['/'];
        return { kind: 'locations', locations: [...new Set([os.homedir(), ...locations])] };
      }
      if (command.kind === 'open') {
        const original = input.taskSource;
        const task = original && fileTarget ? await fileTarget(original.runId, { ...original.source, resource_owner: { kind: 'local' } }, '.', signal) : null;
        if (original && task?.kind !== 'document') throw new Error('This task has no available writable file view yet');
        const { root, identity } = await resolve(task?.kind === 'document' ? task.root : command.path?.trim() || os.homedir(), undefined, signal);
        return { kind: 'opened', root, workspaceId: identity.workspaceId, locations: [...new Set([os.homedir(), path.parse(root).root])] };
      }
      if (!input.root || !input.workspaceId) throw new Error('Choose a file location first');
      const { root, identity } = await resolve(input.root, input.workspaceId, signal);
      const file = await (['readlink', 'symlink', 'remove', 'rename', 'copy'].includes(command.kind) ? entryTarget : target)(root, command.path);
      if (command.kind === 'list') {
        const names = (await fs.readdir(file.absolutePath, { withFileTypes: true })).filter(entry => !command.query || entry.name.toLocaleLowerCase().includes(command.query.toLocaleLowerCase()))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const offset = command.cursor === undefined ? 0 : Number(command.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid directory cursor');
        const page = names.slice(offset, offset + 100);
        const entries = (await Promise.all(page.map(async (entry): Promise<ResourceFileEntry | null> => {
          const base = { name: entry.name, path: path.posix.join(file.relativePath, entry.name), kind: entry.isDirectory() ? 'directory' as const : entry.isSymbolicLink() ? 'symlink' as const : 'file' as const };
          try { const stats = await fs.lstat(path.join(file.absolutePath, entry.name)); return { ...base, size: stats.size, modifiedAt: stats.mtime.toISOString() }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return { ...base, size: 0, modifiedAt: '', unavailable: (error as Error).message }; }
        }))).filter((entry): entry is ResourceFileEntry => entry !== null);
        signal?.throwIfAborted();
        return { kind: 'list', page: { path: file.relativePath, entries, nextCursor: offset + page.length < names.length ? String(offset + page.length) : null } };
      }
      if (command.kind === 'readlink') return { kind: 'link', target: await fs.readlink(file.absolutePath) };
      if (command.kind === 'bytes') {
        if (!Number.isSafeInteger(command.offset) || command.offset < 0) throw new Error('Invalid file offset');
        const handle = await fs.open(file.absolutePath, 'r');
        try {
          const before = await handle.stat();
          const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(0, before.size - command.offset)));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, command.offset);
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('The source file changed during reading');
          return { kind: 'bytes', bytesBase64: buffer.subarray(0, bytesRead).toString('base64'), nextOffset: command.offset + bytesRead,
            eof: command.offset + bytesRead >= before.size, byteLength: before.size, version: `${before.ino}:${before.size}:${before.mtimeMs}` };
        } finally { await handle.close(); }
      }
      if (!file.relativePath) throw new Error('Choose an entry inside this location');
      if (command.kind === 'symlink') await mutate(identity, command.key, [file.relativePath], async () => {
        const result = await files.applyStateDetailed(identity, file.relativePath, { kind: 'symlink', symlinkTarget: checked(command.target) }, { expected: { kind: 'missing' }, operationId: command.key });
        if (result.status !== 'applied') throw new Error('The destination already exists');
      });
      else if (command.kind === 'mkdir') await mutate(identity, `mkdir:${file.relativePath}`, [file.relativePath], () => files.mkdir(identity, file.relativePath, false));
      else if (command.kind === 'remove') await mutate(identity, command.key, [file.relativePath], async () => {
        if (command.expectedHash || command.expectedLink !== undefined) {
          const captured = await files.captureState(identity, root, file.relativePath, { store: false });
          if (command.expectedHash && (captured.state.kind !== 'regular-file' || captured.state.objectHash !== command.expectedHash)
            || command.expectedLink !== undefined && (captured.state.kind !== 'symlink' || captured.state.symlinkTarget !== command.expectedLink)) throw new Error('The source changed after it was copied; it was not removed');
          const applied = await files.applyStateDetailed(identity, file.relativePath, { kind: 'missing' }, { expected: captured.state, operationId: command.key });
          if (applied.status !== 'applied') throw new Error('The source changed; it was not removed');
        } else await files.remove(identity, file.relativePath, { recursive: !command.emptyDirectory, operationId: command.key });
      });
      else if (command.kind === 'rename' || command.kind === 'copy') {
        const destination = await entryTarget(root, command.destination);
        if (!destination.relativePath || normalizePathIdentity(file.absolutePath) === normalizePathIdentity(destination.absolutePath)) throw new Error('Choose a different destination');
        await mutate(identity, command.key, [file.relativePath, destination.relativePath], async () => {
          if (command.kind === 'rename') {
            const result = await files.rename(identity, file.relativePath, destination.relativePath, { targetMustBeMissing: true, operationId: command.key });
            if (result !== 'renamed') throw new Error(result === 'target-exists' ? 'The destination already exists' : 'The source changed');
          } else {
            const stats = await fs.lstat(file.absolutePath);
            if (stats.isDirectory()) {
              const relative = path.relative(file.absolutePath, destination.absolutePath);
              if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('A folder cannot be copied into itself');
              const result = await files.materializeRoot(identity, destination.relativePath, file.absolutePath, { operationId: command.key, ...(signal ? { signal } : {}) });
              if (result.status !== 'materialized') throw new Error('The destination already exists');
            } else if (stats.isSymbolicLink()) {
              const captured = await files.captureState(identity, root, file.relativePath, { store: false });
              const result = await files.applyStateDetailed(identity, destination.relativePath, captured.state, { expected: { kind: 'missing' }, operationId: command.key });
              if (result.status !== 'applied') throw new Error('The destination already exists');
            } else {
              const result = await files.writeStream(identity, destination.relativePath, createReadStream(file.absolutePath), { byteLength: stats.size, mode: stats.mode, operationId: command.key, expected: { kind: 'missing' }, ...(signal ? { signal } : {}) });
              if (result.status !== 'applied') throw new Error('The destination already exists');
            }
          }
        });
      } else throw new Error('Unknown file operation');
      return { kind: 'done' };
    },
    async upload(input, body, signal) {
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || !input.key) throw new Error('Invalid upload metadata');
      const { root, identity } = await resolve(input.root, input.workspaceId, signal);
      const file = await target(root, input.path);
      if (!file.relativePath) throw new Error('A filename is required');
      await mutate(identity, input.key, [file.relativePath], async () => {
        const result = await files.writeStream(identity, file.relativePath, body, { byteLength: input.byteLength, operationId: input.key, expected: { kind: 'missing' }, ...(signal ? { signal } : {}) });
        if (result.status !== 'applied') throw new Error('The destination already exists; choose another name');
      });
      return { kind: 'done' };
    },
  };
}
