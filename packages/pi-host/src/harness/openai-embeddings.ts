/**
 * OpenAI-compatible embeddings wire contract. Credentials are supplied by the
 * caller; this module never persists them.
 */

export interface OpenAICompatibleEmbeddingsRequest {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  input: string[];
  dimensions?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface OpenAICompatibleEmbeddingsResponse {
  model: string;
  vectors: number[][];
  dim: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const embeddingsUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  return trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
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
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

export async function requestOpenAICompatibleEmbeddings(
  request: OpenAICompatibleEmbeddingsRequest,
): Promise<OpenAICompatibleEmbeddingsResponse> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    encoding_format: "float",
  };
  if (request.dimensions !== undefined) body.dimensions = request.dimensions;
  const response = await fetchImpl(embeddingsUrl(request.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
      ...request.headers,
    },
    body: JSON.stringify(body),
    ...(request.signal ? { signal: request.signal } : {}),
  });
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
    );
  }
  const payload = await response.json() as unknown;
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
  };
}
