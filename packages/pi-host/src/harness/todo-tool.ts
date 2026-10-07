import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { TodoUpsertResult } from "@varin/protocol";

const TodoParams = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String(),
      status: Type.Union([
        Type.Literal("open", { description: "Unfinished item" }),
        Type.Literal("done", { description: "Completed item" }),
        Type.Literal("blocked", { description: "Item currently unable to proceed" }),
      ], { description: "Only open, done, or blocked. Open covers both pending and ongoing work." }),
    }),
  ),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export function createTodoTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "todo",
    label: "Todo",
    description: "Replace the conversation's plan with items using open (unfinished), done (completed) or blocked (unable to proceed). The saved plan is shown in the work overview.",
    promptSnippet: "todo: update the session plan with a list of todo items and their statuses",
    parameters: TodoParams,
    prepareArguments: (args) => {
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const items = (args as { items?: unknown }).items;
        if (Array.isArray(items)) {
          for (const [index, item] of items.entries()) {
            if (item && typeof item === 'object' && 'status' in item && !['open', 'done', 'blocked'].includes(item.status)) {
              throw new Error(`todo.items[${index}].status must be open (unfinished, including ongoing work), done (completed), or blocked (unable to proceed).`);
            }
          }
        }
      }
      return args as Static<typeof TodoParams>;
    },
    outputSchema: Type.Object({ text: Type.String(), materialRevisions: Type.Optional(Type.Record(Type.String(), Type.String())) }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const result = await bridge.request<"todo.upsert">("todo.upsert", {
          items: params.items,
          branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
          ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
        });
        const typed = result as TodoUpsertResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: { materialRevisions: typed.materialRevisions ?? {} },
          structuredContent: { text: typed.text, materialRevisions: typed.materialRevisions ?? {} },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `todo failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
