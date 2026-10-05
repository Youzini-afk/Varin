/**
 * Embedder surface for the semantic index. Production MiniLM and test
 * hash-embedders share this shape so the store never talks to transformers
 * directly.
 */

import type { VectorSpaceIdentity } from "./identity.js";
import { LOCAL_MINILM_SPACE } from "./identity.js";

export type SemanticEmbedderStatus = "ready" | "unavailable";
export type SemanticEmbedPurpose = "document" | "query";

export interface SemanticEmbedItem {
  id: string;
  text: string;
}

export interface SemanticEmbedRequest {
  purpose: SemanticEmbedPurpose;
  items: readonly SemanticEmbedItem[];
  batchId: string;
  signal?: AbortSignal;
}

export interface SemanticEmbedResultItem {
  id: string;
  index: number;
  vector: number[];
}

export interface SemanticEmbedResult {
  batchId: string;
  space: VectorSpaceIdentity;
  items: SemanticEmbedResultItem[];
}

export interface SemanticEmbedder {
  status: SemanticEmbedderStatus;
  space: VectorSpaceIdentity;
  /** Local inference grain, not an input quota. Shared scheduling releases its
   * slot between these calls. Remote backends retain their transport batching. */
  inferenceBatchSize?: number;
  batchByLength?: boolean;
  dispose?(): Promise<void>;
  prepare(): Promise<void>;
  countTokens(text: string): number;
  embed(
    texts: readonly string[],
    request?: { purpose?: SemanticEmbedPurpose; signal?: AbortSignal; batchId?: string; priority?: "foreground" | "background" },
  ): Promise<number[][]>;
  embedBatch(request: SemanticEmbedRequest): Promise<SemanticEmbedResult>;
}

export function vectorsFromEmbedResult(result: SemanticEmbedResult): number[][] {
  return [...result.items].sort((left, right) => left.index - right.index).map((item) => item.vector);
}

export function embedBatchFromTexts(
  embedder: SemanticEmbedder,
  texts: readonly string[],
  purpose: SemanticEmbedPurpose,
): Promise<SemanticEmbedResult> {
  return embedder.embedBatch({
    purpose,
    batchId: `${purpose}:${texts.length}`,
    items: texts.map((text, index) => ({ id: `${purpose}-${index}`, text })),
  });
}

const l2normalize = (values: number[]): number[] => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return values;
  return values.map((value) => value / norm);
};

/** Deterministic bag-of-words vector for tests. Not a MiniLM substitute. */
export function hashEmbed(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/u).filter(Boolean);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slot = Math.abs(hash) % dim;
    vector[slot] = (vector[slot] ?? 0) + 1;
    const neighbor = (slot + 1) % dim;
    vector[neighbor] = (vector[neighbor] ?? 0) + 0.25;
  }
  return l2normalize(vector);
}

export function createHashEmbedder(space: VectorSpaceIdentity = {
  ...LOCAL_MINILM_SPACE,
  modelRevision: "test-hash",
}): SemanticEmbedder {
  const embedder: SemanticEmbedder = {
    status: "ready",
    space,
    prepare: async () => undefined,
    countTokens: (text) => Math.max(1, text.split(/\s+/u).filter(Boolean).length),
    embed: async (texts) => texts.map((text) => hashEmbed(text, space.dim)),
    embedBatch: async (request) => {
      request.signal?.throwIfAborted();
      const vectors = await embedder.embed(request.items.map((item) => item.text));
      return {
        batchId: request.batchId,
        space,
        items: request.items.map((item, index) => ({
          id: item.id,
          index,
          vector: vectors[index]!,
        })),
      };
    },
  };
  return embedder;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const n = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < n; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}
