import type { SemanticChunk } from "./chunker.js";
import type { SemanticScopeKey, VectorSpaceIdentity, IndexRecipeIdentity } from "./identity.js";
import type { IndexPathScope } from "../index-scope.js";

export type SemanticIndexLifecycle = "idle" | "building" | "rebuilding" | "ready";
export type SemanticQueryCoverage = "empty" | "partial" | "complete";

export type SemanticHit = {
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  similarity: number;
  rank: number;
  scope: SemanticScopeKey;
  spaceId: string;
  generation: string;
};

export type SemanticCheckpoint = {
  generation: string;
  spaceId: string;
  recipeId: string;
  lifecycle: SemanticIndexLifecycle;
  coverage: SemanticQueryCoverage;
  publishedDocuments: number;
};

export type BlockPayload = {
  type: "block";
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  embedText: string;
  embedKey: string;
};

export type DocumentPayload = {
  type: "document";
  documentId: string;
  revision: string;
  recipeId: string;
  blockCount: number;
  sourceMetadata?: SemanticSourceMetadata;
};

/** Inventory hint paired with a successfully published/verified revision.
 * Equality avoids a repeat build, but never replaces query-time byte checks. */
export type SemanticSourceMetadata = { byteLength: string; modifiedTimeNs: string };
export type SemanticDocumentState = Pick<DocumentPayload, "documentId" | "revision" | "recipeId" | "sourceMetadata">;
export type SemanticSourceMetadataUpdate = {
  documentId: string; revision: string; sourceMetadata: SemanticSourceMetadata; publishToken: number;
};

export type SemanticDocumentPublication = {
  documentId: string;
  revision: string;
  chunks: readonly SemanticChunk[];
  /** Monotonic per-document token. A lower token cannot overwrite a higher one. */
  publishToken?: number;
  sourceMetadata?: SemanticSourceMetadata;
};

export type SemanticOverlayBlock = {
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  vector: number[];
};

export type SemanticSearchOptions = {
  indexScope?: IndexPathScope & { resourceRoot: string };
  roots?: readonly string[];
  maskPaths?: readonly string[];
  extras?: readonly SemanticOverlayBlock[];
  disk?: boolean;
};

const isRootList = (value: readonly string[] | SemanticSearchOptions): value is readonly string[] => (
  Array.isArray(value)
);

export const resolveSemanticSearchOptions = (
  rootsOrOptions?: readonly string[] | SemanticSearchOptions,
): SemanticSearchOptions => {
  if (rootsOrOptions === undefined) return {};
  if (isRootList(rootsOrOptions)) return { roots: rootsOrOptions };
  return rootsOrOptions;
};

export type SemanticStoreOpenOptions = {
  dataDir: string;
  hostId: string;
  scope: SemanticScopeKey;
  space: VectorSpaceIdentity;
  recipe?: IndexRecipeIdentity;
};

export type PreparedSemanticPublication = SemanticDocumentPublication & { vectors: number[][] };

