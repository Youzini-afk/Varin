import {
  KnowledgeBlockConflictError, KnowledgeMutationError,
  type Block, type BlockChange, type KnowledgeStore, type OpenWorkspaceKnowledgeDeps,
} from "./store-contract.js";

export type StoreMethod = Exclude<keyof KnowledgeStore, "dim" | "knowledgeRevision">;
// Exhaustive at compile time, and a runtime allowlist on the private child pipe.
export const STORE_METHODS: Record<StoreMethod, true> = {
  putEvent: true, listEvents: true, putSession: true, getBlocks: true,
  upsertBlock: true, deleteBlock: true, putKnowledge: true,
  createKnowledgeIfAbsent: true, updateSuggestedKnowledge: true,
  updateAcceptedKnowledge: true, supersedeKnowledge: true,
  retireKnowledge: true, getKnowledge: true,
  listKnowledge: true, getSupersedeChain: true, acceptKnowledge: true,
  dismissKnowledge: true, recordRecall: true, recall: true, touchFile: true,
  replaceFileSymbols: true, resolveAssociationCandidates: true,
  removeFileSymbols: true, recordResolvedRelations: true,
  replaceResolvedRelationsForAnchor: true, searchSymbols: true,
  getDefinedSymbols: true, getFileRelations: true, findLinks: true,
  findReferences: true, findCallers: true, findCalls: true, catalogStats: true,
  findImporters: true, connectionLiterals: true, deleteSession: true,
  runRetention: true, close: true,
};
export const isStoreMethod = (value: unknown): value is StoreMethod => (
  typeof value === "string" && Object.hasOwn(STORE_METHODS, value)
);

export type StoreOpenOptions = Pick<OpenWorkspaceKnowledgeDeps, "dataDir" | "hostId" | "workspaceId" | "scope"> & {
  embedding: { dim: number } | null;
};
export type StoreRequest = {
  id: number;
  storeId: number;
  method: StoreMethod | "open";
  args: unknown[];
};
export type StoreFailure = { name: string; message: string; code?: string; current?: Block | null };
export type StoreResponse = { id: number; revision?: string } & (
  | { ok: true; value: unknown }
  | { ok: false; error: StoreFailure }
);
export type StoreNotification =
  | { type: "blocks"; storeId: number; sessionId: string; change: BlockChange }
  | { type: "knowledge"; storeId: number; ids: readonly number[]; revision: string }
  | { type: "persistence-error"; storeId: number; error: StoreFailure };
export type StoreChildMessage =
  | { type: "ready"; version: 1 }
  | { type: "results"; responses: StoreResponse[] }
  | StoreNotification;

const isBlock = (value: unknown): value is Block => {
  if (!value || typeof value !== "object") return false;
  const block = value as Block;
  return typeof block.sessionId === "string" && typeof block.label === "string"
    && typeof block.content === "string" && typeof block.updatedAt === "number"
    && ["agent", "memory-agent", "user"].includes(block.updatedBy);
};
const isFailure = (value: unknown): value is StoreFailure => {
  if (!value || typeof value !== "object") return false;
  const error = value as StoreFailure;
  return typeof error.name === "string" && typeof error.message === "string"
    && (error.code === undefined || typeof error.code === "string")
    && (error.current === undefined || error.current === null || isBlock(error.current));
};
export const isStoreResponse = (value: unknown): value is StoreResponse => {
  if (!value || typeof value !== "object") return false;
  const r = value as StoreResponse;
  return Number.isSafeInteger(r.id) && (r.revision === undefined || typeof r.revision === "string")
    && (r.ok === true || (r.ok === false && isFailure(r.error)));
};
export const isStoreNotification = (value: unknown): value is StoreNotification => {
  if (!value || typeof value !== "object") return false;
  const r = value as StoreNotification;
  if (!Number.isSafeInteger(r.storeId)) return false;
  if (r.type === "knowledge") return typeof r.revision === "string" && Array.isArray(r.ids) && r.ids.every(Number.isSafeInteger);
  if (r.type === "persistence-error") return isFailure(r.error);
  if (r.type !== "blocks" || typeof r.sessionId !== "string" || !r.change || typeof r.change !== "object") return false;
  return (r.change.previous === null || isBlock(r.change.previous))
    && (r.change.current === null || isBlock(r.change.current));
};

export function storeFailure(error: unknown): StoreFailure {
  const value = error instanceof Error ? error : new Error("Knowledge store operation failed");
  const code = (value as Error & { code?: unknown }).code;
  return {
    name: value.name, message: value.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(value instanceof KnowledgeBlockConflictError ? { current: value.current } : {}),
  };
}
export function restoreStoreError(error: StoreFailure): Error {
  if (error.name === "KnowledgeBlockConflictError") {
    return new KnowledgeBlockConflictError(error.current ?? null);
  }
  if (error.name === "KnowledgeMutationError"
    && (error.code === "conflict" || error.code === "not-found" || error.code === "invalid")) {
    return new KnowledgeMutationError(error.code, error.message);
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  if (error.code !== undefined) Object.assign(restored, { code: error.code });
  return restored;
}
