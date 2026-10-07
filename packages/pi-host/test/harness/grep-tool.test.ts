import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createGrepTool } from "../../src/harness/grep-tool.js";

describe("Host-backed grep tool", () => {
  it("remains parallel, forwards cancellation, and renders context without claiming a timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    let observedParams: unknown;
    const bridge = {
      request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        observedParams = _params;
        return {
          status: "ready" as const,
          files: [{
            path: "src/a.ts",
            hits: [{ line: 2, text: "match", before: ["before"], after: ["after"] }],
          }],
          totalHits: 2,
          totalFiles: 1,
          searchedFiles: 1,
          partial: true,
        };
      },
    } as unknown as HostServicesBridge;
    const controller = new AbortController();
    const tool = createGrepTool(bridge, "session");

    const result = await tool.execute(
      "call",
      { pattern: "match", context: 1, hidden: true, noIgnore: true },
      controller.signal,
      undefined,
      undefined as never,
    );
    const text = (result.content[0] as { text: string }).text;

    assert.equal(tool.executionMode, undefined);
    assert.equal(observedSignal, controller.signal);
    assert.deepEqual(observedParams, { pattern: "match", context: 1, hidden: true, noIgnore: true });
    assert.match(text, /partial result/);
    assert.doesNotMatch(text, /timed out/);
    assert.match(text, /before[\s\S]*2: match[\s\S]*after/);
  });
});
