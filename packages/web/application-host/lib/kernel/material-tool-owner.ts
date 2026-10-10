import type { JsonValue } from "@varin/extension-contract";
import type { HostCapabilityHandler } from "@varin/extension-host";
import { WebSnapshotReadError, type WebMaterialStore } from "../harness/web-materials.js";
import { requireToolInvocation } from "./tool-invocation.js";

export const MATERIAL_SNAPSHOT_CAPABILITY = "materials.snapshot";

export type MaterialSnapshotReadInput = {
  snapshotId: string;
  /** UTF-8 byte offset, at a codepoint boundary; EOF is allowed. */
  offset: number;
  /** Positive byte budget. A page never splits or replaces a codepoint. */
  maxBytes: number;
  expectedContentHash?: string;
};

export type MaterialSnapshotReadResult = {
  status: "ok" | "empty";
  snapshotId: string;
  /** Snapshots are immutable; their content hash identifies the fixed revision. */
  revision: string;
  contentHash: string;
  totalBytes: number;
  range: { offset: number; byteLength: number };
  nextOffset: number | null;
  text: string;
} | {
  status: "unavailable" | "conflict" | "invalid-range" | "corrupt";
  snapshotId: string;
  message: string;
};

const parseReadInput = (params: JsonValue): MaterialSnapshotReadInput => {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Material snapshot read requires an object");
  }
  const fields = new Set(["snapshotId", "offset", "maxBytes", "expectedContentHash"]);
  for (const key of Object.keys(params)) {
    if (!fields.has(key)) throw new Error(`Unknown material snapshot read field: ${key}`);
  }
  const { snapshotId, offset, maxBytes, expectedContentHash } = params;
  if (typeof snapshotId !== "string" || !snapshotId.trim()) throw new Error("snapshotId must be a non-empty string");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative safe integer");
  }
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (expectedContentHash !== undefined
    && (typeof expectedContentHash !== "string" || !/^sha256-[0-9a-f]{64}$/.test(expectedContentHash))) {
    throw new Error("expectedContentHash must be a SHA-256 content hash");
  }
  return { snapshotId, offset, maxBytes, ...(expectedContentHash === undefined ? {} : { expectedContentHash }) };
};

/** The capability reads already-stored text only. It never fetches, parses a
 * document, launches OCR, or changes a material record. Permissions and active
 * invocation identity come from the shared tool admission, not these inputs. */
export function createMaterialToolOwner(materials: Pick<WebMaterialStore, "read">): HostCapabilityHandler {
  return async (method, params, context): Promise<MaterialSnapshotReadResult> => {
    context.signal.throwIfAborted();
    const invocation = requireToolInvocation(context);
    if (!invocation.source) throw new Error("Material snapshot reads require a Run source workspace");
    if (method !== "read") throw new Error(`Unknown material snapshot method: ${method}`);
    const input = parseReadInput(params);
    try {
      const found = await materials.read(invocation.source.workspace_id, input.snapshotId, {
        kind: "thread",
        owningWorkspaceId: invocation.source.workspace_id,
        threadId: invocation.threadId,
      }, {
        byteRange: { offset: input.offset, length: input.maxBytes },
        ...(input.expectedContentHash === undefined ? {} : { expectedContentHash: input.expectedContentHash }),
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      // A worker can finish its callback without awaiting a nested capability.
      // Recheck the existing active scope before any delayed bytes are returned.
      requireToolInvocation(context);
      if (!found) {
        // Do not disclose whether another Thread owns an ungranted snapshot.
        return { status: "unavailable", snapshotId: input.snapshotId, message: "Snapshot is missing, released, or not authorized for this Thread" };
      }
      if (found.body.length > 0 && (found.body[0]! & 0xc0) === 0x80 && input.offset > 0) {
        throw new WebSnapshotReadError("invalid-range", "offset must begin at a UTF-8 codepoint boundary");
      }
      const atEnd = input.offset + found.body.byteLength === found.ref.byteLength;
      let text: string;
      try {
        // Streaming decode retains an unfinished trailing codepoint. Nothing is
        // replaced or returned twice: nextOffset points to its original start.
        // Preserve a literal BOM as content rather than silently dropping bytes.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(found.body, { stream: !atEnd });
      } catch {
        throw new WebSnapshotReadError("corrupt", "Snapshot body is not valid UTF-8 text");
      }
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength === 0 && found.body.length > 0) {
        throw new WebSnapshotReadError("invalid-range", "maxBytes is too small for the next UTF-8 codepoint");
      }
      const nextOffset = input.offset + byteLength;
      context.signal.throwIfAborted();
      return {
        status: found.ref.byteLength === 0 ? "empty" : "ok",
        snapshotId: found.ref.snapshotId,
        revision: found.ref.contentHash,
        contentHash: found.ref.contentHash,
        totalBytes: found.ref.byteLength,
        range: { offset: input.offset, byteLength },
        nextOffset: nextOffset < found.ref.byteLength ? nextOffset : null,
        text,
      };
    } catch (error) {
      context.signal.throwIfAborted();
      requireToolInvocation(context);
      if (error instanceof WebSnapshotReadError) {
        return { status: error.code, snapshotId: input.snapshotId, message: error.message };
      }
      // Storage/transport failures retain the original rejection. In particular,
      // a lost kernel connection must never become an empty or missing snapshot.
      throw error;
    }
  };
}
