/**
 * Chooses the live embedding backend from user-owned harness.embedding.
 * A configured remote binding is used for both index and query. There is no
 * silent fallback to a local model for that query.
 */

import {
  HarnessInferenceSettingsValidationError,
  parseHarnessEmbeddingSettings,
  type HarnessEmbeddingSettings,
  type HarnessResolvedEmbeddingBinding,
  type PiSettingsSnapshot,
} from "@varin/protocol";
import type { SemanticEmbedder } from "./embedder.js";
import { createRemoteEmbedder, type RemoteEmbedClient } from "./remote-embedder.js";

export type SemanticBackendKind = "local" | "remote";

const bindingKey = (binding: HarnessResolvedEmbeddingBinding): string => (
  `${binding.protocol}:${binding.providerId}:${binding.modelId}:${binding.configurationId}:${binding.dimensions ?? ""}:${binding.maxTokens ?? ""}`
);

export function embeddingSettingsFromSnapshot(snapshot: PiSettingsSnapshot | null | undefined): HarnessEmbeddingSettings | undefined {
  const harness = snapshot?.global?.harness;
  if (harness === undefined) return undefined;
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
    throw new HarnessInferenceSettingsValidationError("harness must be an object");
  }
  return parseHarnessEmbeddingSettings((harness as { embedding?: unknown }).embedding);
}

export function createSemanticBackend(options: {
  local: SemanticEmbedder;
  embedClient?: RemoteEmbedClient;
}) {
  let kind: SemanticBackendKind = "local";
  let local = options.local;
  let current = local;
  let currentKey = "local";
  let lastError: unknown;

  const bind = (settings: HarnessResolvedEmbeddingBinding | undefined): SemanticEmbedder => {
    lastError = undefined;
    if (!settings) {
      kind = "local";
      current = local;
      currentKey = "local";
      return current;
    }
    if (!options.embedClient) {
      lastError = new Error("Remote embedding is configured but the Pi workspace binding is unavailable.");
      kind = "remote";
      current = {
        ...local,
        status: "unavailable",
      };
      currentKey = bindingKey(settings);
      return current;
    }
    const key = bindingKey(settings);
    if (kind === "remote" && currentKey === key && current.status === "ready") return current;
    kind = "remote";
    currentKey = key;
    current = createRemoteEmbedder({ binding: settings, client: options.embedClient });
    return current;
  };

  const unavailable = (error: unknown): SemanticEmbedder => {
    lastError = error;
    kind = "remote";
    currentKey = "invalid";
    current = { ...local, status: "unavailable" };
    return current;
  };

  return {
    get kind() { return kind; },
    get embedder() { return current; },
    get lastError() { return lastError; },
    bind,
    unavailable,
    get local() { return local; },
    replaceLocal: (next: SemanticEmbedder): void => {
      local = next;
      if (kind === "local") current = next;
    },
  };
}

export type SemanticBackend = ReturnType<typeof createSemanticBackend>;
