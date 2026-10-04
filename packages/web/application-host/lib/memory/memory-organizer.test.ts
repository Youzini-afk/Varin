import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openKnowledgeStoreEngine } from "../knowledge/store-engine.js";
import type { KnowledgeScope, KnowledgeStore, OrganizerProgress } from "../knowledge/store-contract.js";
import { createMemoryService, type MemoryOwner, type MemoryService } from "./memory-service.js";
import { createMemoryOrganizer, type MemoryOrganizerBroker, type OrganizerRunSource } from "./memory-organizer.js";
import type { PiSessionEntry } from "@varin/protocol";
import { estimateMemoryOrganizerInputTokens } from "@varin/protocol";
import { sourceRevision } from "./memory-sources.js";

let testDir: string;

let counter = 0;
const openStore = async (scope: KnowledgeScope = "workspace", name = `store-${++counter}`): Promise<KnowledgeStore> => {
  const dir = join(testDir, name);
  mkdirSync(dir, { recursive: true });
  return openKnowledgeStoreEngine({ dataDir: dir, hostId: "test-host", workspaceId: name, scope, embedding: null });
};

const scopeOfStoreId = (scopeId: string): KnowledgeScope => (
  scopeId.startsWith("bot:") ? "bot" : scopeId.startsWith("session:") ? "session" : "workspace"
);

interface StubCall { method: string; params: Record<string, unknown> }

