import { getEditorResourceWorkspace } from '@/lib/workbench/editors/resource-workspace';
import { SurfaceCapabilityRegistry } from '@varin/extension-surface';
import type { JsonObject, JsonValue } from '@varin/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';

const object = (value: JsonValue, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const identityFrom = (value: JsonValue): DocumentIdentity => {
  const input = object(value, 'resource');
  if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
    throw new TypeError('resource.workspaceId must be a non-empty string');
  }
  if (typeof input.resourceId !== 'string' || !input.resourceId) {
    throw new TypeError('resource.resourceId must be a non-empty string');
  }
  return { workspaceId: input.workspaceId, resourceId: input.resourceId };
};

const serializeRecord = (record: DocumentRecord, resource = record.identity): JsonObject => ({
  status: record.status,
  resource,
  content: record.buffer,
  revision: record.baseRevision,
  documentVersion: record.localEditRevision,
  dirty: record.dirty,
  saving: record.saving,
  encoding: record.encoding,
  bom: record.bom,
  byteLength: record.byteLength,
  ...(record.errorMessage ? { message: record.errorMessage } : {}),
});

const documentCapability = async (method: string, value: JsonValue): Promise<JsonValue> => {
  const params = object(value, 'workspace.documents request');
  const documents = getRegisteredRuntimeAPIs()?.documents;
  if (!documents) throw new Error('Workspace documents are unavailable');
  if (method === 'resolveWorkspace') {
    const context = typeof params.workspaceId === 'string' ? getEditorResourceWorkspace(params.workspaceId) : undefined;
    const resolved = await (context?.scope.api ?? documents).resolveWorkspace(context ? { workspaceId: context.documentWorkspaceId } : params);
    return structuredClone({ ...resolved, ...(context ? { workspaceId: context.workspaceId } : {}) }) as unknown as JsonValue;
  }
  if (method === 'move' || method === 'delete') {
    const source = identityFrom(method === 'move' ? params.from : params.resource);
    const context = getEditorResourceWorkspace(source.workspaceId);
    if (!context) return structuredClone(method === 'move' ? await documents.move(params as never) : await documents.delete(params as never)) as unknown as JsonValue;
    const original = { ...source, workspaceId: context.documentWorkspaceId };
    const token = object(params.token, 'mutation token');
    const request = { ...params, token: { ...token, workspaceId: context.documentWorkspaceId } };
    let result: unknown;
    if (method === 'move') {
      const destination = identityFrom(params.to);
      const target = getEditorResourceWorkspace(destination.workspaceId);
      if (!target || target.scope !== context.scope) throw new Error('Cross-owner moves use resource file transfer');
      result = await context.scope.api.move({ ...request, from: original, to: { ...destination, workspaceId: target.documentWorkspaceId } } as never);
    } else result = await context.scope.api.delete({ ...request, resource: original } as never);
    // The extension keeps its admitted view identity, not a target Host-local ID.
    return JSON.parse(JSON.stringify(result, (key, value) => key === 'workspaceId' && value === context.documentWorkspaceId ? source.workspaceId : value)) as JsonValue;
  }
  if (method !== 'read' && method !== 'write') {
    throw new Error(`workspace.documents does not implement ${method}`);
  }

  const viewIdentity = identityFrom(params.resource ?? params);
  const context = getEditorResourceWorkspace(viewIdentity.workspaceId);
  const identity = { ...viewIdentity, workspaceId: context?.documentWorkspaceId ?? viewIdentity.workspaceId };
  const registry = context?.scope.documents ?? getDocumentRegistry();
  const current = await registry.open(identity);
  if (method === 'read') return serializeRecord(current, viewIdentity);
  if (typeof params.content !== 'string') throw new TypeError('content must be a string');
  const expectedRevision = params.expectedRevision === null || typeof params.expectedRevision === 'string'
    ? params.expectedRevision
    : undefined;
  const expectedDocumentVersion = Number.isSafeInteger(params.expectedDocumentVersion)
    ? Number(params.expectedDocumentVersion)
    : undefined;
  if (
    expectedRevision === undefined
    || expectedRevision !== current.baseRevision
    || (expectedDocumentVersion !== undefined && expectedDocumentVersion !== current.localEditRevision)
    || (expectedDocumentVersion === undefined && current.dirty)
  ) {
    return { status: 'conflict', current: serializeRecord(current, viewIdentity) };
  }
  if (current.status === 'missing') {
    const created = await registry.create(identity, params.content);
    return {
      status: created.status === 'missing' ? 'conflict' : 'written',
      revision: created.baseRevision,
      documentVersion: created.localEditRevision,
      byteLength: created.byteLength,
    };
  }
  registry.applyTransaction(identity, params.content, { origin: 'isolated-editor' });
  const saved = await registry.save(identity);
  if (saved.status === 'conflict' || saved.status === 'deleted') {
    return { status: 'conflict', current: serializeRecord(saved, viewIdentity) };
  }
  return {
    status: 'written',
    revision: saved.baseRevision,
    documentVersion: saved.localEditRevision,
    byteLength: saved.byteLength,
  };
};

export const surfaceCapabilityRegistry = new SurfaceCapabilityRegistry();

surfaceCapabilityRegistry.register({
  exposure: 'remote-safe',
  id: 'workspace.documents',
  projectTrust: 'required',
  supports: ['desktop', 'mobile', 'web'],
}, documentCapability);
