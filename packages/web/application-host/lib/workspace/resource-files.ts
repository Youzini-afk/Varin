import { createHash } from 'node:crypto';
import { parseProjectSourceSelection, type ProjectSourceSelection } from '@varin/application-client';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { attachmentMimeType } from '@varin/protocol';
import { readOfficeFilesystem, type OfficeFilesystemRenderer } from '../office/filesystem-reader.js';
import path from 'node:path';
import os from 'node:os';
import type { ResourceFileCommand, ResourceFileResult, ResourceFileEntry } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { resolveWorkspacePath, normalizePathIdentity, normalizeWorkspaceRelativePath } from './path-safety.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';

export interface ResourceWorkspaceRequest { selection?: ProjectSourceSelection; root?: string; workspaceId?: string; command: ResourceFileCommand; taskSource?: { runId: string; source: import('../kernel/protocol.generated.js').LaunchSource } }
export interface ResourceWorkspaceUpload { selection?: ProjectSourceSelection; root: string; workspaceId: string; path: string; key: string; byteLength: number }
export type ResourceWorkspaceAsset = Omit<import('@varin/application-client').ResourceAssetRequest,'resourceOwner' | 'task'>;
export interface ResourceFilesOwner {
  asset(input:ResourceWorkspaceAsset,signal?:AbortSignal):Promise<Response>;
  request(input: ResourceWorkspaceRequest, signal?: AbortSignal): Promise<ResourceFileResult>;
  upload(input: ResourceWorkspaceUpload, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ kind: 'done' }>;
}
const checked = (value: unknown): string => { if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path'); return value; };

/** User operations share Documents admission and native file transactions with the editor. */
export function createResourceFilesOwner(documents: DocumentAuthority, files: KernelFileResourceBackend,
  fileTarget?: import('../kernel/thread-file-target.js').ThreadFileTargetResolver,
  prepareProjectSelection?: (selection: Extract<ProjectSourceSelection,{mode:'native_workspace'}>, signal?: AbortSignal) => Promise<{path:string;originalRoot:string}>,
  search?: { files: Pick<ReturnType<typeof import('../fs/search.js').createFsSearchRuntime>, 'searchFilesystemFiles'>; content: ReturnType<typeof import('../search/content.js').createWorkspaceContentSearch> },
  renderOffice?:OfficeFilesystemRenderer): ResourceFilesOwner {
  const resolve = async (root: string, workspaceId?: string, signal?: AbortSignal, rawSelection?: ProjectSourceSelection) => {
    const selection = rawSelection === undefined ? undefined : parseProjectSourceSelection(rawSelection);
    const adopted = selection?.mode === 'native_workspace' ? await (async () => {
      if (!prepareProjectSelection) throw new Error('The original native project owner is unavailable');
      return prepareProjectSelection(selection, signal);
    })() : undefined;
    const workspace = await documents.resolveWorkspace({ path: adopted?.path ?? checked(root) });
    const registered = await documents.admitWorkspaceRegistration(workspace.workspaceId, signal);
    if (workspaceId && workspaceId !== workspace.workspaceId) throw new Error('The file location changed; reopen it');
    const physical = await documents.inspectWorkspace(workspace.workspaceId);
    const identity: RecoveryIdentity = { authorityId: registered.hostId, filesystemProfile: process.platform,
      workspaceId: workspace.workspaceId, canonicalRoot: physical.root };
    return { identity, root: physical.root, displayRoot: adopted?.originalRoot ?? physical.root };
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
    async asset(input,signal) {
      signal?.throwIfAborted();
      if(!input.asset || !['raw','serve','office-preview','office-read'].includes(input.asset.kind))throw new Error('Unknown file asset');
      const {root}=await resolve(input.root,input.workspaceId,signal,input.selection);
      const file=await target(root,input.path);
      const stats=await fs.stat(file.absolutePath);
      if(!stats.isFile())throw new Error('Choose a file inside this location');
      if(input.asset.kind==='office-preview'||input.asset.kind==='office-read') {
        const bytes=await fs.readFile(file.absolutePath,{...(signal?{signal}:{})});
        return readOfficeFilesystem(bytes,file.absolutePath,input.asset.kind==='office-read'?input.asset.input:{view:'preview',...(input.asset.expectedRevision===undefined?{}:{expectedRevision:input.asset.expectedRevision})},renderOffice,signal);
      }
      const mime:Record<string,string>={'.html':'text/html','.htm':'text/html','.css':'text/css','.js':'application/javascript','.mjs':'application/javascript','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain'};
      if(input.asset.expectedRevision!==undefined) {
        const hash=createHash('sha256');
        for await(const chunk of createReadStream(file.absolutePath,{...(signal?{signal}:{})}))hash.update(chunk);
        const revision=`sha256-${hash.digest('hex')}`;
        if(revision!==input.asset.expectedRevision)return Response.json({error:'The file changed. Refresh its current revision.',revision},{status:409});
      }
      const stream=createReadStream(file.absolutePath,{...(signal?{signal}:{})});
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{headers:{'Content-Type':mime[path.extname(file.absolutePath).toLowerCase()]??attachmentMimeType(file.absolutePath),'Content-Length':String(stats.size),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
    },
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
        if (input.selection && original) throw new Error('Choose a project source or task source, not both');
        const { root, displayRoot, identity } = await resolve(task?.kind === 'document' ? task.root : command.path?.trim() || os.homedir(), undefined, signal, input.selection);
        return { kind: 'opened', root: displayRoot, workspaceId: identity.workspaceId, locations: [...new Set([os.homedir(), path.parse(root).root])] };
      }
      if (!input.root || !input.workspaceId) throw new Error('Choose a file location first');
      const { root, identity } = await resolve(input.root, input.workspaceId, signal, input.selection);
      const file = await (['readlink', 'symlink', 'remove', 'rename', 'copy'].includes(command.kind) ? entryTarget : target)(root, command.path);
      if (command.kind === 'filename-search' || command.kind === 'content-search') {
        if (!search) throw new Error('The original file search owner is unavailable');
        if (typeof command.query !== 'string') throw new Error('A search query is required');
        if (command.maxResults !== undefined && (!Number.isSafeInteger(command.maxResults) || command.maxResults < 1)) throw new Error('Invalid search result limit');
        const common = { query: command.query,
          ...(command.includeHidden === undefined ? {} : { includeHidden: command.includeHidden }),
          ...(command.respectGitignore === undefined ? {} : { respectGitignore: command.respectGitignore }) };
        if (command.kind === 'filename-search') {
          const found = await search.files.searchFilesystemFiles(file.absolutePath, { ...common,
            ...(command.maxResults === undefined ? {} : { limit: command.maxResults }), ...(signal ? {signal} : {}) });
          return { kind: 'filename-search', results: found.map(item => ({path: path.posix.join(file.relativePath, item.relativePath)})), enumerationStatus: found.enumerationStatus ?? 'incomplete' };
        }
        // The accepted Documents view, never a caller-supplied search workspace,
        // selects the original compute owner. Hits retain that view's identity.
        const result = await search.content.searchContent({ ...common, workspaceId: identity.workspaceId,
          ...(file.relativePath ? { paths: [file.relativePath] } : {}),
          ...(command.maxResults === undefined ? {} : { maxResults: command.maxResults }),
          ...(command.ignoreCase === undefined ? {} : { ignoreCase: command.ignoreCase }),
          ...(command.fixedStrings === undefined ? {} : { fixedStrings: command.fixedStrings }),
          ...(command.glob === undefined ? {} : { glob: command.glob }),
          ...(command.before === undefined ? {} : { before: command.before }),
          ...(command.after === undefined ? {} : { after: command.after }),
        }, { generation: 0, ...(signal ? {signal} : {}) });
        return { kind: 'content-search', result };
      }
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
              // Node stat modes include the file type. The native file state carries the kind separately.
              const result = await files.writeStream(identity, destination.relativePath, createReadStream(file.absolutePath), {
                byteLength: stats.size, mode: stats.mode & 0o7777, operationId: command.key,
                expected: { kind: 'missing' }, ...(signal ? { signal } : {}),
              });
              if (result.status !== 'applied') throw new Error('The destination already exists');
            }
          }
        });
      } else throw new Error('Unknown file operation');
      return { kind: 'done' };
    },
    async upload(input, body, signal) {
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || !input.key) throw new Error('Invalid upload metadata');
      const { root, identity } = await resolve(input.root, input.workspaceId, signal, input.selection);
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
