import { createHash } from "node:crypto";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createMaterialLifecycle } from "./material-lifecycle.js";
import type { KernelRecordContext } from "./kernel-records.js";
import { createWebMaterialStore } from "./web-materials.js";

/** Exercises the production material and collection owners over record/blob
 * fixtures. It is not evidence of native storage or kernel admission. */
type TestRecord = {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  threadId?: string;
  recordRevision: number;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

export const createMaterialStoreFixture = (options: {
  beforeObjectRead?: () => Promise<void>;
  client?: KernelRecordContext["client"];
  operationReceipts?: boolean;
  workspaceId?: string;
} = {}) => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, TestRecord>();
  const operations = new Map<string, Record<string, unknown>>();
  const store = {
    async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      return { hash, byteLength: bytes.byteLength };
    },
    async getObject(hash: string): Promise<Buffer | null> {
      await options.beforeObjectRead?.();
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes) : null;
    },
    async getObjectSlice(hash: string, _byteLength: number, offset: number, length: number): Promise<Buffer | null> {
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes.subarray(offset, offset + length)) : null;
    },
  };
  const receiptClient: KernelRecordContext["client"] = options.operationReceipts ? {
    getOperation: async id => structuredClone(operations.get(id) ?? null),
    getBlob: async (hash, source, range) => {
      await options.beforeObjectRead?.();
      range?.signal?.throwIfAborted();
      const record = records.get(source.recordId), bytes = objects.get(hash);
      if (!bytes || !record?.references.some(ref => ref.slot === source.slot && ref.objectHash === hash)) throw new Error("Fixture blob proof is unavailable");
      const offset = range?.offset ?? 0;
      const nextOffset = Math.min(bytes.byteLength, offset + (range?.length ?? bytes.byteLength));
      return { byteLength: bytes.byteLength, bytesBase64: bytes.subarray(offset, nextOffset).toString("base64"), nextOffset, eof: nextOffset === bytes.byteLength };
    },
  } : undefined;
  const context = {
    ...(options.client ?? receiptClient ? { client: options.client ?? receiptClient } : {}),
    records: {
      async get(recordId: string): Promise<TestRecord | null> {
        return records.get(recordId) ?? null;
      },
      async list(input: { recordType?: string }): Promise<TestRecord[]> {
        return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType);
      },
      async put(input: Omit<TestRecord, "recordRevision" | "workspaceId"> & { workspaceId?: string; operationId: string; expectedRecordRevision?: number }): Promise<TestRecord> {
        const existing = records.get(input.recordId);
        if (existing && input.expectedRecordRevision !== existing.recordRevision) throw new Error("record revision conflict");
        const record = { ...input, workspaceId: input.workspaceId ?? options.workspaceId ?? "ws", recordRevision: (existing?.recordRevision ?? 0) + 1, references: [...(input.references ?? [])] };
        records.set(record.recordId, record);
        operations.set(input.operationId, { operationId: input.operationId, kind: "storage.record.put", state: "committed", result: structuredClone(record) });
        return record;
      },
      async release(_operationId: string, recordId: string): Promise<Record<string, unknown>> {
        const released = records.delete(recordId);
        return { recordId, released };
      },
    },
  };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (_workspaceId, _purpose, operation) => operation(
      store as unknown as WorkingStateRootStore,
      context as unknown as WorkingStateRootContext,
    ),
  };
  return {
    records,
    operations,
    objects,
    workingStates,
    // A fresh store over the same maps simulates a Host restart: durable
    // records remain resolvable while nothing about the process survived.
    reopen: () => createWebMaterialStore(workingStates),
    materials: createWebMaterialStore(workingStates),
    lifecycle: createMaterialLifecycle(workingStates),
  };
};
