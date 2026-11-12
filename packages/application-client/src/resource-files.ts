import { getRuntimeUrlResolver } from './transport/runtime-url.js';
import { getRuntimeUrlAuthTokenSync } from './transport/runtime-auth.js';
import type { SourceResourceOwner } from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

/** A user-selected file view. It never changes a Run's accepted source. */
export interface ResourceFileLocation {
  selection?: import('./threads.js').ProjectSourceSelection;
  resourceOwner: SourceResourceOwner;
  root: string;
  workspaceId: string;
  /** Original task identity, when opened from a task. */
  task?: ThreadIdentity;
}
export interface ResourceFileEntry { name: string; path: string; kind: 'file' | 'directory' | 'symlink'; size: number; modifiedAt: string; unavailable?: string }
export interface ResourceFilePage { entries: ResourceFileEntry[]; nextCursor: string | null; path: string }
export interface ResourceFileSearchOptions {
  query: string;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  maxResults?: number;
}
export interface ResourceFileContentSearchOptions extends ResourceFileSearchOptions {
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  glob?: string[];
  before?: number;
  after?: number;
}
export type ResourceFileContentSearchResult =
  | { status: 'ready'; generation: number | undefined; hits: Array<import('./types.js').WorkspaceContentSearchHit & { revision?: string; before?: string[]; after?: string[] }>; incomplete?: true; scannedFiles?: number }
  | { status: 'empty' | 'cancelled'; generation: number | undefined; scannedFiles?: number }
  | { status: 'failure'; generation: number | undefined; message: string; scannedFiles?: number };
export type ResourceFileCommand =
  | ({ kind: 'filename-search'; path: string } & ResourceFileSearchOptions)
  | ({ kind: 'content-search'; path: string } & ResourceFileContentSearchOptions)
  | { kind: 'open'; path?: string }
  | { kind: 'locations' }
  | { kind: 'list'; path: string; query?: string; cursor?: string }
  | { kind: 'bytes'; path: string; offset: number }
  | { kind: 'readlink'; path: string }
  | { kind: 'symlink'; path: string; target: string; key: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'remove'; path: string; key: string; expectedHash?: string; expectedLink?: string; emptyDirectory?: boolean }
  | { kind: 'rename'; path: string; destination: string; key: string }
  | { kind: 'copy'; path: string; destination: string; key: string };
export type ResourceFileResult =
  | { kind: 'filename-search'; results: import('./types.js').FileSearchResult[]; enumerationStatus: 'complete' | 'incomplete' | 'failed' | 'cancelled' }
  | { kind: 'content-search'; result: ResourceFileContentSearchResult }
  | { kind: 'opened'; root: string; workspaceId: string; locations: string[] }
  | { kind: 'locations'; locations: string[] }
  | { kind: 'list'; page: ResourceFilePage }
  | { kind: 'bytes'; bytesBase64: string; nextOffset: number; eof: boolean; byteLength: number; version: string }
  | { kind: 'link'; target: string }
  | { kind: 'done' };
export interface ResourceFileRequest { selection?: import('./threads.js').ProjectSourceSelection; resourceOwner: SourceResourceOwner; root?: string; workspaceId?: string; task?: ThreadIdentity; command: ResourceFileCommand }
export interface ResourceFileTransfer { source: ResourceFileLocation; path: string; destination: ResourceFileLocation; destinationPath: string; move: boolean; key: string }

export function createResourceFilesHttpAPI() {
  return {
    async transfer(input: ResourceFileTransfer): Promise<{ copied: number; removed: number; error?: string }> {
      const generation = getRuntimeEndpointGeneration();
      const response = await runtimeFetch('/api/resource-files/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const result = await response.json();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('The selected Varin service changed');
      if (!response.ok) throw new Error(result.error ?? 'Transfer failed');
      return result;
    },
    async request(input: ResourceFileRequest, signal?: AbortSignal): Promise<ResourceFileResult> {
      const generation = getRuntimeEndpointGeneration();
      const response = await runtimeFetch('/api/resource-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...(signal ? { signal } : {}) });
      const result = await response.json();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('The selected Varin service changed');
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'File operation failed');
      return result as ResourceFileResult;
    },
    async upload(location: ResourceFileLocation, path: string, file: Blob, key: string, signal?: AbortSignal): Promise<void> {
      const generation = getRuntimeEndpointGeneration();
      const metadata = encodeURIComponent(JSON.stringify({ ...location, path, key, byteLength: file.size }));
      const response = await runtimeFetch(`/api/resource-files/upload?input=${metadata}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, ...(signal ? { signal } : {}) });
      const result = await response.json();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('The selected Varin service changed');
      if (!response.ok) throw new Error(result.error ?? 'Upload failed');
    },
    async retain(location: ResourceFileLocation, path: string, identity: ThreadIdentity, key: string): Promise<import('@varin/protocol').Attachment> {
      const generation = getRuntimeEndpointGeneration();
      const response = await runtimeFetch('/api/resource-files/retain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, path, identity, key }) });
      const result = await response.json();
      if (generation !== getRuntimeEndpointGeneration()) throw new Error('The selected Varin service changed');
      if (!response.ok) throw new Error(result.error ?? 'Could not reference this file');
      return result;
    },
  };
}

export interface ResourceAssetOptions { kind: 'raw' | 'serve' | 'office-preview'; expectedRevision?: string }
export type ResourceOfficeReadInput = Omit<import('@varin/protocol').OfficeReadRequest, 'path' | 'snapshotId'> & { expectedRevision?: string };
export type ResourceAssetRequest = ResourceFileLocation & { path: string; asset: ResourceAssetOptions | {kind:'office-read';input:ResourceOfficeReadInput} };
/** Ephemeral URL credentials are derived here, never stored with a file location. */
export function createResourceAssetUrl(location:ResourceFileLocation,resourceId:string,options:ResourceAssetOptions):string {
  const token=getRuntimeUrlAuthTokenSync() || '-';
  const encoded=encodeURIComponent(JSON.stringify(location));
  const resource=resourceId.replaceAll('\\','/').split('/').map(encodeURIComponent).join('/');
  return getRuntimeUrlResolver().api(`/api/resource-assets/${encodeURIComponent(token)}/${encoded}/${options.kind}/${resource}`, options.expectedRevision === undefined ? undefined : {expectedRevision:options.expectedRevision});
}
export async function readResourceOffice(location:ResourceFileLocation,resourceId:string,input:ResourceOfficeReadInput,signal?:AbortSignal):Promise<import('@varin/protocol').OfficeReadResult & {title:string}> {
  const generation=getRuntimeEndpointGeneration();
  const response=await runtimeFetch('/api/resource-office',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...location,path:resourceId,asset:{kind:'office-read',input}}),...(signal?{signal}:{})});
  const result=await response.json();
  if(generation!==getRuntimeEndpointGeneration())throw new Error('The selected Varin service changed');
  if(!response.ok)throw Object.assign(new Error(result.error??'Office read failed'),{status:response.status,revision:result.revision});
  return result;
}
