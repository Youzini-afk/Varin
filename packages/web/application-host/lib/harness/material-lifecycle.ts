/** Internal deletion primitive over an already admitted material storage context.
 * Releases only the addressed native Thread's material records; explicit shares
 * and persisted collections keep their original references. Run settlement and
 * Thread archival never imply permission to delete material. */
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createWorkspaceOpSerializer, kernelContext, type KernelRecordContext } from "./kernel-records.js";
type ContextLike = KernelRecordContext;
type RecordLike = NonNullable<Awaited<ReturnType<ContextLike["records"]["get"]>>>;

const releaseRecord = async (
  context: ContextLike,
  operationPrefix: string,
  record: RecordLike,
): Promise<void> => {
  await context.records.release(
    `${operationPrefix}:${record.workspaceId ?? "workspace"}:${record.recordId}`,
    record.recordId,
  );
};

// These are active request lifetimes, not durable byte ownership. Native records
// remain the authority; deletion waits for admitted readers and writers to actually stop.
const readers = new Map<string, { count: number; stopped: Array<() => void>; closing: number }>();
const readerKey = (workspaceId: string, threadId: string) => JSON.stringify([workspaceId, threadId]);
export function beginMaterialActivity(workspaceId: string, threadId: string): () => void {
  const key = readerKey(workspaceId, threadId), state = readers.get(key) ?? { count: 0, stopped: [], closing: 0 };
  if (state.closing) throw new Error('The original attachment recipient is being deleted');
  state.count++; readers.set(key, state);
  let released = false;
  return () => {
    if (released) return; released = true; state.count--;
    if (!state.count) { for (const resolve of state.stopped.splice(0)) resolve(); if (!state.closing) readers.delete(key); }
  };
}
export async function stopMaterialActivity(workspaceId: string, threadIds: readonly string[]): Promise<() => void> {
  const states = threadIds.map(threadId => {
    const key = readerKey(workspaceId, threadId), state = readers.get(key) ?? { count: 0, stopped: [], closing: 0 };
    state.closing++; readers.set(key, state); return { key, state };
  });
  await Promise.all(states.map(({ state }) => state.count ? new Promise<void>(resolve => state.stopped.push(resolve)) : Promise.resolve()));
  return () => { for (const { key, state } of states) { state.closing--; if (!state.count && !state.closing) readers.delete(key); } };
}
const withReadersStopped = async <T>(workspaceId: string, threadIds: readonly string[], action: () => Promise<T>): Promise<T> => {
  const resume = await stopMaterialActivity(workspaceId, threadIds);
  try { return await action(); } finally { resume(); }
};

const WEB_SNAPSHOT_RECORD_TYPE = "web.snapshot";
const MATERIAL_COLLECTION_RECORD_TYPE = "material.collection";

const persistedCollection = (record: RecordLike): boolean => {
  try {
    return (JSON.parse(record.payloadJson) as { persisted?: unknown }).persisted === true;
  } catch {
    return false;
  }
};

/** Explicit live shares retain the addressed collection itself. This is a
 * direct record edge, not a continuing check of the sender's ancestor grants. */
const sharedCollectionIds = (records: readonly RecordLike[], grantSurvives: (record: RecordLike) => boolean): Set<string> => {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.recordType !== "material.grant" || record.state === "released" || !grantSurvives(record)) continue;
    try {
      const value = JSON.parse(record.payloadJson) as { fromThreadId?: unknown; toThreadId?: unknown; collectionIds?: unknown };
      if (typeof value.fromThreadId !== "string" || value.fromThreadId !== record.threadId || typeof value.toThreadId !== "string" || !Array.isArray(value.collectionIds)) continue;
      for (const id of value.collectionIds) if (typeof id === "string") ids.add(id);
    } catch { /* Malformed grants retain nothing. */ }
  }
  return ids;
};
const collectionIdOf = (record: RecordLike): string | undefined => {
  try { const value = JSON.parse(record.payloadJson) as { collectionId?: unknown }; return typeof value.collectionId === "string" ? value.collectionId : undefined; }
  catch { return undefined; }
};

