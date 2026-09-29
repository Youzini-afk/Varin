import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessRequestData } from "@varin/protocol";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createDispatchTool } from "../../src/harness/thread-tools.js";

describe("Bot consultation dispatch", () => {
  it("passes the current model as fallback for a Bot without a model preference", async () => {
    const sessionId = "caller-session";
    let dispatched: HarnessRequestData | undefined;
    const bridge = new HostServicesBridge({
      sessionId,
      defaultTimeoutMs: 5_000,
      emit: (_event, data) => {
        dispatched = data as HarnessRequestData;
        queueMicrotask(() => bridge.respond(sessionId, dispatched!.requestId, {
          ok: true,
          result: { text: "consult started", threadId: "consult-1", queued: false },
        }));
      },
    });
    const tool = createDispatchTool(bridge, sessionId, [], {
      getActiveToolNames: () => ["read", "recall", "memory"],
    });
    const result = await tool.execute("call-1", {
      task: "Compare two approaches", kind: "discussion", bot: "bot-1",
    } as never, undefined, undefined, {
      model: { provider: "caller-provider", id: "caller-model" },
    } as never);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(dispatched?.method, "thread.dispatch");
    assert.deepEqual(dispatched?.params, {
      task: "Compare two approaches",
      kind: "discussion",
      bot: "bot-1",
      model: { providerId: "caller-provider", modelId: "caller-model" },
      tools: ["read", "recall", "memory"],
    });
  });
});
