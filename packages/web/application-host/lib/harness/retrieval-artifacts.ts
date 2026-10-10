import { createHash, randomUUID } from "node:crypto";
import type {
  RetrievalArtifactRef,
  RetrievalEvidence,
  RetrievalReceiptAuthority,
  RetrievalUrlReceipt,
  Thread,
} from "@varin/protocol";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import type { WebFetchReceiptDraft } from "./web-fetch-receipt.js";

export const RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND = "retrieval-evidence-pending";
export const RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND = "retrieval-evidence-sealed";
export const RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND = "retrieval-artifact-temporary";
export const WEB_FETCH_RECEIPT_OWNER_KIND = "web-fetch-receipt-temporary";

export const hashRetrievalText = (text: string): string => (
  `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`
);

const keyPart = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const authorityKey = (authority: RetrievalReceiptAuthority): string => [
  authority.owningWorkspaceId,
  authority.sessionId,
  authority.threadId ?? "",
  authority.runId ?? "",
].map(keyPart).join(".");

export type RetrievalArtifactRecordRef = RetrievalArtifactRef;
type ArtifactInput = RetrievalArtifactRef;

const artifactRecordId = (authority: RetrievalReceiptAuthority | undefined, hash: string): string => (
  `retrieval-artifact:${authority ? authorityKey(authority) : "unbound"}:${keyPart(hash)}:${randomUUID()}`
);
const receiptRecordId = (authority: RetrievalReceiptAuthority, receiptId: string): string => (
  `retrieval-receipt:${authorityKey(authority)}:${keyPart(receiptId)}`
);
const evidenceRecordId = (kind: "pending" | "sealed", threadId: string, runId: string): string => (
  `retrieval-evidence:${kind}:${threadId}:${runId}`
);

const sameAuthority = (left: RetrievalReceiptAuthority, right: RetrievalReceiptAuthority): boolean => (
  left.owningWorkspaceId === right.owningWorkspaceId
  && left.sessionId === right.sessionId
  && (left.threadId ?? "") === (right.threadId ?? "")
  && (left.runId ?? "") === (right.runId ?? "")
);

const hashesForEvidence = (evidence: RetrievalEvidence): string[] => (
  [...new Set(evidence.facts.flatMap((fact) => fact.sources.flatMap((source) => (
    source.artifact?.hash ? [source.artifact.hash] : []
  ))))].sort()
);

type StoreLike = {
  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }>;
  getObject(hash: string): Promise<Buffer | null>;
  getObjectSlice(hash: string, byteLength: number, offset: number, length: number): Promise<Buffer | null>;
  ownerIdForObject?(hash: string): string | undefined;
};

type RecordLike = {
  recordId: string;
  workspaceId?: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  recordRevision: number;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

type RecordPutInput = {
  operationId: string;
  recordId: string;
  recordType: string;
  state: string;
  payloadJson: string;
  references?: Array<{ slot: string; objectHash: string }>;
  ownerIds?: string[];
  sessionId?: string;
  threadId?: string;
  runId?: string;
  expectedRecordRevision?: number;
};

type KernelBlobClient = {
  getBlob(
    hash: string,
    source: { recordId: string; slot: string },
    options?: { offset?: number; length?: number; signal?: AbortSignal },
  ): Promise<{ byteLength: number; bytesBase64: string }>;
};

type ContextLike = {
  client?: KernelBlobClient;
  records: {
    get(id: string): Promise<RecordLike | null>;
    list(input: { recordType?: string }): Promise<RecordLike[]>;
    put(input: RecordPutInput): Promise<RecordLike>;
    release(operationId: string, recordId: string): Promise<Record<string, unknown>>;
  };
};

const withKernel = async <T>(
  workingStates: WorkspaceWorkingStateRootAccess,
  workspaceId: string,
  purpose: string,
  operation: (store: StoreLike, context: ContextLike) => Promise<T> | T,
): Promise<T> => workingStates.withBranchStore(workspaceId, purpose, (store, context) => {
  if (!context?.records) throw new Error("Kernel record storage is unavailable");
  return operation(store, {
    records: context.records as unknown as ContextLike["records"],
    ...(context.client ? { client: context.client as unknown as KernelBlobClient } : {}),
  });
}, "exclusive");

export const kernelContext = withKernel;
export type { ContextLike as KernelRecordContext, StoreLike as KernelRecordStore };

/**
 * Serialize record writes per workspace. The kernel root store exposes one
 * owner lookup per object hash, so concurrent puts of equal content must not
 * interleave. Shared by the retrieval and web-snapshot stores.
 */
export const createWorkspaceOpSerializer = () => {
  const workspaceTails = new Map<string, Promise<void>>();
  const runSerialized = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = workspaceTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    workspaceTails.set(workspaceId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (workspaceTails.get(workspaceId) === current) workspaceTails.delete(workspaceId);
    }
  };
  return { runSerialized };
};

