/** Reads the original immutable Documents capture for the existing WorkingState branch preparation. */
import type { AgentInputContext, AgentInputSnapshotConsumer } from '@varin/protocol';
import type { DocumentAuthority } from '../../documents/authority.js';
import { encodeDocumentText } from '../../documents/inspect.js';
import type { SourceDraftProvenance, SourceDraftResource } from '../../kernel/protocol.generated.js';


const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source draft provenance is malformed');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

export function parseSourceDraftProvenance(value: unknown): SourceDraftProvenance {
  const input = record(value);
  if (!keys(input, ['threadId', 'branchId', 'snapshotRef', 'ownerId', 'ownerGeneration', 'resources'])
    || !text(input.threadId) || !text(input.branchId) || !text(input.snapshotRef) || !text(input.ownerId)
    || !Number.isSafeInteger(input.ownerGeneration) || Number(input.ownerGeneration) < 0 || !Array.isArray(input.resources)) {
    throw new Error('Source draft provenance is malformed');
  }
  const seen = new Set<string>();
  const resources = input.resources.map((entry): SourceDraftResource => {
    const resource = record(entry);
    if (!keys(resource, ['workspaceId', 'resourceId', 'baseRevision', 'localEditRevision', 'revision', 'encoding', 'bom', 'coordinationId', 'documentInstanceId', 'bufferHash', 'lineEnding'])
      || !text(resource.workspaceId) || !text(resource.resourceId)
      || resource.resourceId.includes('\\') || resource.resourceId.includes('\0') || resource.resourceId.startsWith('/')
      || /^[A-Za-z]:/.test(resource.resourceId) || resource.resourceId.split('/').some(part => !part || part === '.' || part === '..')
      || (resource.baseRevision !== null && typeof resource.baseRevision !== 'string')
      || !Number.isSafeInteger(resource.localEditRevision) || Number(resource.localEditRevision) < 0
      || !text(resource.revision) || resource.encoding !== 'utf-8' || typeof resource.bom !== 'boolean'
      || (resource.coordinationId !== undefined && !text(resource.coordinationId))
      || (resource.documentInstanceId !== undefined && !text(resource.documentInstanceId))
      || (resource.bufferHash !== undefined && (typeof resource.bufferHash !== 'string' || !/^sha256-[0-9a-f]{64}$/.test(resource.bufferHash)))
      || (resource.lineEnding !== undefined && !['lf', 'crlf', 'cr'].includes(String(resource.lineEnding)))) {
      throw new Error('Source draft resource provenance is malformed');
    }
    const identity = JSON.stringify([resource.workspaceId, resource.resourceId]);
    if (seen.has(identity)) throw new Error('Source draft resources contain duplicate identities');
    seen.add(identity);
    return structuredClone(resource) as unknown as SourceDraftResource;
  });
  return { threadId: input.threadId, branchId: input.branchId, snapshotRef: input.snapshotRef,
    ownerId: input.ownerId, ownerGeneration: Number(input.ownerGeneration), resources };
}

export function readSourceDrafts(input: {
  documents: Pick<DocumentAuthority, 'cloneInputSnapshot'>;
  consumer: Extract<AgentInputSnapshotConsumer, { kind: 'thread' }>;
  context: AgentInputContext;
  workspaceId: string;
  signal?: AbortSignal;
}): { editorDrafts: Array<{ path: string; content: Buffer }>; drafts?: SourceDraftProvenance } {
  const { documents, consumer, context, workspaceId, signal } = input;
  signal?.throwIfAborted();
  if (context.source === 'disk') return { editorDrafts: [] };
  if (context.roots.some(root => root.workspaceId !== workspaceId)) throw new Error('Editor drafts must belong to the explicitly selected source workspace');
  const clone = documents.cloneInputSnapshot(consumer, context);
  if (clone.status !== 'ready' || !clone.owner || context.snapshot.status !== 'ready') {
    throw new Error(clone.status === 'unavailable' ? clone.message : 'The selected editor source snapshot is unavailable');
  }
  const requested = context.roots.flatMap(root => root.dirtyPaths).sort();
  const resources = clone.resources.filter(resource => resource.resource.workspaceId === workspaceId)
    .sort((left, right) => left.resource.resourceId < right.resource.resourceId ? -1 : left.resource.resourceId > right.resource.resourceId ? 1 : 0);
  if (resources.length !== clone.resources.length || resources.length !== requested.length
    || resources.some((resource, index) => resource.resource.resourceId !== requested[index]) || clone.supersededResources.length) {
    throw new Error('The selected editor source snapshot no longer matches its capture');
  }
  const drafts = parseSourceDraftProvenance({ threadId: consumer.threadId, branchId: consumer.branchId,
    snapshotRef: context.snapshot.ref, ownerId: clone.owner.ownerId, ownerGeneration: clone.owner.generation,
    resources: resources.map(({ content: _content, aliases: _aliases, resource, ...metadata }) => ({ ...resource, ...metadata })) });
  return { editorDrafts: resources.map(resource => ({ path: resource.resource.resourceId, content: encodeDocumentText(resource) })), drafts };
}
