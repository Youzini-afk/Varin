/**
 * Knowledge vectors are stored by the same generation store as code semantic
 * vectors. The authority remains knowledge/store.ts; this module only gives
 * callers a knowledge-specific scope name.
 */

import type { SemanticEmbedder } from "../semantic/embedder.js";
import {
  createSemanticGenerationStore,
  type SemanticGenerationStore,
} from "../semantic/store.js";
import type { SemanticVectorCache } from "../semantic/vector-cache.js";
import type { EmbedScheduler } from "../semantic/embed-scheduler.js";
import type { KnowledgeScope } from "../store.js";
import { knowledgeStoreKeyForScope } from "../../harness/owner-scope.js";

export type KnowledgeVectorStore = SemanticGenerationStore;

export const knowledgeVectorScopeKey = (scope: KnowledgeScope, scopeId: string) => ({
  scopeKind: `knowledge-${scope}`,
  scopeId: scope === 'bot' ? knowledgeStoreKeyForScope(scopeId) : scopeId,
});

/** A vector hit after the semantic block result is aggregated by knowledge id. */
export type KnowledgeVectorHit = {
  knowledgeId: number;
  contentRevision: string;
  similarity: number;
  rank: number;
  spaceId: string;
};

export function createKnowledgeVectorStore(options: {
  dataDir: string;
  hostId: string;
  scope: KnowledgeScope;
  scopeId: string;
  embedder: SemanticEmbedder;
  cache?: SemanticVectorCache;
  scheduler?: EmbedScheduler;
}): KnowledgeVectorStore {
  return createSemanticGenerationStore({
    dataDir: options.dataDir,
    hostId: options.hostId,
    scope: knowledgeVectorScopeKey(options.scope, options.scopeId),
    embedder: options.embedder,
    ...(options.cache ? { vectorCache: options.cache } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
}
