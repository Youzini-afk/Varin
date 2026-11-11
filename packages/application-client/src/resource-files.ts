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
export type ResourceFileCommand =
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
