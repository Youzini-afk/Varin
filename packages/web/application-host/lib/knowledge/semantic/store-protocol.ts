import type { SemanticStoreEngine } from "./store-engine.js";
export type SemanticStoreMethod = Exclude<keyof SemanticStoreEngine, "hostId" | "visitPublished" | "scope" | "space" | "spaceId" | "recipeId" | "generation" | "coverage" | "lifecycle">;
export const SEMANTIC_STORE_METHODS: Record<SemanticStoreMethod, true> = {
  checkpoint: true, markBuilding: true, markReady: true, lookupVectors: true,
  publishedRevision: true, publishDocuments: true, listDocumentIds: true,
  listDocumentStates: true, recordSourceMetadata: true,
  retainPublished: true, retainEmpty: true, listDocumentStatesPinned: true, lookupVectorsPinned: true,
  searchPinned: true, releasePinned: true, publishedReaderStats: true,
  removeDocument: true, search: true, searchDocumentScores: true, close: true,
};
export const isSemanticStoreMethod = (value: unknown): value is SemanticStoreMethod =>
  typeof value === "string" && Object.hasOwn(SEMANTIC_STORE_METHODS, value);
