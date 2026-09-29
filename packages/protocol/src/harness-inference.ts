import type {
  HarnessFastDecisionPurpose,
  HarnessFastDecisionPurposeStatus,
} from "./harness-fast-decision.js";

/**
 * Workspace-scoped embedding and rerank calls. These are not chat model slots.
 * Secrets stay in the Pi runtime; the Host only submits authorized text.
 */

/** Remote embedding window. Not the local MiniLM 512-token limit. */
export const REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS = 8192;

export type HarnessEmbedPurpose = "document" | "query";

export type HarnessEmbeddingProtocol = "openai-compatible";

export interface HarnessEmbeddingSettings {
  protocol: HarnessEmbeddingProtocol;
  providerId: string;
  modelId: string;
  dimensions?: number;
  maxTokens?: number;
}

/** Credential-free provider/model configuration identity resolved by Pi. */
export interface HarnessResolvedEmbeddingBinding extends HarnessEmbeddingSettings {
  configurationId: string;
}

export type HarnessRerankProtocol = "http-rerank";

export interface HarnessRerankSettings {
  protocol: HarnessRerankProtocol;
  providerId: string;
  modelId: string;
  /** Provider-relative path. Defaults to `/rerank`. */
  endpoint?: string;
  maxDocumentTokens?: number;
}

/** Credential-free provider/model configuration identity resolved by Pi. */
export interface HarnessResolvedRerankBinding extends HarnessRerankSettings {
  configurationId: string;
}

export interface HarnessInferenceBindingSnapshot {
  embedding:
    | { status: "ready"; binding: HarnessResolvedEmbeddingBinding }
    | { status: "unconfigured" | "invalid" | "unavailable"; message?: string };
  rerank:
    | { status: "ready"; binding: HarnessResolvedRerankBinding }
    | { status: "unconfigured" | "invalid" | "unavailable"; message?: string };
  /**
   * Per-purpose fast-decision resolution. Absent when the worker predates the
   * capability — consumers must treat a missing entry as unavailable.
   */
  fastDecision?: {
    purposes: Partial<Record<HarnessFastDecisionPurpose, HarnessFastDecisionPurposeStatus>>;
  };
}

export interface HarnessVectorSpaceBinding {
  configurationId: string;
  providerId: string;
  modelId: string;
  protocol: HarnessEmbeddingProtocol | "local";
  dim: number;
  maxTokens: number;
  spaceId: string;
}

export interface HarnessEmbedItem {
  id: string;
  text: string;
}

export interface HarnessEmbedParams {
  configurationId: string;
  purpose: HarnessEmbedPurpose;
  providerId: string;
  modelId: string;
  protocol: HarnessEmbeddingProtocol;
  items: HarnessEmbedItem[];
  batchId: string;
  dimensions?: number;
  maxTokens?: number;
}

export interface HarnessEmbedVector {
  id: string;
  index: number;
  vector: number[];
}

export interface HarnessEmbedResult {
  batchId: string;
  space: HarnessVectorSpaceBinding;
  items: HarnessEmbedVector[];
}

export interface HarnessRerankDocument {
  id: string;
  text: string;
  revision?: string;
}

export interface HarnessRerankParams {
  configurationId: string;
  providerId: string;
  modelId: string;
  protocol: HarnessRerankProtocol;
  query: string;
  documents: HarnessRerankDocument[];
  batchId: string;
  endpoint?: string;
  maxDocumentTokens?: number;
}

export interface HarnessRerankScore {
  id: string;
  index: number;
  score: number;
}

export interface HarnessRerankResult {
  batchId: string;
  providerId: string;
  modelId: string;
  scores: HarnessRerankScore[];
}

/**
 * `harness.memoryOrganize` — one generative narration batch for the BC2
 * background organizer (Host -> Pi workspace worker). Unlike embed/rerank/
 * fastDecision this is a chat-model completion against the configured
 * `models.memoryOrganizer` slot; the worker resolves provider/auth and
 * rejects a request whose frozen binding no longer matches live settings.
 */
export interface HarnessMemoryOrganizeParams {
  batchId: string;
  providerId: string;
  modelId: string;
  /** A Bot profile supplied this model because the global organizer slot is unset. */
  modelSource?: "bot";
  /** Output reservation used by both the Host planner and the Pi provider call. */
  maxOutputTokens?: number;
  /** System prompt — organizer contract and output schema. */
  system: string;
  /** User prompt — the source material and candidate memories to judge. */
  prompt: string;
}

