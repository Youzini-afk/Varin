/** Current native skill management. Execution reads remain bound to the Run resource checkpoint. */
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export type NativeResourceKind = 'skill';
export type NativeResourceScope = 'user' | 'project';
/** A saved navigation project, resolved and trust-checked by the Host. No renderer path grants. */
export interface ResourceManagementTarget { projectId?: string }
export interface NativeResourceSourceInfo {
  origin: 'package' | 'top-level'; scope: NativeResourceScope; path: string; source: string; baseDir?: string;
}
export interface NativeResourceDescriptor {
  id: string; kind: NativeResourceKind; name: string; description: string; filePath: string;
  active: boolean; valid: boolean; writable: boolean; sourceInfo: NativeResourceSourceInfo; disableModelInvocation?: boolean;
}
export interface NativeResourceDiagnostic { kind: string; message: string; path?: string; resourceId?: string; collision?: { winnerPath: string; loserPath: string; name: string; resourceType: 'skill' } }
export interface NativeResourceCatalogSnapshot { resources: NativeResourceDescriptor[]; diagnostics: NativeResourceDiagnostic[]; projectTrusted: boolean }
export interface NativeResourceDocumentSnapshot { descriptor: NativeResourceDescriptor; content: string; revision: string; projectTrusted: boolean }
export interface NativeResourceCreate { scope: NativeResourceScope; name: string; content: string; key: string }
export interface NativeResourceUpdate { id: string; content: string; expectedRevision: string; key: string }
export interface NativeResourceRemove { id: string; expectedRevision: string; key: string }
export interface NativeResourceCopy extends NativeResourceRemove { scope: NativeResourceScope; name: string }
export class ResourceManagementError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Capture the selected Host even for delayed editor saves. */
export function createResourceManagementHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const post = async <T>(action: string, target: ResourceManagementTarget, input: object, signal?: AbortSignal): Promise<T> => {
    const check = () => {
      signal?.throwIfAborted();
      if (generation !== getRuntimeEndpointGeneration()) throw new ResourceManagementError(409, 'host-changed', 'Application Host changed. Reload resources.');
    };
    check();
    const response = await runtimeFetch(`/api/resources/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, ...input }), ...(signal ? { signal } : {}) });
    check();
    const result = await response.json();
    check();
    if (!response.ok) throw new ResourceManagementError(response.status, result.code ?? 'resource-request-failed', result.message ?? 'Resource request failed.');
    return result as T;
  };
  return {
    list: (target: ResourceManagementTarget, signal?: AbortSignal) => post<NativeResourceCatalogSnapshot>('list', target, {}, signal),
    read: (target: ResourceManagementTarget, id: string, signal?: AbortSignal) => post<NativeResourceDocumentSnapshot>('read', target, { id }, signal),
    create: (target: ResourceManagementTarget, input: NativeResourceCreate, signal?: AbortSignal) => post<NativeResourceDocumentSnapshot>('create', target, input, signal),
    update: (target: ResourceManagementTarget, input: NativeResourceUpdate, signal?: AbortSignal) => post<NativeResourceDocumentSnapshot>('update', target, input, signal),
    remove: (target: ResourceManagementTarget, input: NativeResourceRemove, signal?: AbortSignal) => post<{ removed: true }>('remove', target, input, signal),
    copy: (target: ResourceManagementTarget, input: NativeResourceCopy, signal?: AbortSignal) => post<NativeResourceDocumentSnapshot>('copy', target, input, signal),
  };
}
