import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createRelatedTool } from "../../src/harness/related-tool.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { DEFAULT_HARNESS_SETTINGS } from "@varin/protocol";
import { HostServicesBridge as Bridge } from "../../src/harness/host-services-bridge.js";

describe("Host-backed related tool", () => {
  it("validates and forwards the anchor", async () => {
    let forwarded: unknown;
    const bridge = {
      request: async (_method: string, params: unknown) => {
        forwarded = params;
        return {
          text: "related target.ts (path) · ready",
          status: "ready",
          anchor: { kind: "path", value: "target.ts" },
          roles: [],
          definitions: [],
          imports: { items: [], unresolved: [], incomplete: false },
          importers: { items: [], incomplete: false },
          connections: { items: [], incomplete: false },
        };
      },
    } as unknown as HostServicesBridge;
    const tool = createRelatedTool(bridge, "session");
    await tool.execute("call", { anchor: "target.ts" }, undefined, undefined, undefined as never);
    assert.deepEqual(forwarded, { anchor: "target.ts" });
    assert.equal(Value.Check(tool.parameters, { anchor: "target.ts" }), true);
    assert.equal(Value.Check(tool.parameters, { anchor: "" }), true);
    assert.equal(Value.Check(tool.parameters, { anchor: 1 }), false);
  });

  it("is registered by default and omitted when tools.related is false", () => {
    const bridge = new Bridge({ emit: () => {}, sessionId: "test", defaultTimeoutMs: 5000 });
    const deps = {
      bridge,
      sessionId: "test",
      cwd: "/tmp",
      workspaceMutationJournal: undefined,
      isOpenAIFamily: false,
    };
    const names = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, deps).map((tool) => tool.name);
    assert.ok(names.includes("related"));
    const off = selectHarnessTools({ ...DEFAULT_HARNESS_SETTINGS, tools: { related: false } }, deps).map((tool) => tool.name);
    assert.equal(off.includes("related"), false);
  });
});
