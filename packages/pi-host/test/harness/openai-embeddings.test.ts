import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmbeddingResponseError, requestAdaptiveEmbeddings, requestOpenAICompatibleEmbeddings } from "../../src/harness/openai-embeddings.js";

const jsonResponse = (status: number, body: unknown) => (
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
);

describe("OpenAI-compatible embeddings", () => {
  it("reorders by index and rejects count, dimension, and non-finite faults", async () => {
    const ok = await requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a", "b"],
      fetchImpl: async () => jsonResponse(200, {
        model: "embed-1",
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    });
    assert.deepEqual(ok.vectors, [[1, 0], [0, 1]]);
    assert.equal(ok.dim, 2);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a", "b"],
      fetchImpl: async () => jsonResponse(200, {
        data: [{ index: 0, embedding: [1, 0] }],
      }),
    }), EmbeddingResponseError);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a"],
      fetchImpl: async () => jsonResponse(200, {
        data: [{ index: 0, embedding: [1, Number.NaN] }],
      }),
    }), EmbeddingResponseError);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a"],
      fetchImpl: async () => jsonResponse(200, {
        data: [{ index: 0, embedding: [1, Number.POSITIVE_INFINITY] }],
      }),
    }), EmbeddingResponseError);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a", "b"],
      fetchImpl: async () => jsonResponse(200, {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [1] },
        ],
      }),
    }), EmbeddingResponseError);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a"],
      fetchImpl: async () => jsonResponse(503, { error: "busy" }),
    }), /HTTP 503/);

    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1", apiKey: "secret", model: "embed-1",
      input: ["short", "longer"],
      fetchImpl: async () => jsonResponse(400, { error: { code: "input_too_long", message: "secret and document content" } }),
    }), (error: unknown) => error instanceof EmbeddingResponseError
      && /HTTP 400 \(inputs 2, longest 6 chars, code input_too_long\)/u.test(error.message)
      && !error.message.includes("secret"));
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => requestOpenAICompatibleEmbeddings({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "embed-1",
      input: ["a"],
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        init?.signal?.throwIfAborted();
        return jsonResponse(200, { data: [{ index: 0, embedding: [1] }] });
      },
    }), { name: "AbortError" });
  });

  it("splits a rejected large batch and keeps the original vector order", async () => {
    const sizes: number[] = [];
    const result = await requestAdaptiveEmbeddings({
      baseUrl: "https://models.example/v1", apiKey: "secret", model: "embed-1",
      input: ["0", "1", "2", "3", "4"],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        sizes.push(body.input.length);
        if (body.input.length > 2) return jsonResponse(413, { error: { code: "batch_too_large" } });
        return jsonResponse(200, { data: body.input.map((value, index) => ({ index, embedding: [Number(value)] })) });
      },
    });
    assert.deepEqual(result.vectors, [[0], [1], [2], [3], [4]]);
    assert.deepEqual(sizes, [5, 2, 3, 1, 2]);
  });
});
