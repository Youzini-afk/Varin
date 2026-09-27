import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PiSessionEntry, SessionEntriesResult, ThreadMessageRecord, ThreadReport } from "@varin/protocol";
import { createObservationCursorStore } from "./observation-cursors.js";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import {
  createThreadStatusProjector,
  lastVisibleOutput,
  threadStatusState,
} from "./thread-status.js";
import { createZone2StatusService } from "./harness-services.js";
import { createThreadReadService } from "./thread-services.js";
import type { HarnessServiceHost } from "./service-host.js";
import type { HarnessServiceContext } from "./router.js";

const WORKSPACE = "workspace-1";
const PARENT = { kind: "session", id: "parent-1" } as const;

const input = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  scopeId: WORKSPACE,
  parent: PARENT,
  brief: "verify the implementation",
  preset: "check",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  tools: [],
  permissions: {},
  ...overrides,
});

const report = (): ThreadReport => ({
  conclusion: "all checks pass",
  changedFiles: ["a.ts"],
  unresolved: [],
  deviations: [],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
  blocksSnapshot: {},
});

const assistantEntry = (id: string, text: string, stopReason = "stop"): PiSessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
  message: {
    role: "assistant",
    api: "openai",
    model: "m",
    provider: "p",
    stopReason: stopReason as "stop",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text }],
  },
});

const entriesResult = (entries: PiSessionEntry[], sessionId = "s"): SessionEntriesResult => ({
  entries,
  leafId: entries.at(-1)?.id ?? null,
  scope: "branch",
  sessionId,
});

const ctx = (sessionId: string): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "authority",
    sessionId,
    workerId: "worker",
    workerGeneration: 1,
    workspaceId: WORKSPACE,
    grantedCapabilities: ["context.session"],
  },
  authorizedPaths: [],
  sessionId,
  workspaceId: WORKSPACE,
  signal: new AbortController().signal,
});

