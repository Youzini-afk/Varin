/**
 * Explicit HTTP rerank wire contract. This is not chat completion and not
 * OpenAI embeddings.
 *
 * POST {baseUrl}{endpoint}
 * {
 *   model, query,
 *   documents: [text],
 *   return_documents: false
 * }
 * {
 *   results: [{ id?, index, relevance_score }]
 * }
 */

export interface HttpRerankRequest {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: string;
  query: string;
  documents: Array<{ id: string; text: string }>;
  endpoint?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface HttpRerankScore {
  id: string;
  index: number;
  score: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const rerankUrl = (baseUrl: string, endpoint?: string): string => {
  const root = baseUrl.replace(/\/+$/u, "");
  const path = (endpoint ?? "/rerank").startsWith("/") ? (endpoint ?? "/rerank") : `/${endpoint}`;
  return `${root}${path}`;
};

export class RerankResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerankResponseError";
  }
}

export async function requestHttpRerank(request: HttpRerankRequest): Promise<HttpRerankScore[]> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(rerankUrl(request.baseUrl, request.endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
      ...request.headers,
    },
    body: JSON.stringify({
      model: request.model,
      query: request.query,
      // HTTP rerank providers receive text strings. Keep our source identities
      // client-side and bind each returned index back to the submitted document.
      documents: request.documents.map((document) => document.text),
      return_documents: false,
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) {
    throw new RerankResponseError(`Rerank HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new RerankResponseError("Rerank response is missing results");
  }
  const seen = new Set<number>();
  const scores: HttpRerankScore[] = [];
  for (const row of payload.results) {
    if (!isRecord(row)) throw new RerankResponseError("Rerank row is not an object");
    const index = row.index;
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= request.documents.length) {
      throw new RerankResponseError("Rerank row index is out of range");
    }
    if (seen.has(Number(index))) throw new RerankResponseError("Rerank response has a duplicate index");
    const score = row.relevance_score ?? row.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new RerankResponseError("Rerank row is missing a finite score");
    }
    const id = typeof row.id === "string" && row.id ? row.id : request.documents[Number(index)]!.id;
    if (id !== request.documents[Number(index)]!.id) {
      throw new RerankResponseError("Rerank row id does not match the submitted document");
    }
    seen.add(Number(index));
    scores.push({ id, index: Number(index), score });
  }
  return scores;
}
