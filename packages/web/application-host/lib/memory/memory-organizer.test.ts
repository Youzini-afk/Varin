import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openKnowledgeStoreEngine } from "../knowledge/store-engine.js";
import type { KnowledgeScope, KnowledgeStore, OrganizerProgress } from "../knowledge/store-contract.js";
import { createMemoryService, type MemoryOwner, type MemoryService } from "./memory-service.js";
import { createMemoryOrganizer, type MemoryOrganizerBroker, type OrganizerRunSource } from "./memory-organizer.js";

// Scratch stores live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "varin-test-memory-organizer");

const cleanup = () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
};

let counter = 0;
const openStore = async (scope: KnowledgeScope = "workspace", name = `store-${++counter}`): Promise<KnowledgeStore> => {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  return openKnowledgeStoreEngine({ dataDir: dir, hostId: "test-host", workspaceId: name, scope, embedding: null });
};

const scopeOfStoreId = (scopeId: string): KnowledgeScope => (
  scopeId.startsWith("bot:") ? "bot" : scopeId.startsWith("session:") ? "session" : "workspace"
);

interface StubCall { method: string; params: Record<string, unknown> }

const wait = async (predicate: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for organizer");
};

describe("memory organizer (BC2)", () => {
  let stores: Map<string, KnowledgeStore>;
  let userStore: KnowledgeStore;
  let calls: StubCall[];
  let organizeText: string | (() => string | Promise<string>);
  let fastDecisionAnswers: { value: number }[] | null;
  let nowMs: number;
  let runSources: OrganizerRunSource[];
  let scopeSessions: Map<string, string[]>;
  let scopeForSession: (sessionId: string) => string | null;
  let autoOrganize: { workspace: boolean; user: boolean; bot: boolean };
  let autoAccept: { workspace: boolean; user: boolean };

  const memory = (): MemoryService => createMemoryService({
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    userStore: async () => userStore,
    ownerForSession: async (sessionId) => ({ scope: "workspace", ownerId: sessionId }),
  });

  const broker = (): MemoryOrganizerBroker => ({
    requestForWorkspace: (async (_cwd: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "settings.get") {
        return {
          global: {
            harness: {
              models: { memoryOrganizer: { providerId: "test-provider", modelId: "test-model" } },
              knowledge: {
                autoOrganize,
                autoAcceptSuggestions: autoAccept,
              },
            },
          },
        } as unknown;
      }
      if (method === "harness.inference.describe") {
        return { fastDecision: { purposes: {} } } as unknown;
      }
      if (method === "harness.fastDecision") {
        const answers = fastDecisionAnswers
          ?? (params.questions as { id: string }[]).map((question) => ({ id: question.id, kind: "judge", value: 1 }));
        return {
          batchId: params.batchId,
          providerId: "fd-provider",
          modelId: "fd-model",
          answers,
          missing: [],
        } as unknown;
      }
      if (method === "harness.memoryOrganize") {
        const text = typeof organizeText === "function" ? await organizeText() : organizeText;
        return { batchId: params.batchId, providerId: params.providerId, modelId: params.modelId, text } as unknown;
      }
      if (method === "harness.inference.cancel") return { cancelled: true } as unknown;
      throw new Error(`unexpected method ${method}`);
    }) as unknown as MemoryOrganizerBroker["requestForWorkspace"],
  });

  const organizer = (service: MemoryService) => createMemoryOrganizer({
    configCwd: "/tmp/varin-config",
    getBroker: () => broker(),
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    hasStoreForScope: (scopeId) => stores.has(scopeId),
    listScopeIds: async () => [...stores.keys()],
    listScopeSessions: async (scopeId) => scopeSessions.get(scopeId) ?? [],
    listRunSources: async () => runSources,
    scopeForSession: async (sessionId) => scopeForSession(sessionId),
    readEntries: async () => [],
    memory: service,
    now: () => nowMs,
  });

  const progressFor = async (scopeId: string, key: string): Promise<OrganizerProgress | null> => {
    const store = stores.get(scopeId);
    return store ? store.getOrganizerProgress(key) : null;
  };

  beforeEach(async () => {
    cleanup();
    stores = new Map();
    userStore = await openStore("user", "user-store");
    calls = [];
    organizeText = JSON.stringify({ memories: [] });
    fastDecisionAnswers = null;
    nowMs = 1_000_000;
    runSources = [];
    scopeSessions = new Map();
    scopeForSession = () => null;
    autoOrganize = { workspace: true, user: true, bot: true };
    autoAccept = { workspace: false, user: false };
  });

  afterEach(async () => {
    await Promise.all([...stores.values(), userStore].map((store) => store.close().catch(() => undefined)));
    cleanup();
  });

  it("organizes durable session events into a suggested memory with provenance", async () => {
    const ws = await stores.get("ws-1") ?? await openStore("workspace", "ws-1");
    stores.set("ws-1", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "We decided to use Postgres for the catalog store.", source: "agent" });
    scopeSessions.set("ws-1", ["s1"]);
    organizeText = JSON.stringify({
      memories: [{
        action: "new", scope: "workspace", nature: "decision",
        content: "Catalog store uses Postgres.", trigger: "database schema questions", source: "u0",
      }],
    });
    const org = organizer(memory());
    org.noteScope("ws-1");
    await wait(async () => (await ws.listKnowledge({ scope: "workspace" })).length === 1);
    const [item] = await ws.listKnowledge({ scope: "workspace" });
    expect(item?.status).toBe("suggested");
    expect(item?.nature).toBe("decision");
    expect(item?.source?.kind).toBe("memory-organizer");
    const progress = await progressFor("ws-1", "session:s1");
    expect(progress?.status).toBe("formed");
    expect(progress?.produced).toEqual([item?.id]);
    org.dispose();
  });

  it("does not reprocess covered events after progress commits", async () => {
    const ws = await openStore("workspace", "ws-2");
    stores.set("ws-2", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Decision recorded.", source: "agent" });
    scopeSessions.set("ws-2", ["s1"]);
    const service = memory();
    const org = organizer(service);
    org.noteScope("ws-2");
    await wait(async () => (await progressFor("ws-2", "session:s1"))?.status !== undefined
      && ["formed", "reviewed-empty"].includes((await progressFor("ws-2", "session:s1"))?.status ?? ""));
    const callsAfterFirst = calls.filter((c) => c.method === "harness.memoryOrganize").length;
    org.noteScope("ws-2");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.filter((c) => c.method === "harness.memoryOrganize").length).toBe(callsAfterFirst);
    org.dispose();
  });

  it("marks the range failed when the model errors and retries after backoff", async () => {
    const ws = await openStore("workspace", "ws-3");
    stores.set("ws-3", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Something worth keeping.", source: "agent" });
    scopeSessions.set("ws-3", ["s1"]);
    let attempts = 0;
    organizeText = () => { attempts += 1; if (attempts === 1) throw new Error("transport down"); return JSON.stringify({
      memories: [{ action: "new", scope: "workspace", content: "Persisted fact.", source: "u0" }],
    }); };
    const service = memory();
    const org = organizer(service);
    org.noteScope("ws-3");
    await wait(async () => (await progressFor("ws-3", "session:s1"))?.status === "failed");
    expect(attempts).toBe(1);
    // Not yet retryable — backoff still active.
    org.noteScope("ws-3");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(attempts).toBe(1);
    nowMs += 6 * 60_000;
    org.noteScope("ws-3");
    await wait(async () => (await progressFor("ws-3", "session:s1"))?.status === "formed");
    expect(attempts).toBe(2);
    expect((await ws.listKnowledge({ scope: "workspace" })).map((k) => k.content)).toEqual(["Persisted fact."]);
    org.dispose();
  });

  it("treats unparseable model output as a retryable failure, not empty success", async () => {
    const ws = await openStore("workspace", "ws-4");
    stores.set("ws-4", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Material.", source: "agent" });
    scopeSessions.set("ws-4", ["s1"]);
    organizeText = "sorry, I cannot help with that";
    const org = organizer(memory());
    org.noteScope("ws-4");
    await wait(async () => (await progressFor("ws-4", "session:s1"))?.status === "failed");
    expect(await ws.listKnowledge({ scope: "workspace" })).toEqual([]);
    // A failed range must not advance coverage — the retry recollects it.
    expect((await progressFor("ws-4", "session:s1"))?.eventCursor).toBeUndefined();
    org.dispose();
  });

  it("honours autoOrganize gates per scope", async () => {
    autoOrganize = { workspace: false, user: true, bot: true };
    const ws = await openStore("workspace", "ws-5");
    stores.set("ws-5", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Material.", source: "agent" });
    scopeSessions.set("ws-5", ["s1"]);
    const org = organizer(memory());
    org.noteScope("ws-5");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.filter((c) => c.method === "harness.memoryOrganize")).toEqual([]);
    expect(await progressFor("ws-5", "session:s1")).toBeNull();
    org.dispose();
  });

  it("routes bot-scope proposals to the bot store and gates user-scope proposals", async () => {
    const bot = await openStore("bot", "bot-scope-store");
    stores.set("bot:b-1", bot);
    await bot.putEvent({ kind: "turn", at: 1, sessionId: "s-bot", text: "The bot learned its owner prefers terse updates.", source: "agent" });
    scopeSessions.set("bot:b-1", ["s-bot"]);
    organizeText = JSON.stringify({
      memories: [
        { action: "new", scope: "bot", nature: "preference", content: "Owner prefers terse updates.", trigger: "status updates", source: "u0" },
        { action: "new", scope: "user", content: "User-level fact should not land.", source: "u0" },
      ],
    });
    autoOrganize = { workspace: true, user: false, bot: true };
    const org = organizer(memory());
    org.noteScope("bot:b-1");
    await wait(async () => (await bot.listKnowledge({ scope: "bot" })).length === 1);
    expect((await bot.listKnowledge({ scope: "bot" }))[0]?.content).toBe("Owner prefers terse updates.");
    expect(await userStore.listKnowledge({ scope: "user" })).toEqual([]);
    org.dispose();
  });

  it("correct supersedes the existing revision instead of duplicating it", async () => {
    autoAccept = { workspace: true, user: false };
    const ws = await openStore("workspace", "ws-6");
    stores.set("ws-6", ws);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-6" };
    const existing = await service.remember(owner, {
      content: "Catalog uses SQLite.", trigger: "db questions", nature: "decision",
      source: { kind: "user-mark" }, commit: "accepted",
    });
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Correction: catalog moved to Postgres.", source: "agent" });
    scopeSessions.set("ws-6", ["s1"]);
    organizeText = JSON.stringify({
      memories: [{
        action: "correct", scope: "workspace", nature: "decision",
        content: "Catalog uses Postgres.", trigger: "db questions",
        target: `k:${existing.item.id}`, source: "u0",
      }],
    });
    const org = organizer(service);
    org.noteScope("ws-6");
    await wait(async () => (await progressFor("ws-6", "session:s1"))?.status === "formed");
    const rows = await ws.listKnowledge({ scope: "workspace" });
    const active = rows.filter((row) => row.invalidAt === undefined);
    expect(active.map((row) => row.content)).toEqual(["Catalog uses Postgres."]);
    expect(active[0]?.status).toBe("accepted");
    const previous = rows.find((row) => row.id === existing.item.id);
    expect(previous?.invalidAt).not.toBeUndefined();
    org.dispose();
  });
});
