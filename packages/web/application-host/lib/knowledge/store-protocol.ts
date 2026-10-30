import {
  KnowledgeMutationError,
  type KnowledgeStore, type OpenWorkspaceKnowledgeDeps,
} from "./store-contract.js";
import type { PlanChanged } from "@varin/protocol";
import type { AssociationRefreshPort } from "./association-refresh.js";
import type { FilePurgePort } from './file-purge.js';

export type DirectStoreMethod = Exclude<keyof KnowledgeStore, "dim" | "knowledgeRevision" | "resolveAssociationCandidates" | "purgeFileCatalog">;
export type StoreMethod = DirectStoreMethod | keyof AssociationRefreshPort | keyof FilePurgePort;
// Exhaustive at compile time, and a runtime allowlist on the private child pipe.
export const STORE_METHODS: Record<DirectStoreMethod, true> = {
  putEvent: true, listEvents: true,
  getOrganizerProgress: true, putOrganizerProgress: true,
  listOrganizerProgress: true, putKnowledge: true,
  readPlanCandidate: true, readPlan: true, mutatePlan: true, readPlanMutation: true, capturePlanFork: true,
  readKnowledgeMutation: true, createKnowledgeIfAbsent: true, updateSuggestedKnowledge: true,
  maintainKnowledge: true, noteMemoryMaintenance: true,
  releaseMaintenanceReceipt: true, clearKnowledgeHistory: true,
  updateAcceptedKnowledge: true, supersedeKnowledge: true,
  retireKnowledge: true, getKnowledge: true,
  listKnowledge: true, getSupersedeChain: true, acceptKnowledge: true,
  dismissKnowledge: true, recordRecall: true, recall: true, touchFile: true,
  replaceFileSymbols: true,
  removeFileSymbols: true, recordResolvedRelations: true,
  replaceResolvedRelationsForAnchor: true, searchSymbols: true,
  getDefinedSymbols: true, getFileRelations: true, findLinks: true,
  listFileIndexStates: true, recordFileSourceMetadata: true,
  findReferences: true, findCallers: true, findCalls: true, catalogStats: true,
  findImporters: true, connectionLiterals: true,
  runRetention: true, compact: true, close: true,
};
const ASSOCIATION_METHODS: Record<keyof AssociationRefreshPort, true> = {
  beginAssociationRefresh: true, stepAssociationRefresh: true, releaseAssociationRefresh: true,
};
const FILE_PURGE_METHODS: Record<keyof FilePurgePort, true> = {
  beginFilePurge: true, stepFilePurge: true, releaseFilePurge: true,
};
export const isStoreMethod = (value: unknown): value is StoreMethod => (
  typeof value === "string" && (Object.hasOwn(STORE_METHODS, value) || Object.hasOwn(ASSOCIATION_METHODS, value) || Object.hasOwn(FILE_PURGE_METHODS, value))
);

export type StoreOpenOptions = Pick<OpenWorkspaceKnowledgeDeps, "dataDir" | "hostId" | "workspaceId" | "scope"> & {
  embedding: { dim: number } | null;
};
export type StoreRequest = {
  id: number;
  storeId: number;
  method: StoreMethod | "open" | "semantic";
  args: unknown[];
};
export type StoreFailure = { name: string; message: string; code?: string };
export type StoreResponse = { id: number; revision?: string } & (
  | { ok: true; value: unknown }
  | { ok: false; error: StoreFailure }
);
export type StoreNotification =
  | { type: "plan-changed"; storeId: number; change: PlanChanged }
  | { type: "knowledge"; storeId: number; ids: readonly number[]; revision: string }
  | { type: "persistence-error"; storeId: number; error: StoreFailure };
export type StoreChildMessage =
  | { type: "ready"; version: 4 }
  | { type: "results"; responses: StoreResponse[] }
  | StoreNotification;

const isFailure = (value: unknown): value is StoreFailure => {
  if (!value || typeof value !== "object") return false;
  const error = value as StoreFailure;
  return typeof error.name === "string" && typeof error.message === "string"
    && (error.code === undefined || typeof error.code === "string");
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
  if (r.type === "plan-changed") return Boolean(r.change && typeof r.change === "object"
    && typeof r.change.threadId === "string" && typeof r.change.branchId === "string" && typeof r.change.ref === "string");
  if (r.type === "knowledge") return typeof r.revision === "string" && Array.isArray(r.ids) && r.ids.every(Number.isSafeInteger);
  if (r.type === "persistence-error") return isFailure(r.error);
  return false;
};

export function storeFailure(error: unknown): StoreFailure {
  const value = error instanceof Error ? error : new Error("Knowledge store operation failed");
  const code = (value as Error & { code?: unknown }).code;
  return {
    name: value.name, message: value.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}
export function restoreStoreError(error: StoreFailure): Error {
  if (error.name === "KnowledgeMutationError"
    && (error.code === "conflict" || error.code === "not-found" || error.code === "invalid")) {
    return new KnowledgeMutationError(error.code, error.message);
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  if (error.code !== undefined) Object.assign(restored, { code: error.code });
  return restored;
}
