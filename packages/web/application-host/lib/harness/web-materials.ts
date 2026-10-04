/**
 * D-315 / Stage L1: fixed web content snapshots.
 *
 * A snapshot pins the readable representation extracted from one fetch: the
 * source identity (requested + final URL), content hash, parser name, and the
 * stored text body. Positions reported against a snapshot (extracted-text
 * line ranges) stay valid for exactly this content — a refresh mints a new
 * snapshotId rather than mutating an existing one, so older references keep
 * resolving to the older content.
 *
 * Snapshots live in the same kernel record store as retrieval artifacts:
 * `web.snapshot` records with a `body` object reference. The record itself is
 * temporary and owned by the fetching session/thread/run; it is released by
 * the ordinary retrieval lifecycle (run settle, thread deletion, session
 * drop, workspace reconcile) unless another live record — promoted evidence,
 * a project source, another run's receipt — still references its body hash.
 * Sharing therefore never depends on possessing another run's receipt: a
 * consumer reads the snapshot under its own session authority.
 */
import { createHash, randomUUID } from "node:crypto";
import type { RetrievalReceiptAuthority, WebSnapshotRef } from "@varin/protocol";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createWorkspaceOpSerializer, kernelContext } from "./retrieval-artifacts.js";

export const WEB_SNAPSHOT_RECORD_TYPE = "web.snapshot";
const MATERIAL_GRANT_RECORD_TYPE = "material.grant";
const MATERIAL_COLLECTION_RECORD_TYPE = "material.collection";

export interface WebSnapshotDraft {
  sourceUrl: string;
  finalUrl: string;
  contentType?: string;
  title?: string;
  /** Parser that produced the readable view, e.g. "readability-markdown". */
  representation: string;
  rendered?: boolean;
  /** Detected structure of this exact body (pages/headings/tables/figures). */
  structure?: WebSnapshotRef["structure"];
  document?: WebSnapshotRef["document"];
}

export interface WebSnapshotContent {
  ref: WebSnapshotRef;
  /** Stored readable body (utf-8 extracted text). */
  body: Buffer;
  /** Original source bytes, loaded only when explicitly requested. */
  source?: { bytes: Buffer; contentType: string };
}

type WebSnapshotAuthority = Pick<RetrievalReceiptAuthority, "owningWorkspaceId" | "sessionId" | "threadId">;

const hashBytes = (bytes: Buffer): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

const recordIdFor = (snapshotId: string): string => `web.snapshot:${snapshotId}`;

const parseSnapshotPayload = (payloadJson: string): WebSnapshotRef | null => {
  try {
    const value = JSON.parse(payloadJson) as WebSnapshotRef;
    if (!value || typeof value.snapshotId !== "string" || typeof value.finalUrl !== "string"
      || typeof value.contentHash !== "string" || typeof value.byteLength !== "number") return null;
    return value;
  } catch {
    return null;
  }
};

