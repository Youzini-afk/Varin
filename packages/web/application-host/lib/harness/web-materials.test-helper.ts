import { createHash } from "node:crypto";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createRetrievalArtifactAccess, type KernelRecordContext } from "./retrieval-artifacts.js";
import { createWebMaterialStore } from "./web-materials.js";

/** Exercises the production material and collection owners over record/blob
 * fixtures. It is not evidence of native storage or kernel admission. */
type TestRecord = {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  recordRevision: number;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

export const createMaterialStoreFixture = (options: {
  beforeObjectRead?: () => Promise<void>;
  client?: KernelRecordContext["client"];
} = {}) => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, TestRecord>();
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
  const context = {
    ...(options.client ? { client: options.client } : {}),
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
        const record = { ...input, workspaceId: input.workspaceId ?? "ws", recordRevision: (existing?.recordRevision ?? 0) + 1, references: [...(input.references ?? [])] };
        records.set(record.recordId, record);
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
    objects,
    workingStates,
    // A fresh store over the same maps simulates a Host restart: durable
    // records remain resolvable while nothing about the process survived.
    reopen: () => createWebMaterialStore(workingStates),
    materials: createWebMaterialStore(workingStates),
    retrieval: createRetrievalArtifactAccess(workingStates),
  };
};
