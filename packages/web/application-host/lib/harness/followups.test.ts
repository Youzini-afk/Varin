import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it as vitestIt, vi } from "vitest";
import { sliceUtf8ByBytes, type ExperimentArtifactView, type ExperimentAttemptView } from "@varin/protocol";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { createFollowUpService, type FollowUpCaller, type FollowUpExternalSource, type FollowUpResourceSample, type FollowUpServiceDeps, type FollowUpShellEvent } from "./followups.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") {
  throw new Error("Follow-up acceptance requires the release kernel");
}
const it = vitestIt.skipIf(!available);

const clients: KernelClient[] = [];
const roots: string[] = [];
const pause = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

interface ThreadStub {
  id: string;
  lifecycle: string;
  parent: { kind: "session"; id: string };
  activeRunId: string | null;
}

interface Harness {
  threads: Map<string, ThreadStub>;
  runs: Map<string, { id: string; workerState: string }>;
  continued: Array<{ threadId: string; task: string; requestId: string }>;
  parked: Array<{ threadId: string; requestId: string }>;
  informs: Array<{ sessionId: string; messageId: string; text: string }>;
  sessionRequests: Array<{ sessionId: string; messageId: string; text: string }>;
  ledger: Array<{ id: string; status: string }>;
  attention: Array<{ threadId: string; waitingFor: { kind: string; text: string } | null }>;
  goals: Map<string, { id: string; status: string; statusReason?: string | undefined }>;
  busy: Set<string>;
  attempts: Map<string, ExperimentAttemptView | null>;
  attemptListeners: Array<(workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void>;
  experiments: Map<string, { attempt: ExperimentAttemptView; artifacts: ExperimentArtifactView[] }>;
  logs: Map<string, string>;
  logEof: Map<string, boolean>;
  files: Map<string, { exists: boolean; size: number; mtimeMs: number }>;
  fileWatchListeners: Map<string, Array<(event: { sourceId: string; kind: string; sequence: number; generation: number; path?: string }) => void>>;
  activeWriters: Set<string>;
  samples: Map<string, FollowUpResourceSample>;
  sampleListeners: Array<(sample: FollowUpResourceSample) => void>;
  external: Map<string, FollowUpExternalSource>;
  shellEvents: Map<string, FollowUpShellEvent[]>;
  shellListeners: Array<(event: FollowUpShellEvent) => void>;
  shellRuntime: Map<string, { running: boolean; exitCode?: number }>;
  shellOutput: Map<string, { text: string; running: boolean; exitCode?: number }>;
  desktopStatuses: Map<string, string | null>;
  desktopFiles: Map<string, string>;
  errors: Error[];
}

const artifactView = (overrides: Partial<ExperimentArtifactView> = {}): ExperimentArtifactView => ({
  artifactId: "art-1",
  attemptId: "attempt-1",
  name: "result.json",
  kind: "file",
  state: "available",
  byteLength: 128,
  collectedAt: Date.now(),
  ...overrides,
});

const attemptView = (overrides: Partial<ExperimentAttemptView> = {}): ExperimentAttemptView => ({
  attemptId: "attempt-1",
  specId: "spec-1",
  backend: "local",
  collection: "none",
  createdAt: Date.now(),
  state: "running",
  ...overrides,
});

async function fixture(options: {
  canExecuteScope?: (scopeId: string) => Promise<boolean>;
  seed?: (harness: Harness) => void;
  afterNotify?: (harness: Harness) => void;
  getAttempt?: (harness: Harness, attemptId: string, caller: FollowUpCaller) => Promise<ExperimentAttemptView | null>;
  watchReady?: Promise<boolean>;
  continueRun?: (harness: Harness, input: Parameters<FollowUpServiceDeps["sendToThread"]>[0]) => Promise<{ runId?: string }>;
  sendToThread?: (harness: Harness, input: Parameters<FollowUpServiceDeps["sendToThread"]>[0]) => Promise<{ delivery: import("@varin/protocol").FollowUpOccurrenceDelivery; runId?: string }>;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-followup-"));
  roots.push(root);
  const client = createKernelClient({
    hostId: "followup-test",
    storageRoot: path.join(root, "storage"),
    kernelPath,
    buildVersion,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();

  const harness: Harness = {
    threads: new Map(),
    runs: new Map(),
    continued: [],
    parked: [],
    informs: [],
    sessionRequests: [],
    ledger: [],
    attention: [],
    goals: new Map(),
    busy: new Set(),
    attempts: new Map(),
    attemptListeners: [],
    experiments: new Map(),
    logs: new Map(),
    logEof: new Map(),
    files: new Map(),
    fileWatchListeners: new Map(),
    activeWriters: new Set(),
    samples: new Map(),
    sampleListeners: [],
    external: new Map(),
    shellEvents: new Map(),
    shellListeners: [],
    shellRuntime: new Map(),
    shellOutput: new Map(),
    desktopStatuses: new Map(),
    desktopFiles: new Map(),
    errors: [],
  };
  options.seed?.(harness);

  const deps: FollowUpServiceDeps = {
    client,
    ...(options.canExecuteScope ? { canExecuteScope: options.canExecuteScope } : {}),
    getThread: async (_ws, threadId) => harness.threads.get(threadId) ?? null,
    notifySession: async (sessionId, text, messageId) => {
      harness.informs.push({ messageId, sessionId, text });
      options.afterNotify?.(harness);
    },
    sessionRequest: async (sessionId, text, messageId) => {
      harness.sessionRequests.push({ messageId, sessionId, text });
    },
    sessionBusy: async (sessionId) => harness.busy.has(sessionId),
    sendToThread: async (input) => {
      if (options.sendToThread) return options.sendToThread(harness, input);
      const thread = harness.threads.get(input.threadId);
      if (!thread || thread.lifecycle === "archived") return { delivery: "dropped" };
      harness.ledger.push({ id: input.requestId, status: thread.lifecycle === "queued" ? "pending" : "delivered" });
      if (thread.lifecycle === "queued") {
        harness.parked.push({ requestId: input.requestId, threadId: input.threadId });
        return { delivery: "parked" };
      }
      if (thread.lifecycle === "active" && thread.activeRunId) {
        harness.sessionRequests.push({ sessionId: "s-1", messageId: input.requestId, text: input.text });
        return { delivery: "active-inform", runId: thread.activeRunId };
      }
      harness.continued.push({ requestId: input.requestId, task: input.text, threadId: input.threadId });
      if (options.continueRun) {
        const result = await options.continueRun(harness, input);
        return result.runId ? { delivery: "continued", runId: result.runId } : { delivery: "parked" };
      }
      return { delivery: "continued", runId: `run-${harness.continued.length}` };
    },
    setFollowUpAttention: async (_ws, threadId, waitingFor) => {
      harness.attention.push({ threadId, waitingFor });
      return {};
    },
    requestForSession: async (sessionId, method, params) => {
      if (method === "session.features.get") {
        const goal = harness.goals.get(sessionId);
        return goal ? { goal: { ...goal } } : {};
      }
      if (method === "session.features.mutate") {
        const mutation = (params as { mutation?: { goalId?: string; status?: string; statusReason?: string } }).mutation;
        const goal = harness.goals.get(sessionId);
        if (goal && mutation?.goalId === goal.id && mutation.status) {
          goal.status = mutation.status;
          goal.statusReason = mutation.statusReason;
        }
        return { applied: true };
      }
      return {};
    },
    subscribeAttempts: (listener) => {
      harness.attemptListeners.push(listener);
      return () => {
        const index = harness.attemptListeners.indexOf(listener);
        if (index >= 0) harness.attemptListeners.splice(index, 1);
      };
    },
    getAttempt: async (attemptCaller, attemptId) => options.getAttempt
      ? options.getAttempt(harness, attemptId, attemptCaller)
      : harness.attempts.get(attemptId) ?? null,
    getExperiment: async (_caller, attemptId) => harness.experiments.get(attemptId) ?? null,
    readExperimentLog: async (_caller, params) => {
      const key = `${params.attemptId}:${params.stream ?? "stdout"}`;
      const bytes = Buffer.from(harness.logs.get(key) ?? "", "utf8");
      const start = Math.min(Math.max(0, params.offset ?? 0), bytes.length);
      const slice = bytes.subarray(start, start + (params.maxBytes ?? 64 * 1024));
      return {
        text: slice.toString("utf8"),
        offset: start,
        nextOffset: start + slice.byteLength,
        eof: harness.logEof.get(key) === true,
      };
    },
    watchWorkspace: (workspaceId, listener) => {
      const listeners = harness.fileWatchListeners.get(workspaceId) ?? [];
      listeners.push(listener);
      harness.fileWatchListeners.set(workspaceId, listeners);
      return {
        ready: options.watchReady ?? Promise.resolve(true),
        close: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
    statWorkspaceFile: async (workspaceId, filePath) => (
      harness.files.get(`${workspaceId}:${filePath}`) ?? { exists: false }
    ),
    workspaceHasActiveWriters: async (workspaceId) => harness.activeWriters.has(workspaceId),
    subscribeResourceSamples: (listener) => {
      harness.sampleListeners.push(listener);
      return () => {
        const index = harness.sampleListeners.indexOf(listener);
        if (index >= 0) harness.sampleListeners.splice(index, 1);
      };
    },
    getResourceSample: async (machineId) => harness.samples.get(machineId) ?? null,
    observeDesktop: async (desktopId) => ({ status: harness.desktopStatuses.has(desktopId) ? harness.desktopStatuses.get(desktopId)! : null }),
    inspectDesktopArtifact: async (desktopId, relativePath) => {
      const sha = harness.desktopFiles.get(`${desktopId}:${relativePath}`);
      return sha ? { sha256: sha } : null;
    },
    externalSource: (provider) => harness.external.get(provider) ?? null,
    getShellEvents: async (_workspaceId, sessionId, executionId, afterId = 0) => (
      (harness.shellEvents.get(`${sessionId}:${executionId}`) ?? []).filter((event) => event.id > afterId)
    ),
    subscribeShellEvents: (listener) => {
      harness.shellListeners.push(listener);
      return () => {
        const index = harness.shellListeners.indexOf(listener);
        if (index >= 0) harness.shellListeners.splice(index, 1);
      };
    },
    getShellExecutionStatus: async (sessionId, executionId) => harness.shellRuntime.get(`${sessionId}:${executionId}`) ?? null,
    readShellExecutionOutput: async (sessionId, executionId, offset, length) => {
      const output = harness.shellOutput.get(`${sessionId}:${executionId}`);
      if (!output) return null;
      return {
        ...sliceUtf8ByBytes(output.text, offset, length),
        running: output.running,
        ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
      };
    },
    onError: (error) => harness.errors.push(error),
  };
  const service = createFollowUpService(deps);
  return { client, harness, service };
}

const caller = (overrides: Partial<FollowUpCaller> = {}): FollowUpCaller => ({
  allowedThreadIds: ["t-1"],
  executionWorkspaceId: "ws",
  rootSessionId: "s-1",
  workspaceId: "ws",
  sessionId: "s-1",
  threadId: "t-1",
  runId: "r-1",
  ...overrides,
});
/** Session-scoped caller — no thread binding (root session). */
const sessionCaller = (): FollowUpCaller => ({
  allowedThreadIds: [],
  executionWorkspaceId: "ws",
  rootSessionId: "s-1",
  sessionId: "s-1",
  workspaceId: "ws",
});

const settledThread = (): ThreadStub => ({
  activeRunId: null,
  id: "t-1",
  lifecycle: "settled",
  parent: { kind: "session", id: "s-1" },
});

const until = async (check: () => boolean | Promise<boolean>, ms = 4_000, errors?: Error[]): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  assert.ok(await check(), `condition did not hold; service errors: ${JSON.stringify(errors?.map((e) => e.message) ?? [])}`);
};

describe("follow-up service on the real kernel", () => {
  it('Bot sleep retains a due follow-up and wakes it once without replaying missed triggers', async () => {
    let sleeping = true;
    const f = await fixture({ canExecuteScope: async () => !sleeping, seed: (h) => h.threads.set('t-1', settledThread()) });
    try {
      const registered = await f.service.register(caller(), {
        instruction: 'continue the saved work', source: { kind: 'time', at: Date.now() + 50 },
      });
      await pause(100);
      assert.equal(f.harness.continued.length, 0);
      assert.equal((await f.service.get(caller(), { id: registered.followUp.id })).followUp.status, 'waiting');
      sleeping = false;
      await f.service.resumeScope('ws');
      await until(() => f.harness.continued.length === 1);
      await f.service.resumeScope('ws');
      assert.equal(f.harness.continued.length, 1);
    } finally { f.service.dispose(); }
  });
  it("registers a durable wait, lists it, and fires a due time source on check", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "summarise what finished",
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    assert.equal(registered.followUp.status, "waiting");
    assert.equal(registered.firedImmediately, false);
    assert.match(registered.followUp.id, /^fu-/);
    assert.equal(registered.followUp.threadId, "t-1");

    const listed = await f.service.list(caller(), {});
    assert.equal(listed.followUps.length, 1);
    assert.equal(listed.followUps[0]!.instruction, "summarise what finished");

    // Program check on a not-yet-due source stays waiting and calls nothing.
    const early = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(early.fired, false);
    assert.equal(early.followUp.status, "waiting");
    assert.equal(f.harness.continued.length, 0);

    // Moving the due time into the past fires during the update itself.
    const updated = await f.service.update(caller(), {
      expectedRevision: registered.followUp.revision,
      id: registered.followUp.id,
      source: { at: Date.now() - 1_000, kind: "time" },
    });
    assert.equal(updated.followUp.status, "delivered");
    const fired = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(fired.fired, false);

    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    // Settled thread → the normal continuation admission ran with the
    // occurrence id as the idempotent request identity.
    assert.equal(f.harness.continued.length, 1);
    assert.match(f.harness.continued[0]!.requestId, /^followup\.occurrence:occ-/);
    assert.match(f.harness.continued[0]!.task, /summarise what finished/);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
    assert.equal(detail.occurrences[0]!.delivery, "continued");
    assert.equal(detail.occurrences[0]!.reason, "time-due");
  });

  it("armed timer fires once without a model call and replays idempotently", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "check in",
      source: { at: Date.now() + 60, kind: "time" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 1);

    // A second check after delivery must not fire again — the wait is spent.
    const again = await f.service.check(caller(), { id: registered.followUp.id });
    assert.equal(again.fired, false);
    assert.equal(f.harness.continued.length, 1);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
  });

  it("chunks timers beyond Node's maximum delay without firing at the first chunk", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    vi.useFakeTimers();
    try {
      const dueAt = Date.now() + 2_147_483_647 + 1_000;
      const registered = await f.service.register(caller(), {
        instruction: "wait for the actual due time",
        source: { at: dueAt, kind: "time" },
      });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      assert.equal(f.harness.continued.length, 0);
      assert.equal((await f.service.get(caller(), { id: registered.followUp.id })).followUp.status, "waiting");
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => assert.equal(f.harness.continued.length, 1));
    } finally {
      f.service.dispose();
      vi.useRealTimers();
    }
  });

  it("experiment source: terminal at registration fires immediately; running attempt fires on the subscription", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-done", attemptView({ attemptId: "attempt-done", endedAt: Date.now(), exitCode: 0, state: "completed" }));
      h.attempts.set("attempt-live", attemptView({ attemptId: "attempt-live", state: "running" }));
    } });

