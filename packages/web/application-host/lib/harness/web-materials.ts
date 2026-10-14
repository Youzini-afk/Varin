/** Fixed content snapshots owned by a real native Thread. A refresh mints a
 * new snapshot identity; explicit grants and persisted collection references
 * retain access independently of the original fetching Run. */
import { createHash, randomUUID } from "node:crypto";
import type { WebSnapshotRef } from "@varin/protocol";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createWorkspaceOpSerializer, kernelContext } from "./kernel-records.js";

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

/** Native callers have a real Thread, without manufacturing a Pi session. */
export type ThreadMaterialAuthority = { kind: "thread"; owningWorkspaceId: string; threadId: string };
export type WebMaterialAuthority = ThreadMaterialAuthority;
export type WebSnapshotReadAuthority = ThreadMaterialAuthority;

export class WebSnapshotReadError extends Error {
  constructor(readonly code: "conflict" | "invalid-range" | "corrupt", message: string) {
    super(message);
    this.name = "WebSnapshotReadError";
  }
}

const hashBytes = (bytes: Buffer): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

const recordIdFor = (snapshotId: string): string => `web.snapshot:${snapshotId}`;

const parseSnapshotPayload = (payloadJson: string): WebSnapshotRef | null => {
  try {
    const value = JSON.parse(payloadJson) as WebSnapshotRef;
    if (!value || typeof value.snapshotId !== "string" || typeof value.finalUrl !== "string"
      || typeof value.contentHash !== "string" || !/^sha256-[0-9a-f]{64}$/.test(value.contentHash)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) return null;
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
  const access = (authority: WebSnapshotReadAuthority): WorkspaceWorkingStateRootAccess => {
    if (!authority || authority.kind !== "thread" || !authority.threadId || !authority.owningWorkspaceId) {
      throw new Error("Web snapshots require an admitted Thread authority");
    }
    return { withBranchStore: (workspaceId, purpose, consume, mode) => {
      if (workspaceId !== authority.owningWorkspaceId) throw new Error("Material authority changed its scope");
      return workingStates.withBranchStore(workspaceId, purpose, consume, mode, { threadId: authority.threadId });
    } };
  };

  const put = async (
    workspaceId: string,
    draft: WebSnapshotDraft,
    body: Buffer,
    authority: WebMaterialAuthority,
    options: {
      forceNew?: boolean;
      source?: { bytes: Buffer; contentType: string };
    } = {},
  ): Promise<WebSnapshotRef> => serializer.runSerialized(workspaceId, () => kernelContext(
    access(authority),
    workspaceId,
    "web-snapshot-put",
    async (store, context) => {
      if (authority.owningWorkspaceId !== workspaceId) {
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
      // A snapshot record carries the owning Thread, so returning a
      // foreign record would make another Run depend on the first Run's
      // cleanup lifecycle. The body object is still content-addressed and is
      // reused by the new record.
      if (!options.forceNew) {
        for (const record of await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE })) {
          if (record.workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
          if (record.state === "released") continue;
          if (record.threadId !== authority.threadId) continue;
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
        threadId: authority.threadId,
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
    authority: WebSnapshotReadAuthority,
    options: {
      includeSource?: boolean;
      /** Exact byte range; text/codepoint pagination belongs to the reader. */
      byteRange?: { offset: number; length: number };
      expectedContentHash?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<WebSnapshotContent | null> => {
    options.signal?.throwIfAborted();
    const scoped = access(authority);
    if (authority.owningWorkspaceId !== workspaceId) {
      throw new Error("Web snapshot authority does not match its owning workspace");
    }
    const result = await kernelContext(
      scoped,
      workspaceId,
      "web-snapshot-get",
      async (store, context) => {
        options.signal?.throwIfAborted();
        const record = await context.records.get(recordIdFor(snapshotId));
        options.signal?.throwIfAborted();
        if (!record
          || record.recordType !== WEB_SNAPSHOT_RECORD_TYPE
          || record.state === "released"
          || (record.workspaceId !== undefined && record.workspaceId !== workspaceId)) {
          return null;
        }
        if (record.threadId !== authority.threadId) {
          // The snapshot id is intentionally not a workspace-wide bearer token.
          // A caller may reread it from the same Thread across Runs;
          // another Thread needs an explicit `material.grant` record issued by
          // the owning thread (D-315 L4). A foreign receipt id never applies.
          const granted = await (async () => {
            // Persisted collections are workspace-owned material assets. Their
            // member snapshots remain readable while the collection names them.
            for (const collectionRecord of await context.records.list({ recordType: MATERIAL_COLLECTION_RECORD_TYPE })) {
              if (collectionRecord.state === "released"
                || (collectionRecord.workspaceId !== undefined && collectionRecord.workspaceId !== workspaceId)) continue;
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
              if (candidate.state === "released"
                || (candidate.workspaceId !== undefined && candidate.workspaceId !== workspaceId)) continue;
              try {
                const grant = JSON.parse(candidate.payloadJson) as {
                  toThreadId?: unknown;
                  fromThreadId?: unknown;
                  snapshotIds?: unknown;
                  collectionIds?: unknown;
                };
                if (grant.toThreadId !== authority.threadId) continue;
                // The trusted collection owner already checked the sender's read
                // authority when issuing this explicit grant. It may be a reshare;
                // the sender must match this grant's envelope, not the first fetcher.
                if (grant.fromThreadId !== candidate.threadId || typeof grant.fromThreadId !== "string") continue;
                if (Array.isArray(grant.snapshotIds) && grant.snapshotIds.includes(snapshotId)) return true;
                if (!Array.isArray(grant.collectionIds)) continue;
                for (const collectionId of grant.collectionIds) {
                  if (typeof collectionId !== "string") continue;
                  const collectionRecord = await context.records.get(`material.collection:${collectionId}`);
                  if (!collectionRecord || collectionRecord.state === "released"
                    || (collectionRecord.workspaceId !== undefined && collectionRecord.workspaceId !== workspaceId)) continue;
                  if (collectionRecord.recordType !== MATERIAL_COLLECTION_RECORD_TYPE) continue;
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
        options.signal?.throwIfAborted();
        const ref = parseSnapshotPayload(record.payloadJson);
        if (!ref || ref.snapshotId !== snapshotId) throw new WebSnapshotReadError("corrupt", `Invalid web snapshot metadata: ${snapshotId}`);
        if (options.expectedContentHash !== undefined && options.expectedContentHash !== ref.contentHash) {
          throw new WebSnapshotReadError("conflict", `Web snapshot content hash does not match the expected revision: ${snapshotId}`);
        }
        const range = options.byteRange;
        if (range && (!Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > ref.byteLength
          || !Number.isSafeInteger(range.length) || range.length < 0)) {
          throw new WebSnapshotReadError("invalid-range", `Web snapshot byte range is invalid: ${snapshotId}`);
        }
        const reference = record.references.find((item) => item.slot === "body" && item.objectHash === ref.contentHash);
        if (!reference) throw new WebSnapshotReadError("corrupt", `Web snapshot body reference is missing: ${snapshotId}`);
        if (ref.document?.source && !record.references.some(item => item.slot === "source" && item.objectHash === ref.document?.source?.contentHash)) {
          throw new WebSnapshotReadError("corrupt", `Web snapshot source reference is missing: ${snapshotId}`);
        }
        const readBlob = async (hash: string, slot: "body" | "source", byteLength: number,
          offset = 0, length = byteLength): Promise<Buffer> => {
          if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
            throw new WebSnapshotReadError("corrupt", `Web snapshot ${slot} length is invalid: ${snapshotId}`);
          }
          const chunks: Buffer[] = [];
          let cursor = offset;
          do {
            options.signal?.throwIfAborted();
            // A page is transfer granularity, never a document-size limit. Every
            // read keeps the same original record proof; Rust owns hash validation
            // and its getBlob promise settles only when the actual worker stops.
            const pageLength = Math.min(256 * 1024, offset + length - cursor);
            const page = await context.client!.getBlob(hash, { recordId: record.recordId, slot }, {
              offset: cursor, length: pageLength, ...(options.signal ? { signal: options.signal } : {}),
            });
            options.signal?.throwIfAborted();
            const bytes = Buffer.from(page.bytesBase64, "base64");
            if (page.byteLength !== byteLength || bytes.byteLength !== pageLength) {
              throw new WebSnapshotReadError("corrupt", `Web snapshot ${slot} is incomplete: ${snapshotId}`);
            }
            chunks.push(bytes);
            cursor += pageLength;
          } while (cursor < offset + length);
          return Buffer.concat(chunks, length);
        };
        const offset = range?.offset ?? 0;
        const length = Math.min(range?.length ?? ref.byteLength, ref.byteLength - offset);
        let body: Buffer;
        if (context.client) {
          // Rust verifies the immutable object's full hash before range reads. The
          // first verification can read the whole object; only returned bytes are
          // bounded by this range. Keep that verification with its existing owner.
          body = await readBlob(ref.contentHash, "body", ref.byteLength, offset, length);
        } else {
          // The non-native store remains a fixture seam, not a production fallback.
          const fullBody = await store.getObject(ref.contentHash);
          if (!fullBody || fullBody.byteLength !== ref.byteLength || hashBytes(fullBody) !== ref.contentHash) {
            throw new WebSnapshotReadError("corrupt", `Web snapshot body is missing or corrupt: ${snapshotId}`);
          }
          body = fullBody.subarray(offset, offset + length);
        }
        options.signal?.throwIfAborted();
        if (body.byteLength !== length) throw new WebSnapshotReadError("corrupt", `Web snapshot body is incomplete: ${snapshotId}`);
        let source: WebSnapshotContent["source"];
        if (options.includeSource && ref.document?.source) {
          const sourceReference = record.references.find((item) =>
            item.slot === "source" && item.objectHash === ref.document?.source?.contentHash);
          if (!sourceReference) throw new WebSnapshotReadError("corrupt", `Web snapshot source reference is missing: ${snapshotId}`);
          const sourceBytes = context.client
            ? await readBlob(ref.document.source.contentHash, "source", ref.document.source.byteLength)
            : await store.getObject(ref.document.source.contentHash);
          if (!sourceBytes || sourceBytes.byteLength !== ref.document.source.byteLength
            || (!context.client && hashBytes(sourceBytes) !== ref.document.source.contentHash)) {
            throw new WebSnapshotReadError("corrupt", `Web snapshot source is missing or corrupt: ${snapshotId}`);
          }
          source = { bytes: sourceBytes, contentType: ref.document.source.contentType };
        }
        return { ref, body, ...(source ? { source } : {}) };
      },
    );
    options.signal?.throwIfAborted();
    return result;
  };

  /** Reuse a fixed analysis only under the caller's own material authority. */
  const findAnalysis = async (
    workspaceId: string,
    sourceHash: string,
    analysisId: string,
    authority: WebSnapshotReadAuthority,
    sourceSnapshotId?: string,
    signal?: AbortSignal,
  ): Promise<WebSnapshotContent | null> => {
    signal?.throwIfAborted();
    const candidates = await kernelContext(
      access(authority),
      workspaceId,
      "web-snapshot-find-analysis",
      async (_store, context) => (await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE }))
        .filter((record) => record.state !== "released" && record.threadId === authority.threadId)
        .map((record) => parseSnapshotPayload(record.payloadJson))
        .filter((ref): ref is WebSnapshotRef => ref?.document?.analysis?.id === analysisId
          && ref.document.source?.contentHash === sourceHash
          && (sourceSnapshotId === undefined || ref.document.sourceSnapshotId === sourceSnapshotId))
        .map((ref) => ref.snapshotId),
    );
    for (const snapshotId of candidates) {
      const found = await read(workspaceId, snapshotId, authority, signal ? { signal } : {});
      if (found) return found;
    }
    return null;
  };

  const findAnalysisConfig = async (
    workspaceId: string,
    sourceHash: string,
    configHash: string,
    toolVersions: NonNullable<NonNullable<WebSnapshotRef["document"]>["analysis"]>["toolVersions"],
    authority: WebSnapshotReadAuthority,
    sourceSnapshotId: string,
    signal?: AbortSignal,
  ): Promise<WebSnapshotContent | null> => {
    signal?.throwIfAborted();
    const candidates = await kernelContext(access(authority), workspaceId, "web-snapshot-find-analysis-config",
      async (_store, context) => (await context.records.list({ recordType: WEB_SNAPSHOT_RECORD_TYPE }))
        .filter((record) => record.state !== "released" && record.threadId === authority.threadId)
        .map((record) => parseSnapshotPayload(record.payloadJson))
        .filter((ref): ref is WebSnapshotRef => ref?.document?.source?.contentHash === sourceHash
          && ref.document.sourceSnapshotId === sourceSnapshotId
          && ref.document.analysis?.configHash === configHash
          && ref.document.analysis.toolVersions?.pdfjs === toolVersions?.pdfjs
          && ref.document.analysis.toolVersions?.docling === toolVersions?.docling
          && ref.document.analysis.toolVersions?.tesseract === toolVersions?.tesseract)
        .map((ref) => ref.snapshotId));
    for (const snapshotId of candidates) {
      const found = await read(workspaceId, snapshotId, authority, signal ? { signal } : {});
      if (found) return found;
    }
    return null;
  };

  return { put, read, findAnalysis, findAnalysisConfig };
};

export type WebMaterialStore = ReturnType<typeof createWebMaterialStore>;