export const createWebMaterialStore = (
  workingStates: WorkspaceWorkingStateRootAccess,
  deps: { now?: () => number; serializer?: ReturnType<typeof createWorkspaceOpSerializer> } = {},
) => {
  const now = deps.now ?? Date.now;
  const serializer = deps.serializer ?? createWorkspaceOpSerializer();

  const put = async (
    workspaceId: string,
    draft: WebSnapshotDraft,
    body: Buffer,
    authority?: RetrievalReceiptAuthority,
    options: {
      forceNew?: boolean;
      source?: { bytes: Buffer; contentType: string };
    } = {},
  ): Promise<WebSnapshotRef> => serializer.runSerialized(workspaceId, () => kernelContext(
    workingStates,
    workspaceId,
    "web-snapshot-put",
    async (store, context) => {
      if (authority && authority.owningWorkspaceId !== workspaceId) {
        throw new Error("Web snapshot authority does not match its owning workspace");
      }
      const contentHash = hashBytes(body);
      const sourceDescriptor = options.source
        ? {
            contentHash: hashBytes(options.source.bytes),
            byteLength: options.source.bytes.byteLength,
            contentType: options.source.contentType,
          }
        : undefined;
      const document = draft.document
        ? {
            ...draft.document,
            ...(sourceDescriptor ? { source: sourceDescriptor } : {}),
          }
        : undefined;
      // Reuse an existing snapshot only inside the same material authority.
      // A snapshot record carries the owning session/thread, so returning a
      // foreign record would make another Run depend on the first Run's
      // cleanup lifecycle. The body object is still content-addressed and is
      // reused by the new record.
      if (!options.forceNew) {
        for (const record of await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE })) {
          if (record.workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
          if (record.state === "released") continue;
          if (authority) {
            if (record.threadId !== undefined) {
              if (!authority.threadId || record.threadId !== authority.threadId) continue;
            } else if (record.sessionId !== authority.sessionId || authority.threadId !== undefined) {
              continue;
            }
          }
          const payload = parseSnapshotPayload(record.payloadJson);
          if (payload
            && payload.sourceUrl === draft.sourceUrl
            && payload.finalUrl === draft.finalUrl
            && payload.contentHash === contentHash
            && payload.representation === draft.representation
            && Boolean(payload.rendered) === Boolean(draft.rendered)
            && payload.document?.kind === document?.kind
            && payload.document?.pageCount === document?.pageCount
            && payload.document?.parser === document?.parser
            && payload.document?.source?.contentHash === document?.source?.contentHash
            && payload.document?.sourceSnapshotId === document?.sourceSnapshotId
            && payload.document?.analysis?.id === document?.analysis?.id) {
            return payload;
          }
        }
      }
      const object = await store.putObject(body);
      const snapshotId = `snap-${randomUUID()}`;
      const recordId = recordIdFor(snapshotId);
      const sourceObject = options.source ? await store.putObject(options.source.bytes) : undefined;
      const ref: WebSnapshotRef = {
        snapshotId,
        sourceUrl: draft.sourceUrl,
        finalUrl: draft.finalUrl,
        fetchedAt: now(),
        contentHash,
        representation: draft.representation,
        byteLength: object.byteLength,
        ...(draft.contentType ? { contentType: draft.contentType } : {}),
        ...(draft.rendered ? { rendered: true } : {}),
        ...(draft.title ? { title: draft.title } : {}),
        ...(draft.structure ? { structure: draft.structure } : {}),
        ...(document ? { document } : {}),
      };
      const ownerId = store.ownerIdForObject?.(object.hash);
      const sourceOwnerId = sourceObject ? store.ownerIdForObject?.(sourceObject.hash) : undefined;
      await context.records.put({
        operationId: `web-snapshot-put:${recordId}`,
        recordId,
        recordType: WEB_SNAPSHOT_RECORD_TYPE,
        state: "temporary",
        ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}),
        ...(authority?.threadId ? { threadId: authority.threadId } : {}),
        ...(authority?.runId ? { runId: authority.runId } : {}),
        payloadJson: JSON.stringify(ref),
        ownerIds: [ownerId, sourceOwnerId].filter((value): value is string => typeof value === "string"),
        references: [
          { slot: "body", objectHash: object.hash },
          ...(sourceObject ? [{ slot: "source", objectHash: sourceObject.hash }] : []),
        ],
      });
      return ref;
    },
  ));

  const read = async (
    workspaceId: string,
    snapshotId: string,
    authority?: WebSnapshotAuthority,
    options: { includeSource?: boolean } = {},
  ): Promise<WebSnapshotContent | null> => kernelContext(
    workingStates,
    workspaceId,
    "web-snapshot-get",
    async (store, context) => {
      const record = await context.records.get(recordIdFor(snapshotId));
      if (!record
        || record.recordType !== WEB_SNAPSHOT_RECORD_TYPE
        || record.state === "released"
        || (record.workspaceId !== undefined && record.workspaceId !== workspaceId)) {
        return null;
      }
      if (authority
        && (record.threadId !== undefined
          ? !authority.threadId || record.threadId !== authority.threadId
          : record.sessionId !== authority.sessionId || authority.threadId !== undefined)) {
        // The snapshot id is intentionally not a workspace-wide bearer token.
        // A caller may reread it from the same Thread across sessions/Runs;
        // another thread needs an explicit `material.grant` record issued by
        // the owning thread (D-315 L4). A foreign receipt id never applies.
        const granted = authority.threadId !== undefined && await (async () => {
          // Persisted collections are workspace-owned material assets. Their
          // member snapshots remain readable while the collection names them.
          for (const collectionRecord of await context.records.list({ recordType: MATERIAL_COLLECTION_RECORD_TYPE })) {
            if (collectionRecord.state === "released") continue;
            try {
              const collection = JSON.parse(collectionRecord.payloadJson) as {
                persisted?: unknown;
                members?: Array<{ snapshotId?: unknown }>;
              };
              if (collection.persisted === true && Array.isArray(collection.members)
                && collection.members.some((member) => member.snapshotId === snapshotId)) return true;
            } catch {
              // A malformed collection record grants nothing.
            }
          }
          for (const candidate of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
            if (candidate.state === "released") continue;
            try {
              const grant = JSON.parse(candidate.payloadJson) as {
                toThreadId?: unknown;
                fromThreadId?: unknown;
                snapshotIds?: unknown;
                collectionIds?: unknown;
              };
              if (grant.toThreadId !== authority.threadId) continue;
              if (record.threadId !== undefined && grant.fromThreadId !== record.threadId) continue;
              if (Array.isArray(grant.snapshotIds) && grant.snapshotIds.includes(snapshotId)) return true;
              if (!Array.isArray(grant.collectionIds)) continue;
              for (const collectionId of grant.collectionIds) {
                if (typeof collectionId !== "string") continue;
                const collectionRecord = await context.records.get(`material.collection:${collectionId}`);
                if (!collectionRecord || collectionRecord.state === "released") continue;
                if (collectionRecord.threadId !== undefined && collectionRecord.threadId !== grant.fromThreadId) continue;
                try {
                  const collection = JSON.parse(collectionRecord.payloadJson) as {
                    members?: Array<{ snapshotId?: unknown }>;
                  };
                  if (Array.isArray(collection.members)
                    && collection.members.some((member) => member.snapshotId === snapshotId)) return true;
                } catch {
                  // A malformed collection record grants nothing.
                }
              }
            } catch {
              // A malformed grant grants nothing.
            }
          }
          return false;
        })();
        if (!granted) return null;
      }
      const ref = parseSnapshotPayload(record.payloadJson);
      if (!ref || ref.snapshotId !== snapshotId) throw new Error(`Invalid web snapshot metadata: ${snapshotId}`);
      const reference = record.references.find((item) => item.slot === "body" && item.objectHash === ref.contentHash);
      if (!reference) throw new Error(`Web snapshot body reference is missing: ${snapshotId}`);
      const body = context.client
        ? await context.client.getBlob(ref.contentHash, { recordId: record.recordId, slot: "body" })
          .then((value) => Buffer.from(value.bytesBase64, "base64"))
        : await store.getObject(ref.contentHash);
      if (!body || body.byteLength !== ref.byteLength) throw new Error(`Web snapshot body is missing or incomplete: ${snapshotId}`);
      let source: WebSnapshotContent["source"];
      if (options.includeSource && ref.document?.source) {
        const sourceReference = record.references.find((item) =>
          item.slot === "source" && item.objectHash === ref.document?.source?.contentHash);
        if (!sourceReference) throw new Error(`Web snapshot source reference is missing: ${snapshotId}`);
        const sourceBytes = context.client
          ? await context.client.getBlob(ref.document.source.contentHash, { recordId: record.recordId, slot: "source" })
            .then((value) => Buffer.from(value.bytesBase64, "base64"))
          : await store.getObject(ref.document.source.contentHash);
        if (!sourceBytes || sourceBytes.byteLength !== ref.document.source.byteLength) throw new Error(`Web snapshot source is missing or incomplete: ${snapshotId}`);
        source = { bytes: sourceBytes, contentType: ref.document.source.contentType };
      }
      return { ref, body, ...(source ? { source } : {}) };
    },
  );

  /** Reuse a fixed analysis only under the caller's own material authority. */
  const findAnalysis = async (
    workspaceId: string,
    sourceHash: string,
    analysisId: string,
    authority: WebSnapshotAuthority,
    sourceSnapshotId?: string,
  ): Promise<WebSnapshotContent | null> => {
    const candidates = await kernelContext(
      workingStates,
      workspaceId,
      "web-snapshot-find-analysis",
      async (_store, context) => (await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE }))
        .filter((record) => record.state !== "released" && (
          record.threadId !== undefined
            ? authority.threadId !== undefined && record.threadId === authority.threadId
            : authority.threadId === undefined && record.sessionId === authority.sessionId
        ))
        .map((record) => parseSnapshotPayload(record.payloadJson))
        .filter((ref): ref is WebSnapshotRef => ref?.document?.analysis?.id === analysisId
          && ref.document.source?.contentHash === sourceHash
          && (sourceSnapshotId === undefined || ref.document.sourceSnapshotId === sourceSnapshotId))
        .map((ref) => ref.snapshotId),
    );
    for (const snapshotId of candidates) {
      const found = await read(workspaceId, snapshotId, authority);
      if (found) return found;
    }
    return null;
  };

  const findAnalysisConfig = async (
    workspaceId: string,
    sourceHash: string,
    configHash: string,
    toolVersions: NonNullable<NonNullable<WebSnapshotRef["document"]>["analysis"]>["toolVersions"],
    authority: WebSnapshotAuthority,
    sourceSnapshotId: string,
  ): Promise<WebSnapshotContent | null> => {
    const candidates = await kernelContext(workingStates, workspaceId, "web-snapshot-find-analysis-config",
      async (_store, context) => (await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE }))
        .filter((record) => record.state !== "released" && (
          record.threadId !== undefined
            ? authority.threadId !== undefined && record.threadId === authority.threadId
            : authority.threadId === undefined && record.sessionId === authority.sessionId
        ))
        .map((record) => parseSnapshotPayload(record.payloadJson))
        .filter((ref): ref is WebSnapshotRef => ref?.document?.source?.contentHash === sourceHash
          && ref.document.sourceSnapshotId === sourceSnapshotId
          && ref.document.analysis?.configHash === configHash
          && ref.document.analysis.toolVersions?.pdfjs === toolVersions?.pdfjs
          && ref.document.analysis.toolVersions?.docling === toolVersions?.docling
          && ref.document.analysis.toolVersions?.tesseract === toolVersions?.tesseract)
        .map((ref) => ref.snapshotId));
    for (const snapshotId of candidates) {
      const found = await read(workspaceId, snapshotId, authority);
      if (found) return found;
    }
    return null;
  };

  return { put, read, findAnalysis, findAnalysisConfig };
};

export type WebMaterialStore = ReturnType<typeof createWebMaterialStore>;
