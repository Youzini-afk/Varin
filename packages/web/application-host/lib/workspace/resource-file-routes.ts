import {sendResourceAsset} from './asset-response.js';
import type { Express, RequestHandler, Response } from 'express';
import { isDeepStrictEqual } from 'node:util';
import type { ResourceFileRequest, ResourceFileLocation, ResourceFileResult, ResourceFileTransfer, ThreadIdentity } from '@varin/application-client';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { attachmentMimeType } from '@varin/protocol';
import type { ResourceFilesOwner, ResourceWorkspaceUpload } from './resource-files.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ManagedSourceOwner } from '../kernel/managed-source-bridge.js';
import { parseSourceResourceOwner } from '../kernel/thread-sources.js';

export function registerResourceFileRoutes(app: Express, options: {
  local: ResourceFilesOwner; remote: ManagedSourceOwner; runtime: AgentRuntimeClient; requireAuth: RequestHandler;
  attachments: import('../kernel/thread-attachments.js').ThreadAttachmentOwner;
}) {
  const failure = (response: Response, error: unknown) => {
    const detail = error as { status?: number; code?: unknown };
    if (!response.destroyed) response.status(detail?.status ?? 400).json({ error: error instanceof Error ? error.message : String(error), ...(detail?.code ? { reason: detail.code } : {}) });
  };
  app.use('/api/resource-documents', options.requireAuth, async (request, response, next) => {
    const controller = new AbortController();
    const closed = () => controller.abort();
    try {
      const owner = parseSourceResourceOwner(JSON.parse(String(request.query.resourceOwner)));
      if (owner.kind === 'local') throw new Error('Use the local Documents service');
      if (request.method !== 'GET' && request.method !== 'POST') { next(); return; }
      const url = new URL(request.url, 'http://resource.local');
      url.searchParams.delete('resourceOwner');
      const watching = url.pathname === '/watch';
      if (watching) response.once('close', closed);
      const remote = await options.remote(owner);
      const result = await remote.documents(url.pathname.slice(1) + url.search, request.method, request.method === 'POST' ? request.body : undefined, watching ? controller.signal : undefined);
      response.status(result.status).setHeader('Content-Type', result.headers.get('Content-Type') ?? 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.flushHeaders();
      if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
      else response.end();
    } catch (error) { if (!response.headersSent) failure(response, error); else response.end(); }
    finally { response.off('close', closed); controller.abort(); }
  });
  const endpoint = async (location: ResourceFileLocation) => {
    const owner = parseSourceResourceOwner(location.resourceOwner);
    const remote = owner.kind === 'managed_host' ? await options.remote(owner) : null;
    return {
      request: (command: ResourceFileRequest['command']) => remote ? remote.workspace({ root: location.root, workspaceId: location.workspaceId, ...(location.selection !== undefined ? {selection:location.selection} : {}), coordinatorHostId: options.runtime.coordinatorHostId, command }) : options.local.request({ ...location, command }),
      upload: (request: ResourceWorkspaceUpload, body: AsyncIterable<Uint8Array>) => remote ? remote.workspaceUpload({ ...request, coordinatorHostId: options.runtime.coordinatorHostId }, body) : options.local.upload(request, body),
    };
  };
  const route = async (input: ResourceFileRequest) => {
    const resourceOwner = parseSourceResourceOwner(input.resourceOwner);
    if (!input.task || input.command.kind !== 'open') return { resourceOwner };
    const thread = await options.runtime.thread(input.task.threadId);
    const branch = thread.branches.find(branch => branch.branch_id === input.task!.branchId);
    if (!branch || input.task.runtime !== 'agent') throw new Error('The original work is unavailable');
    const runId = branch.active_run_id ?? branch.latest_run?.id;
    const launch = runId ? await options.runtime.launch(runId) : null;
    if (!runId || !launch?.selection.source) throw new Error('This work has no file source');
    const source = launch.selection.source;
    if (!isDeepStrictEqual(resourceOwner, source.resource_owner)) throw new Error('The work uses a different file device');
    return { resourceOwner, taskSource: { runId, source } };
  };
  app.post('/api/resource-files', options.requireAuth, async (request, response) => {
    const controller = new AbortController();
    const closed = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', closed); response.once('close', closed);
    try {
      const input = request.body as ResourceFileRequest;
      const signal = input.command?.kind === 'filename-search' || input.command?.kind === 'content-search' ? controller.signal : undefined;
      const { resourceOwner, taskSource } = await route(input);
      const command = { command: input.command, ...(input.selection !== undefined ? {selection:input.selection} : {}), ...(input.root ? { root: input.root } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(taskSource ? { taskSource } : {}) };
      const result = resourceOwner.kind === 'local' ? await options.local.request(command, signal)
        : await (await options.remote(resourceOwner)).workspace({ ...command, coordinatorHostId: options.runtime.coordinatorHostId }, signal);
      if (!response.destroyed) response.json(result);
    } catch (error) { if (!controller.signal.aborted) failure(response, error); }
    finally { request.off('aborted', closed); response.off('close', closed); }
  });
  const asset = async (input:import('@varin/application-client').ResourceAssetRequest,response:Response) => {
    const controller=new AbortController(),close=()=>{if(!response.writableEnded)controller.abort();};
    response.once('close',close);
    try {
      const owner=parseSourceResourceOwner(input.resourceOwner);
      const result=owner.kind==='local'?await options.local.asset(input,controller.signal)
        :await (await options.remote(owner)).workspaceAsset({...input,coordinatorHostId:options.runtime.coordinatorHostId},controller.signal);
      await sendResourceAsset(result,response);
    }catch(error){if(!controller.signal.aborted&&!response.headersSent)failure(response,error);else if(!response.destroyed)response.end();}
    finally{response.off('close',close);}
  };
  app.get(/^\/api\/resource-assets\/[^/]+\/([^/]+)\/(raw|serve|office-preview)\/(.+)$/,options.requireAuth,async(request,response)=>{
    try {
      const location=JSON.parse(request.params[0]!) as ResourceFileLocation;
      const kind=request.params[1] as 'raw'|'serve'|'office-preview';
      await asset({...location,path:request.params[2]!,asset:{kind,...(typeof request.query.expectedRevision==='string'?{expectedRevision:request.query.expectedRevision}:{})}},response);
    }catch(error){failure(response,error);}
  });
  app.post('/api/resource-office',options.requireAuth,async(request,response)=>{
    if(request.body?.asset?.kind!=='office-read'){response.status(400).json({error:'An Office read is required'});return;}
    await asset(request.body,response);
  });
  app.post('/api/resource-files/upload', options.requireAuth, async (request, response) => {
    try {
      const input = JSON.parse(String(request.query.input)) as ResourceWorkspaceUpload & { resourceOwner: ResourceFileRequest['resourceOwner'] };
      const owner = parseSourceResourceOwner(input.resourceOwner);
      const result = owner.kind === 'local' ? await options.local.upload(input, request)
        : await (await options.remote(owner)).workspaceUpload({ ...input, coordinatorHostId: options.runtime.coordinatorHostId }, request);
      if (!response.destroyed) response.json(result);
    } catch (error) { failure(response, error); }
  });
  app.post('/api/resource-files/retain', options.requireAuth, async (request, response) => {
    try {
      const { location, path, identity, key } = request.body as { location: ResourceFileLocation; path: string; identity: ThreadIdentity; key: string };
      const owner = parseSourceResourceOwner(location.resourceOwner);
      const recipient = await options.runtime.thread(identity.threadId);
      const branch = recipient.branches.find(branch => branch.branch_id === identity.branchId);
      if (!branch) throw new Error('The receiving conversation is unavailable');
      const runId = branch.active_run_id ?? branch.latest_run?.id;
      const source = runId ? (await options.runtime.launch(runId))?.selection.source : null;
      if (owner.kind === 'local' && !source || source && isDeepStrictEqual(owner, source.resource_owner) &&
        (source.mode === 'live_root' || location.task?.threadId === identity.threadId && location.task.branchId === identity.branchId)) {
        const selectedPath = `${location.root.replaceAll('\\', '/').replace(/\/$/, '')}/${path}`;
        const [attachment] = await options.attachments.prepare(identity, [{ path: selectedPath }], `file-reference:${key}`);
        if (!attachment) throw new Error('The original file could not be retained');
        response.json(attachment); return;
      }
      const remote = owner.kind === 'managed_host' ? await options.remote(owner) : null;
      const read = (offset: number) => remote
        ? remote.workspace({ root: location.root, workspaceId: location.workspaceId, ...(location.selection !== undefined ? {selection:location.selection} : {}), coordinatorHostId: options.runtime.coordinatorHostId, command: { kind: 'bytes', path, offset } })
        : options.local.request({ ...location, command: { kind: 'bytes', path, offset } });
      const first = await read(0);
      if (first.kind !== 'bytes') throw new Error('The original file could not be read');
      const stream = async function* () {
        let page: Extract<ResourceFileResult, { kind: 'bytes' }> = first;
        for (;;) {
          if (page.version !== first.version || page.byteLength !== first.byteLength) throw new Error('The source file changed during transfer');
          yield Buffer.from(page.bytesBase64, 'base64');
          if (page.eof) return;
          const next = await read(page.nextOffset);
          if (next.kind !== 'bytes' || next.nextOffset <= page.nextOffset) throw new Error('The file transfer stopped before reaching the end');
          page = next;
        }
      };
      const filename = path.split(/[\\/]/).at(-1)!;
      response.json(await options.attachments.upload(identity, { key, filename, mimeType: attachmentMimeType(filename), byteLength: first.byteLength }, stream()));
    } catch (error) { failure(response, error); }
  });
  app.post('/api/resource-files/transfer', options.requireAuth, async (request, response) => {
    let copied = 0, removed = 0;
    try {
      const input = request.body as ResourceFileTransfer;
      if (!input.key || !input.path || !input.destinationPath) throw new Error('Source and destination are required');
      const [source, target] = await Promise.all([endpoint(input.source), endpoint(input.destination)]);
      // Reject a directory copying into itself before creating any entries.
      const sourceNative = input.source.selection?.mode === 'native_workspace' ? input.source.selection : undefined;
      const targetNative = input.destination.selection?.mode === 'native_workspace' ? input.destination.selection : undefined;
      const sameView = sourceNative || targetNative ? sourceNative && targetNative
        && sourceNative.workspaceId === targetNative.workspaceId && sourceNative.executionWorkspaceId === targetNative.executionWorkspaceId
        && sourceNative.branchId === targetNative.branchId : true;
      if (isDeepStrictEqual(input.source.resourceOwner, input.destination.resourceOwner) && sameView) {
        const normalize = (root: string, relative: string) => path.posix.normalize(`${root.replaceAll('\\', '/')}/${relative}`).replace(/\/$/, '');
        const from = normalize(sourceNative?.nativeScope ?? (sourceNative ? '/' : input.source.root), input.path), to = normalize(targetNative?.nativeScope ?? (targetNative ? '/' : input.destination.root), input.destinationPath);
        const folded = /^[a-z]:/i.test(from) ? [from.toLowerCase(), to.toLowerCase()] : [from, to];
        if (folded[1] === folded[0] || folded[1]!.startsWith(`${folded[0]}/`)) throw new Error('Choose a destination outside the source');
      }
      const copy = async (from: string, to: string, kind: 'file' | 'directory' | 'symlink') => {
        const key = `${input.key}:${createHash('sha256').update(from).digest('hex')}`;
        if (kind === 'directory') {
          await target.request({ kind: 'mkdir', path: to });
          // Enumerate before removing children so cursors do not shift under a move.
          const entries: import('@varin/application-client').ResourceFileEntry[] = [];
          let cursor: string | undefined;
          do {
            const page = await source.request({ kind: 'list', path: from, ...(cursor ? { cursor } : {}) });
            if (page.kind !== 'list') throw new Error('Source directory is unavailable');
            entries.push(...page.page.entries); cursor = page.page.nextCursor ?? undefined;
          } while (cursor);
          for (const entry of entries) await copy(entry.path, `${to}/${entry.name}`, entry.kind);
          if (input.move) await source.request({ kind: 'remove', path: from, key, emptyDirectory: true });
          return;
        }
        if (kind === 'symlink') {
          const link = await source.request({ kind: 'readlink', path: from });
          if (link.kind !== 'link') throw new Error('The source link is unavailable');
          await target.request({ kind: 'symlink', path: to, target: link.target, key }); copied++;
          if (input.move) { await source.request({ kind: 'remove', path: from, key: `${key}:remove`, expectedLink: link.target }); removed++; }
          return;
        }
        const first = await source.request({ kind: 'bytes', path: from, offset: 0 });
        if (first.kind !== 'bytes') throw new Error('Source file is unavailable');
        const hash = createHash('sha256');
        const stream = async function* () {
          let page = first;
          for (;;) {
            if (page.version !== first.version || page.byteLength !== first.byteLength) throw new Error('Source file changed during transfer');
            const bytes = Buffer.from(page.bytesBase64, 'base64'); hash.update(bytes); yield bytes;
            if (page.eof) return;
            const next = await source.request({ kind: 'bytes', path: from, offset: page.nextOffset });
            if (next.kind !== 'bytes' || next.nextOffset <= page.nextOffset) throw new Error('Incomplete file transfer');
            page = next;
          }
        };
        await target.upload({ ...(input.destination.selection !== undefined ? {selection:input.destination.selection} : {}), root: input.destination.root, workspaceId: input.destination.workspaceId, path: to, key, byteLength: first.byteLength }, stream()); copied++;
        if (input.move) { await source.request({ kind: 'remove', path: from, key: `${key}:remove`, expectedHash: `sha256-${hash.digest('hex')}` }); removed++; }
      };
      const parent = path.posix.dirname(input.path), name = path.posix.basename(input.path);
      let cursor: string | undefined, found: import('@varin/application-client').ResourceFileEntry | undefined;
      do {
        const page = await source.request({ kind: 'list', path: parent === '.' ? '' : parent, query: name, ...(cursor ? { cursor } : {}) });
        if (page.kind !== 'list') throw new Error('Source directory is unavailable');
        found = page.page.entries.find(entry => entry.name === name); cursor = page.page.nextCursor ?? undefined;
      } while (!found && cursor);
      if (!found) throw new Error('The source no longer exists');
      await copy(input.path, input.destinationPath, found.kind);
      response.json({ copied, removed });
    } catch (error) { if (!response.destroyed) response.json({ copied, removed, error: error instanceof Error ? error.message : String(error) }); }
  });
}
