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
  let contextWindow: number | null;

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
              knowledge: { autoOrganize },
            },
          },
        } as unknown;
      }
      if (method === "model.list") {
        return (contextWindow === null ? [] : [{
          id: "test-model", provider: "test-provider", contextWindow,
        }]) as unknown;
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

  const organizer = (service: MemoryService, overrides: Partial<Parameters<typeof createMemoryOrganizer>[0]> = {}) => createMemoryOrganizer({
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
    onError: (error) => { console.error("[organizer]", error); },
    ...overrides,
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
    contextWindow = 200_000;
  });

  afterEach(async () => {
    await Promise.all([...stores.values(), userStore].map((store) => store.close().catch(() => undefined)));
    cleanup();
  });

  it("organizes durable session events into effective memory with inference provenance", async () => {
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
    expect(item?.status).toBe("accepted");
    expect(item?.nature).toBe("decision");
    expect(item?.source?.kind).toBe("memory-organizer");
    const progress = await progressFor("ws-1", "session:s1");
    expect(progress?.status).toBe("formed");
    expect(progress?.produced).toEqual([item?.id]);
    await org.dispose();
  });

  it("commits two distinct proposals from one source without self-conflicting", async () => {
    const ws = await openStore("workspace", "ws-two-proposals");
    stores.set("ws-two-proposals", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Use Postgres and release on Thursday.", source: "user" });
    scopeSessions.set("ws-two-proposals", ["s1"]);
    organizeText = JSON.stringify({ memories: [
      { action: "new", scope: "workspace", content: "Catalog uses Postgres.", source: "u0" },
      { action: "new", scope: "workspace", content: "Release day is Thursday.", source: "u0" },
    ] });
    const org = organizer(memory());
    org.noteScope("ws-two-proposals");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.status === "formed");
    expect((await ws.listKnowledge({ scope: "workspace", activeOnly: true })).map((item) => item.content).sort()).toEqual([
      "Catalog uses Postgres.", "Release day is Thursday.",
    ]);
    await org.dispose();
  });

  it("recovers all produced ids after the second proposal fails mid-commit", async () => {
    const ws = await openStore("workspace", "ws-partial-commit");
    stores.set("ws-partial-commit", ws);
    const service = memory();
    const original = service.remember.bind(service);
    let writes = 0;
    (service as { remember: typeof original }).remember = async (...args) => {
      if (++writes === 2) throw new Error("second write unavailable");
      return original(...args);
    };
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Two decisions.", source: "user" });
    scopeSessions.set("ws-partial-commit", ["s1"]);
    organizeText = JSON.stringify({ memories: [
      { action: "new", scope: "workspace", content: "Decision A.", source: "u0" },
      { action: "new", scope: "workspace", content: "Decision B.", source: "u0" },
    ] });
    const org = organizer(service);
    org.noteScope("ws-partial-commit");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.lastError === "second write unavailable");
    org.retryScope("ws-partial-commit");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.status === "formed");
    const rows = await ws.listKnowledge({ scope: "workspace", activeOnly: true });
    expect(rows).toHaveLength(2);
    expect((await ws.getOrganizerProgress("session:s1"))?.produced?.sort()).toEqual(rows.map((row) => row.id).sort());
    await org.dispose();
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
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(calls.filter((c) => c.method === "harness.memoryOrganize").length).toBe(callsAfterFirst);
    const next = await ws.putEvent({ kind: "turn", at: 2, sessionId: "s1", text: "A later decision in the same conversation.", source: "user" });
    org.noteScope("ws-2");
    await wait(async () => (await progressFor("ws-2", "session:s1"))?.eventCursor === next.id);
    expect(calls.filter((c) => c.method === "harness.memoryOrganize").length).toBe(callsAfterFirst + 1);
    await org.dispose();
  });

  it("forgetting one source range does not suppress a later decision in the same session", async () => {
    const ws = await openStore("workspace", "ws-forgotten-range");
    stores.set("ws-forgotten-range", ws);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-forgotten-range" };
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Use SQLite for local state.", source: "user" });
    scopeSessions.set("ws-forgotten-range", ["s1"]);
    let narrative = 0;
    organizeText = () => JSON.stringify({ memories: [{
      action: "new", scope: "workspace", source: "u0",
      content: ++narrative === 1 ? "Local state uses SQLite." : "Backups run every Thursday.",
    }] });
    const org = organizer(service);
    org.noteScope("ws-forgotten-range");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.status === "formed");
    const [first] = await service.list(owner, { activeOnly: true });
    expect(first?.source?.key).toBeTruthy();
    await service.forget(owner, first!.id);
    const later = await ws.putEvent({ kind: "turn", at: 2, sessionId: "s1", text: "Backups are every Thursday.", source: "user" });
    org.noteScope("ws-forgotten-range");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.eventCursor === later.id);
    expect((await service.list(owner, { activeOnly: true })).map((item) => item.content)).toEqual(["Backups run every Thursday."]);
    await org.dispose();
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
    // A deliberate user retry bypasses the automatic backoff immediately.
    org.retryScope("ws-3");
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

  it("does not acknowledge unreadable sources or invalid proposal rows as empty successes", async () => {
    const store = await openStore("workspace", "source-failure");
    stores.set("ws", store);
    await store.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Important source", source: "user" });
    const org = organizer(memory(), { readEntries: async () => { throw new Error("session read failed"); } });
    org.noteScope("ws");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(await store.getOrganizerProgress("session:s1")).toMatchObject({
      status: "failed", lastError: "session read failed",
    });
    expect(calls.some((call) => call.method === "harness.memoryOrganize")).toBe(false);
    await org.dispose();
    organizeText = JSON.stringify({ memories: [{}] });
    const retry = organizer(memory());
    retry.retryScope("ws");
    await wait(async () => (await store.getOrganizerProgress("session:s1"))?.lastError?.includes("parseable proposals envelope") === true);
    expect((await store.getOrganizerProgress("session:s1"))?.eventCursor).toBeUndefined();
    await retry.dispose();
  });

  it("does not commit a late proposal after a human forget, and sends the entire covered source", async () => {
    const store = await openStore("workspace", "late-memory");
    stores.set("ws", store);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws" };
    // The forgotten row was itself mined from this session — forgetting it
    // suppresses re-derivation from the same logical source.
    const saved = await service.remember(owner, {
      content: "Old preference.", source: { kind: "memory-organizer", sessionId: "s1" },
    });
    const source = "Long source: " + "material ".repeat(900) + "last-material-marker";
    await store.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: source, source: "user" });
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    organizeText = async () => {
      began();
      await new Promise<void>((resolve) => { finish = resolve; });
      return JSON.stringify({ memories: [{ action: "new", scope: "workspace", content: "A paraphrase of the forgotten preference.", source: "u0" }] });
    };
    const org = organizer(service);
    org.noteScope("ws");
    await started;
    expect(calls.find((call) => call.method === "harness.memoryOrganize")?.params.prompt).toContain("last-material-marker");
    await service.forget(owner, saved.item.id);
    finish();
    // The forget bumps the revision between narrate and commit — the unit is
    // durably prepared, and the replay drops the deduped proposal instead of
    // resurrecting what the human just forgot.
    await wait(async () => (await store.getOrganizerProgress("session:s1"))?.status === "prepared");
    expect(await service.list(owner, { activeOnly: true })).toEqual([]);
    org.noteScope("ws");
    await wait(async () => (await store.getOrganizerProgress("session:s1"))?.status === "reviewed-empty");
    expect(await service.list(owner, { activeOnly: true })).toEqual([]);
    await org.dispose();
  });

  it("persists supplement proposals as a supplements edge to the target", async () => {
    const ws = await openStore("workspace", "ws-supplement");
    stores.set("ws-supplement", ws);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-supplement" };
    const existing = await service.remember(owner, {
      content: "Deploys run on Friday.", trigger: "release cadence", nature: "decision",
    });
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Releases moved to Thursday this quarter.", source: "agent" });
    scopeSessions.set("ws-supplement", ["s1"]);
    organizeText = JSON.stringify({
      memories: [{
        action: "supplement", scope: "workspace", nature: "decision",
        content: "This quarter releases happen on Thursday.", trigger: "release cadence",
        target: `k:${existing.item.id}`, source: "u0",
      }],
    });
    const org = organizer(service);
    org.noteScope("ws-supplement");
    await wait(async () => (await progressFor("ws-supplement", "session:s1"))?.status === "formed");
    const rows = await ws.listKnowledge({ scope: "workspace" });
    const supplement = rows.find((row) => row.id !== existing.item.id);
    expect(supplement?.content).toBe("This quarter releases happen on Thursday.");
    expect(supplement?.supplements).toBe(existing.item.id);
    expect((await ws.getKnowledge(existing.item.id))?.invalidAt).toBeUndefined();
    await org.dispose();
  });

  it("replays durably prepared proposals after a commit failure without re-narrating", async () => {
    const ws = await openStore("workspace", "ws-prepared");
    stores.set("ws-prepared", ws);
    const service = memory();
    const original = service.remember.bind(service);
    let failCommit = true;
    (service as { remember: typeof original }).remember = async (...args) => {
      if (failCommit) { failCommit = false; throw new Error("commit boom"); }
      return original(...args);
    };
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "The catalog store uses Postgres.", source: "agent" });
    scopeSessions.set("ws-prepared", ["s1"]);
    organizeText = JSON.stringify({
      memories: [{ action: "new", scope: "workspace", content: "Catalog uses Postgres.", trigger: "db", source: "u0" }],
    });
    const org = organizer(service);
    org.noteScope("ws-prepared");
    await wait(async () => (await progressFor("ws-prepared", "session:s1"))?.status === "prepared");
    const narrations = calls.filter((call) => call.method === "harness.memoryOrganize").length;
    const prepared = await progressFor("ws-prepared", "session:s1");
    expect(prepared?.proposals?.length).toBe(1);
    expect(prepared?.proposals?.[0]?.content).toBe("Catalog uses Postgres.");
    expect(prepared?.lastError).toContain("commit boom");
    const later = await ws.putEvent({ kind: "turn", at: 2, sessionId: "s1", text: "New work arrived while the first proposal was prepared.", source: "user" });
    // The retry first replays the frozen range. The appended turn remains
    // uncovered until the prepared proposal has committed.
    org.noteScope("ws-prepared");
    await wait(async () => (await progressFor("ws-prepared", "session:s1"))?.status === "formed");
    expect(calls.filter((call) => call.method === "harness.memoryOrganize").length).toBe(narrations);
    expect((await progressFor("ws-prepared", "session:s1"))?.eventCursor).not.toBe(later.id);
    const rows = await ws.listKnowledge({ scope: "workspace" });
    expect(rows.map((row) => row.content)).toEqual(["Catalog uses Postgres."]);
    expect((await progressFor("ws-prepared", "session:s1"))?.proposals).toBeUndefined();
    await org.dispose();
  });

  it("reopens coverage when a terminal row's source content changed", async () => {
    const ws = await openStore("workspace", "ws-revise");
    stores.set("ws-revise", ws);
    runSources.push({
      threadId: "t1", threadTitle: "Job", runId: "r1", sessionId: "s1",
      reportText: "The run shipped v1.", endedAt: null,
    });
    organizeText = JSON.stringify({ memories: [] });
    const org = organizer(memory());
    org.noteScope("ws-revise");
    await wait(async () => (await progressFor("ws-revise", "run:r1"))?.status === "reviewed-empty");
    const narrations = calls.filter((call) => call.method === "harness.memoryOrganize").length;
    // A revised report under the same run id changes the fingerprint — the
    // covered claim no longer matches and the range is reprocessed.
    runSources = [{ ...runSources[0]!, reportText: "The run shipped v2 after a rollback." }];
    org.noteScope("ws-revise");
    await wait(async () => calls.filter((call) => call.method === "harness.memoryOrganize").length === narrations + 1);
    await org.dispose();
  });

  it("does not commit a report that changed while the model was narrating", async () => {
    const ws = await openStore("workspace", "ws-live-report-change");
    stores.set("ws-live-report-change", ws);
    runSources = [{ threadId: "t1", threadTitle: "Job", runId: "r1", sessionId: null,
      reportText: "Release v1.", endedAt: null }];
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let requests = 0;
    organizeText = async () => {
      if (++requests === 1) {
        began();
        await new Promise<void>((resolve) => { finish = resolve; });
        return JSON.stringify({ memories: [{ action: "new", scope: "workspace", content: "Release v1 shipped.", source: "u0" }] });
      }
      return JSON.stringify({ memories: [] });
    };
    const org = organizer(memory());
    org.noteScope("ws-live-report-change");
    await started;
    runSources = [{ ...runSources[0]!, reportText: "Release v2 after rollback." }];
    finish();
    await wait(async () => (await ws.getOrganizerProgress("run:r1"))?.lastError?.includes("source changed") === true);
    expect(await ws.listKnowledge({ scope: "workspace" })).toEqual([]);
    await org.dispose();
  });

  it("subdivides an oversized run report into per-part coverage rows", async () => {
    contextWindow = 8_000; // → unitChars floor 4k, batch ~12.8k
    const ws = await openStore("workspace", "ws-chunk");
    stores.set("ws-chunk", ws);
    runSources.push({
      threadId: "t1", threadTitle: "Big job", runId: "r9", sessionId: "s1",
      reportText: Array.from({ length: 400 }, (_, index) => `Finding ${index}: something worth noting.`).join("\n"),
      endedAt: null,
    });
    const org = organizer(memory());
    org.noteScope("ws-chunk");
    await wait(async () => (await progressFor("ws-chunk", "run:r9"))?.status !== undefined);
    await wait(async () => (await ws.listOrganizerProgress()).filter((row) => row.key.startsWith("run:r9")).length > 1);
    const rows = (await ws.listOrganizerProgress()).filter((row) => row.key.startsWith("run:r9"));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.status === "reviewed-empty" || row.status === "formed")).toBe(true);
    await org.dispose();
  });

  it("keeps a multi-source model request within the selected model's source budget", async () => {
    contextWindow = 8_000;
    const ws = await openStore("workspace", "ws-batch-capacity");
    stores.set("ws-batch-capacity", ws);
    runSources = Array.from({ length: 8 }, (_, index) => ({
      threadId: `t${index}`, threadTitle: `Job ${index}`, runId: `r${index}`,
      sessionId: null, reportText: `Finding ${index}: ${"important detail ".repeat(180)}`, endedAt: null,
    }));
    const org = organizer(memory());
    org.noteScope("ws-batch-capacity");
    await wait(() => calls.some((call) => call.method === "harness.memoryOrganize"));
    const first = calls.find((call) => call.method === "harness.memoryOrganize")!;
    expect(String(first.params.prompt).length).toBeLessThanOrEqual(12_800);
    await wait(async () => (await ws.listOrganizerProgress()).filter((row) => row.status === "reviewed-empty").length === 8, 15_000);
    expect(calls.filter((call) => call.method === "harness.memoryOrganize").length).toBeGreaterThan(1);
    await org.dispose();
  });

  it("describes scope readiness and progress rows for the settings surface", async () => {
    const ws = await openStore("workspace", "ws-describe");
    stores.set("ws-describe", ws);
    const org = organizer(memory());
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Worth keeping.", source: "agent" });
    scopeSessions.set("ws-describe", ["s1"]);
    org.noteScope("ws-describe");
    await wait(async () => (await progressFor("ws-describe", "session:s1"))?.status !== undefined);
    const status = await org.describe("ws-describe");
    expect(status.enabled).toBe(true);
    expect(status.model).toEqual({ providerId: "test-provider", modelId: "test-model" });
    expect(status.rows.some((row) => row.key === "session:s1")).toBe(true);
    await org.dispose();
  });
});
