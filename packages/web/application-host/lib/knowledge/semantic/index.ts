export {
  LOCAL_DEFAULT_MAX_TOKENS,
  LOCAL_DEFAULT_SPACE,
  SEMANTIC_CHUNKER_VERSION,
  SEMANTIC_TEXT_DECORATION_VERSION,
  blockIdentity,
  contentHashOf,
  defaultRecipeIdentity,
  intraOpThreads,
  parentUnitIdentity,
  recipeIdOf,
  semanticGenerationDir,
  semanticRootDir,
  semanticSpaceDir,
  spaceIdOf,
  workspaceScope,
} from "./identity.js";
export type { IndexRecipeIdentity, SemanticDocumentKey, SemanticScopeKey, VectorSpaceIdentity } from "./identity.js";
export { buildEmbedText, splitSourceLines, textOfLines } from "./embed-text.js";
export type { EmbedTextParts, TokenCounter } from "./embed-text.js";
export { relocateSemanticFocus } from "./relocate.js";
export type { SemanticRelocateMode, SemanticRelocateResult } from "./relocate.js";
export { packStructuralUnits } from "./chunker.js";
export type { PackStructuralUnitsInput, SemanticChunk } from "./chunker.js";
export { cosineSimilarity, createHashEmbedder, hashEmbed, vectorsFromEmbedResult } from "./embedder.js";
export type {
  SemanticEmbedder,
  SemanticEmbedderStatus,
  SemanticEmbedPurpose,
  SemanticEmbedRequest,
  SemanticEmbedResult,
} from "./embedder.js";
export { createRemoteEmbedder } from "./remote-embedder.js";
export { createSemanticBackend, embeddingSettingsFromSnapshot } from "./backend.js";
export { createEmbedScheduler } from "./embed-scheduler.js";
export { createVectorCache } from "./vector-cache.js";
export { createSemanticGenerationStore } from "./store.js";
export type {
  SemanticCheckpoint,
  SemanticGenerationStore,
  SemanticHit,
  SemanticIndexLifecycle,
  SemanticQueryCoverage,
} from "./store.js";
