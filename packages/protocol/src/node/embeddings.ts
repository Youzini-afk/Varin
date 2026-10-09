/**
 * OpenAI-compatible embeddings wire contract. Credentials are supplied by the
 * caller; this module never persists them. Host and Pi share this exact transport.
 * Node-only subpath: never exported through the browser-safe protocol root.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export interface OpenAICompatibleEmbeddingsRequest {
  baseUrl: string;
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model: string;
  input: string[];
  dimensions?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Additional attempts for temporary HTTP failures; defaults to two. */
  maxRetries?: number;
  redirect?: 'error' | 'follow' | 'manual';
  /** Runs for every actual attempt, after body construction, before any network dispatch. */
  beforeDispatch?(request: { url: string; body: string; attempt: number }): Promise<Record<string, string> | void>;
  onDispatch?(attempt: number): void;
  onResponse?(response: { attempt: number; status: number }): void;
  onUsage?(usage: EmbeddingUsage): void;
}

export interface EmbeddingUsage { inputTokens?: number; totalTokens?: number }


export interface OpenAICompatibleEmbeddingsResponse {
  model: string;
  vectors: number[][];
  dim: number;
  usage?: EmbeddingUsage;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export const embeddingRequestUrl = (baseUrl: string, endpoint?: string): string => {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  if (endpoint) return `${trimmed}${endpoint}`;
  return trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
};

/** Credential-free vector configuration identity, shared by both runtime paths. */
export const embeddingConfigurationId = (providerId: string, modelId: string, baseUrl: string, endpoint?: string): string => {
  const address = new URL(embeddingRequestUrl(baseUrl, endpoint));
  address.username = "";
  address.password = "";
  address.hash = "";
  const defaultEndpoint = address.pathname.endsWith("/embeddings");
  const customEndpoint = defaultEndpoint ? undefined : address.pathname;
  if (defaultEndpoint) address.pathname = address.pathname.slice(0, -"/embeddings".length);
  return createHash("sha256").update(JSON.stringify({ providerId, modelId,
    baseUrl: address.toString().replace(/\/$/u, ""), api: "openai-compatible", capability: "openai-compatible", endpoint: customEndpoint })).digest("hex").slice(0, 16);
};

const retryWait = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  do {
    signal?.throwIfAborted();
    // Node overflows larger timers into a 1ms delay. Split the wait rather
    // than shortening the provider's Retry-After instruction.
    await delay(Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647), undefined,
      signal ? { signal } : {});
  } while (Date.now() < deadline);
};

const finiteVector = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const vector: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return undefined;
    vector.push(entry);
  }
  return vector;
};

export class EmbeddingResponseError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