    const done = await f.service.register(caller(), {
      instruction: "read results",
      source: { attemptId: "attempt-done", kind: "experiment" },
    });
    assert.equal(done.firedImmediately, true);
    assert.equal(done.followUp.status, "delivered");
    assert.equal(done.followUp.lastOccurrence?.delivered, true);
    await pause(200);
    assert.deepEqual(f.harness.errors.map((e) => e.message), []);
    await until(async () => (await f.service.get(caller(), { id: done.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);

    const live = await f.service.register(caller(), {
      instruction: "diagnose on failure",
      source: { attemptId: "attempt-live", kind: "experiment" },
    });
    assert.equal(live.firedImmediately, false);
    assert.equal(live.followUp.status, "waiting");

    const failedAttempt = attemptView({ attemptId: "attempt-live", exitCode: 1, state: "failed" });
    f.harness.attempts.set("attempt-live", failedAttempt);
    for (const listener of [...f.harness.attemptListeners]) listener("ws", "attempt-live", failedAttempt);
    await until(async () => (await f.service.get(caller(), { id: live.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 2);
    assert.match(f.harness.continued[1]!.task, /attempt-live/);
    assert.match(f.harness.continued[1]!.task, /failed/);
  });

  it("observes an experiment terminal transition during registration without double delivery", async () => {
    let firstRead = true;
    const observedScopes: string[][] = [];
    const f = await fixture({
      seed: (h) => {
        h.threads.set("t-1", settledThread());
        h.attempts.set("attempt-race", attemptView({ attemptId: "attempt-race", state: "running" }));
      },
      getAttempt: async (h, attemptId, attemptCaller) => {
        observedScopes.push([...attemptCaller.allowedThreadIds]);
        if (firstRead) {
          firstRead = false;
          const terminal = attemptView({ attemptId, endedAt: Date.now(), exitCode: 0, state: "completed" });
          h.attempts.set(attemptId, terminal);
          for (const listener of [...h.attemptListeners]) listener("ws", attemptId, terminal);
        }
        return h.attempts.get(attemptId) ?? null;
      },
    });
    const registered = await f.service.register(caller(), {
      instruction: "consume the result",
      source: { attemptId: "attempt-race", kind: "experiment" },
    });
    assert.equal(registered.firedImmediately, true);
    assert.equal(registered.followUp.status, "delivered");
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
    assert.equal(f.harness.continued.length, 1);
    assert.ok(observedScopes.length >= 1);
    assert.ok(observedScopes.every((scope) => scope.includes("t-1")));
  });

  it("rejects an experiment callback captured before a source update", async () => {
    let reads = 0;
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const f = await fixture({
      seed: (h) => {
        h.threads.set("t-1", settledThread());
        h.attempts.set("attempt-stale", attemptView({ attemptId: "attempt-stale", state: "running" }));
      },
      getAttempt: async (h, attemptId) => {
        reads += 1;
        if (reads > 1) {
          markReadStarted();
          await blockedRead;
        }
        return h.attempts.get(attemptId) ?? null;
      },
    });
    const registered = await f.service.register(caller(), {
      instruction: "old source",
      source: { attemptId: "attempt-stale", kind: "experiment" },
    });
    const terminal = attemptView({ attemptId: "attempt-stale", state: "completed" });
    f.harness.attempts.set("attempt-stale", terminal);
    for (const listener of [...f.harness.attemptListeners]) listener("ws", "attempt-stale", terminal);
    await readStarted;
    await f.service.update(caller(), {
      expectedRevision: registered.followUp.revision,
      id: registered.followUp.id,
      source: { kind: "manual", note: "replacement" },
    });
    releaseRead();
    await pause(100);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.followUp.source.kind, "manual");
    assert.equal(detail.followUp.status, "waiting");
    assert.equal(detail.occurrences.length, 0);
  });

  it("deadline fallback fires once and keeps the terminal wait armed", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-slow", attemptView({ attemptId: "attempt-slow", state: "running" }));
    } });
    const registered = await f.service.register(caller(), {
      instruction: "if still running, check progress",
      source: { attemptId: "attempt-slow", fallbackAt: Date.now() + 40, kind: "experiment" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).occurrences.length === 1);
    const afterDeadline = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(afterDeadline.followUp.status, "waiting"); // deadline does not finish the wait
    assert.equal(afterDeadline.occurrences[0]!.reason, "deadline");
    assert.equal(f.harness.continued.length, 1);

    // The attempt terminating afterwards still delivers the terminal fact.
    const completedAttempt = attemptView({ attemptId: "attempt-slow", exitCode: 0, state: "completed" });
    f.harness.attempts.set("attempt-slow", completedAttempt);
    for (const listener of [...f.harness.attemptListeners]) listener("ws", "attempt-slow", completedAttempt);
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 2);
    assert.match(f.harness.continued[1]!.task, /experiment-terminal/);
  });

  it("cancel stops the wait; a late callback cannot revive it", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.attempts.set("attempt-x", attemptView({ attemptId: "attempt-x", state: "running" }));
    } });
    const registered = await f.service.register(caller(), {
      instruction: "follow up",
      source: { attemptId: "attempt-x", kind: "experiment" },
    });
    const cancelled = await f.service.cancel(caller(), { id: registered.followUp.id });
    assert.equal(cancelled.followUp.status, "cancelled");
    for (const listener of [...f.harness.attemptListeners]) {
      listener("ws", "attempt-x", attemptView({ attemptId: "attempt-x", state: "completed" }));
    }
    await pause(150);
    assert.equal(f.harness.continued.length, 0);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 0);
  });

  it("update enforces the CAS revision", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "original",
      source: { kind: "manual", note: "hold" },
    });
    await assert.rejects(
      f.service.update(caller(), {
        expectedRevision: "999",
        id: registered.followUp.id,
        instruction: "hijacked",
      }),
      /revision conflict/,
    );
    const updated = await f.service.update(caller(), {
      expectedRevision: registered.followUp.revision,
      id: registered.followUp.id,
      instruction: "revised",
    });
    assert.equal(updated.followUp.instruction, "revised");
  });

  it("enforces exact target ownership and validates update payloads at the service boundary", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.threads.set("t-2", { ...settledThread(), id: "t-2" });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "owner only",
      source: { kind: "manual" },
    });
    const otherThread = caller({ allowedThreadIds: ["t-2"], threadId: "t-2" });
    await assert.rejects(f.service.get(otherThread, { id: registered.followUp.id }), /unknown follow-up/i);
    assert.deepEqual((await f.service.list(otherThread, {})).followUps, []);
    await assert.rejects(
      f.service.update(caller(), { id: registered.followUp.id, instruction: "   " }),
      /instruction must be a non-empty string/,
    );
    await assert.rejects(
      f.service.update(caller(), {
        id: registered.followUp.id,
        source: { kind: "time", at: Number.NaN },
      }),
      /finite `at`/,
    );
  });

  it("routes delivery by lifecycle: active informs, queued parks, archived drops", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-active", {
        activeRunId: "r-live",
        id: "t-active",
        lifecycle: "active",
        parent: { kind: "session", id: "s-1" },
      });
      h.runs.set("r-live", { id: "r-live", workerState: "running" });
      h.threads.set("t-queued", {
        activeRunId: null,
        id: "t-queued",
        lifecycle: "queued",
        parent: { kind: "session", id: "s-1" },
      });
      h.threads.set("t-gone", {
        activeRunId: null,
        id: "t-gone",
        lifecycle: "archived",
        parent: { kind: "session", id: "s-1" },
      });
    } });

    const register = (threadId: string) => f.service.register(caller({ threadId }), {
      instruction: `resume ${threadId}`,
      source: { kind: "manual" },
    });
    const fire = async (id: string, threadId: string) => {
      const targetCaller = caller({ allowedThreadIds: [threadId], threadId });
      await f.service.fire(targetCaller, { id });
      await until(async () => {
        const detail = await f.service.get(targetCaller, { id });
        return detail.occurrences.length === 1 && detail.occurrences[0]!.delivery !== undefined;
      });
      return f.service.get(targetCaller, { id });
    };

    const active = await fire((await register("t-active")).followUp.id, "t-active");
    assert.equal(active.occurrences[0]!.delivery, "active-inform");
    assert.equal(f.harness.sessionRequests.length, 1);
    assert.equal(f.harness.ledger.length, 1);
    assert.equal(f.harness.ledger[0]!.id, `followup.occurrence:${active.occurrences[0]!.id}`);

    const queued = await fire((await register("t-queued")).followUp.id, "t-queued");
    assert.equal(queued.occurrences[0]!.delivery, "parked");
    assert.equal(f.harness.parked.length, 1);
    assert.match(f.harness.parked[0]!.requestId, /^followup\.occurrence:/);

    const gone = await fire((await register("t-gone")).followUp.id, "t-gone");
    assert.equal(gone.occurrences[0]!.delivery, "dropped");
    assert.equal(gone.followUp.status, "unavailable");
  });

  it("uses one thread.send request receipt when an active run settles at admission", async () => {
    const f = await fixture({
      seed: (h) => {
        h.threads.set("t-1", {
          activeRunId: "r-live",
          id: "t-1",
          lifecycle: "active",
          parent: { kind: "session", id: "s-1" },
        });
        h.runs.set("r-live", { id: "r-live", workerState: "running" });
      },
      sendToThread: async (h, input) => {
        const thread = h.threads.get("t-1")!;
        thread.activeRunId = null;
        thread.lifecycle = "settled";
        h.runs.get("r-live")!.workerState = "completed";
        h.ledger.push({ id: input.requestId, status: "delivered" });
        h.continued.push({ requestId: input.requestId, task: input.text, threadId: input.threadId });
        return { delivery: "continued", runId: "run-after-settle" };
      },
    });
    const registered = await f.service.register(caller(), {
      instruction: "survive the settle race",
      source: { kind: "manual" },
    });
    const fired = await f.service.fire(caller(), { id: registered.followUp.id });
    assert.equal(fired.occurrences[0]!.delivery, "continued");
    assert.equal(f.harness.continued.length, 1);
    assert.equal(f.harness.ledger.length, 1);
    assert.equal(f.harness.ledger[0]!.id, f.harness.continued[0]!.requestId);
  });

  it("root-session registrations deliver through the session request path", async () => {
    const f = await fixture(); // no thread binding at all
    const registered = await f.service.register(sessionCaller(), {
      instruction: "report back",
      source: { kind: "manual" },
    });
    assert.equal(registered.followUp.threadId, undefined);
    await f.service.fire(sessionCaller(), { id: registered.followUp.id });
    await until(async () => (await f.service.get(sessionCaller(), { id: registered.followUp.id })).followUp.status === "delivered");
    assert.equal(f.harness.sessionRequests.length, 1);
    assert.match(f.harness.sessionRequests[0]!.text, /report back/);
    assert.equal(f.harness.continued.length, 0);
  });

  it("a busy root session receives the trigger as an inform instead of a new run", async () => {
    const f = await fixture({ seed: (h) => h.busy.add("s-1") });
    const registered = await f.service.register(sessionCaller(), {
      instruction: "note this",
      source: { kind: "manual" },
    });
    await f.service.fire(sessionCaller(), { id: registered.followUp.id });
    await until(() => f.harness.informs.length === 1);
    assert.equal(f.harness.sessionRequests.length, 0);
  });

  it("pause marks follow-up attention and pauses the goal; delivery resumes it", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.goals.set("s-1", { id: "goal-1", status: "active" });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "continue the goal",
      pause: true,
      source: { kind: "manual" },
    });
    assert.equal(registered.followUp.pausedGoal, true);
    assert.equal(f.harness.goals.get("s-1")?.status, "paused");
    assert.equal(f.harness.goals.get("s-1")?.statusReason, "waiting");
    assert.ok(f.harness.attention.some((entry) => entry.waitingFor?.kind === "followup"));

    await f.service.fire(caller(), { id: registered.followUp.id });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.goals.get("s-1")?.status, "active");
    assert.ok(f.harness.attention.some((entry) => entry.waitingFor === null));
  });

  it("keeps a shared paused goal paused until its last follow-up finishes", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.goals.set("s-1", { id: "goal-shared", status: "active" });
    } });
    const first = await f.service.register(caller(), {
      instruction: "first wait",
      pause: true,
      source: { kind: "manual" },
    });
    const second = await f.service.register(caller(), {
      instruction: "second wait",
      pause: true,
      source: { kind: "manual" },
    });
    assert.equal(first.followUp.pausedGoal, true);
    assert.equal(second.followUp.pausedGoal, true);
    await f.service.fire(caller(), { id: first.followUp.id });
    assert.equal(f.harness.goals.get("s-1")?.status, "paused");
    await f.service.fire(caller(), { id: second.followUp.id });
    assert.equal(f.harness.goals.get("s-1")?.status, "active");
  });

  it("disarms an unavailable source and restores pause side effects before register returns", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.goals.set("s-1", { id: "goal-missing-source", status: "active" });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "will not run",
      pause: true,
      source: { attemptId: "missing-attempt", kind: "experiment" },
    });
    assert.equal(registered.followUp.status, "unavailable");
    assert.equal(f.harness.goals.get("s-1")?.status, "active");
    assert.equal(f.harness.attention.at(-1)?.waitingFor, null);
  });

  it("reconcile after restart fires an overdue wait once and redelivers a stuck triggered record", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "after restart",
      source: { at: Date.now() + 60_000, kind: "time" },
    });

    // Simulate a host that died: a second service over the same kernel store.
    const f2 = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    // Rewire the second harness onto the SAME kernel client storage.
    const service2 = createFollowUpService({
      client: f.client,
      getThread: async (_ws, threadId) => f2.harness.threads.get(threadId) ?? null,
      notifySession: async () => {},
      sessionRequest: async () => {},
      sessionBusy: async () => false,
      sendToThread: async (input) => {
        f2.harness.continued.push({ requestId: input.requestId, task: input.text, threadId: input.threadId });
        return { delivery: "continued", runId: "run-restarted" };
      },
      setFollowUpAttention: async () => ({}),
      requestForSession: async () => ({}),
      onError: (error) => f2.harness.errors.push(error),
    });
    // First reconcile while the wait is not yet due: re-arms, does not fire.
    await service2.reconcile("ws");
    await pause(80);
    assert.equal(f2.harness.continued.length, 0);

    // Push the due time into the past by rewriting the durable record directly
    // — a service update would re-arm this host's timer and fire it here, which
    // is not the restart path under test.
    const grant = await f.client.issueGrant({
      capabilities: ["storage.read", "storage.write", "storage.maintenance"],
      executionWorkspace: "ws",
      grantId: `test-rewrite-${Date.now()}`,
      owningWorkspace: "ws",
      pathScopes: [""],
    });
    const scoped = f.client.scoped(grant);
    const recordId = `followup.definition:${registered.followUp.id}`;
    const existing = await scoped.getRecord("ws", recordId);
    assert.ok(existing, "durable definition must exist");
    const payload = JSON.parse(existing.payloadJson) as { source: { at: number } };
    payload.source.at = Date.now() - 5_000;
    await scoped.putRecord({
      expectedRecordRevision: existing.recordRevision,
      operationId: `test-rewrite-${Date.now()}`,
      ownerIds: [],
      payloadJson: JSON.stringify(payload),
      recordId,
      recordType: "followup.definition",
      references: [],
      state: "waiting",
      workspaceId: "ws",
      ...(existing.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing.threadId ? { threadId: existing.threadId } : {}),
      ...(existing.runId ? { runId: existing.runId } : {}),
    });
    const service3 = createFollowUpService({
      client: f.client,
      getThread: async (_ws, threadId) => f2.harness.threads.get(threadId) ?? null,
      notifySession: async () => {},
      sessionRequest: async () => {},
      sessionBusy: async () => false,
      sendToThread: async (input) => {
        f2.harness.continued.push({ requestId: input.requestId, task: input.text, threadId: input.threadId });
        return { delivery: "continued", runId: "run-restarted" };
      },
      setFollowUpAttention: async () => ({}),
      requestForSession: async () => ({}),
      onError: (error) => f2.harness.errors.push(error),
    });
    await service3.reconcile("ws");
    await until(() => f2.harness.continued.length === 1, 4_000, f2.harness.errors);
    assert.match(f2.harness.continued[0]!.task, /after restart/);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.followUp.status, "delivered");
    assert.equal(detail.occurrences.length, 1);
    service2.dispose();
    service3.dispose();
  });

  const emitAttempt = (h: Harness, workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => {
    for (const listener of h.attemptListeners) listener(workspaceId, attemptId, view);
  };
  const emitFile = (h: Harness, workspaceId: string, path: string, kind = "changed", sequence = 1) => {
    for (const listener of h.fileWatchListeners.get(workspaceId) ?? []) {
      listener({ sourceId: "watch-test", generation: 1, kind, path, sequence });
    }
  };
  const emitSample = (h: Harness, sample: FollowUpResourceSample) => {
    for (const listener of h.sampleListeners) listener(sample);
  };

  it("artifact source: ready fires with artifact facts; terminal-without-it reports missing", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.experiments.set("attempt-1", {
        artifacts: [artifactView({ artifactId: "art-pending", state: "pending" })],
        attempt: attemptView({ collection: "pending", state: "running" }),
      });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "inspect the artifact",
      source: { artifactId: "art-pending", attemptId: "attempt-1", kind: "artifact" },
    });
    assert.equal(registered.followUp.status, "waiting");
    assert.equal(registered.firedImmediately, false);
    assert.equal(f.harness.continued.length, 0);

    // Artifact becomes collected — the attempt wakeup evaluates and fires.
    const detail = f.harness.experiments.get("attempt-1")!;
    detail.artifacts = [artifactView({ artifactId: "art-pending", byteLength: 512 })];
    emitAttempt(f.harness, "ws", "attempt-1", detail.attempt);
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 1);
    const occurrences = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences;
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]!.reason, "artifact-ready");
    assert.equal(occurrences[0]!.facts.artifactId, "art-pending");
    assert.equal(occurrences[0]!.facts.byteLength, 512);

    // A second wait on the same attempt ends honestly when the attempt is
    // terminal without the bound artifact.
    detail.artifacts = [];
    detail.attempt = attemptView({ collection: "done", state: "completed" });
    const missing = await f.service.register(caller(), {
      instruction: "artifact never arrived",
      source: { artifactId: "art-nope", attemptId: "attempt-1", kind: "artifact" },
    });
    await until(async () => (await f.service.get(caller(), { id: missing.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const missingOcc = (await f.service.get(caller(), { id: missing.followUp.id })).occurrences;
    assert.equal(missingOcc[0]!.reason, "artifact-missing");
  });

  it("artifact every: fires once per collected artifact and closes on collection done", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.experiments.set("attempt-1", {
        artifacts: [],
        attempt: attemptView({ collection: "pending", state: "running" }),
      });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "process each artifact",
      source: { attemptId: "attempt-1", every: true, kind: "artifact" },
    });
    const detail = f.harness.experiments.get("attempt-1")!;

    detail.artifacts = [artifactView({ artifactId: "art-a", name: "a.json" })];
    emitAttempt(f.harness, "ws", "attempt-1", detail.attempt);
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    assert.equal((await f.service.get(caller(), { id: registered.followUp.id })).followUp.status, "waiting");

    detail.artifacts = [artifactView({ artifactId: "art-a", name: "a.json" }), artifactView({ artifactId: "art-b", name: "b.json" })];
    emitAttempt(f.harness, "ws", "attempt-1", detail.attempt);
    await until(() => f.harness.continued.length === 2, 4_000, f.harness.errors);
    // Re-notification of the same artifacts must not double-fire.
    emitAttempt(f.harness, "ws", "attempt-1", detail.attempt);
    await pause(150);
    assert.equal(f.harness.continued.length, 2);

    detail.attempt = attemptView({ collection: "done", state: "completed" });
    emitAttempt(f.harness, "ws", "attempt-1", detail.attempt);
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const occurrences = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences;
    assert.deepEqual(occurrences.map((occurrence) => occurrence.reason).sort(), [
      "artifact-collection-finished", "artifact-ready", "artifact-ready",
    ]);
  });

  it("file source: exists fires on a watch event; ready waits for quiet + stability", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "report exists",
      source: { condition: "exists", kind: "file", path: "out/result.json" },
    });
    assert.equal(registered.followUp.status, "waiting");
    assert.equal(f.harness.fileWatchListeners.get("ws")?.length, 1);

    f.harness.files.set("ws:out/result.json", { exists: true, mtimeMs: 1_000, size: 64 });
    emitFile(f.harness, "ws", "out/result.json", "created");
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 1);

    // "ready" must not fire while the document authority reports a writer.
    f.harness.activeWriters.add("ws");
    f.harness.files.set("ws:model/checkpoint.bin", { exists: true, mtimeMs: 2_000, size: 1024 });
    const ready = await f.service.register(caller(), {
      instruction: "checkpoint ready",
      source: { condition: "ready", kind: "file", path: "model/checkpoint.bin" },
    });
    await pause(1_100); // settle window must not fire under an active writer
    assert.equal((await f.service.get(caller(), { id: ready.followUp.id })).followUp.status, "waiting");
    assert.equal(f.harness.continued.length, 1);

    f.harness.activeWriters.delete("ws");
    emitFile(f.harness, "ws", "model/checkpoint.bin", "changed", 2);
    await until(async () => (await f.service.get(caller(), { id: ready.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const readyOcc = (await f.service.get(caller(), { id: ready.followUp.id })).occurrences;
    assert.equal(readyOcc[0]!.reason, "file-ready");
    assert.equal(readyOcc[0]!.facts.size, 1024);
  });

  it("waits for the document watch to become ready, then snapshots the registration gap", async () => {
    let releaseReady!: () => void;
    const watchReady = new Promise<boolean>((resolve) => { releaseReady = () => resolve(true); });
    const f = await fixture({
      watchReady,
      seed: (h) => h.threads.set("t-1", settledThread()),
    });
    const registering = f.service.register(caller(), {
      instruction: "observe a file created while the watch attaches",
      source: { condition: "exists", kind: "file", path: "out/gap.txt" },
    });
    await until(() => (f.harness.fileWatchListeners.get("ws")?.length ?? 0) === 1);
    f.harness.files.set("ws:out/gap.txt", { exists: true, mtimeMs: 10, size: 3 });
    releaseReady();
    const registered = await registering;
    assert.equal(registered.firedImmediately, true);
    assert.equal(registered.followUp.status, "delivered");
    assert.equal(f.harness.continued.length, 1);
  });

  it("file changed: re-arms across deletion, creation, and content changes", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.files.set("ws:data/input.csv", { exists: true, mtimeMs: 1, size: 1 });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "react to changes",
      source: { condition: "changed", kind: "file", path: "data/input.csv" },
    });
    f.harness.files.delete("ws:data/input.csv");
    emitFile(f.harness, "ws", "data/input.csv", "deleted", 1);
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    const afterDelete = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(afterDelete.occurrences[0]!.facts.exists, false);

    f.harness.files.set("ws:data/input.csv", { exists: true, mtimeMs: 2, size: 2 });
    emitFile(f.harness, "ws", "data/input.csv", "changed", 2);
    await until(() => f.harness.continued.length === 2, 4_000, f.harness.errors);
    // `continued` is recorded by the harness before the service finishes its
    // durable occurrence delivery and re-arms the definition. Observe the
    // persisted completion boundary instead of racing that handoff.
    await until(async () => {
      const detail = await f.service.get(caller(), { id: registered.followUp.id });
      return detail.followUp.status === "waiting"
        && detail.occurrences.length === 2
        && detail.occurrences[1]?.delivery === "continued";
    }, 4_000, f.harness.errors);

    f.harness.files.set("ws:data/input.csv", { exists: true, mtimeMs: 3, size: 3 });
    emitFile(f.harness, "ws", "data/input.csv", "changed", 3);
    await until(() => f.harness.continued.length === 3, 4_000, f.harness.errors);
    await until(async () => {
      const detail = await f.service.get(caller(), { id: registered.followUp.id });
      return detail.followUp.status === "waiting"
        && detail.occurrences.length === 3
        && detail.occurrences[2]?.delivery === "continued";
    }, 4_000, f.harness.errors);
    const occurrences = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences;
    assert.equal(occurrences.length, 3);
    assert.equal(occurrences[2]!.facts.sequence, 3);
  });

  it("rechecks every file wait on a pathless reset", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.files.set("ws:data/reset.csv", { exists: true, mtimeMs: 1, size: 1 });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "react after watcher overflow",
      source: { condition: "changed", kind: "file", path: "data/reset.csv" },
    });
    assert.equal(registered.firedImmediately, false);
    f.harness.files.set("ws:data/reset.csv", { exists: true, mtimeMs: 2, size: 2 });
    for (const listener of f.harness.fileWatchListeners.get("ws") ?? []) {
      listener({ sourceId: "watch-test", generation: 2, kind: "reset", sequence: 1 });
    }
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    const occurrence = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences[0]!;
    assert.equal(occurrence.reason, "file-changed");
    assert.equal(occurrence.facts.generation, 2);
    assert.equal(occurrence.facts.sequence, 1);
  });

  it("buffers and coalesces a file change that arrives during re-arming delivery", async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let deliveries = 0;
    const f = await fixture({
      seed: (h) => {
        h.threads.set("t-1", settledThread());
        h.files.set("ws:data/live.csv", { exists: true, mtimeMs: 1, size: 1 });
      },
      continueRun: async () => {
        deliveries += 1;
        if (deliveries === 1) await firstDelivery;
        return { runId: `run-${deliveries}` };
      },
    });
    const registered = await f.service.register(caller(), {
      instruction: "react to coalesced file changes",
      source: { condition: "changed", kind: "file", path: "data/live.csv" },
    });
    f.harness.files.set("ws:data/live.csv", { exists: true, mtimeMs: 2, size: 2 });
    emitFile(f.harness, "ws", "data/live.csv", "changed", 2);
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    f.harness.files.set("ws:data/live.csv", { exists: true, mtimeMs: 3, size: 3 });
    emitFile(f.harness, "ws", "data/live.csv", "changed", 3);
    await pause(50);
    releaseFirst();
    await until(() => f.harness.continued.length === 2, 4_000, f.harness.errors);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 2);
    assert.equal(detail.occurrences[1]!.facts.size, 3);
  });

  it("metric source: crossing fires once; steady-true samples do not re-wake", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "memory pressure",
      source: { kind: "metric", machineId: "local", metric: "memoryMb", predicate: "above", threshold: 8_000 },
    });
    assert.equal(registered.followUp.status, "waiting");

    emitSample(f.harness, { machineId: "local", observedAt: 1, usage: { memoryMb: 4_000 } });
    await pause(120);
    assert.equal(f.harness.continued.length, 0);

    emitSample(f.harness, { machineId: "local", observedAt: 2, usage: { memoryMb: 9_500 } });
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.followUp.status, "delivered");
    assert.equal(detail.occurrences[0]!.reason, "metric-crossed");
    assert.equal(detail.occurrences[0]!.facts.value, 9_500);
  });

  it("metric source: does not lose a crossing behind an earlier sample write", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const createScoped = f.client.scoped.bind(f.client);
    let scoped: ReturnType<typeof f.client.scoped> | undefined;
    f.client.scoped = (grant) => {
      scoped = createScoped(grant);
      return scoped;
    };
    const registered = await f.service.register(caller(), {
      instruction: "memory pressure",
      source: { kind: "metric", machineId: "local", metric: "memoryMb", predicate: "above", threshold: 8_000 },
    });
    assert.ok(scoped);

    let releaseLowUpdate!: () => void;
    const lowUpdateGate = new Promise<void>((resolve) => { releaseLowUpdate = resolve; });
    let lowUpdateStarted = false;
    let highObservationWritten = false;
    const originalPutRecord = scoped.putRecord.bind(scoped);
    scoped.putRecord = async (params, signal) => {
      const payload = JSON.parse(params.payloadJson) as {
        source?: { kind?: string };
        sourceState?: { metricObservedAt?: number };
        facts?: { observedAt?: number };
      };
      if (payload.source?.kind === "metric" && payload.sourceState?.metricObservedAt === 1) {
        lowUpdateStarted = true;
        await lowUpdateGate;
      }
      const record = await originalPutRecord(params, signal);
      if (params.recordType === "followup.observation" && payload.facts?.observedAt === 2) {
        highObservationWritten = true;
      }
      return record;
    };

    try {
      emitSample(f.harness, { machineId: "local", observedAt: 1, usage: { memoryMb: 4_000 } });
      await until(() => lowUpdateStarted, 4_000, f.harness.errors);
      emitSample(f.harness, { machineId: "local", observedAt: 2, usage: { memoryMb: 9_500 } });
      await until(() => highObservationWritten, 4_000, f.harness.errors);
      // The crossing is durably observed while the earlier sample still owns
      // the definition's serial mutation slot.
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseLowUpdate();
      await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    } finally {
      releaseLowUpdate();
    }

    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 1);
    assert.equal(detail.occurrences[0]!.reason, "metric-crossed");
    assert.equal(detail.occurrences[0]!.facts.observedAt, 2);
  });

  it("metric every: re-arms across crossings but never repeats on a held condition", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const registered = await f.service.register(caller(), {
      instruction: "each crossing",
      source: { every: true, kind: "metric", machineId: "local", metric: "cpuPercent", predicate: "above", threshold: 90 },
    });
    emitSample(f.harness, { machineId: "local", observedAt: 1, usage: { cpuPercent: 95 } });
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    assert.equal((await f.service.get(caller(), { id: registered.followUp.id })).followUp.status, "waiting");

    // Still above — no edge, no wake.
    emitSample(f.harness, { machineId: "local", observedAt: 2, usage: { cpuPercent: 97 } });
    await pause(120);
    assert.equal(f.harness.continued.length, 1);

    // Release then cross again → second occurrence.
    emitSample(f.harness, { machineId: "local", observedAt: 3, usage: { cpuPercent: 40 } });
    await pause(80);
    emitSample(f.harness, { machineId: "local", observedAt: 4, usage: { cpuPercent: 96 } });
    await until(() => f.harness.continued.length === 2, 4_000, f.harness.errors);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 2);
    assert.equal(detail.occurrences[1]!.facts.observedAt, 4);
  });

  it("buffers metric transitions during delivery and re-primes before waiting again", async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let deliveries = 0;
    const f = await fixture({
      seed: (h) => h.threads.set("t-1", settledThread()),
      continueRun: async () => {
        deliveries += 1;
        if (deliveries === 1) await firstDelivery;
        return { runId: `run-${deliveries}` };
      },
    });
    const registered = await f.service.register(caller(), {
      instruction: "observe crossings during delivery",
      source: { every: true, kind: "metric", machineId: "local", metric: "cpuPercent", predicate: "above", threshold: 90 },
    });
    emitSample(f.harness, { machineId: "local", observedAt: 1, usage: { cpuPercent: 95 } });
    await until(() => f.harness.continued.length === 1, 4_000, f.harness.errors);
    emitSample(f.harness, { machineId: "local", observedAt: 2, usage: { cpuPercent: 20 } });
    emitSample(f.harness, { machineId: "local", observedAt: 3, usage: { cpuPercent: 96 } });
    await pause(50);
    releaseFirst();
    await until(() => f.harness.continued.length === 2, 4_000, f.harness.errors);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences.length, 2);
    assert.equal(detail.occurrences[1]!.facts.observedAt, 3);
  });

  it("log source: incremental match fires with byte offset; eof without match reports exhausted", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.logs.set("attempt-1:stdout", "booting\nstill working\n");
    } });
    const registered = await f.service.register(caller(), {
      instruction: "server is up",
      source: { attemptId: "attempt-1", kind: "log", pattern: "READY" },
    });
    assert.equal(registered.firedImmediately, false);
    assert.equal(registered.followUp.status, "waiting");

    f.harness.logs.set("attempt-1:stdout", "booting\nstill working\nREADY on :8080\n");
    emitAttempt(f.harness, "ws", "attempt-1", attemptView({ state: "running" }));
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const occurrences = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences;
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]!.reason, "log-match");
    assert.equal(occurrences[0]!.facts.offset, Buffer.byteLength("booting\nstill working\n"));

    // A wait whose pattern never appears ends honestly at eof.
    const exhausted = await f.service.register(caller(), {
      instruction: "never appears",
      source: { attemptId: "attempt-1", kind: "log", pattern: "NONEXISTENT", stream: "stderr" },
    });
    f.harness.logEof.set("attempt-1:stderr", true);
    emitAttempt(f.harness, "ws", "attempt-1", attemptView({ collection: "done", state: "completed" }));
    await until(async () => (await f.service.get(caller(), { id: exhausted.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const exhaustedOcc = (await f.service.get(caller(), { id: exhausted.followUp.id })).occurrences;
    assert.equal(exhaustedOcc[0]!.reason, "log-exhausted");
  });

  it("log source: preserves overlap across appended bytes and read pages", async () => {
    const boundaryPrefix = `${"x".repeat(256 * 1024 - 2)}RE`;
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.logs.set("attempt-1:stdout", boundaryPrefix);
    } });
    const appended = await f.service.register(caller(), {
      instruction: "match the appended suffix",
      source: { attemptId: "attempt-1", kind: "log", pattern: "READY" },
    });
    f.harness.logs.set("attempt-1:stdout", `${boundaryPrefix}ADY`);
    emitAttempt(f.harness, "ws", "attempt-1", attemptView({ state: "running" }));
    await until(async () => (await f.service.get(caller(), { id: appended.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal((await f.service.get(caller(), { id: appended.followUp.id })).occurrences[0]!.facts.offset, boundaryPrefix.length - 2);

    // The same literal crossing a 256 KiB reader page must be found in one drain.
    const paged = await f.service.register(caller(), {
      instruction: "match across pages",
      source: { attemptId: "attempt-1", kind: "log", pattern: "READY" },
    });
    assert.equal(paged.followUp.status, "delivered");
    assert.equal((await f.service.get(caller(), { id: paged.followUp.id })).occurrences[0]!.facts.offset, boundaryPrefix.length - 2);
  });

  it("log source: drains a terminal log beyond the old per-event page cap", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.logs.set("attempt-1:stdout", "");
    } });
    const registered = await f.service.register(caller(), {
      instruction: "find the late terminal marker",
      source: { attemptId: "attempt-1", kind: "log", pattern: "READY" },
    });
    f.harness.logs.set("attempt-1:stdout", `${"x".repeat(64 * 256 * 1024 + 1)}READY`);
    emitAttempt(f.harness, "ws", "attempt-1", attemptView({ collection: "done", state: "completed" }));
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const occurrence = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences[0]!;
    assert.equal(occurrence.reason, "log-match");
    assert.equal(occurrence.facts.offset, 64 * 256 * 1024 + 1);
  });

  it("external source: adapter match fires; unregistered provider stays honest", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.external.set("github-pr", {
        intervalMs: 60_000,
        query: async () => ({
          eventId: "github-pr-42-merged",
          facts: { branch: "main", pr: { number: 42, state: "merged" } },
          matched: true,
        }),
      });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "PR merged — continue",
      source: { condition: "merged", kind: "external", provider: "github-pr" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const occurrences = (await f.service.get(caller(), { id: registered.followUp.id })).occurrences;
    assert.equal(occurrences[0]!.reason, "external-match");
    assert.equal(occurrences[0]!.facts.provider, "github-pr");

    // An unregistered provider is rejected at the boundary — no record, no wait.
    await assert.rejects(
      f.service.register(caller(), {
        instruction: "wait on bogus",
        // @ts-expect-error — invalid provider rejected at the boundary
        source: { condition: "open", kind: "external", provider: "bogus" },
      }),
      /not a registered adapter/,
    );
  });

  it("external source: polling survives an independent fallback deadline timer", async () => {
    vi.useFakeTimers();
    try {
      let queries = 0;
      const f = await fixture({ seed: (h) => {
        h.threads.set("t-1", settledThread());
        h.external.set("github-pr", {
          intervalMs: 5_000,
          query: async () => {
            queries += 1;
            return queries === 1
              ? { facts: {}, matched: false }
              : { eventId: "github-pr-42-open", facts: { number: 42 }, matched: true };
          },
        });
      } });
      const registered = await f.service.register(caller(), {
        instruction: "PR opened",
        source: { condition: "open", fallbackAt: Date.now() + 60_000, kind: "external", provider: "github-pr" },
      });
      assert.equal(registered.followUp.status, "waiting");
      await vi.advanceTimersByTimeAsync(5_000);
      const detail = await f.service.get(caller(), { id: registered.followUp.id });
      assert.ok(queries >= 2);
      assert.equal(detail.followUp.status, "delivered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("external source unavailable marks the wait unavailable", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.external.set("github-pr", {
        intervalMs: 60_000,
        query: async () => ({ facts: { reason: "github not connected" }, matched: false, unavailable: true }),
      });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "PR check",
      source: { condition: "open", kind: "external", provider: "github-pr" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "unavailable", 4_000, f.harness.errors);
    assert.equal(f.harness.continued.length, 0);
  });

  it("combines ordinary sources with any/all and hides durable child definitions", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const any = await f.service.register(caller(), {
      instruction: "first signal wins",
      source: {
        kind: "any",
        sources: [{ kind: "file", condition: "exists", path: "out/combined.txt" }, { kind: "time", at: Date.now() + 60_000 }],
      },
    });
    f.harness.files.set("ws:out/combined.txt", { exists: true, size: 1, mtimeMs: 1 });
    emitFile(f.harness, "ws", "out/combined.txt", "created", 1);
    await until(async () => (await f.service.get(caller(), { id: any.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);

    const all = await f.service.register(caller(), {
      instruction: "both signals arrived",
      source: {
        kind: "all",
        sources: [{ kind: "time", at: Date.now() - 1 }, { kind: "manual", note: "approval" }],
      },
    });
    assert.equal(all.followUp.status, "waiting");
    await f.service.fire(caller(), { id: all.followUp.id, reason: "approved" });
    await until(async () => (await f.service.get(caller(), { id: all.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const visible = await f.service.list(caller(), { includeInactive: true });
    assert.equal(visible.followUps.filter((entry) => entry.id === any.followUp.id || entry.id === all.followUp.id).length, 2);
    assert.ok(visible.followUps.every((entry) => !entry.id.includes(":source:")));
  });

  it("uses durable shell lifecycle facts and persists only compact output matches", async () => {
    const started: FollowUpShellEvent = {
      id: 1, type: "shell-start", sessionId: "s-1", workspaceId: "ws", executionId: "exec-1",
      at: Date.now(), state: "running", command: "long build", cwd: "C:/ws",
    };
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.shellEvents.set("s-1:exec-1", [started]);
      h.shellRuntime.set("s-1:exec-1", { running: true });
    } });
    const output = await f.service.register(caller(), {
      instruction: "service ready",
      source: { kind: "shell", executionId: "exec-1", condition: "output", pattern: "READY" },
    });
    f.harness.shellOutput.set("s-1:exec-1", { text: "boot\nREADY\n", running: true });
    const transient: FollowUpShellEvent = { ...started, id: 0, type: "shell-output", offset: 0, text: "boot\nREADY\n" };
    for (const listener of [...f.harness.shellListeners]) listener(transient);
    await until(async () => (await f.service.get(caller(), { id: output.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    assert.equal((await f.service.get(caller(), { id: output.followUp.id })).occurrences[0]!.reason, "shell-output-match");

    const exit = await f.service.register(caller(), {
      instruction: "build finished",
      source: { kind: "shell", executionId: "exec-1", condition: "exit" },
    });
    const completed: FollowUpShellEvent = { ...started, id: 2, type: "shell-completion", state: "completed", exitCode: 0 };
    f.harness.shellEvents.set("s-1:exec-1", [started, completed]);
    f.harness.shellRuntime.set("s-1:exec-1", { running: false, exitCode: 0 });
    for (const listener of [...f.harness.shellListeners]) listener(completed);
    await until(async () => (await f.service.get(caller(), { id: exit.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);

    f.harness.shellEvents.set("s-1:exec-lost", [{ ...started, executionId: "exec-lost", id: 3 }]);
    const lost = await f.service.register(caller(), {
      instruction: "cannot reattach",
      source: { kind: "shell", executionId: "exec-lost", condition: "exit" },
    });
    assert.equal(lost.followUp.status, "unavailable");
  });

  it("reads output that existed before an ordinary shell follow-up was registered", async () => {
    const started: FollowUpShellEvent = {
      id: 1,
      type: "shell-start",
      sessionId: "s-1",
      workspaceId: "ws",
      executionId: "exec-existing",
      at: Date.now(),
      state: "running",
      command: "serve",
      cwd: "/workspace",
    };
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.shellEvents.set("s-1:exec-existing", [started]);
      h.shellRuntime.set("s-1:exec-existing", { running: true });
      h.shellOutput.set("s-1:exec-existing", { text: "booting\nREADY\n", running: true });
    } });
    const registered = await f.service.register(caller(), {
      instruction: "service ready",
      source: { kind: "shell", executionId: "exec-existing", condition: "output", pattern: "READY" },
    });
    await until(async () => (await f.service.get(caller(), { id: registered.followUp.id })).followUp.status === "delivered", 4_000, f.harness.errors);
    const detail = await f.service.get(caller(), { id: registered.followUp.id });
    assert.equal(detail.occurrences[0]!.reason, "shell-output-match");
    assert.equal(detail.occurrences[0]!.facts.offset, 8);
  });

  it("shares a workspace file observer and releases it after the last subscriber", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const first = await f.service.register(caller(), {
      instruction: "first", source: { kind: "file", condition: "changed", path: "out/shared.txt" },
    });
    const second = await f.service.register(caller(), {
      instruction: "second", source: { kind: "file", condition: "changed", path: "out/shared.txt" },
    });
    assert.equal(f.harness.fileWatchListeners.get("ws")?.length, 1);
    await f.service.cancel(caller(), { id: first.followUp.id });
    assert.equal(f.harness.fileWatchListeners.get("ws")?.length, 1);
    await f.service.cancel(caller(), { id: second.followUp.id });
    assert.equal(f.harness.fileWatchListeners.get("ws")?.length, 0);

    const metricA = await f.service.register(caller(), {
      instruction: "metric a", source: { kind: "metric", machineId: "local", metric: "cpuPercent", predicate: "above", threshold: 90 },
    });
    const metricB = await f.service.register(caller(), {
      instruction: "metric b", source: { kind: "metric", machineId: "local", metric: "cpuPercent", predicate: "above", threshold: 95 },
    });
    assert.equal(f.harness.sampleListeners.length, 1);
    await f.service.cancel(caller(), { id: metricA.followUp.id });
    await f.service.cancel(caller(), { id: metricB.followUp.id });
    assert.equal(f.harness.sampleListeners.length, 0);

    f.harness.experiments.set("attempt-shared", { attempt: attemptView({ attemptId: "attempt-shared" }), artifacts: [] });
    const artifactA = await f.service.register(caller(), {
      instruction: "artifact a", source: { kind: "artifact", attemptId: "attempt-shared", name: "a" },
    });
    const artifactB = await f.service.register(caller(), {
      instruction: "artifact b", source: { kind: "artifact", attemptId: "attempt-shared", name: "b" },
    });
    assert.equal(f.harness.attemptListeners.length, 1);
    await f.service.cancel(caller(), { id: artifactA.followUp.id });
    await f.service.cancel(caller(), { id: artifactB.followUp.id });
    assert.equal(f.harness.attemptListeners.length, 0);
  });

  it("coalesces compatible external queries into one in-flight adapter call", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let queries = 0;
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.external.set("github-pr", {
        intervalMs: 60_000,
        query: async () => { queries += 1; await blocked; return { facts: {}, matched: false }; },
      });
    } });
    const first = f.service.register(caller(), {
      instruction: "first query", source: { kind: "external", provider: "github-pr", condition: "open", branch: "main" },
    });
    await until(() => queries === 1);
    const second = f.service.register(caller(), {
      instruction: "second query", source: { kind: "external", provider: "github-pr", condition: "open", branch: "main" },
    });
    await pause(50);
    assert.equal(queries, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    await f.service.cancel(caller(), { id: a.followUp.id });
    await f.service.cancel(caller(), { id: b.followUp.id });
  });

  it("rejects path escapes and invalid source fields at the boundary", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    await assert.rejects(
      f.service.register(caller(), { instruction: "x", source: { condition: "exists", kind: "file", path: "../escape.txt" } }),
      /workspace-relative/,
    );
    await assert.rejects(
      f.service.register(caller(), { instruction: "x", source: { condition: "exists", kind: "file", path: "C:\\abs.txt" } }),
      /workspace-relative/,
    );
    await assert.rejects(
      f.service.register(caller(), { instruction: "x", source: { kind: "metric", machineId: "local", metric: "bogus", predicate: "above", threshold: 1 } }),
      /metric source metric/,
    );
    await assert.rejects(
      f.service.register(caller(), { instruction: "x", source: { attemptId: "a", kind: "log", pattern: "([", regex: true } }),
      /regular expression/,
    );
    await assert.rejects(
      f.service.register(caller({ workspaceScope: ["packages/allowed"] }), {
        instruction: "scope escape",
        source: { condition: "exists", kind: "file", path: "packages/private/result.txt" },
      }),
      /outside the actor scope/,
    );
    const scoped = await f.service.register(caller({ workspaceScope: ["packages/allowed"] }), {
      instruction: "inside scope",
      source: { condition: "changed", kind: "file", path: "packages/allowed/result.txt" },
    });
    await assert.rejects(
      f.service.update(caller({ workspaceScope: ["packages/allowed"] }), {
        id: scoped.followUp.id,
        source: { condition: "changed", kind: "file", path: "packages/private/result.txt" },
      }),
      /outside the actor scope/,
    );
  });

  it("reconcile rebuilds file and metric observers after restart", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    const fileWait = await f.service.register(caller(), {
      instruction: "file changed while the observer was down",
      source: { condition: "changed", kind: "file", path: "out/flag" },
    });
    const metricWait = await f.service.register(caller(), {
      instruction: "cpu hot",
      source: { kind: "metric", machineId: "local", metric: "cpuPercent", predicate: "above", threshold: 95 },
    });
    assert.equal(fileWait.followUp.status, "waiting");
    assert.equal(metricWait.followUp.status, "waiting");

    // Restart: a new service instance over the same kernel rebuilds observers.
    const harness2: Harness = {
      ...f.harness,
      attemptListeners: [],
      continued: [],
      errors: [],
      fileWatchListeners: new Map(),
      informs: [],
      ledger: [],
      parked: [],
      sampleListeners: [],
      sessionRequests: [],
    };
    const service2 = createFollowUpService({
      client: f.client,
      getThread: async (_ws, threadId) => harness2.threads.get(threadId) ?? null,
      notifySession: async () => {},
      sessionRequest: async () => {},
      sessionBusy: async () => false,
      sendToThread: async (input) => {
        harness2.continued.push({ requestId: input.requestId, task: input.text, threadId: input.threadId });
        return { delivery: "continued", runId: "run-2" };
      },
      setFollowUpAttention: async () => ({}),
      requestForSession: async () => ({}),
      getExperiment: async (_c, attemptId) => harness2.experiments.get(attemptId) ?? null,
      readExperimentLog: async (_c, params) => {
        const key = `${params.attemptId}:${params.stream ?? "stdout"}`;
        const bytes = Buffer.from(harness2.logs.get(key) ?? "", "utf8");
        const start = Math.min(Math.max(0, params.offset ?? 0), bytes.length);
        const slice = bytes.subarray(start, start + (params.maxBytes ?? 64 * 1024));
        return { eof: harness2.logEof.get(key) === true, nextOffset: start + slice.byteLength, offset: start, text: slice.toString("utf8") };
      },
      watchWorkspace: (workspaceId, listener) => {
        const listeners = harness2.fileWatchListeners.get(workspaceId) ?? [];
        listeners.push(listener);
        harness2.fileWatchListeners.set(workspaceId, listeners);
        return { close: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); }, ready: Promise.resolve(true) };
      },
      statWorkspaceFile: async (workspaceId, filePath) => harness2.files.get(`${workspaceId}:${filePath}`) ?? { exists: false },
      workspaceHasActiveWriters: async (workspaceId) => harness2.activeWriters.has(workspaceId),
      subscribeResourceSamples: (listener) => {
        harness2.sampleListeners.push(listener);
        return () => { const i = harness2.sampleListeners.indexOf(listener); if (i >= 0) harness2.sampleListeners.splice(i, 1); };
      },
      getResourceSample: async (machineId) => harness2.samples.get(machineId) ?? null,
      externalSource: (provider) => harness2.external.get(provider) ?? null,
      onError: (error) => harness2.errors.push(error),
    });
    harness2.files.set("ws:out/flag", { exists: true, mtimeMs: 5, size: 1 });
    await service2.reconcile("ws");
    emitSample(harness2, { machineId: "local", observedAt: 10, usage: { cpuPercent: 99 } });
    await until(() => harness2.continued.length === 2, 4_000, harness2.errors);
    service2.dispose();
  });

  it("definitionWorkspaces enumerates owning workspaces through the kernel", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    assert.deepEqual(await f.service.definitionWorkspaces(), []);
    await f.service.register(caller(), {
      instruction: "later",
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    assert.deepEqual(await f.service.definitionWorkspaces(), ["ws"]);
    const otherSession = { ...sessionCaller(), sessionId: "s-2", rootSessionId: "s-2" };
    await f.service.register(otherSession, { instruction: "root wait", source: { kind: "manual" } });
    const overview = await f.service.listForHost({ includeInactive: true });
    assert.equal(overview.followUps.length, 2);
    assert.equal((await f.service.list(caller(), {})).followUps.length, 1);
    assert.equal((await f.service.list(otherSession, {})).followUps.length, 1);
  });

  it("settleTarget cancels waits whose thread or session is gone", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.threads.set("t-other", { ...settledThread(), id: "t-other" });
      h.goals.set("s-1", { id: "g-1", status: "active" });
    } });
    const threadWait = await f.service.register(caller(), {
      instruction: "thread wait",
      pause: true,
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    const sessionWait = await f.service.register(sessionCaller(), {
      instruction: "session wait",
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    const otherWait = await f.service.register(
      caller({ sessionId: "s-other", threadId: "t-other" }),
      { instruction: "other wait", source: { at: Date.now() + 60_000, kind: "time" } },
    );
    assert.equal(f.harness.goals.get("s-1")?.status, "paused");

    const settledThreads = await f.service.settleTarget("ws", { kind: "thread", id: "t-1" });
    assert.equal(settledThreads, 1);
    assert.equal((await f.service.get(caller(), { id: threadWait.followUp.id })).followUp.status, "cancelled");
    // The goal this registration paused is resumed; the other wait survives.
    assert.equal(f.harness.goals.get("s-1")?.status, "active");
    assert.equal(f.harness.attention.at(-1)?.waitingFor, null);
    assert.equal((await f.service.get(caller(), { id: sessionWait.followUp.id })).followUp.status, "waiting");

    const settledSessions = await f.service.settleTarget("ws", { kind: "session", id: "s-1" });
    assert.equal(settledSessions, 1);
    assert.equal((await f.service.get(caller(), { id: sessionWait.followUp.id })).followUp.status, "cancelled");
    assert.equal((await f.service.get(caller({ sessionId: "s-other", threadId: "t-other" }), { id: otherWait.followUp.id })).followUp.status, "waiting");
  });

  it("reconcile retries durable thread lifecycle settlement after an archive event is missed", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
    } });
    const wait = await f.service.register(caller(), {
      instruction: "must close with its thread",
      source: { at: Date.now() + 60_000, kind: "time" },
    });
    f.harness.threads.get("t-1")!.lifecycle = "archived";
    await f.service.reconcile("ws");
    assert.equal((await f.service.get(caller(), { id: wait.followUp.id })).followUp.status, "cancelled");
  });
});

