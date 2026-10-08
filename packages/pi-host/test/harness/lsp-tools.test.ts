import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLspNavigationTools } from "../../src/harness/lsp-tools.js";

describe("LSP navigation tools", () => {
  it("registers four tools and forwards one-based positions to typed Host methods", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const bridge = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { status: "ready", text: "src/a.ts:2:3", value: [] };
      },
    };
    const tools = createLspNavigationTools(bridge as never);
    assert.deepEqual(tools.map((tool) => tool.name), ["symbols", "definition", "references", "hover"]);
    const definition = tools.find((tool) => tool.name === "definition")!;
    const result = await definition.execute(
      "call-1",
      { path: "src/a.ts", line: 2, character: 3 } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(requests, [{ method: "lsp.definition", params: { path: "src/a.ts", line: 2, character: 3 } }]);
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "src/a.ts:2:3");
  });
  it("distinguishes unavailable navigation from an empty ready response", async () => {
    for (const response of [{ status: "ready", text: "no references", value: [] }, { status: "unavailable", text: "no server" },
      { status: 'busy', text: 'file in use' }, new Error("offline"), new Error('file resource is busy under lease file-lease:other')]) {
      const tools = createLspNavigationTools({ request: async () => {
        if (response instanceof Error) throw response;
        return response;
      } } as never);
      for (const tool of tools) {
        const result = await tool.execute("call", { path: "file.ts", line: 1, query: "name" } as never, undefined, undefined, undefined as never);
        assert.equal(result.isError === true, response instanceof Error || response.status !== "ready", tool.name);
        if (response instanceof Error && response.message.includes('busy under lease')) {
          assert.equal((result.details as { status: string }).status, 'busy');
        }
      }
    }
  });
});
