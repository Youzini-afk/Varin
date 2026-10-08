import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments, type JsonValue } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTodoTool } from "../../src/harness/todo-tool.js";

const prepare = (tool: ToolDefinition, args: Record<string, JsonValue>) => validateToolArguments(tool, {
  type: "toolCall", id: "call", name: tool.name,
  arguments: (tool.prepareArguments?.(args) ?? args) as Record<string, JsonValue>,
});

describe("todo tool", () => {
  it("accepts common statuses, defaults new items and sends the normalized complete plan", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const tool = createTodoTool({
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return { text: "plan updated", materialRevisions: { "block:plan": "plan-revision" } };
      },
    } as never);
    let prompts = 0;
    const result = await tool.execute(
      "call-1",
      prepare(tool, { items: [
        { text: "Later" },
        { text: "Investigate", status: "in_progress" },
        { text: "Collect", status: "done" },
        { text: "External dependency", status: "blocked" },
      ] }),
      undefined,
      undefined,
      {
        sessionManager: { getBranch: () => [{ id: "entry-1" }] },
        ui: { select: async () => { prompts += 1; return "Use plan"; } },
      } as never,
    );
    assert.equal(prompts, 0);
    assert.deepEqual(requests, [{ items: [
      { text: "Later", status: "pending" },
      { text: "Investigate", status: "in_progress" },
      { text: "Collect", status: "completed" },
      { text: "External dependency", status: "blocked" },
    ], branchEntryIds: ["entry-1"] }]);
    assert.deepEqual(result.details, { materialRevisions: { "block:plan": "plan-revision" } });
  });

  it("rejects an unknown status before any plan write and accepts an empty list", () => {
    const tool = createTodoTool({ request: () => assert.fail("invalid input must not reach Host") } as never);
    assert.throws(() => prepare(tool, { items: [
      { text: "Completed item", status: "completed" },
      { text: "Invalid item", status: "almost_done" },
    ] }), /todo.items\[1\].status must be pending, in_progress, completed, or blocked/);
    assert.deepEqual(prepare(tool, { items: [] }), { items: [] });
  });
});
