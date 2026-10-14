import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputContext, AgentInputSnapshotConsumer } from '@varin/protocol';

export interface SurfaceSnapshotResource {
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  content: string;
  localEditRevision: number;
  documentInstanceId?: string;
  resource: { workspaceId: string; resourceId: string };
  /** Host-resolved identity and registered aliases for the same physical target. */
  coordinationId?: string;
  aliases?: ReadonlyArray<{ workspaceId: string; resourceId: string }>;
  /** Editor-normalized buffer identity, distinct from serialized file bytes. */
  bufferHash?: string;
  lineEnding?: 'lf' | 'crlf' | 'cr';
}

interface StoredContent {
  content: string;
  references: number;
}

interface StoredResource extends Omit<SurfaceSnapshotResource, 'content'> {
  contentHash: string;
}

interface StoredSnapshot {
  roots: ReadonlyArray<{ workspaceId: string; dirtyPaths: readonly string[] }>;
  ownerId: string;
  ownerGeneration: number;
  ref: string;
  resources: readonly StoredResource[];
  consumerKey: string;
}

export type SurfaceSnapshotCloneResult =
  | { status: 'disk' }
  | {
      status: 'ready';
      owner: { ownerId: string; generation: number };
      resources: Array<SurfaceSnapshotResource & { revision: string }>;
    }
  | { status: 'unavailable'; message: string };

export interface SurfaceSnapshotStoreOptions {
  caseSensitive?: boolean;
}

/** Immutable capture held until the original Thread source preparation copies it
 * into WorkingState or releases it. Live disk/editor writes cannot change it. */
export const createSurfaceSnapshotStore = (options: SurfaceSnapshotStoreOptions = {}) => {
  const contents = new Map<string, StoredContent>();
  const snapshots = new Map<string, StoredSnapshot>();
  const resourceKey = (workspaceId: string, resourceId: string): string => JSON.stringify([
    workspaceId, options.caseSensitive === false ? resourceId.toLowerCase() : resourceId,
  ]);
  const consumerKey = (consumer: AgentInputSnapshotConsumer): string => JSON.stringify([consumer.threadId, consumer.branchId]);
  const rootKeys = (roots: StoredSnapshot['roots']): string[] => roots.flatMap(root =>
    root.dirtyPaths.map(resourceId => resourceKey(root.workspaceId, resourceId))).sort();
  const releaseStored = (snapshot: StoredSnapshot): void => {
    if (!snapshots.delete(snapshot.ref)) return;
    for (const resource of snapshot.resources) {
      const stored = contents.get(resource.contentHash);
      if (stored && --stored.references === 0) contents.delete(resource.contentHash);
    }
  };
  const resolve = (consumer: AgentInputSnapshotConsumer, context: AgentInputContext): StoredSnapshot | null => {
    if (context.source !== 'surface' || context.snapshot.status !== 'ready') return null;
    const snapshot = snapshots.get(context.snapshot.ref);
    if (!snapshot || snapshot.consumerKey !== consumerKey(consumer)) return null;
    const captured = rootKeys(snapshot.roots), requested = rootKeys(context.roots);
    return captured.length === requested.length && captured.every((key, index) => key === requested[index]) ? snapshot : null;
  };
  const capture = (input: {
    ownerId: string;
    ownerGeneration?: number;
    resources: readonly SurfaceSnapshotResource[];
    consumer: AgentInputSnapshotConsumer;
  }): AgentInputContext => {
    const keys = input.resources.map(entry => resourceKey(entry.resource.workspaceId, entry.resource.resourceId));
    if (new Set(keys).size !== keys.length) throw new Error('Snapshot resources contain duplicate document identities');
    const ref = randomUUID();
    const pathsByRoot = new Map<string, string[]>();
    const resources = input.resources.map(entry => {
      const { content, ...metadata } = entry;
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      const stored = contents.get(contentHash);
      if (stored) stored.references += 1;
      else contents.set(contentHash, { content, references: 1 });
      const paths = pathsByRoot.get(entry.resource.workspaceId) ?? [];
      paths.push(entry.resource.resourceId);
      pathsByRoot.set(entry.resource.workspaceId, paths);
      return { ...structuredClone(metadata), contentHash };
    });
    const roots = [...pathsByRoot].map(([workspaceId, dirtyPaths]) => ({ workspaceId, dirtyPaths: dirtyPaths.sort() }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    snapshots.set(ref, { ownerId: input.ownerId, ownerGeneration: input.ownerGeneration ?? 0,
      consumerKey: consumerKey(input.consumer), ref, resources, roots });
    return { source: 'surface', roots: structuredClone(roots), snapshot: { status: 'ready', ref } };
  };
  const clone = (consumer: AgentInputSnapshotConsumer, context: AgentInputContext): SurfaceSnapshotCloneResult => {
    if (context.source === 'disk') return { status: 'disk' };
    const snapshot = resolve(consumer, context);
    if (!snapshot) return { status: 'unavailable', message: 'The selected editor source snapshot is unavailable on the application host.' };
    const resources: Array<SurfaceSnapshotResource & { revision: string }> = [];
    for (const entry of snapshot.resources) {
      const { contentHash, ...metadata } = entry;
      const content = contents.get(contentHash)?.content;
      if (content === undefined) return { status: 'unavailable', message: 'The selected editor source snapshot is unavailable on the application host.' };
      resources.push({ ...structuredClone(metadata), content, revision: `surface-draft:${snapshot.ref}:${entry.localEditRevision}` });
    }
    return { status: 'ready', owner: { ownerId: snapshot.ownerId, generation: snapshot.ownerGeneration }, resources };
  };
  const release = (consumer: AgentInputSnapshotConsumer, context: AgentInputContext): { released: boolean } => {
    const snapshot = resolve(consumer, context);
    if (!snapshot) return { released: false };
    releaseStored(snapshot);
    return { released: true };
  };
  const dropPendingOwner = (ownerId: string, workspaceId: string): void => {
    for (const snapshot of snapshots.values()) {
      if (snapshot.ownerId === ownerId && snapshot.roots.some(root => root.workspaceId === workspaceId)) releaseStored(snapshot);
    }
  };
  return { capture, clone, release, dropPendingOwner, dispose: () => { snapshots.clear(); contents.clear(); } };
};

export type SurfaceSnapshotStore = ReturnType<typeof createSurfaceSnapshotStore>;
