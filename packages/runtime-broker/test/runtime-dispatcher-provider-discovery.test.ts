import assert from "node:assert/strict";
import { it } from "node:test";
import type { PiRuntimeBroker } from "../src/runtime-broker.js";
import { dispatchRuntimeRequest } from "../src/runtime-dispatcher.js";

it("forwards inference discovery through the same workspace/session route and validates its capability", async () => {
  const calls: Array<{ target: string; method: string; params: unknown }> = [];
  const request = async (target: string, method: string, params: unknown) => {
    calls.push({ target, method, params });
    return { models: [{ id: "discovered" }] };
  };
  const broker = { requestForWorkspace: request, requestForSession: request } as unknown as PiRuntimeBroker;
  const config = { id: "provider", capabilities: { embedding: {
    protocol: "openai-compatible", baseUrl: "https://embeddings.example/v1", credentialRef: "owner",
  } } };
  for (const context of [{ cwd: "/workspace" }, { sessionId: "session-1" }]) {
    for (const capability of ["embedding", "rerank", "decision"]) {
      const params = { config, capability, providerId: "provider", interactionId: "discovery-1", requestCredential: false };
      const result = await dispatchRuntimeRequest(broker, "provider.models.discover", { ...context, ...params });
      assert.deepEqual(result.models, [{ id: "discovered" }]);
      assert.deepEqual(calls.at(-1), {
        target: context.cwd ?? context.sessionId, method: "provider.models.discover", params,
      });
    }
  }
  await assert.rejects(dispatchRuntimeRequest(broker, "provider.models.discover", {
    cwd: "/workspace", providerId: "provider", interactionId: "discovery-2", capability: "unknown",
  }), { code: "invalid_params" });
  assert.equal(calls.length, 6);
});
