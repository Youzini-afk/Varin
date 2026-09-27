import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  createSuggestion,
  proposeUserMessageSuggestion,
  suggestSupersedes,
  acceptSuggestion,
  dismissSuggestion,
  DEFAULT_SUGGESTIONS_SETTINGS,
  suggestionSettingsFromSnapshot,
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

describe("suggestion settings", () => {
  it("uses trusted project workspace policy without letting it change user scope", () => {
    const snapshot = {
      global: { harness: { knowledge: { autoAcceptSuggestions: { workspace: false, user: true } } } },
      globalRevision: "global-1",
      project: { harness: { knowledge: { autoAcceptSuggestions: { workspace: true, user: false } } } },
      projectRevision: "project-1",
      projectTrusted: true,
    };
    expect(suggestionSettingsFromSnapshot(snapshot)).toEqual({
      autoAcceptSuggestions: { workspace: true, user: true, session: false },
    });
    expect(suggestionSettingsFromSnapshot({ ...snapshot, projectTrusted: false })).toEqual({
      autoAcceptSuggestions: { workspace: false, user: true, session: false },
    });
  });
});

describe("createSuggestion", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("creates suggestion with raw content when no model", async () => {
    const result = await createSuggestion(
      { trigger: "user-mark", content: "Always use bun", sessionId: "s1", kind: "message" },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(result.status).toBe("suggested");
    expect(result.content).toBe("Always use bun");
    expect(result.trigger).toBe("");
    expect(result.scope).toBe("workspace");

    const list = await store.listKnowledge({ status: "suggested" });
    expect(list).toHaveLength(1);
  });

  it("uses model to draft content and trigger when provided", async () => {
    const result = await createSuggestion(
      {
        trigger: "user-message", content: "I prefer bun over npm",
        sessionId: "s1", kind: "message",
        draftWithModel: async () => ({ content: "Use bun for package management", trigger: "package management" }),
      },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(result.content).toBe("Use bun for package management");
    expect(result.trigger).toBe("package management");
  });

  it("skips user-message duplicates including dismissed rows", async () => {
    await createSuggestion(
      { trigger: "user-message", content: "Use bun", sessionId: "s1", kind: "user-message" },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    const first = (await store.listKnowledge({ status: "suggested" }))[0]!;
    await dismissSuggestion(first.id, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, "workspace");
    const skipped = await proposeUserMessageSuggestion(
      { trigger: "user-message", content: "Use bun", sessionId: "s2", kind: "user-message" },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(skipped).toEqual({ created: false, skippedReason: "duplicate" });
    expect(await store.listKnowledge({ scope: "workspace" })).toHaveLength(1);
  });

  it("serializes concurrent user-message proposals and checks retired history", async () => {
    const [first, second] = await Promise.all([
      proposeUserMessageSuggestion(
        { trigger: "user-message", content: "Keep this durable policy", sessionId: "s1", kind: "user-message" },
        { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
      ),
      proposeUserMessageSuggestion(
        { trigger: "user-message", content: "Keep   this durable policy", sessionId: "s2", kind: "user-message" },
        { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
      ),
    ]);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(await store.listKnowledge({ scope: "workspace" })).toHaveLength(1);

    const id = first.suggestion?.id ?? second.suggestion?.id;
    expect(id).toBeDefined();
    const opened = await store.getKnowledge(id!);
    await store.retireKnowledge(id!, "workspace", {
      content: opened!.content,
      trigger: opened!.trigger,
      status: opened!.status,
      invalidAt: null,
    });
    const afterRetire = await proposeUserMessageSuggestion(
      { trigger: "user-message", content: "Keep this durable policy", sessionId: "s3", kind: "user-message" },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(afterRetire).toEqual({ created: false, skippedReason: "duplicate" });
  });

  it("auto-accepts when configured", async () => {
    const result = await createSuggestion(
      { trigger: "user-mark", content: "Always use bun", sessionId: "s1", kind: "message" },
      { store, settings: { ...DEFAULT_SUGGESTIONS_SETTINGS, autoAcceptSuggestions: { workspace: true, user: false, session: false } } },
    );
    const accepted = await store.listKnowledge({ status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(result.status).toBe("accepted");
  });
});

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

    const suggestions = await suggestSupersedes(newId, "package management", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
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

    const suggestions = await suggestSupersedes(newId, "package management", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns empty for empty trigger", async () => {
    const suggestions = await suggestSupersedes(1, "", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
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
    await acceptSuggestion(id, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, {});
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
    await acceptSuggestion(newId, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, { supersedes: [oldId] });
    await expect(acceptSuggestion(newId, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, { supersedes: [oldId] })).resolves.toBeUndefined();
    const active = await store.listKnowledge({ activeOnly: true });
    expect(active.find((k) => k.id === oldId)).toBeUndefined();
    expect(active.find((k) => k.id === newId)).toBeDefined();
  });

  it("dismissSuggestion moves to dismissed", async () => {
    const id = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "test", trigger: "",
    });
    await dismissSuggestion(id, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS });
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