const bodyHashOf = (record: RecordLike): string | undefined => (
  // A PDF source record has an intentionally empty readable body. Its original
  // bytes, rather than the shared empty-string object, are its retention key.
  ([WEB_SNAPSHOT_RECORD_TYPE, 'attachment.file'].includes(record.recordType) && record.references.some(reference => reference.slot === 'source')
    ? record.references.find((reference) => reference.slot === "source")?.objectHash
    : record.references.find((reference) => reference.slot === "body")?.objectHash)
);

/**
 * Object hashes still referenced by live records outside the candidate set.
 * A web snapshot is addressed by its record (snapshotId), so the record must
 * survive while another live material record still cites its body.
 */
const referencedHashesOutside = async (
  context: ContextLike,
  candidateIds: Set<string>,
): Promise<Set<string>> => {
  const referenced = new Set<string>();
  for (const record of await context.records.list({})) {
    if (candidateIds.has(record.recordId) || record.state === "released" || record.recordType === "file.object-view") continue;
    for (const reference of record.references) referenced.add(reference.objectHash);
  }
  return referenced;
};

const releaseSnapshots = async (
  context: ContextLike,
  candidates: RecordLike[],
  alsoReleasing: RecordLike[],
  operationPrefix: string,
): Promise<void> => {
  if (candidates.length === 0) return;
  const excluded = new Set([...candidates, ...alsoReleasing].map((record) => record.recordId));
  const referenced = await referencedHashesOutside(context, excluded);
  for (const record of candidates) {
    const hash = bodyHashOf(record);
    if (hash && referenced.has(hash)) continue;
    await releaseRecord(context, operationPrefix, record);
  }
};

export const createMaterialLifecycle = (
  workingStates: WorkspaceWorkingStateRootAccess,
  serializer = createWorkspaceOpSerializer(),
) => {
  const inKernel = <T>(workspaceId: string, purpose: string,
    operation: Parameters<typeof kernelContext<T>>[3]): Promise<T> =>
    serializer.runSerialized(workspaceId, () => kernelContext(workingStates, workspaceId, purpose, operation));
  const releaseThreadMaterials = async (workspaceId: string, threadIds: string | readonly string[]): Promise<void> => inKernel(
    workspaceId,
    "material-thread-release",
    async (_store, context) => withReadersStopped(workspaceId, typeof threadIds === 'string' ? [threadIds] : threadIds, async () => {
      const deleted = new Set(typeof threadIds === 'string' ? [threadIds] : threadIds);
      const releasesGrant = (record: RecordLike): boolean => {
        if (deleted.has(record.threadId ?? '')) return true;
        try { return deleted.has((JSON.parse(record.payloadJson) as { toThreadId?: string }).toThreadId ?? ''); }
        catch { return false; }
      };
      const snapshots: RecordLike[] = [];
      const plain: RecordLike[] = [];
      const records = await context.records.list({});
      const sharedCollections = sharedCollectionIds(records, record => !releasesGrant(record));
      for (const record of records) {
        const isSnapshot = record.recordType === WEB_SNAPSHOT_RECORD_TYPE || record.recordType === 'attachment.file';
        const isCollection = record.recordType === MATERIAL_COLLECTION_RECORD_TYPE;
        const isGrant = record.recordType === "material.grant" || record.recordType === 'material.inheritance';
        if (record.state === 'released') continue;
        if (!(
          isSnapshot
          || isCollection
          || isGrant
          || record.recordType === 'media.resource' || record.recordType === 'attachment.delivery'
        )) continue;
        if (isCollection && (persistedCollection(record) || sharedCollections.has(collectionIdOf(record) ?? ""))) continue;
        if (deleted.has(record.threadId ?? '') || isGrant && releasesGrant(record)) {
          (isSnapshot ? snapshots : plain).push(record);
        }
      }
      for (const record of plain) {
        await releaseRecord(context, "thread-release", record);
      }
      await releaseSnapshots(context, snapshots, plain, "thread-release");
    }),
  );

  return { releaseThreadMaterials };
};
