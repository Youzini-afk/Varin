import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { parseTodoPlan, type TodoItem } from "@varin/protocol";
import { executeTodoTool } from "./todo-tool.js";

const TEST_DIR = join(tmpdir(), "varin-test-todo");
function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore() {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir, hostId: "test-host", workspaceId: "ws-test", embedding: null,
  });
}

describe("executeTodoTool", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("replaces plan block and returns summary", async () => {
    const items: TodoItem[] = [
      { text: "Inspect", status: "completed" },
      { text: "Implement", status: "in_progress" },
      { text: "Document", status: "in_progress" },
      { text: "Review", status: "pending" },
      { text: "External dependency", status: "blocked" },
    ];
    const result = await executeTodoTool(
      { items },
      { store, sessionId: "s1" },
    );
    expect(result.text).toBe("plan updated: 1/5 done, 1 blocked");

    const blocks = await store.getBlocks("s1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.label).toBe("plan");
    expect(blocks[0]?.updatedBy).toBe("agent");
    expect(parseTodoPlan(blocks[0]!.content)).toEqual(items);
  });

  it("replaces the full list and clears it when the new list is empty", async () => {
    await executeTodoTool(
      { items: [{ text: "Task", status: "pending" }] },
      { store, sessionId: "s1" },
    );
    await executeTodoTool({ items: [{ text: "Replacement", status: "in_progress" }] }, { store, sessionId: "s1" });
    expect((await store.getBlocks("s1"))[0]?.content).toBe("- [/] Replacement");
    await executeTodoTool({ items: [] }, { store, sessionId: "s1" });
    expect((await store.getBlocks("s1"))[0]?.content).toBe("");
  });

  it("preserves the saved plan when a replacement contains an invalid status", async () => {
    const deps = { store, sessionId: "s1" };
    await executeTodoTool({ items: [{ text: "Keep this plan", status: "pending" }] }, deps);
    const before = await store.getBlocks("s1");
    await expect(executeTodoTool({ items: [
      { text: "Valid first item", status: "completed" },
      { text: "Invalid later item", status: "almost_done" },
    ] } as never, deps)).rejects.toThrow(/todo.items\[1\].status/);
    expect(await store.getBlocks("s1")).toEqual(before);
  });
});
