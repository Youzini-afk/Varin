/** Shared read-only Office package and rendering boundary for admitted files. */
import path from 'node:path';
import type { OfficeReadRequest } from '@varin/protocol';
import { OfficePackage } from './package.js';
export type OfficeFilesystemInput = Omit<OfficeReadRequest, 'path' | 'snapshotId'> & { expectedRevision?: string };
export type OfficeFilesystemRenderer = (bytes: Buffer, format: import('@varin/protocol').OfficeFormat, signal: AbortSignal) => Promise<{bytes:Buffer;engine:{name:string;version:string}}>;
export async function readOfficeFilesystem(bytes: Buffer, filename: string, input: OfficeFilesystemInput | {view:'preview';expectedRevision?:string}, render?: OfficeFilesystemRenderer, signal?:AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const file = new OfficePackage(bytes);
  if (input.expectedRevision !== undefined && input.expectedRevision !== file.revision) return Response.json({error:'The Office file changed. Refresh to read its current revision.',revision:file.revision},{status:409});
  if (input.view === 'preview') {
    if (!render) return Response.json({error:'Office rendering is unavailable on this Host'},{status:503});
    const result = await render(bytes,file.format,signal ?? new AbortController().signal);
    signal?.throwIfAborted();
    return new Response(new Uint8Array(result.bytes),{headers:{'Content-Type':'application/pdf','X-Varin-Document-Revision':file.revision,'X-Varin-Render-Engine':`${result.engine.name} ${result.engine.version}`}});
  }
  if (input.view !== undefined && !['overview','content','find'].includes(input.view)) return Response.json({error:'Unsupported Office view'},{status:400});
  for (const key of ['offset','limit'] as const) if(input[key]!==undefined&&(!Number.isSafeInteger(input[key])||Number(input[key])<(key==='limit'?1:0)))return Response.json({error:`Invalid ${key}`},{status:400});
  // Only the admitted bytes select the file. Transport callers cannot smuggle
  // another path or snapshot into OfficePackage's read request.
  const request: OfficeReadRequest = {};
  for (const key of ['view','section','objectId','range','query','offset','limit'] as const) {
    if(input[key]!==undefined)Object.assign(request,{[key]:input[key]});
  }
  return Response.json({...file.read(request),title:path.basename(filename)});
}