export const collectRetrievalArtifactHashes = hashesForEvidence;

const authorityMatchesRecord = (
  record: RecordLike,
  artifact: ArtifactInput,
  workspaceId: string,
): boolean => {
  if (record.workspaceId !== workspaceId || artifact.workspaceId !== workspaceId) return false;
  for (const field of ["sessionId", "threadId", "runId"] as const) {
    if (record[field] !== artifact[field]) return false;
  }
  return true;
};

const artifactHandle = (value: unknown): RetrievalArtifactRecordRef | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as ArtifactInput;
  if (typeof input.hash !== "string" || typeof input.byteLength !== "number") return null;
  if (typeof input.recordId !== "string" || input.recordId.length === 0) return null;
  if (typeof input.recordType !== "string") return null;
  if (input.recordType !== "retrieval.artifact" && input.recordType !== "retrieval.receipt") return null;
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) return null;
  for (const field of ["sessionId", "threadId", "runId"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") return null;
  }
  return input as RetrievalArtifactRecordRef;
};

const bodyReference = (record: RecordLike, hash: string): { slot: string; objectHash: string } | undefined => (
  record.references.find((reference) => reference.slot === "body" && reference.objectHash === hash)
);

const evidenceReference = (record: RecordLike, hash: string): { slot: string; objectHash: string } | undefined => (
  record.references.find((reference) => reference.objectHash === hash)
);

const canUseEvidenceFallback = (artifact: RetrievalArtifactRecordRef): boolean => {
  if (!artifact.threadId || !artifact.runId || !artifact.sessionId) return false;
  const owner = authorityKey({
    owningWorkspaceId: artifact.workspaceId,
    sessionId: artifact.sessionId,
    threadId: artifact.threadId,
    runId: artifact.runId,
  });
  const prefix = artifact.recordType === "retrieval.receipt"
    ? `retrieval-receipt:${owner}:`
    : `retrieval-artifact:${owner}:`;
  return artifact.recordId.startsWith(prefix);
};

/**
 * Resolve only the record named by the ref. Once promotion releases the
 * temporary source record, the same ref may resolve to the exact pending or
 * sealed evidence record for its verified owner. It never scans by hash.
 */
const resolveArtifactRecord = async (
  context: ContextLike,
  workspaceId: string,
  artifact: RetrievalArtifactRecordRef,
): Promise<RecordLike | null> => {
  if (artifact.workspaceId !== workspaceId) return null;
  const direct = await context.records.get(artifact.recordId);
  if (direct
    && (direct.recordType === "retrieval.artifact" || direct.recordType === "retrieval.receipt")
    && authorityMatchesRecord(direct, artifact, workspaceId)
    && bodyReference(direct, artifact.hash)
    && artifact.recordType === direct.recordType) {
    return direct;
  }
  if (!canUseEvidenceFallback(artifact)) return null;
  for (const kind of ["pending", "sealed"] as const) {
    const candidate = await context.records.get(evidenceRecordId(kind, artifact.threadId!, artifact.runId!));
    if (candidate
      && (candidate.workspaceId === undefined || candidate.workspaceId === workspaceId)
      && candidate.recordType === `retrieval.evidence.${kind}`
      && candidate.threadId === artifact.threadId
      && candidate.runId === artifact.runId
      && evidenceReference(candidate, artifact.hash)) {
      return candidate;
    }
  }
  return null;
};