export interface HarnessMemoryOrganizeResult {
  batchId: string;
  providerId: string;
  modelId: string;
  /** Raw model text. The Host parses and validates proposals before commit. */
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * The organizer has no provider-independent exact tokenizer. Count the entire
 * UTF-8 bytes as a conservative upper estimate for byte-level tokenizers,
 * including the system contract and chat framing. Host planning and Pi
 * admission use this same estimate; providers with additional hidden framing
 * can still reject the request, which remains a visible retryable failure.
 */
export function estimateMemoryOrganizerInputTokens(system: string, prompt: string): number {
  return new TextEncoder().encode(system).length + new TextEncoder().encode(prompt).length + 64;
}

export function memoryOrganizerOutputReservation(contextWindow: number, maxTokens: number): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
    || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("Memory organizer model has no usable context/output capacity");
  }
  return Math.min(maxTokens, Math.max(512, Math.floor(contextWindow / 4)));
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const nonEmpty = (value: unknown): string | undefined => (
  typeof value === "string" && value.trim() ? value.trim() : undefined
);

const positiveInt = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
);

export class HarnessInferenceSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessInferenceSettingsValidationError";
  }
}

const requiredNonEmpty = (value: unknown, path: string): string => {
  const parsed = nonEmpty(value);
  if (!parsed) throw new HarnessInferenceSettingsValidationError(`${path} must be a non-empty string`);
  return parsed;
};

const optionalPositiveInt = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = positiveInt(value);
  if (parsed === undefined) {
    throw new HarnessInferenceSettingsValidationError(`${path} must be a positive integer`);
  }
  return parsed;
};

const rerankEndpoint = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const endpoint = requiredNonEmpty(value, "harness.rerank.endpoint");
  if (/^[a-z][a-z\d+.-]*:/iu.test(endpoint) || endpoint.startsWith("//") || endpoint.includes("\\")) {
    throw new HarnessInferenceSettingsValidationError(
      "harness.rerank.endpoint must be a provider-relative HTTP path",
    );
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
};

export function parseHarnessEmbeddingSettings(value: unknown): HarnessEmbeddingSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HarnessInferenceSettingsValidationError("harness.embedding must be an object");
  }
  if (value.protocol !== "openai-compatible") {
    throw new HarnessInferenceSettingsValidationError(
      "harness.embedding.protocol must be openai-compatible",
    );
  }
  const providerId = requiredNonEmpty(value.providerId, "harness.embedding.providerId");
  const modelId = requiredNonEmpty(value.modelId, "harness.embedding.modelId");
  const dimensions = optionalPositiveInt(value.dimensions, "harness.embedding.dimensions");
  const maxTokens = optionalPositiveInt(value.maxTokens, "harness.embedding.maxTokens");
  return {
    protocol: "openai-compatible",
    providerId,
    modelId,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

/**
 * Canonical remote vector-space identity. Credentials are never included.
 * The resolved provider/model configuration and actual dimension participate.
 * Credentials never do. An automatic dimension is therefore provisional until
 * the first real response resolves it; no persistent `auto` space is opened.
 */
export function remoteEmbeddingSpaceParts(input: {
  protocol: string;
  providerId: string;
  modelId: string;
  maxTokens: number;
  dimensions: number;
  configurationId: string;
}): readonly unknown[] {
  return [
    input.protocol,
    input.providerId,
    input.modelId,
    input.configurationId,
    input.maxTokens,
    input.dimensions,
  ];
}

export function parseHarnessRerankSettings(value: unknown): HarnessRerankSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HarnessInferenceSettingsValidationError("harness.rerank must be an object");
  }
  if (value.protocol !== "http-rerank") {
    throw new HarnessInferenceSettingsValidationError(
      "harness.rerank.protocol must be http-rerank",
    );
  }
  const providerId = requiredNonEmpty(value.providerId, "harness.rerank.providerId");
  const modelId = requiredNonEmpty(value.modelId, "harness.rerank.modelId");
  const endpoint = rerankEndpoint(value.endpoint);
  const maxDocumentTokens = optionalPositiveInt(
    value.maxDocumentTokens,
    "harness.rerank.maxDocumentTokens",
  );
  return {
    protocol: "http-rerank",
    providerId,
    modelId,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(maxDocumentTokens === undefined ? {} : { maxDocumentTokens }),
  };
}