const wait = async (predicate: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await vi.advanceTimersToNextTimerAsync();
    await setImmediate();
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
  let organizerConfigured: boolean;
  let organizers: Set<ReturnType<typeof createMemoryOrganizer>>;
  let releaseInference: Array<() => void>;

  const memory = (overrides: Partial<Parameters<typeof createMemoryService>[0]> = {}): MemoryService => createMemoryService({
    storeForScopeId: async (scopeId) => {
      const existing = stores.get(scopeId);
      if (existing) return existing;
      const opened = await openStore(scopeOfStoreId(scopeId));
      stores.set(scopeId, opened);
      return opened;
    },
    userStore: async () => userStore,
    ownerForSession: async (sessionId) => ({ scope: "workspace", ownerId: sessionId }),
    ...overrides,
  });

  const broker = (): MemoryOrganizerBroker => ({
    requestForWorkspace: (async (_cwd: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "settings.get") {
        return {
          global: {
            harness: {
              ...(organizerConfigured ? { models: { memoryOrganizer: { providerId: "test-provider", modelId: "test-model" } } } : {}),
              knowledge: { autoOrganize },
            },
          },
        } as unknown;
      }
      if (method === "model.list") {
        return (contextWindow === null ? [] : [{
          id: "test-model", provider: "test-provider", contextWindow, maxTokens: 4_096,
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

  const organizer = (service: MemoryService, overrides: Partial<Parameters<typeof createMemoryOrganizer>[0]> = {}) => {
    const instance = createMemoryOrganizer({
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
    organizers.add(instance);
    return instance;
  };

  const progressFor = async (scopeId: string, key: string): Promise<OrganizerProgress | null> => {
    const store = stores.get(scopeId);
    return store ? store.getOrganizerProgress(key) : null;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    testDir = mkdtempSync(join(tmpdir(), 'varin-memory-organizer-'));
    organizers = new Set();
    releaseInference = [];
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
    organizerConfigured = true;
  });

  afterEach(async () => {
    try {
      for (const release of releaseInference) release();
      await Promise.all([...organizers].map(instance => instance.dispose()));
    } finally {
      try {
        await Promise.all([...new Set([...stores.values(), userStore])].map(store => store.close()));
      } finally {
        rmSync(testDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    }
  });

  it("keeps user memory out of startup source discovery and scheduled source reads", async () => {
    const opened: string[] = [];
    const workspaceStore = await openStore("workspace", "ws-1");
    stores.set("ws-1", workspaceStore);
    const org = organizer(memory(), {
      listScopeIds: async () => ["user", "session:s1", "ws-1"],
      hasStoreForScope: async () => true,
      storeForScopeId: async (scopeId) => {
        opened.push(scopeId);
        if (scopeId !== "ws-1") throw new Error("user memory already has its own writer");
        return workspaceStore;
      },
    });
    org.start();
    org.noteScope("user");
    await vi.advanceTimersByTimeAsync(5_000);
    await org.dispose();
    expect(opened).toEqual(["ws-1"]);
    await expect(userStore.listKnowledge({ scope: "user" })).resolves.toEqual([]);
  });

  it("organizes durable session events into effective memory with inference provenance", async () => {
    const ws = await stores.get("ws-1") ?? await openStore("workspace", "ws-1");
    stores.set("ws-1", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "We decided to use Postgres for the catalog store.", source: "agent" });
    scopeSessions.set("ws-1", ["s1"]);
    organizeText = JSON.stringify({
      memories: [{
        action: "new", scope: "workspace", nature: "decision",
        content: "Catalog store uses Postgres.", trigger: "database schema questions", source: "u0", quote: "We decided to use Postgres for the catalog store.",
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

  it('previews an explicit selection while automatic memory is disabled and cancels its inference', async () => {
    autoOrganize = { workspace: false, user: false, bot: false };
    const org = organizer(memory());
    try {
      const result = await org.extractSelection('ws-1', 'Extract selected memory.', 'Only this passage.', new AbortController().signal);
      expect(result).toBe(organizeText);
      expect(stores.size).toBe(0);
      let finish!: (value: string) => void;
      organizeText = () => new Promise<string>((resolve) => { finish = resolve; releaseInference.push(() => resolve('{"memories":[]}')); });
      const controller = new AbortController();
      const pending = org.extractSelection('ws-1', 'Extract.', 'Selected.', controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      await wait(() => !!finish);
      controller.abort();
      finish('{"memories":[]}');
      await rejected;
      expect(calls.some((call) => call.method === 'harness.inference.cancel')).toBe(true);
    } finally { await org.dispose(); }
  });

  it("commits two distinct proposals from one source without self-conflicting", async () => {
    const ws = await openStore("workspace", "ws-two-proposals");
    stores.set("ws-two-proposals", ws);
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Use Postgres and release on Thursday.", source: "user" });
    scopeSessions.set("ws-two-proposals", ["s1"]);
    organizeText = JSON.stringify({ memories: [
      { action: "new", scope: "workspace", content: "Catalog uses Postgres.", source: "u0", quote: "Use Postgres" },
      { action: "new", scope: "workspace", content: "Release day is Thursday.", source: "u0", quote: "release on Thursday." },
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
      { action: "new", scope: "workspace", content: "Decision A.", source: "u0", quote: "Two decisions." },
      { action: "new", scope: "workspace", content: "Decision B.", source: "u0", quote: "Two decisions." },
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

  it("replays a cross-store user proposal after a crash between durable memory and source progress", async () => {
    const ws = await openStore("workspace", "ws-cross-store");
    stores.set("ws-cross-store", ws);
    runSources = [{ threadId: "t1", threadTitle: "Summary task", runId: "r1", sessionId: null,
      reportText: "The user prefers short summaries.", endedAt: null }];
    organizeText = JSON.stringify({ memories: [{ action: "new", scope: "user",
      content: "User prefers short summaries.", source: "u0", quote: "The user prefers short summaries." }] });
    const putProgress = ws.putOrganizerProgress.bind(ws);
    let interrupted = false;
    (ws as { putOrganizerProgress: typeof putProgress }).putOrganizerProgress = async (row) => {
      if (!interrupted && row.status === "formed") {
        interrupted = true;
        throw new Error("source progress unavailable");
      }
      return putProgress(row);
    };
    const first = organizer(memory());
    first.noteScope("ws-cross-store");
    await wait(async () => (await ws.getOrganizerProgress("run:r1"))?.lastError === "source progress unavailable");
    const [saved] = await userStore.listKnowledge({ scope: "user" });
    expect(saved?.content).toBe("User prefers short summaries.");
    const narrations = calls.filter((call) => call.method === "harness.memoryOrganize").length;
    await first.dispose();
    await ws.close();
    await userStore.close();
    const reopenedWs = await openStore("workspace", "ws-cross-store");
    stores.set("ws-cross-store", reopenedWs);
    userStore = await openStore("user", "user-store");
    expect((await reopenedWs.getOrganizerProgress("run:r1"))?.status).toBe("prepared");
    expect((await userStore.listKnowledge({ scope: "user" })).map((item) => item.id)).toEqual([saved!.id]);
    await userStore.updateAcceptedKnowledge(saved!.id, { content: "Human-edited summary preference.", trigger: "" }, "user", {
      content: saved!.content, trigger: saved!.trigger, status: "accepted", invalidAt: null,
    });
    // The original Pi/Thread source is unavailable after restart. The durable
    // proposal and memory provenance still establish that the write committed.
    runSources = [];
    autoOrganize.workspace = false;
    const resumed = organizer(memory());
    resumed.noteScope("ws-cross-store");
    await wait(async () => (await reopenedWs.getOrganizerProgress("run:r1"))?.status === "formed");
    expect(calls.filter((call) => call.method === "harness.memoryOrganize").length).toBe(narrations);
    expect((await reopenedWs.getOrganizerProgress("run:r1"))?.produced).toEqual([saved!.id]);
    expect((await userStore.listKnowledge({ scope: "user" })).map((item) => item.content)).toEqual(["Human-edited summary preference."]);
    await resumed.dispose();
  });

  it("keeps an uncommitted prepared proposal pending if its source disappears", async () => {
    const ws = await openStore("workspace", "ws-missing-prepared-source");
    stores.set("ws-missing-prepared-source", ws);
    runSources = [{ threadId: "t1", threadTitle: "Task", runId: "r1", sessionId: null,
      reportText: "A proposed decision.", endedAt: null }];
    organizeText = JSON.stringify({ memories: [{ action: "new", scope: "workspace",
      content: "The decision is pending.", source: "u0", quote: "A proposed decision." }] });
    const service = memory();
    (service as { remember: MemoryService["remember"] }).remember = async () => { throw new Error("write unavailable"); };
    const org = organizer(service);
    org.noteScope("ws-missing-prepared-source");
    await wait(async () => (await ws.getOrganizerProgress("run:r1"))?.lastError === "write unavailable");
    runSources = [];
    org.retryScope("ws-missing-prepared-source");
    await wait(async () => (await ws.getOrganizerProgress("run:r1"))?.lastError?.includes("not all proposals were committed") === true);
    expect((await ws.getOrganizerProgress("run:r1"))?.status).toBe("prepared");
    expect(await ws.listKnowledge({ scope: "workspace" })).toEqual([]);
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
    await vi.advanceTimersByTimeAsync(2200);
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
      quote: narrative === 1 ? "Use SQLite for local state." : "Backups are every Thursday.",
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
      memories: [{ action: "new", scope: "workspace", content: "Persisted fact.", source: "u0", quote: "Something worth keeping." }],
    }); };
    const service = memory();
    const org = organizer(service);
    org.noteScope("ws-3");
    await wait(async () => (await progressFor("ws-3", "session:s1"))?.status === "failed");
    expect(attempts).toBe(1);
    // Not yet retryable — backoff still active.
    org.noteScope("ws-3");
    await vi.advanceTimersByTimeAsync(2200);
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
    await vi.advanceTimersByTimeAsync(2200);
    expect(calls.some(call => call.method === 'settings.get')).toBe(true);
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
        { action: "new", scope: "bot", nature: "preference", content: "Owner prefers terse updates.", trigger: "status updates", source: "u0", quote: "The bot learned its owner prefers terse updates." },
        { action: "new", scope: "user", content: "User-level fact should not land.", source: "u0", quote: "The bot learned its owner prefers terse updates." },
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

  it("uses the Bot profile model when the organizer slot is unset", async () => {
    organizerConfigured = false;
    const bot = await openStore("bot", "bot-inherited-model");
    stores.set("bot:b-1", bot);
    await bot.putEvent({ kind: "turn", at: 1, sessionId: "s-bot", text: "A durable Bot decision.", source: "user" });
    scopeSessions.set("bot:b-1", ["s-bot"]);
    const org = organizer(memory(), {
      organizerModelForScope: async () => ({ providerId: "test-provider", modelId: "test-model" }),
    });
    org.noteScope("bot:b-1");
    await wait(async () => (await bot.getOrganizerProgress("session:s-bot"))?.status === "reviewed-empty");
    expect(calls.find((call) => call.method === "harness.memoryOrganize")?.params.modelSource).toBe("bot");
    await org.dispose();
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
        quote: "Correction: catalog moved to Postgres.",
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

  it("replaying a prepared correction cannot overwrite a newer human edit", async () => {
    const ws = await openStore("workspace", "ws-prepared-correction");
    stores.set("ws-prepared-correction", ws);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-prepared-correction" };
    const original = await service.remember(owner, { content: "Catalog uses SQLite.", trigger: "catalog" });
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "The catalog changed to Postgres.", source: "user" });
    scopeSessions.set("ws-prepared-correction", ["s1"]);
    organizeText = JSON.stringify({ memories: [{ action: "correct", scope: "workspace",
      target: `k:${original.item.id}`, content: "Catalog uses Postgres.", source: "u0", quote: "The catalog changed to Postgres." }] });
    const correct = service.correct.bind(service);
    let failed = false;
    (service as { correct: typeof correct }).correct = async (...args) => {
      if (!failed) { failed = true; throw new Error("commit interrupted"); }
      return correct(...args);
    };
    const org = organizer(service);
    org.noteScope("ws-prepared-correction");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.lastError === "commit interrupted");
    expect((await ws.getOrganizerProgress("session:s1"))?.proposals?.[0]?.expectedTarget?.content).toBe("Catalog uses SQLite.");
    await correct(owner, original.item.id, { content: "User chose DuckDB.", expected: {
      content: original.item.content, trigger: original.item.trigger, status: "accepted", invalidAt: null,
    } });
    org.retryScope("ws-prepared-correction");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.status === "reviewed-empty");
    expect((await service.list(owner, { activeOnly: true })).map((item) => item.content)).toEqual(["User chose DuckDB."]);
    await org.dispose();
  });

  it("does not acknowledge unreadable sources or invalid proposal rows as empty successes", async () => {
    const store = await openStore("workspace", "source-failure");
    stores.set("ws", store);
    await store.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "Important source", source: "user" });
    const org = organizer(memory(), { readEntries: async () => { throw new Error("session read failed"); } });
    org.noteScope("ws");
    await wait(async () => (await store.getOrganizerProgress('session:s1'))?.status === 'failed');
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
    const event = await store.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: source, source: "user" });
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    organizeText = async () => {
      began();
      await new Promise<void>((resolve) => { finish = resolve; releaseInference.push(resolve); });
      return JSON.stringify({ memories: [{ action: "new", scope: "workspace", content: "A paraphrase of the forgotten preference.", source: "u0", quote: "last-material-marker" }] });
    };
    const org = organizer(service);
    org.noteScope("ws");
    await wait(() => Boolean(finish));
    await started;
    expect(calls.find((call) => call.method === "harness.memoryOrganize")?.params.prompt).toContain("last-material-marker");
    await service.remember(owner, { content: "Old preference.", source: { kind: "user-mark", sessionId: "s1", spans: [{
      kind: "event", id: String(event.id), scopeId: "ws", sessionId: "s1", revision: sourceRevision(source),
      start: source.indexOf("last-material-marker"), end: source.length,
    }] } });
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
        quote: "Releases moved to Thursday this quarter.",
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
      memories: [{ action: "new", scope: "workspace", content: "Catalog uses Postgres.", trigger: "db", source: "u0", quote: "The catalog store uses Postgres." }],
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
        await new Promise<void>((resolve) => { finish = resolve; releaseInference.push(resolve); });
        return JSON.stringify({ memories: [{ action: "new", scope: "workspace", content: "Release v1 shipped.", source: "u0", quote: "Release v1." }] });
      }
      return JSON.stringify({ memories: [] });
    };
    const errors: unknown[] = [];
    const org = organizer(memory(), { onError: error => errors.push(error) });
    org.noteScope("ws-live-report-change");
    await wait(() => Boolean(finish));
    await started;
    runSources = [{ ...runSources[0]!, reportText: "Release v2 after rollback." }];
    finish();
    await wait(() => errors.some(error => error instanceof Error && error.message.includes('source changed')));
    await org.dispose();
    expect(await ws.listKnowledge({ scope: "workspace" })).toEqual([]);
  });

  it("subdivides an oversized run report into per-part coverage rows", async () => {
    contextWindow = 8_000;
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

  it("keeps Run-report part boundaries stable after an adaptive budget retry", async () => {
    contextWindow = 8_000;
    const ws = await openStore("workspace", "ws-run-boundary");
    stores.set("ws-run-boundary", ws);
    const reportText = "决".repeat(3_000);
    runSources = [{ threadId: "t1", threadTitle: "Task", runId: "r1", sessionId: null,
      reportText, endedAt: null }];
    const first = organizer(memory());
    first.noteScope("ws-run-boundary");
    await wait(async () => {
      const rows = (await ws.listOrganizerProgress()).filter((row) => row.key.startsWith("run:r1"));
      return rows.length > 1 && rows.every((row) => row.status === "reviewed-empty")
        && rows.some((row) => row.runEndOffset === reportText.length);
    }, 15_000);
    await first.dispose();
    const narrations = calls.filter((call) => call.method === "harness.memoryOrganize").length;
    const settingsReads = calls.filter((call) => call.method === "settings.get").length;
    const resumed = organizer(memory());
    resumed.noteScope("ws-run-boundary");
    await wait(() => calls.filter((call) => call.method === "settings.get").length > settingsReads);
    await wait(() => resumed.pending === 0);
    expect(calls.filter((call) => call.method === "harness.memoryOrganize")).toHaveLength(narrations);
    await resumed.dispose();
  });

  it("keeps the full source-and-memory prompt plus reserved output within model context", async () => {
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
    expect(estimateMemoryOrganizerInputTokens(String(first.params.system), String(first.params.prompt))
      + Number(first.params.maxOutputTokens)).toBeLessThanOrEqual(8_000);
    await wait(async () => (await ws.listOrganizerProgress()).filter((row) => row.status === "reviewed-empty").length === 8, 30_000);
    expect(calls.filter((call) => call.method === "harness.memoryOrganize").length).toBeGreaterThan(1);
    await org.dispose();
  });

  it("accounts for existing memory text instead of overflowing a small model", async () => {
    contextWindow = 8_000;
    const ws = await openStore("workspace", "ws-existing-capacity");
    stores.set("ws-existing-capacity", ws);
    const service = memory();
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-existing-capacity" };
    await service.remember(owner, { content: "HUGE-MEMORY " + "x".repeat(30_000) });
    await service.remember(owner, { content: "Prefer concise reports." });
    await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: "A new long-term decision.", source: "user" });
    scopeSessions.set("ws-existing-capacity", ["s1"]);
    const org = organizer(service);
    org.noteScope("ws-existing-capacity");
    await wait(() => calls.some((call) => call.method === "harness.memoryOrganize"));
    const request = calls.find((call) => call.method === "harness.memoryOrganize")!;
    expect(estimateMemoryOrganizerInputTokens(String(request.params.system), String(request.params.prompt))
      + Number(request.params.maxOutputTokens)).toBeLessThanOrEqual(8_000);
    expect(String(request.params.prompt)).not.toContain("HUGE-MEMORY");
    expect(String(request.params.prompt)).toContain("Prefer concise reports.");
    await org.dispose();
  });

  it("covers a long event in durable segments without losing text or splitting a surrogate pair", async () => {
    contextWindow = 8_000;
    const ws = await openStore("workspace", "ws-long-event");
    stores.set("ws-long-event", ws);
    const source = "A".repeat(3_980) + "😀" + "B".repeat(4_200) + "LAST-EVENT";
    const event = await ws.putEvent({ kind: "turn", at: 1, sessionId: "s1", text: source, source: "user" });
    scopeSessions.set("ws-long-event", ["s1"]);
    const first = organizer(memory());
    first.noteScope("ws-long-event");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.eventPartial !== undefined);
    const partial = await ws.getOrganizerProgress("session:s1");
    expect(partial?.eventCursor).toBeUndefined();
    expect(partial?.eventPartial?.id).toBe(event.id);
    await first.dispose();
    const resumed = organizer(memory());
    resumed.noteScope("ws-long-event");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.eventCursor === event.id, 15_000);
    const complete = await ws.getOrganizerProgress("session:s1");
    expect(complete?.eventPartial).toBeUndefined();
    const pieces = calls.filter((call) => call.method === "harness.memoryOrganize")
      .map((call) => String(call.params.prompt).split("[turn] ")[1] ?? "");
    expect(pieces.join("")).toBe(source);
    expect(pieces.join("")).not.toContain("�");
    await resumed.dispose();
  });

  it("advances a long Pi message only after every segment has been covered", async () => {
    contextWindow = 8_000;
    const ws = await openStore("workspace", "ws-long-entry");
    stores.set("ws-long-entry", ws);
    const source = "A".repeat(8_100) + "LAST-ENTRY";
    const entry: PiSessionEntry = {
      type: "message", id: "entry-1", parentId: null, timestamp: new Date(0).toISOString(),
      message: { role: "user", content: source, timestamp: 0 },
    };
    scopeSessions.set("ws-long-entry", ["s1"]);
    const org = organizer(memory(), { readEntries: async () => [entry] });
    org.noteScope("ws-long-entry");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.entryCursor === entry.id, 15_000);
    expect((await ws.getOrganizerProgress("session:s1"))?.entryPartial).toBeUndefined();
    const pieces = calls.filter((call) => call.method === "harness.memoryOrganize")
      .map((call) => String(call.params.prompt).split("[user] ")[1] ?? "");
    expect(pieces.join("")).toBe(source);
    await org.dispose();
  });

  it("continues past the per-pass event scan without waiting for the periodic sweep", async () => {
    const ws = await openStore("workspace", "ws-many-events");
    stores.set("ws-many-events", ws);
    let lastId = 0;
    for (let index = 0; index < 121; index += 1) {
      lastId = (await ws.putEvent({ kind: "turn", at: index, sessionId: "s1",
        text: `Decision ${index}.`, source: "user" })).id;
    }
    scopeSessions.set("ws-many-events", ["s1"]);
    const org = organizer(memory());
    org.noteScope("ws-many-events");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.eventCursor === lastId, 10_000);
    expect(calls.filter((call) => call.method === "harness.memoryOrganize")).toHaveLength(2);
    await org.dispose();
  });

  it("shares precise explicit coverage, preserves unrelated text, and recovers native branch revisions", async () => {
    const ws = await openStore("workspace", "ws-shared-source");
    stores.set("ws-shared-source", ws);
    const owner: MemoryOwner = { scope: "workspace", ownerId: "ws-shared-source" };
    const entry = (id: string, content: string, parentId: string | null = null): PiSessionEntry => ({
      type: "message", id, parentId, timestamp: new Date(0).toISOString(), message: { role: "user", content, timestamp: 0 },
    });
    let entries = [entry("a", "Use SQLite. Backups run Thursday.")];
    const service = memory({ readSessionEntries: async () => entries });
    const saved = await service.remember(owner, { content: "Local data uses SQLite.", sourceText: "Use SQLite.", source: { kind: "memory.remember", sessionId: "s1" } });
    await service.forget(owner, saved.item.id);
    scopeSessions.set("ws-shared-source", ["s1"]);
    let org = organizer(service, { readEntries: async () => entries });
    org.noteScope("ws-shared-source");
    await wait(async () => (await ws.getOrganizerProgress("session:s1"))?.status === "reviewed-empty");
    const first = String(calls.find((call) => call.method === "harness.memoryOrganize")!.params.prompt);
    expect(first).not.toContain("Use SQLite.");
    expect(first).toContain("Backups run Thursday.");
    expect(await service.readSource(owner, saved.item.id)).toMatchObject([{ status: "available", text: "Use SQLite." }]);
    await org.dispose();
    await ws.close();
    stores.set("ws-shared-source", await openStore("workspace", "ws-shared-source"));
    // The new active branch has a different leaf; prior native entries remain
    // original evidence. Reorder the tree to prove coverage is not a list cursor.
    entries = [entry("b", "New branch uses DuckDB.", "a"), ...entries];
    org = organizer(memory(), { readEntries: async () => entries });
    org.noteScope("ws-shared-source");
    await wait(() => calls.filter((call) => call.method === "harness.memoryOrganize").length === 2);
    await wait(() => org.pending === 0);
    const second = String(calls.filter((call) => call.method === "harness.memoryOrganize")[1]!.params.prompt);
    expect(second).toContain("New branch uses DuckDB.");
    expect(second).not.toContain("Backups run Thursday.");
    entries = [entries[0]!, entry("a", "Use Postgres. Backups run Thursday.")];
    org.noteScope("ws-shared-source");
    await wait(() => calls.filter((call) => call.method === "harness.memoryOrganize").length === 3);
    expect(String(calls.filter((call) => call.method === "harness.memoryOrganize")[2]!.params.prompt)).toContain("Use Postgres.");
    expect(await service.readSource(owner, saved.item.id)).toMatchObject([{ status: "changed" }]);
    await expect(service.readSource({ scope: "workspace", ownerId: "unrelated" }, saved.item.id)).rejects.toMatchObject({ code: "not-found" });
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