describe("thread status projection", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;
  let cursors: ReturnType<typeof createObservationCursorStore>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-status-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    cursors = createObservationCursorStore();
  });

  afterEach(async () => {
    cursors.dispose();
    await registry.dispose();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("excerpts the last completed visible output, skipping pending streams", () => {
    const entries = [
      assistantEntry("1", "first answer"),
      assistantEntry("2", "still streaming", "pending"),
      assistantEntry("3", "final answer with quite a lot of visible text"),
    ];
    const excerpt = lastVisibleOutput(entries);
    expect(excerpt?.entryId).toBe("3");
    expect([...excerpt!.text].length).toBeLessThanOrEqual(21);
    expect(excerpt?.text.endsWith("…")).toBe(true);
  });

  it("previews the latest visible paragraph within an assistant entry", () => {
    const entry = assistantEntry("multi", "early block") as Extract<PiSessionEntry, { type: "message" }>;
    const assistant = entry.message as Extract<typeof entry.message, { role: "assistant" }>;
    assistant.content = [
      { type: "text", text: "early block" },
      { type: "text", text: "earlier paragraph\n\nlatest block with the useful result" },
    ];
    expect(lastVisibleOutput([entry])?.text).toContain("latest block");
    expect(lastVisibleOutput([entry])?.text).not.toContain("early block");
    expect(lastVisibleOutput([entry])?.text).not.toContain("earlier paragraph");
  });

  it("maps lifecycle, attention, and worker state into the state column", async () => {
    const thread = await registry.createThread(input());
    const run = await registry.startRun(WORKSPACE, thread.id);
    expect(threadStatusState(thread, run)).toBe("queued");
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    const running = (await registry.getThread(WORKSPACE, PARENT, thread.id))!;
    const runningRun = (await registry.listRuns(WORKSPACE, thread.id)).find((r) => r.id === run.id)!;
    expect(threadStatusState(running, runningRun)).toBe("working");
  });

  it("returns the complete transient table on every request", async () => {
    const first = await registry.createThread(input({ brief: "alpha task" }));
    await registry.createThread(input({ brief: "beta task" }));
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async () => entriesResult([]),
    } as unknown as HarnessServiceHost;
    const service = createZone2StatusService(host);
    const observer = ctx(PARENT.id);

    const initial = await service.handle({}, observer);
    expect(initial.content).toContain(`${first.id} [check] · alpha task`);
    expect(initial.status).toBe("ready");
    const repeated = await service.handle({}, observer);
    expect(repeated).toEqual(initial);
  });

  it("reports child status for a session without a project workspace", async () => {
    const child = await registry.createThread(input({ scopeId: `session:${PARENT.id}` }));
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async () => entriesResult([]),
    } as unknown as HarnessServiceHost;
    const observer = ctx(PARENT.id);
    observer.workspaceId = null;
    observer.actor.workspaceId = null;

    const status = await createZone2StatusService(host).handle({}, observer);
    expect(status.status).toBe("ready");
    expect(status.content).toContain(child.id);
  });

  it("does not consume inbound message bodies", async () => {
    const sender = await registry.createThread(input({ brief: "sender" }));
    const target = await registry.createThread(input({ brief: "target" }));
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async () => entriesResult([]),
    } as unknown as HarnessServiceHost;
    const service = createZone2StatusService(host);
    const observer = ctx(PARENT.id);

    const first = await service.handle({}, observer);

    const message: Omit<ThreadMessageRecord, "direction"> = {
      id: "m-1",
      from: { kind: "thread", id: sender.id },
      to: { kind: "thread", id: target.id },
      kind: "inform",
      text: "the dataset is ready for review",
      status: "delivered",
      at: new Date().toISOString(),
    };
    await registry.recordDirectedMessage(WORKSPACE, message);

    const update = await service.handle({}, observer);
    expect(update.content).toContain(target.id);
    expect(update.content).not.toContain("the dataset is ready for review");
    expect(update.content).not.toContain("message m-1");
    expect(update.content).toBe(first.content);
  });

  it("keeps result revisions out of the transient status body", async () => {
    const thread = await registry.createThread(input({ brief: "worker" }));
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async () => entriesResult([]),
    } as unknown as HarnessServiceHost;
    const service = createZone2StatusService(host);
    const observer = ctx(PARENT.id);

    await service.handle({}, observer);

    await registry.setWorkingState(WORKSPACE, thread.id, { branchId: "b-1", resultRevision: 2 });
    const revised = await service.handle({}, observer);
    expect(revised.status).toBe("ready");
    expect(revised.content).not.toContain("result r2");

    // A thread leaving the scope is reported, not silently dropped.
    const gone = await registry.createThread(input({ brief: "gone", autoRun: false }));
    const withGone = await service.handle({}, observer);
    expect(withGone.content).toContain("gone");
    await registry.deleteThread(WORKSPACE, PARENT, gone.id);
    const removed = await service.handle({}, observer);
    expect(removed.content).not.toContain(gone.id);
  });

  it("keeps progress sourced from an earlier run instead of disguising it", async () => {
    const thread = await registry.createThread(input({ brief: "writer" }));
    const run1 = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run1.id, "session-a");
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => (
        sessionId === "session-a" ? entriesResult([assistantEntry("7", "drafted the survey outline")], sessionId) : entriesResult([], sessionId)
      ),
    } as unknown as HarnessServiceHost;
    const projector = createThreadStatusProjector({
      registry: () => host.threadRegistry ?? null,
      readEntries: host.threadHistoryEntries ?? null,
    });
    const { rows } = await projector.build(WORKSPACE, PARENT, null);
    expect(rows[0]?.progress?.text).toContain("drafted the survey");
    expect(rows[0]?.progress?.entryId).toBe("7");
    expect(rows[0]?.progress?.fromEarlierRun).toBe(false);
    expect(rows[0]?.progress?.runId).toBe(run1.id);
  });

  it("attributes a reused session's progress to the active Run's transcript window", async () => {
    const thread = await registry.createThread(input({ brief: "continued writer" }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "session-reused");
    await registry.endRun(WORKSPACE, thread.id, first.id, "success", null, {
      ...report(),
      resultRevision: 1,
      transcriptRef: { runtimeId: "pi", sessionId: "session-reused", fromEntryId: "old", toEntryId: "old" },
    });
    const second = (await registry.admitRun(WORKSPACE, thread.id, "pi", { allowSettled: true })).run;
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "session-reused");
    const host = {
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => entriesResult([
        assistantEntry("old", "the old Run answer"),
        assistantEntry("new", "the new Run answer"),
      ], sessionId),
    } as unknown as HarnessServiceHost;
    const projector = createThreadStatusProjector({
      registry: () => registry,
      readEntries: host.threadHistoryEntries ?? null,
    });
    const { rows } = await projector.build(WORKSPACE, PARENT, null);
    expect(rows[0]?.progress).toMatchObject({ runId: second.id, entryId: "new", fromEarlierRun: false });
    expect(rows[0]?.progress?.text).toContain("new Run");
  });

  it("keeps the earlier Run when a continuation has no new entries", async () => {
    const thread = await registry.createThread(input({ brief: "empty continuation" }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "session-empty");
    await registry.endRun(WORKSPACE, thread.id, first.id, "success", null, {
      ...report(),
      resultRevision: 1,
      transcriptRef: { runtimeId: "pi", sessionId: "session-empty", fromEntryId: "old", toEntryId: "old" },
    });
    const second = (await registry.admitRun(WORKSPACE, thread.id, "pi", { allowSettled: true })).run;
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "session-empty");
    const host = {
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => entriesResult([assistantEntry("old", "old Run answer")], sessionId),
    } as unknown as HarnessServiceHost;
    const projector = createThreadStatusProjector({ registry: () => registry, readEntries: host.threadHistoryEntries ?? null });
    const { rows } = await projector.build(WORKSPACE, PARENT, null);
    expect(rows[0]?.progress).toMatchObject({ runId: first.id, entryId: "old", fromEarlierRun: true });
  });

  it("does not attribute old output to a Run after a lost predecessor without bounds", async () => {
    const thread = await registry.createThread(input({ brief: "lost predecessor" }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "session-lost");
    await registry.endRun(WORKSPACE, thread.id, first.id, "lost");
    const second = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "session-lost");
    const host = {
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => entriesResult([assistantEntry("old", "lost Run answer")], sessionId),
    } as unknown as HarnessServiceHost;
    const projector = createThreadStatusProjector({ registry: () => registry, readEntries: host.threadHistoryEntries ?? null });
    const { rows } = await projector.build(WORKSPACE, PARENT, null);
    expect(rows[0]?.progress?.runId).toBe(first.id);
    expect(rows[0]?.progress?.fromEarlierRun).toBe(true);
  });

  it("expands a cited excerpt through read_thread transcript entry lookup", async () => {
    const thread = await registry.createThread(input({ brief: "writer" }));
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "session-a");
    const entries = [
      assistantEntry("3", "gathered the samples"),
      assistantEntry("7", "drafted the survey outline"),
      assistantEntry("9", "polished the wording"),
    ];
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => entriesResult(entries, sessionId),
    } as unknown as HarnessServiceHost;
    const read = createThreadReadService(host);

    const page = await read.handle(
      { threadId: thread.id, what: "transcript", entry: "7", before: 1, after: 1 },
      ctx(PARENT.id),
    );
    expect(page.details).toMatchObject({ found: true, entry: "7", runId: run.id, sessionId: "session-a" });
    expect(page.text).toContain("gathered the samples");
    expect(page.text).toContain("drafted the survey outline");
    expect(page.text).toContain("polished the wording");

    // The status excerpt's citation resolves to this same passage.
    const projector = createThreadStatusProjector({
      registry: () => registry,
      readEntries: host.threadHistoryEntries ?? null,
    });
    const { rows } = await projector.build(WORKSPACE, PARENT, null);
    expect(rows[0]?.progress?.entryId).toBe("9");
    const cited = await read.handle(
      { threadId: thread.id, what: "transcript", entry: rows[0]!.progress!.entryId },
      ctx(PARENT.id),
    );
    expect(cited.text).toContain("polished the wording");
  });

  it("scopes an explicit Run transcript to its retained bounds", async () => {
    const thread = await registry.createThread(input({ brief: "bounded transcript" }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "session-reused");
    await registry.endRun(WORKSPACE, thread.id, first.id, "success", null, {
      ...report(),
      resultRevision: 1,
      transcriptRef: { runtimeId: "pi", sessionId: "session-reused", fromEntryId: "old", toEntryId: "old" },
    });
    const second = (await registry.admitRun(WORKSPACE, thread.id, "pi", { allowSettled: true })).run;
    await registry.markRunRunning(WORKSPACE, thread.id, second.id, "session-reused");
    const entries = [assistantEntry("old", "the old Run answer"), assistantEntry("new", "the new Run answer")];
    const read = createThreadReadService({
      threadRegistry: registry,
      threadHistoryEntries: async (sessionId: string) => entriesResult(entries, sessionId),
    } as unknown as HarnessServiceHost);
    const page = await read.handle({ threadId: thread.id, what: "transcript", runId: first.id, entry: "old" }, ctx(PARENT.id));
    expect(page.text).toContain("the old Run answer");
    expect(page.text).not.toContain("the new Run answer");
  });

  it("delivers the complete status table without an arbitrary row cap", async () => {
    for (let i = 0; i < 35; i += 1) {
      await registry.createThread(input({ brief: `task-${String(i).padStart(2, "0")}`, autoRun: false }));
    }
    const host = {
      observationCursors: cursors,
      threadRegistry: registry,
      threadHistoryEntries: async () => entriesResult([]),
    } as unknown as HarnessServiceHost;
    const service = createZone2StatusService(host);
    const result = await service.handle({}, ctx(PARENT.id));
    expect(result.status).toBe("ready");
    expect(result.content).toContain("task-34");
    expect(result.content).not.toContain("more threads in scope");
  });
});
