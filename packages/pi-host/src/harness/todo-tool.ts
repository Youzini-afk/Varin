import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { isTodoItemStatus, type TodoUpsertResult } from "@varin/protocol";

const TodoParams = Type.Object({
  items: Type.Array(
    Type.Object({
      text: Type.String(),
      status: Type.Optional(Type.Union([
        Type.Literal("pending", { description: "Not started" }),
        Type.Literal("in_progress", { description: "Currently being worked on" }),
        Type.Literal("completed", { description: "Finished" }),
        Type.Literal("blocked", { description: "Item currently unable to proceed" }),
      ], { default: "pending" })),
    }),
  ),
});

export function createTodoTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "todo",
    label: "Todo",
    description: "Update this conversation's plan, shown in the work overview. Each call replaces the full list; an empty list clears it. Item status is pending, in_progress, completed, or blocked; omitted status defaults to pending.",
    promptSnippet: "todo: update the session plan with a list of todo items and their statuses",
    parameters: TodoParams,
    prepareArguments: (args) => {
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const items = (args as { items?: unknown }).items;
        if (Array.isArray(items)) {
          return { ...args, items: items.map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
            // Accept an unambiguous model-input synonym before schema validation.
            const status = item.status === undefined ? 'pending' : item.status === 'done' ? 'completed' : item.status;
            if (!isTodoItemStatus(status)) {
              throw new Error(`todo.items[${index}].status must be pending, in_progress, completed, or blocked.`);
            }
            return { ...item, status };
          }) } as Static<typeof TodoParams>;
        }
      }
      return args as Static<typeof TodoParams>;
    },
    outputSchema: Type.Object({ text: Type.String(), materialRevisions: Type.Optional(Type.Record(Type.String(), Type.String())) }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const result = await bridge.request<"todo.upsert">("todo.upsert", {
          items: params.items.map(item => ({ text: item.text, status: item.status ?? "pending" })),
          branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
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
