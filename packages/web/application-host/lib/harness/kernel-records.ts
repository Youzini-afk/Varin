import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";

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
  getOperation?(operationId: string): Promise<Record<string, unknown> | null>;
  getBlob(
    hash: string,
    source: { recordId: string; slot: string },
    options?: { offset?: number; length?: number; signal?: AbortSignal },
  ): Promise<{ byteLength: number; bytesBase64: string; nextOffset: number; eof: boolean }>;
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
 * interleave. Shared by material and other kernel record owners.
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
