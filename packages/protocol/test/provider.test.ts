import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseProviderConfigInput,
  ProviderConfigValidationError,
} from "../src/index.js";

describe("provider configuration protocol", () => {
  it("normalizes the browser-safe Pi models.json subset", () => {
    assert.deepEqual(
      parseProviderConfigInput({
        api: "openai-completions",
        baseUrl: " https://models.example.test/v1/ ",
        id: "custom.provider",
        models: [
          {
            contextWindow: 32_768,
            id: "model-1",
            input: ["text", "image", "image"],
            reasoning: true,
            thinkingLevelMap: { high: "high", off: null },
          },
        ],
      }),
      {
        api: "openai-completions",
        baseUrl: "https://models.example.test/v1",
        id: "custom.provider",
        models: [
          {
            contextWindow: 32_768,
            id: "model-1",
            input: ["text", "image"],
            reasoning: true,
            thinkingLevelMap: { high: "high", off: null },
          },
        ],
      },
    );
  });

  it("rejects unsafe schemes and duplicate model ids", () => {
    assert.throws(
      () =>
        parseProviderConfigInput({
          api: "openai-completions",
          baseUrl: "file:///tmp/models",
          id: "provider",
          models: [],
        }),
      ProviderConfigValidationError,
    );
    assert.equal(
      parseProviderConfigInput({
        api: "openai-completions",
        baseUrl: "http://user:secret@127.0.0.1:11434/v1",
        id: "local-provider",
      }).baseUrl,
      "http://user:secret@127.0.0.1:11434/v1",
    );
    assert.throws(
      () =>
        parseProviderConfigInput({
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          id: "provider",
          models: [{ id: "same" }, { id: "same" }],
        }),
      /duplicate model id/u,
    );
  });

  it("validates each capability independently while allowing one model ID to serve multiple capabilities", () => {
    const input = { id: "mixed", capabilities: {
      embedding: { protocol: "openai-compatible", models: [{ id: "shared" }] },
      rerank: { protocol: "http-rerank", models: [{ id: "shared" }] },
    } };
    assert.equal(parseProviderConfigInput(input).capabilities?.rerank?.models?.[0]?.id, "shared");
    assert.throws(() => parseProviderConfigInput({ ...input, capabilities: { decision: { protocol: "openai-completions" } } }), /protocol/);
    assert.throws(() => parseProviderConfigInput({ ...input, capabilities: { embedding: { protocol: "openai-compatible", baseUrl: "file:///tmp" } } }), /http or https/);
    assert.throws(() => parseProviderConfigInput({ ...input, capabilities: { rerank: { protocol: "http-rerank", endpoint: "https://other.invalid" } } }), /relative path/);
  });
});
