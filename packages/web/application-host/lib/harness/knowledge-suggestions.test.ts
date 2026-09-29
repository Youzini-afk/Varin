import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  suggestSupersedes,
  acceptSuggestion,
  dismissSuggestion,
} from "./knowledge-suggestions.js";

// Scratch stores live in the OS temp dir; see recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "varin-test-suggestions");
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

describe("suggestSupersedes", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("finds entries with similar trigger", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "Use npm", trigger: "package management",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "Use bun", trigger: "package management",
    });

    const suggestions = await suggestSupersedes(newId, "package management", { store });
    expect(suggestions).toContain(oldId);
  });

  it("returns empty for dissimilar triggers", async () => {
    await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "Use vim", trigger: "editor preference",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "Use bun", trigger: "package management",
    });

    const suggestions = await suggestSupersedes(newId, "package management", { store });
    expect(suggestions).toHaveLength(0);
  });

  it("returns empty for empty trigger", async () => {
    const suggestions = await suggestSupersedes(1, "", { store });
    expect(suggestions).toHaveLength(0);
  });
});

describe("review tray actions", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("acceptSuggestion moves to accepted", async () => {
    const id = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "test", trigger: "",
    });
    await acceptSuggestion(id, { store }, {});
    const list = await store.listKnowledge({ status: "accepted" });
    expect(list).toHaveLength(1);
  });

  it("acceptSuggestion with supersedes", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "old", trigger: "test",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "new", trigger: "test",
    });
    await acceptSuggestion(newId, { store }, { supersedes: [oldId] });
    await expect(acceptSuggestion(newId, { store }, { supersedes: [oldId] })).resolves.toBeUndefined();
    const active = await store.listKnowledge({ activeOnly: true });
    expect(active.find((k) => k.id === oldId)).toBeUndefined();
    expect(active.find((k) => k.id === newId)).toBeDefined();
  });

  it("dismissSuggestion moves to dismissed", async () => {
    const id = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "test", trigger: "",
    });
    await dismissSuggestion(id, { store });
    const list = await store.listKnowledge({ status: "dismissed" });
    expect(list).toHaveLength(1);
  });

  it("rejects stale edits and cross-scope supersedes without partially accepting", async () => {
    const oldUser = await store.putKnowledge({ scope: "user", status: "accepted", content: "old", trigger: "test" });
    const suggestion = await store.putKnowledge({ scope: "workspace", status: "suggested", content: "new", trigger: "test" });
    await expect(store.acceptKnowledge(suggestion, {
      expectedScope: "workspace",
      supersedes: [oldUser],
    })).rejects.toMatchObject({ code: "invalid" });
    expect(await store.listKnowledge({ scope: "workspace", status: "suggested" })).toHaveLength(1);
    await store.acceptKnowledge(suggestion, { expectedScope: "workspace" });
    await expect(store.updateSuggestedKnowledge(suggestion, { content: "late", trigger: "test" }, "workspace"))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects accepting or dismissing a retired suggestion", async () => {
    const id = await store.putKnowledge({ scope: "workspace", status: "suggested", content: "retired", trigger: "test" });
    await store.retireKnowledge(id, "workspace", {
      content: "retired", trigger: "test", status: "suggested", invalidAt: null,
    });
    await expect(store.acceptKnowledge(id, { expectedScope: "workspace" })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.dismissKnowledge(id, "workspace")).rejects.toMatchObject({ code: "conflict" });
  });
});