describe("desktop source follow-ups (EE)", () => {
  it("fires when the desktop's catalog status transitions into a matching state", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.desktopStatuses.set("managed-linux", "starting");
    } });
    const wait = await f.service.register(caller(), {
      instruction: "the desktop is ready — open the app",
      source: { kind: "desktop", desktopId: "managed-linux", condition: "status", states: ["available"] },
    });
    assert.equal(wait.firedImmediately, false);
    f.harness.desktopStatuses.set("managed-linux", "available");
    await until(() => f.harness.continued.length === 1, 6_000, f.harness.errors);
    assert.equal(f.harness.continued[0]?.threadId, "t-1");
    assert.match(f.harness.continued[0]?.task ?? "", /desktop/);
    const view = (await f.service.get(caller(), { id: wait.followUp.id }));
    assert.equal(view.occurrences[0]?.reason, "desktop-status");
    assert.equal(view.occurrences[0]?.facts.status, "available");
  });

  it("a status poll observes the real transition, never a guessed state", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      // Absent from the catalog → status null → never satisfies.
    } });
    const wait = await f.service.register(caller(), {
      instruction: "report when reachable",
      source: { kind: "desktop", desktopId: "remote:r1:h:d0", condition: "status", states: ["available"] },
    });
    assert.equal(wait.firedImmediately, false);
    const check = await f.service.check(caller(), { id: wait.followUp.id });
    assert.equal(check.fired, false);
    assert.equal((check.observed as Record<string, unknown> | undefined)?.status, null);
  });

  it("fires on a new managed-desktop file revision and keeps the revision as provenance", async () => {
    const sha256 = "b".repeat(64);
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.desktopFiles.set("managed-linux:Downloads/report.csv", sha256);
    } });
    const wait = await f.service.register(caller(), {
      instruction: "the export landed — collect it",
      source: { kind: "desktop", desktopId: "managed-linux", condition: "artifact", path: "Downloads/report.csv" },
    });
    // Present at registration → the prime check fires immediately.
    assert.equal(wait.firedImmediately, true);
    await until(() => f.harness.continued.length === 1, 6_000, f.harness.errors);
    const view = await f.service.get(caller(), { id: wait.followUp.id });
    assert.equal(view.occurrences[0]?.facts.sha256, sha256);
    assert.equal(view.occurrences[0]?.facts.path, "Downloads/report.csv");
  });

  it("waits for a different revision when a baseline sha256 is bound", async () => {
    const f = await fixture({ seed: (h) => {
      h.threads.set("t-1", settledThread());
      h.desktopFiles.set("managed-linux:out.json", "a".repeat(64));
    } });
    const wait = await f.service.register(caller(), {
      instruction: "content moved past the registered revision",
      source: { kind: "desktop", desktopId: "managed-linux", condition: "artifact", path: "out.json", sha256: "a".repeat(64) },
    });
    assert.equal(wait.firedImmediately, false);
    f.harness.desktopFiles.set("managed-linux:out.json", "c".repeat(64));
    await until(() => f.harness.continued.length === 1, 6_000, f.harness.errors);
    const view = await f.service.get(caller(), { id: wait.followUp.id });
    assert.equal(view.occurrences[0]?.facts.previousSha256, "a".repeat(64));
  });

  it("rejects malformed desktop sources instead of arming a dead wait", async () => {
    const f = await fixture({ seed: (h) => h.threads.set("t-1", settledThread()) });
    await assert.rejects(() => f.service.register(caller(), {
      instruction: "x", source: { kind: "desktop", desktopId: "", condition: "status", states: ["available"] },
    }), /desktopId/);
    await assert.rejects(() => f.service.register(caller(), {
      instruction: "x", source: { kind: "desktop", desktopId: "d", condition: "status" },
    }), /states/);
    await assert.rejects(() => f.service.register(caller(), {
      instruction: "x", source: { kind: "desktop", desktopId: "d", condition: "artifact", path: "../escape" },
    }), /relative/);
    await assert.rejects(() => f.service.register(caller(), {
      instruction: "x", source: { kind: "desktop", desktopId: "d", condition: "artifact", path: "p", sha256: "zz" },
    }), /sha256/);
  });
});