const objectBytesForRecord = async (
  store: StoreLike,
  context: ContextLike,
  record: RecordLike,
  artifact: RetrievalArtifactRecordRef,
  offset?: number,
  length?: number,
): Promise<Buffer | null> => {
  const reference = record.recordType.startsWith("retrieval.evidence.")
    ? evidenceReference(record, artifact.hash)
    : bodyReference(record, artifact.hash);
  if (!reference) return null;
  if (context.client) {
    const value = await context.client.getBlob(
      artifact.hash,
      { recordId: record.recordId, slot: reference.slot },
      {
        ...(offset === undefined ? {} : { offset }),
        ...(length === undefined ? {} : { length }),
      },
    );
    if (value.byteLength !== artifact.byteLength) return null;
    return Buffer.from(value.bytesBase64, "base64");
  }
  return offset === undefined || length === undefined
    ? store.getObject(artifact.hash)
    : store.getObjectSlice(artifact.hash, artifact.byteLength, offset, length);
};

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

const fieldsMatch = (
  record: RecordLike,
  authority: RetrievalReceiptAuthority,
  includeSession = true,
): boolean => (
  (!includeSession || record.sessionId === authority.sessionId)
  && record.threadId === authority.threadId
  && record.runId === authority.runId
);

const WEB_SNAPSHOT_RECORD_TYPE = "web.snapshot";
const MATERIAL_COLLECTION_RECORD_TYPE = "material.collection";

const persistedCollection = (record: RecordLike): boolean => {
  try {
    return (JSON.parse(record.payloadJson) as { persisted?: unknown }).persisted === true;
  } catch {
    return false;
  }
};

const temporaryArtifactsFor = async (
  context: ContextLike,
  authority: RetrievalReceiptAuthority,
): Promise<RecordLike[]> => (
  (await context.records.list({ recordType: "retrieval.artifact" }))
    .filter((record) => record.state === "temporary" && fieldsMatch(record, authority))
);

const temporarySnapshotsFor = async (
  context: ContextLike,
  authority: RetrievalReceiptAuthority,
): Promise<RecordLike[]> => (
  (await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE }))
    .filter((record) => record.state === "temporary" && fieldsMatch(record, authority))
);

const bodyHashOf = (record: RecordLike): string | undefined => (
  // A PDF source record has an intentionally empty readable body. Its original
  // bytes, rather than the shared empty-string object, are its retention key.
  (record.recordType === WEB_SNAPSHOT_RECORD_TYPE && (() => {
    try { return (JSON.parse(record.payloadJson) as { representation?: string }).representation === "pdf-source-v1"; }
    catch { return false; }
  })()
    ? record.references.find((reference) => reference.slot === "source")?.objectHash
    : record.references.find((reference) => reference.slot === "body")?.objectHash)
);

/**
 * Object hashes still referenced by live records outside the candidate set.
 * A web snapshot is addressed by its record (snapshotId), so the record must
 * survive while promoted evidence, a project source, or another run's
 * receipt still cites its body.
 */
