/**
 * Vector-space and index-recipe identities, plus the D-162 scope seam.
 *
 * `workspaceId` is not a path, block, parent-unit, or query parameter. The
 * only conversion is `workspaceScope`, which builds `{ scopeKind, scopeId }`.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { remoteEmbeddingSpaceParts } from "@varin/protocol";
import { CATALOG_EXTRACTOR_VERSION } from "../symbols.js";

export const SEMANTIC_CHUNKER_VERSION = 4;
export const SEMANTIC_TEXT_DECORATION_VERSION = 1;

/** Effective word-piece window written into the space id (D-166). */
export const LOCAL_MINILM_MAX_TOKENS = 512;

export const LOCAL_MINILM_SPACE = {
  provider: "local",
  model: "all-MiniLM-L6-v2",
  modelRevision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dim: 384,
  pooling: "mean" as const,
  normalize: true,
  maxTokens: LOCAL_MINILM_MAX_TOKENS,
};

export type VectorSpaceIdentity = {
  provider: string;
  model: string;
  modelRevision: string;
  dim: number;
  pooling: "mean" | "cls";
  normalize: boolean;
  maxTokens: number;
  /** Credential-free resolved provider/model configuration identity. */
  configurationId?: string;
  /** When set (remote bindings), this is the published space id. */
  spaceId?: string;
};

export type IndexRecipeIdentity = {
  chunkerVersion: number;
  extractorVersion: number;
  textDecorationVersion: number;
};

export type SemanticScopeKey = {
  scopeKind: string;
  scopeId: string;
};

export type SemanticDocumentKey = {
  scope: SemanticScopeKey;
  documentId: string;
  revision: string;
};

export const workspaceScope = (workspaceId: string): SemanticScopeKey => ({
  scopeKind: "workspace",
  scopeId: workspaceId,
});

export const defaultRecipeIdentity = (): IndexRecipeIdentity => ({
  chunkerVersion: SEMANTIC_CHUNKER_VERSION,
  extractorVersion: CATALOG_EXTRACTOR_VERSION,
  textDecorationVersion: SEMANTIC_TEXT_DECORATION_VERSION,
});

const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

export const spaceIdOf = (space: VectorSpaceIdentity): string => (
  space.spaceId ?? digest(JSON.stringify([
    ...(space.configurationId ? [space.configurationId] : []),
    space.provider,
    space.model,
    space.modelRevision,
    space.dim,
    space.pooling,
    space.normalize,
    space.maxTokens,
  ]))
);

export const remoteEmbeddingSpaceId = (input: {
  protocol: string;
  providerId: string;
  modelId: string;
  maxTokens: number;
  dimensions: number;
  configurationId: string;
}): string => digest(JSON.stringify(remoteEmbeddingSpaceParts(input)));

export const embedTextKey = (embedText: string): string => (
  createHash("sha256").update(embedText).digest("hex")
);

export const recipeIdOf = (recipe: IndexRecipeIdentity = defaultRecipeIdentity()): string => digest(JSON.stringify([
  recipe.chunkerVersion,
  recipe.extractorVersion,
  recipe.textDecorationVersion,
]));

/**
 * Block identity is a document id plus a line span. The document id is opaque:
 * it is encoded, never joined as a filesystem path.
 */
export const blockIdentity = (documentId: string, startLine: number, endLine: number): string => (
  `${encodeURIComponent(documentId)}#${startLine}-${endLine}`
);

export const parentUnitIdentity = (documentId: string, name: string, kind: string): string => (
  `${encodeURIComponent(documentId)}#${encodeURIComponent(name)}#${encodeURIComponent(kind)}`
);

export const contentHashOf = (text: string): string => (
  createHash("sha256").update(text).digest("hex")
);

export const semanticRootDir = (dataDir: string, hostId: string): string => (
  join(dataDir, "knowledge", hostId, "semantic")
);

export const semanticSpaceDir = (
  dataDir: string,
  hostId: string,
  scope: SemanticScopeKey,
  spaceId: string,
): string => join(semanticRootDir(dataDir, hostId), scope.scopeKind, scope.scopeId, spaceId);

export const semanticGenerationDir = (
  dataDir: string,
  hostId: string,
  scope: SemanticScopeKey,
  spaceId: string,
  generation: string,
): string => join(semanticSpaceDir(dataDir, hostId, scope, spaceId), generation);

export const intraOpThreads = (parallelism: number): number => Math.max(1, Math.floor(parallelism / 2));
