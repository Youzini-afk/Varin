import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestHttpRerank, RerankResponseError } from "../../src/harness/http-rerank.js";

const jsonResponse = (status: number, body: unknown) => (
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
);

describe("HTTP rerank", () => {
  it("sends text documents, maps partial results by index, and rejects bad identities", async () => {
    const scores = await requestHttpRerank({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "rerank-1",
      query: "needle",
      documents: [
        { id: "v1", text: "alpha" },
        { id: "v2", text: "beta" },
      ],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        // Reproduce the real provider's 400 for object-valued documents.
        if (!body.documents.every((value: unknown) => typeof value === "string")) {
          return jsonResponse(400, { error: "documents must contain strings" });
        }
        assert.deepEqual(body.documents, ["alpha", "beta"]);
        return jsonResponse(200, { results: [{ index: 1, relevance_score: 0.9 }] });
      },
    });
    assert.deepEqual(scores, [{ id: "v2", index: 1, score: 0.9 }]);

    await assert.rejects(() => requestHttpRerank({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "rerank-1",
      query: "needle",
      documents: [{ id: "v1", text: "alpha" }],
      fetchImpl: async () => jsonResponse(200, {
        results: [{ index: 0, score: Number.POSITIVE_INFINITY }],
      }),
    }), RerankResponseError);

    await assert.rejects(() => requestHttpRerank({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
      model: "rerank-1",
      query: "needle",
      documents: [{ id: "v1", text: "alpha" }],
      fetchImpl: async () => jsonResponse(200, {
        results: [{ index: 0, score: 1, id: "other" }],
      }),
    }), RerankResponseError);
  });
});