const referencedHashesOutside = async (
  context: ContextLike,
  candidateIds: Set<string>,
): Promise<Set<string>> => {
  const referenced = new Set<string>();
  for (const record of await context.records.list({})) {
    if (candidateIds.has(record.recordId) || record.state === "released") continue;
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

const releaseTemporaryArtifactsInContext = async (
  context: ContextLike,
  authority: RetrievalReceiptAuthority,
): Promise<void> => {
  const artifacts = await temporaryArtifactsFor(context, authority);
  const snapshots = await temporarySnapshotsFor(context, authority);
  for (const record of artifacts) {
    await releaseRecord(context, "artifact-release", record);
  }
  await releaseSnapshots(context, snapshots, artifacts, "snapshot-release");
};

const releaseReceiptInContext = async (
  context: ContextLike,
  authority: RetrievalReceiptAuthority,
  receiptId: string,
): Promise<void> => {
  const record = await context.records.get(receiptRecordId(authority, receiptId));
  if (!record || record.recordType !== "retrieval.receipt" || !fieldsMatch(record, authority)) return;
  try {
    const parsed = JSON.parse(record.payloadJson) as RetrievalUrlReceipt;
    if (parsed.receiptId !== receiptId || !sameAuthority(parsed.authority, authority)) return;
    if (!bodyReference(record, parsed.artifact.hash)) return;
    await releaseRecord(context, "receipt-release", record);
  } catch {
    // A malformed receipt is not released by a guessed payload owner. Its
    // record identity remains available to a later explicit cleanup path.
  }
};

const putEvidence = async (
  workspaceId: string,
  kind: "pending" | "sealed",
  threadId: string,
  runId: string,
  evidence: RetrievalEvidence,
  context: ContextLike,
): Promise<void> => {
  const references = hashesForEvidence(evidence).map((objectHash) => ({ slot: objectHash, objectHash }));
  const recordId = evidenceRecordId(kind, threadId, runId);
  const existing = await context.records.get(recordId);
  await context.records.put({
    operationId: `evidence-put:${workspaceId}:${recordId}:${existing ? existing.recordRevision + 1 : 1}:${randomUUID()}`,
    recordId,
    recordType: `retrieval.evidence.${kind}`,
    state: kind,
    threadId,
    runId,
    ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
    payloadJson: JSON.stringify(evidence),
    references,
  });
};

const evidenceIdsForThread = (thread: Thread): Set<string> => {
  const keep = new Set<string>();
  const activeRunId = thread.lifecycle === "active" ? thread.activeRunId : null;
  if (thread.pendingEvidence && activeRunId) keep.add(evidenceRecordId("pending", thread.id, activeRunId));
  const sealedRunId = thread.report?.evidenceRunId ?? (thread.report?.evidence ? thread.activeRunId : null);
  if (thread.report?.evidence && sealedRunId) keep.add(evidenceRecordId("sealed", thread.id, sealedRunId));
  return keep;
};

const releaseThreadTemporaryRecords = async (
  context: ContextLike,
  thread: Thread,
): Promise<void> => {
  const activeRunId = thread.lifecycle === "active" ? thread.activeRunId : null;
  const records = await context.records.list({});
  const plain: RecordLike[] = [];
  for (const record of records) {
    const isSnapshot = record.recordType === WEB_SNAPSHOT_RECORD_TYPE;
    const isRetrieval = record.recordType === "retrieval.artifact" || record.recordType === "retrieval.receipt";
    if ((!isSnapshot && !isRetrieval) || record.threadId !== thread.id) continue;
    // A web snapshot is the fixed source that a settled report may refer to
    // on a later Run. Its owner is the Thread, not the individual Run. The
    // thread-removal path releases it after the last report/reference is gone.
    if (isSnapshot) continue;
    if (activeRunId && record.runId === activeRunId) continue;
    plain.push(record);
  }
  for (const record of plain) {
    await releaseRecord(context, "thread-run-release", record);
  }
};

const syncThreadEvidenceInContext = async (
  workspaceId: string,
  context: ContextLike,
  thread: Thread,
): Promise<void> => {
  const keepEvidence = evidenceIdsForThread(thread);
  for (const record of await context.records.list({})) {
    if ((record.recordType === "retrieval.evidence.pending" || record.recordType === "retrieval.evidence.sealed")
      && record.threadId === thread.id
      && !keepEvidence.has(record.recordId)) {
      await releaseRecord(context, "evidence-release", record);
    }
  }
  await releaseThreadTemporaryRecords(context, thread);
  const activeRunId = thread.lifecycle === "active" ? thread.activeRunId : null;
  if (thread.pendingEvidence && activeRunId) {
    await putEvidence(workspaceId, "pending", thread.id, activeRunId, thread.pendingEvidence, context);
  }
  const sealedRunId = thread.report?.evidenceRunId ?? (thread.report?.evidence ? thread.activeRunId : null);
  if (thread.report?.evidence && sealedRunId) {
    await putEvidence(workspaceId, "sealed", thread.id, sealedRunId, thread.report.evidence, context);
  }
};

export const createRetrievalArtifactAccess = (
  workingStates: WorkspaceWorkingStateRootAccess,
  serializer: ReturnType<typeof createWorkspaceOpSerializer> = createWorkspaceOpSerializer(),
) => {
  const inKernel = <T>(
    workspaceId: string,
    purpose: string,
    operation: (store: StoreLike, context: ContextLike) => Promise<T> | T,
  ): Promise<T> => serializer.runSerialized(workspaceId, () => withKernel(workingStates, workspaceId, purpose, operation));

  const storeArtifact = async (
    workspaceId: string,
    bytes: Buffer,
    authority?: RetrievalReceiptAuthority,
  ): Promise<RetrievalArtifactRecordRef> => inKernel(
    workspaceId,
    "retrieval-evidence-put",
    async (store, context) => {
      if (authority && authority.owningWorkspaceId !== workspaceId) {
        throw new Error("Retrieval artifact authority does not match its owning workspace");
      }
      const object = await store.putObject(bytes);
      const recordId = artifactRecordId(authority, object.hash);
      const ownerId = store.ownerIdForObject?.(object.hash);
      await context.records.put({
        operationId: `artifact-put:${recordId}`,
        recordId,
        recordType: "retrieval.artifact",
        state: authority ? "temporary" : "durable",
        ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
        ...(authority?.threadId ? { threadId: authority.threadId } : {}),
        ...(authority?.runId ? { runId: authority.runId } : {}),
        payloadJson: JSON.stringify({
          artifact: {
            durability: "durable",
            hash: object.hash,
            byteLength: object.byteLength,
            recordId,
            recordType: "retrieval.artifact",
            workspaceId,
            ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
            ...(authority?.threadId ? { threadId: authority.threadId } : {}),
            ...(authority?.runId ? { runId: authority.runId } : {}),
          },
          authority: authority ?? null,
        }),
        ownerIds: ownerId ? [ownerId] : [],
        references: [{ slot: "body", objectHash: object.hash }],
      });
      return {
        durability: "durable",
        hash: object.hash,
        byteLength: object.byteLength,
        recordId,
        recordType: "retrieval.artifact",
        workspaceId,
        ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
        ...(authority?.threadId ? { threadId: authority.threadId } : {}),
        ...(authority?.runId ? { runId: authority.runId } : {}),
      };
    },
  );

  const readArtifact = async (
    workspaceId: string,
    input: ArtifactInput,
  ): Promise<Buffer | null> => {
    const artifact = artifactHandle(input);
    if (!artifact) return null;
    return inKernel(workspaceId, "retrieval-evidence-get", async (store, context) => {
      const record = await resolveArtifactRecord(context, workspaceId, artifact);
      if (!record) return null;
      const bytes = await objectBytesForRecord(store, context, record, artifact);
      return bytes && bytes.byteLength === artifact.byteLength ? bytes : null;
    });
  };

  const readArtifactSlice = async (
    workspaceId: string,
    input: ArtifactInput,
    offset: number,
    length: number,
  ): Promise<Buffer | null> => {
    const artifact = artifactHandle(input);
    if (!artifact) return null;
    return inKernel(workspaceId, "retrieval-evidence-slice", async (store, context) => {
      const record = await resolveArtifactRecord(context, workspaceId, artifact);
      if (!record) return null;
      return objectBytesForRecord(store, context, record, artifact, offset, length);
    });
  };

  const persistReceipt = async (
    workspaceId: string,
    draft: WebFetchReceiptDraft,
    markdown: string,
  ): Promise<RetrievalUrlReceipt> => inKernel(
    workspaceId,
    "web-fetch-receipt-put",
    async (store, context) => {
      if (draft.authority.owningWorkspaceId !== workspaceId) {
        throw new Error("Web receipt authority does not match its owning workspace");
      }
      const body = await store.putObject(Buffer.from(markdown, "utf8"));
      if (body.hash !== draft.contentHash || draft.revision !== draft.contentHash) {
        throw new Error("Web receipt content identity does not match its durable body");
      }
      const recordId = receiptRecordId(draft.authority, draft.receiptId);
      const receiptArtifact: RetrievalArtifactRecordRef = {
        durability: "durable",
        hash: body.hash,
        byteLength: body.byteLength,
        recordId,
        recordType: "retrieval.receipt",
        workspaceId,
        sessionId: draft.authority.sessionId,
        ...(draft.authority.threadId ? { threadId: draft.authority.threadId } : {}),
        ...(draft.authority.runId ? { runId: draft.authority.runId } : {}),
      };
      const receipt: RetrievalUrlReceipt = { ...draft, artifact: receiptArtifact };
      const meta = await store.putObject(Buffer.from(JSON.stringify(receipt), "utf8"));
      const owners = [
        store.ownerIdForObject?.(body.hash),
        store.ownerIdForObject?.(meta.hash),
      ].filter((value): value is string => Boolean(value));
      await context.records.put({
        operationId: `receipt-put:${recordId}`,
        recordId,
        recordType: "retrieval.receipt",
        state: "temporary",
        sessionId: receipt.authority.sessionId,
        ...(receipt.authority.threadId ? { threadId: receipt.authority.threadId } : {}),
        ...(receipt.authority.runId ? { runId: receipt.authority.runId } : {}),
        payloadJson: JSON.stringify(receipt),
        ownerIds: owners,
        references: [{ slot: "body", objectHash: body.hash }, { slot: "meta", objectHash: meta.hash }],
      });
      return receipt;
    },
  );

  const lookupReceipt = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
    receiptId: string,
  ): Promise<RetrievalUrlReceipt | null> => inKernel(
    workspaceId,
    "web-fetch-receipt-get",
    async (store, context) => {
      const record = await context.records.get(receiptRecordId(authority, receiptId));
      if (!record
        || (record.workspaceId !== undefined && record.workspaceId !== workspaceId)
        || record.recordType !== "retrieval.receipt"
        || !fieldsMatch(record, authority)) return null;
      try {
        const parsed = JSON.parse(record.payloadJson) as RetrievalUrlReceipt;
        const body = record.references.find((item) => item.slot === "body");
        const artifact = artifactHandle(parsed.artifact);
        if (
          parsed.receiptId !== receiptId
          || !sameAuthority(parsed.authority, authority)
          || !body
          || body.objectHash !== parsed.artifact?.hash
          || !artifact
          || artifact.recordId !== record.recordId
          || artifact.recordType !== "retrieval.receipt"
          || artifact.workspaceId !== workspaceId
        ) return null;
        const bytes = await objectBytesForRecord(store, context, record, artifact);
        if (!bytes || bytes.byteLength !== parsed.artifact.byteLength) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  );

  const promotePendingEvidence = async (input: {
    workspaceId: string;
    threadId: string;
    runId: string;
    evidence: RetrievalEvidence;
    receiptAuthority: RetrievalReceiptAuthority;
  }): Promise<void> => inKernel(
    input.workspaceId,
    "retrieval-evidence-promote",
    async (_store, context) => {
      if (input.receiptAuthority.owningWorkspaceId !== input.workspaceId
        || input.receiptAuthority.threadId !== input.threadId
        || input.receiptAuthority.runId !== input.runId) {
        throw new Error("Retrieval evidence authority does not match its active Run");
      }
      await putEvidence(input.workspaceId, "pending", input.threadId, input.runId, input.evidence, context);
      // Pending evidence now holds durable hash references. Release every
      // temporary source record owned by this exact Run, including sources
      // omitted by a malformed or superseded submission.
      await releaseTemporaryArtifactsInContext(context, input.receiptAuthority);
      const receiptIds = new Set<string>();
      for (const fact of input.evidence.facts) {
        for (const source of fact.sources) {
          if (source.kind === "url" && source.receiptId) receiptIds.add(source.receiptId);
        }
      }
      for (const receiptId of receiptIds) {
        await releaseReceiptInContext(context, input.receiptAuthority, receiptId);
      }
    },
  );

  const syncThreadEvidence = async (workspaceId: string, thread: Thread): Promise<void> => inKernel(
    workspaceId,
    "retrieval-evidence-reconcile-thread",
    (_store, context) => syncThreadEvidenceInContext(workspaceId, context, thread),
  );

  const releaseThreadEvidence = async (workspaceId: string, threadId: string): Promise<void> => inKernel(
    workspaceId,
    "retrieval-evidence-release",
    async (_store, context) => {
      const snapshots: RecordLike[] = [];
      const plain: RecordLike[] = [];
      for (const record of await context.records.list({})) {
        const isSnapshot = record.recordType === WEB_SNAPSHOT_RECORD_TYPE;
        const isCollection = record.recordType === MATERIAL_COLLECTION_RECORD_TYPE;
        const isGrant = record.recordType === "material.grant";
        if (!(
          isSnapshot
          || isCollection
          || isGrant
          || record.recordType.startsWith("retrieval.evidence.")
          || record.recordType === "retrieval.artifact"
          || record.recordType === "retrieval.receipt"
        )) continue;
        if (isCollection && persistedCollection(record)) continue;
        if (record.threadId === threadId) {
          (isSnapshot ? snapshots : plain).push(record);
          continue;
        }
        // Exact structured authority parsing handles rows written before the
        // top-level owner columns were populated. Never use substring tests.
        try {
          const payload = JSON.parse(record.payloadJson) as { authority?: { threadId?: unknown } };
          if (payload.authority?.threadId === threadId) {
            (isSnapshot ? snapshots : plain).push(record);
          }
        } catch {
          // A malformed row has no verifiable owner and is left for reconcile.
        }
      }
      for (const record of plain) {
        await releaseRecord(context, "thread-release", record);
      }
      await releaseSnapshots(context, snapshots, plain, "thread-release");
    },
  );

  const releaseReceiptAuthority = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
  ): Promise<void> => inKernel(
    workspaceId,
    "web-fetch-receipt-release",
    async (_store, context) => {
      const receipts: RecordLike[] = [];
      const collections: RecordLike[] = [];
      for (const record of await context.records.list({})) {
        if (record.recordType === "retrieval.receipt" && fieldsMatch(record, authority)) {
          receipts.push(record);
        } else if (record.recordType === MATERIAL_COLLECTION_RECORD_TYPE
          && !persistedCollection(record)
          && fieldsMatch(record, authority)) {
          collections.push(record);
        }
      }
      const snapshots = await temporarySnapshotsFor(context, authority);
      for (const record of receipts) {
        await releaseRecord(context, "receipt-authority-release", record);
      }
      for (const record of collections) {
        await releaseRecord(context, "collection-authority-release", record);
      }
      // Session-scoped web snapshots die with the same authority, unless a
      // surviving record still cites their body.
      await releaseSnapshots(context, snapshots, receipts, "snapshot-authority-release");
    },
  );

  const releaseTemporaryArtifacts = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
  ): Promise<void> => inKernel(
    workspaceId,
    "retrieval-artifact-temporary-release",
    (_store, context) => releaseTemporaryArtifactsInContext(context, authority),
  );

  const reconcileWorkspaceEvidence = async (
    workspaceId: string,
    threads: readonly Thread[],
  ): Promise<void> => inKernel(
    workspaceId,
    "retrieval-evidence-reconcile-workspace",
    async (_store, context) => {
      const knownThreads = new Map(threads.map((thread) => [thread.id, thread]));
      const records = await context.records.list({});
      const plainOrphans: RecordLike[] = [];
      const snapshotOrphans: RecordLike[] = [];
      for (const record of records) {
        if (record.recordType === "retrieval.evidence.pending" || record.recordType === "retrieval.evidence.sealed") {
          const thread = record.threadId ? knownThreads.get(record.threadId) : undefined;
          if (!thread || !evidenceIdsForThread(thread).has(record.recordId)) {
            await releaseRecord(context, "workspace-orphan-evidence", record);
          }
          continue;
        }
        const isSnapshot = record.recordType === WEB_SNAPSHOT_RECORD_TYPE;
        if (record.recordType === MATERIAL_COLLECTION_RECORD_TYPE) {
          // Persisted collections are saved workspace assets. Temporary ones
          // bound to a dead thread are orphans; session-scoped ones (no
          // threadId) are left for session-drop release.
          if (!persistedCollection(record) && record.threadId && !knownThreads.has(record.threadId)) {
            plainOrphans.push(record);
          }
          continue;
        }
        if (record.recordType === "material.grant") {
          // A grant dies with the granting thread — the receiver keeps only
          // what it separately pinned or was handed a durable reference to.
          if (record.threadId && !knownThreads.has(record.threadId)) plainOrphans.push(record);
          continue;
        }
        if (record.recordType !== "retrieval.artifact" && record.recordType !== "retrieval.receipt" && !isSnapshot) continue;
        if (!record.threadId || !record.runId) {
          // Session-scoped records release on session drop; only a mixed
          // owner shape (one of thread/run set) is an orphan.
          if (record.threadId || record.runId) plainOrphans.push(record);
          continue;
        }
        const thread = knownThreads.get(record.threadId);
        const activeRunId = thread?.lifecycle === "active" ? thread.activeRunId : null;
        if (!thread) {
          (isSnapshot ? snapshotOrphans : plainOrphans).push(record);
        } else if (!isSnapshot && (!activeRunId || record.runId !== activeRunId)) {
          plainOrphans.push(record);
        }
      }
      for (const record of plainOrphans) {
        await releaseRecord(context, "workspace-orphan-retrieval", record);
      }
      await releaseSnapshots(context, snapshotOrphans, plainOrphans, "workspace-orphan-retrieval");
      for (const thread of threads) await syncThreadEvidenceInContext(workspaceId, context, thread);
    },
  );

  return {
    storeArtifact,
    readArtifact,
    readArtifactSlice,
    persistReceipt,
    lookupReceipt,
    promotePendingEvidence,
    syncThreadEvidence,
    releaseThreadEvidence,
    releaseReceiptAuthority,
    releaseTemporaryArtifacts,
    reconcileWorkspaceEvidence,
  };
};