export async function requestOpenAICompatibleEmbeddings(
  request: OpenAICompatibleEmbeddingsRequest,
): Promise<OpenAICompatibleEmbeddingsResponse> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const maxRetries = request.maxRetries ?? 2;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('Embedding maxRetries must be a nonnegative integer');
  }
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    encoding_format: "float",
  };
  if (request.dimensions !== undefined) body.dimensions = request.dimensions;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
      ...request.headers,
    },
    body: JSON.stringify(body),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.redirect ? { redirect: request.redirect } : {}),
  };
  // A transient gateway failure must not discard a whole long-running index.
  // Retry the identical batch; persistent errors still reach the caller.
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    request.signal?.throwIfAborted();
    const url = embeddingRequestUrl(request.baseUrl, request.endpoint);
    const headers = await request.beforeDispatch?.({ url, body: String(init.body), attempt: attempt + 1 });
    request.signal?.throwIfAborted();
    request.onDispatch?.(attempt + 1);
    const attemptHeaders = new Headers(init.headers);
    for (const [name, value] of Object.entries(headers ?? {})) attemptHeaders.set(name, value);
    response = await fetchImpl(url, { ...init, headers: attemptHeaders });
    request.onResponse?.({ attempt: attempt + 1, status: response.status });
    if (attempt >= maxRetries || (response.status !== 429 && (response.status < 500 || response.status > 599))) break;
    const retryAfter = response.headers.get("retry-after");
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const date = retryAfter === null ? NaN : Date.parse(retryAfter);
    const waitMs = Number.isFinite(seconds * 1000) && seconds >= 0 ? seconds * 1000
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 500 * 2 ** attempt;
    console.warn(`[Embedding] HTTP ${response.status}; retry ${attempt + 1}/${maxRetries}`);
    await response.body?.cancel().catch(() => undefined);
    await retryWait(waitMs, request.signal);
  }
  if (!response.ok) {
    // Provider messages can echo input or credentials. Keep only a short,
    // machine-readable code and request shape in diagnostics.
    const payload = await response.json().catch(() => null) as unknown;
    const providerError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const rawCode = providerError?.code;
    const code = typeof rawCode === "string" && /^[a-z0-9._-]{1,64}$/iu.test(rawCode) ? rawCode : undefined;
    const longestInput = request.input.reduce((longest, value) => Math.max(longest, value.length), 0);
    throw new EmbeddingResponseError(
      `Embedding HTTP ${response.status} (inputs ${request.input.length}, longest ${longestInput} chars${code ? `, code ${code}` : ""})`,
      response.status,
    );
  }
  const payload = await response.json() as unknown;
  const usage = readEmbeddingUsage(payload);
  if (usage) request.onUsage?.(usage);
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new EmbeddingResponseError("Embedding response is missing data");
  }
  const byIndex = new Map<number, number[]>();
  for (const row of payload.data) {
    if (!isRecord(row)) throw new EmbeddingResponseError("Embedding row is not an object");
    const index = row.index;
    if (!Number.isInteger(index) || Number(index) < 0) {
      throw new EmbeddingResponseError("Embedding row is missing a valid index");
    }
    const vector = finiteVector(row.embedding);
    if (!vector) throw new EmbeddingResponseError("Embedding row has a non-finite or empty vector");
    if (byIndex.has(Number(index))) throw new EmbeddingResponseError("Embedding response has a duplicate index");
    byIndex.set(Number(index), vector);
  }
  if (byIndex.size !== request.input.length) {
    throw new EmbeddingResponseError(
      `Embedding response count ${byIndex.size} does not match input count ${request.input.length}`,
    );
  }
  const vectors: number[][] = [];
  let dim: number | undefined;
  for (let index = 0; index < request.input.length; index += 1) {
    const vector = byIndex.get(index);
    if (!vector) throw new EmbeddingResponseError(`Embedding response is missing index ${index}`);
    if (dim === undefined) dim = vector.length;
    else if (vector.length !== dim) {
      throw new EmbeddingResponseError("Embedding response mixes vector dimensions");
    }
    if (request.dimensions !== undefined && vector.length !== request.dimensions) {
      throw new EmbeddingResponseError(
        `Embedding dimension ${vector.length} does not match requested ${request.dimensions}`,
      );
    }
    vectors.push(vector);
  }
  if (!dim) throw new EmbeddingResponseError("Embedding response has no vectors");
  return {
    model: typeof payload.model === "string" ? payload.model : request.model,
    vectors,
    dim,
    ...(usage ? { usage } : {}),
  };
}

function readEmbeddingUsage(payload: unknown): EmbeddingUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const input = payload.usage.prompt_tokens;
  const total = payload.usage.total_tokens;
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!valid(input) && !valid(total)) return undefined;
  return { ...(valid(input) ? { inputTokens: input } : {}), ...(valid(total) ? { totalTokens: total } : {}) };
}

/** Split only a provider-rejected batch; preserve every input/result identity. */
export async function requestAdaptiveEmbeddings(
  request: OpenAICompatibleEmbeddingsRequest,
): Promise<OpenAICompatibleEmbeddingsResponse> {
  try {
    return await requestOpenAICompatibleEmbeddings(request);
  } catch (error) {
    if (!(error instanceof EmbeddingResponseError) || (error.status !== 400 && error.status !== 413)
      || request.input.length < 2) throw error;
    const middle = Math.floor(request.input.length / 2);
    const left = await requestAdaptiveEmbeddings({ ...request, input: request.input.slice(0, middle) });
    const right = await requestAdaptiveEmbeddings({ ...request, input: request.input.slice(middle) });
    if (left.dim !== right.dim || left.model !== right.model) {
      throw new EmbeddingResponseError('Embedding batches returned different model spaces');
    }
    return { model: left.model, vectors: [...left.vectors, ...right.vectors], dim: left.dim };
  }
}
