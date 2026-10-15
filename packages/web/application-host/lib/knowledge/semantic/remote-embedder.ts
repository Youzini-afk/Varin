/**
 * Host-side remote embedder. Submits authorized text through its retained
 * inference binding and never sees provider secrets.
 */

import { randomUUID } from "node:crypto";
import {
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type HarnessEmbedResult,
  type HarnessResolvedEmbeddingBinding,
} from "@varin/protocol";
import type { SemanticEmbedder, SemanticEmbedRequest, SemanticEmbedResult } from "./embedder.js";
import { remoteEmbeddingSpaceId, type VectorSpaceIdentity } from "./identity.js";

export interface RemoteEmbedClient {
  embed(params: {
    purpose: "document" | "query";
    providerId: string;
    modelId: string;
    protocol: "openai-compatible";
    items: Array<{ id: string; text: string }>;
    batchId: string;
    dimensions?: number;
    maxTokens: number;
    configurationId: string;
    signal?: AbortSignal;
  }): Promise<HarnessEmbedResult>;
}

const spaceFromBinding = (
  binding: HarnessResolvedEmbeddingBinding,
  dim: number,
): VectorSpaceIdentity => {
  const maxTokens = binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
  const identity: VectorSpaceIdentity = {
    provider: binding.providerId,
    model: binding.modelId,
    modelRevision: "openai-compatible",
    dim,
    pooling: "mean",
    normalize: true,
    maxTokens,
    configurationId: binding.configurationId,
  };
  if (dim > 0) {
    identity.spaceId = remoteEmbeddingSpaceId({
      protocol: binding.protocol,
      providerId: binding.providerId,
      modelId: binding.modelId,
      configurationId: binding.configurationId,
      maxTokens,
      dimensions: dim,
    });
  }
  return identity;
};

export function createRemoteEmbedder(options: {
  binding: HarnessResolvedEmbeddingBinding;
  client: RemoteEmbedClient;
  /** Already learned by the same backend; never changes the wire dimensions option. */
  knownDimensions?: number;
}): SemanticEmbedder {
  const maxTokens = options.binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
  const space = spaceFromBinding(options.binding, options.binding.dimensions ?? options.knownDimensions ?? 0);
  const embedder: SemanticEmbedder = {
    status: "ready",
    get space() { return space; },
    prepare: async () => undefined,
    countTokens: (text) => {
      // The provider tokenizer is not available here. Character length is a
      // splitting estimate, not a guarantee about the provider's token count.
      return Math.max(1, text.length);
    },
    embed: async (texts, request) => {
      request?.signal?.throwIfAborted();
      const result = await embedder.embedBatch({
        purpose: request?.purpose ?? "document",
        batchId: request?.batchId ?? randomUUID(),
        items: texts.map((text, index) => ({ id: `remote-${index}`, text })),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return result.items.sort((left, right) => left.index - right.index).map((item) => item.vector);
    },
    embedBatch: async (request: SemanticEmbedRequest): Promise<SemanticEmbedResult> => {
      request.signal?.throwIfAborted();
      const result = await options.client.embed({
        purpose: request.purpose,
        providerId: options.binding.providerId,
        modelId: options.binding.modelId,
        protocol: "openai-compatible",
        configurationId: options.binding.configurationId,
        items: request.items.map((item) => ({ id: item.id, text: item.text })),
        batchId: request.batchId,
        ...(options.binding.dimensions === undefined ? {} : { dimensions: options.binding.dimensions }),
        maxTokens,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (result.items.length !== request.items.length) {
        throw new Error(`Remote embedder returned ${result.items.length} vectors for ${request.items.length} inputs.`);
      }
      if (result.batchId !== request.batchId) {
        throw new Error("Remote embedder returned a different batch identity.");
      }
      if (
        result.space.protocol !== options.binding.protocol
        || result.space.providerId !== options.binding.providerId
        || result.space.modelId !== options.binding.modelId
        || result.space.configurationId !== options.binding.configurationId
        || result.space.maxTokens !== maxTokens
      ) {
        throw new Error("Remote embedder returned a different configured binding.");
      }
      const ordered = [...result.items].sort((left, right) => left.index - right.index);
      for (const [index, item] of ordered.entries()) {
        if (item.index !== index) throw new Error(`Remote embedder result is missing index ${index}.`);
        if (item.id !== request.items[index]!.id) {
          throw new Error("Remote embedder result identity does not match the submitted batch.");
        }
        if (item.vector.some((value) => !Number.isFinite(value))) {
          throw new Error("Remote embedder returned a non-finite vector.");
        }
      }
      const dim = result.space.dim;
      if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error("Remote embedder returned an invalid dimension.");
      if (ordered.some((item) => item.vector.length !== dim)) {
        throw new Error("Remote embedder mixed vector dimensions.");
      }
      const expectedSpaceId = remoteEmbeddingSpaceId({
        protocol: options.binding.protocol,
        providerId: options.binding.providerId,
        modelId: options.binding.modelId,
        configurationId: options.binding.configurationId,
        maxTokens,
        dimensions: dim,
      });
      if (result.space.spaceId !== expectedSpaceId) {
        throw new Error("Remote embedder returned a different vector space than the configured binding.");
      }
      if (space.dim > 0 && space.dim !== dim) {
        throw new Error(`Remote embedding dimension changed from ${space.dim} to ${dim}.`);
      }
      if (space.spaceId && space.spaceId !== expectedSpaceId) {
        throw new Error("Remote embedding space changed after it was resolved.");
      }
      if (space.dim === 0) {
        space.dim = dim;
        space.spaceId = expectedSpaceId;
      }
      return {
        batchId: result.batchId,
        space,
        items: ordered,
      };
    },
  };
  return embedder;
}
