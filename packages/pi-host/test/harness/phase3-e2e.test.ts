/** Thread tools through bridge → trusted router → durable Thread/ThreadRun registry. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadRegistry, type ThreadReport } from "../../../web/application-host/lib/harness/thread-registry.js";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import {
  createDispatchTool,
  createKillTool,
  createMergeTool,
  createReadThreadTool,
  createThreadsTool,
  createWaitTool,
} from "../../src/harness/thread-tools.js";
import { resolvePresets } from "@varin/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "p3-e2e-session";
const WORKSPACE_ID = "p3-e2e-workspace";
const PARENT = { kind: "session", id: SESSION_ID } as const;
const ACTOR = { authorityInstanceId: "test-authority", sessionId: SESSION_ID, workerId: "test-worker", workerGeneration: 1 } as const;
const CAPABILITIES = ["context.session", "control.thread", "read.lsp", "read.output"] as const;
const TEST_MAIN_MODEL = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const TEST_PRESETS = resolvePresets({ worker: TEST_MAIN_MODEL }, TEST_MAIN_MODEL);

const threadInput = (brief: string) => ({
  scopeId: WORKSPACE_ID,
  parent: PARENT,
  brief,
  preset: "worker",
  kind: "implementation" as const,
  createdBy: "agent" as const,
  concurrency: 12,
  autoRun: true,
  worktree: "isolated" as const,
  tools: [] as string[],
  permissions: {},
});

const report = (conclusion = "all tests pass"): ThreadReport => ({
  conclusion,
  changedFiles: ["test.ts"],
  unresolved: [],
  deviations: [],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: "entry-1", toEntryId: "entry-2" },
  blocksSnapshot: {},
});

async function setup(options: { transportTimeoutMs?: number; artifactBody?: Buffer } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p3-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "p3-e2e-data-"));
  const threadRegistry = createThreadRegistry({ dataDir, hostId: "test-host" });
  let sessionCounter = 0;
  let mergeCalls = 0;
  const sent: Array<{ sessionId: string; message: string }> = [];
  const artifactSliceReads: Array<{ offset: number; length: number }> = [];
  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    pathAuthority: createHarnessPathAuthority({ authorityId: ACTOR.authorityInstanceId,
      documents: { getWorkspace: async () => ({ root: workspaceRoot }) } }),
    discoveredShells: { hasBash: process.platform !== "win32", hasPowerShell: process.platform === "win32" },
    threadRegistry,
    threadPrepareIsolatedBranch: async (input) => ({
      branchId: `branch-${input.threadId}`,
      worktree: { path: "/tmp/scratch", base: "zero-commit", viewMode: "virtual", materialized: false },
    }),
    threadSpawnSession: async (input) => {
      const sessionId = `child-session-${++sessionCounter}`;
      await threadRegistry.markRunRunning(input.scopeId, input.threadId, input.runId, sessionId);
      return { sessionId };
    },
    threadKillSession: async () => {},
    threadApplyWorktreeDiff: async () => { mergeCalls += 1; return { merged: 3, conflicts: [] }; },
    threadSendToSession: async (sessionId, message) => { sent.push({ sessionId, message }); },
    threadTranscriptReader: {
      read: async (ref, since = 0) => `[entries ${since + 1}–2 of 2]\n${ref.sessionId}: durable transcript`,
    },
    ...(options.artifactBody ? {
      readRetrievalArtifactSlice: async (_workspaceId: string, _artifact: unknown, offset: number, length: number) => {
        artifactSliceReads.push({ offset, length });
        return options.artifactBody!.subarray(offset, offset + length);
      },
    } : {}),
    zone2Provider: async () => ({
      eventCursor: 0,
      material: {
        userEdits: [],
        userCommands: [],
        newDiagnostics: [],
        git: null,
        knowledge: [],
        blocks: [],
        contextUsage: null,
      },
    }),
  });
  harnessServiceHost.registerSession({
    actor: ACTOR, grantedCapabilities: CAPABILITIES, workspaceId: WORKSPACE_ID, workspaceRoot,
  });

  const router = createHarnessRouter({
    respond: async (identity, requestId, outcome) => { bridge.respond(identity.sessionId, requestId, outcome); },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    ...(options.transportTimeoutMs !== undefined ? { defaultTimeoutMs: options.transportTimeoutMs } : {}),
  });
  registerHarnessServices(router, harnessServiceHost);
  const emittedRequests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      emittedRequests.push({ method: data.method, params: data.params, ...(data.timeoutMs === undefined ? {} : { timeoutMs: data.timeoutMs }) });
      void router.processEvent({ actor: ACTOR, kind: "host", envelope: { kind: "event", event: "harness.request", data } });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: options.transportTimeoutMs ?? 10_000,
  });

  const dispose = async () => {
    bridge.dispose();
    router.dispose();
    await harnessServiceHost.dispose();
    await threadRegistry.dispose();
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  };
  return { bridge, threadRegistry, sent, emittedRequests, artifactSliceReads, getMergeCalls: () => mergeCalls, dispose };
}

async function executeTool(tool: ToolDefinition, params: Record<string, unknown>) {
  const result = await tool.execute(`test-call-${++toolCallSequence}`, params as never, undefined, undefined, undefined as never) as {
    content: Array<{ type: string; text: string }>;
    details?: unknown;
    isError?: boolean;
  };
  return {
    text: result.content.map((part) => part.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

let toolCallSequence = 0;

describe("Phase 3 Thread/ThreadRun e2e", () => {
  it("returns the reviewed conflict binding to the model and forwards a bound choice", async () => {
    const fingerprint = "a".repeat(64);
    const requests: unknown[] = [];
    const bridge = new HostServicesBridge({
      sessionId: SESSION_ID,
      emit: (_event, request) => {
        requests.push(request.params);
        bridge.respond(SESSION_ID, request.requestId, { ok: true, result: {
          text: "Conflict in a.ts", merged: 0, conflicts: ["a.ts"], status: "conflict",
          preview: {
            operationId: "integration-1", threadId: "thread-1", resultRevision: 2,
            bindingFingerprint: fingerprint, valid: true, mergeReady: false,
            binding: { "a.ts": { target: "disk", revision: "reviewed-parent" } },
            paths: [{ path: "a.ts", target: "disk", decision: "conflict", phase: "pending", isText: false }],
            conflictPaths: ["a.ts"], surfaceTargetPaths: [], unavailablePaths: [], appliedPaths: [],
          },
        } });
      },
    });
    try {
      const tool = createMergeTool(bridge, SESSION_ID);
      const first = await executeTool(tool, { threadId: "thread-1" });
      const binding = JSON.parse(first.text.slice(first.text.indexOf('{'))) as {
        resultRevision: number; expectedBindingFingerprint: string; paths: Array<{ path: string; expectedParentRevision: string }>;
      };
      assert.equal(binding.expectedBindingFingerprint, fingerprint);
      assert.equal(binding.paths[0]?.expectedParentRevision, "reviewed-parent");
      const resolution = { path: "a.ts", choice: "child", expectedParentRevision: "reviewed-parent" };
      await executeTool(tool, { threadId: "thread-1", resultRevision: binding.resultRevision,
        expectedBindingFingerprint: binding.expectedBindingFingerprint, resolutions: [resolution] });
      assert.deepEqual(requests[1], { threadId: "thread-1", resultRevision: 2,
        expectedBindingFingerprint: fingerprint, resolutions: [resolution] });
    } finally {
      bridge.dispose();
    }
  });

  it("forwards public merge cancellation to the Host bridge", async () => {
    const cancelled: Array<{ requestId?: string; queryId?: string }> = [];
    const bridge = new HostServicesBridge({
      sessionId: SESSION_ID,
      emit: (event, request) => { if (String(event) === "harness.cancel") cancelled.push(request); },
    });
    const controller = new AbortController();
    try {
      const result = createMergeTool(bridge, SESSION_ID).execute(
        "merge-cancel", { threadId: "thread-1" }, controller.signal, undefined, undefined as never,
      );
      controller.abort();
      assert.equal((await result as { isError?: boolean }).isError, true);
      assert.equal(cancelled.length, 1);
      assert.equal(typeof cancelled[0]?.requestId, "string");
    } finally {
      bridge.dispose();
    }
  });

  it("dispatch creates a Thread and a running attempt", async () => {
    const harness = await setup();
    try {
      const result = await executeTool(createDispatchTool(harness.bridge, SESSION_ID, TEST_PRESETS), {
        preset: "worker",
        task: "run tests",
      });
      assert.match(result.text, /dispatched/);
      const threadId = (result.details as { threadId: string }).threadId;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await harness.threadRegistry.getActiveRun(WORKSPACE_ID, threadId))?.workerState === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const thread = await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, threadId);
      const run = await harness.threadRegistry.getActiveRun(WORKSPACE_ID, threadId);
      assert.equal(thread?.lifecycle, "active");
      assert.equal(run?.attempt, 1);
      assert.equal(run?.workerState, "running");
      assert.match(run?.sessionId ?? "", /^child-session-/);
    } finally {
      await harness.dispose();
    }
  });

  it("threads lists orthogonal state and becomes incremental", async () => {
    const harness = await setup();
    try {
      await harness.threadRegistry.createThread(threadInput("queued work"));
      const tool = createThreadsTool(harness.bridge, SESSION_ID);
      const first = await executeTool(tool, {});
      const second = await executeTool(tool, {});
      assert.match(first.text, /queued/);
      assert.match(second.text, /no changes since last view/);
    } finally {
      await harness.dispose();
    }
  });

  it("projects active and newly settled threads into the parent Zone 2", async () => {
    const harness = await setup();
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("zone2 work"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await harness.threadRegistry.updateRunProgress(WORKSPACE_ID, thread.id, {
        steps: 2,
        lastToolCall: { name: "read", at: new Date().toISOString() },
      });

      const active = await harness.bridge.request("zone2.status", {});
      assert.equal(active.status, "ready");
      assert.match(active.content ?? "", /<varin-status/);
      assert.match(active.content ?? "", new RegExp(`${thread.id}.*zone2 work.*working`));

      await harness.threadRegistry.completeThread(WORKSPACE_ID, thread.id, report("zone2 complete"));
      const current = await harness.bridge.request("zone2.status", {});
      assert.equal(current.status, "ready");
      assert.match(current.content ?? "", new RegExp(`${thread.id}.*success`));
      assert.doesNotMatch(current.content ?? "", /zone2 complete/, "result bodies stay out of the transient roster");
      const completed = await harness.bridge.request("zone2.assemble", { sinceTurn: 1, branchEntryIds: [] });
      assert.match(completed.content ?? "", /<thread-result[^>]*>conclusion: zone2 complete<\/thread-result>/);
      assert.ok(completed.deliveryId);
      await harness.bridge.request("zone2.delivered", { deliveryId: completed.deliveryId });
      const unchanged = await harness.bridge.request("zone2.assemble", { sinceTurn: 2, branchEntryIds: [] });
      assert.equal(unchanged.content, null);

      await harness.bridge.request("context.retained", { retainedObservationRefs: [], retainedGit: false });
      const reset = await harness.bridge.request("zone2.assemble", { sinceTurn: 3, branchEntryIds: [] });
      assert.match(reset.content ?? "", /<thread-result[^>]*>conclusion: zone2 complete<\/thread-result>/);
    } finally {
      await harness.dispose();
    }
  });

  it("wait timeout is a normal result and outlives a smaller transport default", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("long runner"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await executeTool(createThreadsTool(harness.bridge, SESSION_ID), {});
      const started = Date.now();
      const result = await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 600 });
      assert.ok(Date.now() - started >= 500);
      assert.equal(result.isError, false);
      assert.equal((result.details as { timedOut: boolean }).timedOut, true);
    } finally {
      await harness.dispose();
    }
  });

  it("wait wakes on attention and preserves the question", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("ask"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await executeTool(createThreadsTool(harness.bridge, SESSION_ID), {});
      const timer = setTimeout(() => {
        void harness.threadRegistry.setAttention(WORKSPACE_ID, thread.id, "user", { kind: "user", text: "Which config?" });
      }, 100);
      const result = await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 2_000 });
      clearTimeout(timer);
      assert.equal((result.details as { timedOut: boolean }).timedOut, false);
      assert.match(result.text, /waiting for user/);
      assert.match(result.text, /Which config/);
    } finally {
      await harness.dispose();
    }
  });

  it("read_thread and merge use the settled run plus Thread integration", async () => {
    const harness = await setup();
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("finish"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await harness.threadRegistry.completeThread(WORKSPACE_ID, thread.id, report("completed successfully"));
      const readResult = await executeTool(createReadThreadTool(harness.bridge, SESSION_ID), { threadId: thread.id, what: "report" });
      assert.match(readResult.text, /completed successfully/);
      const steps = await executeTool(createReadThreadTool(harness.bridge, SESSION_ID), { threadId: thread.id, what: "steps", since: 1 });
      assert.match(steps.text, /child-1: durable transcript/);
      const unpublished = await executeTool(createMergeTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.equal(unpublished.isError, true);
      assert.match(unpublished.text, /no published code revision/);
      assert.equal(harness.getMergeCalls(), 0);
      await harness.threadRegistry.setWorkingState(WORKSPACE_ID, thread.id, { branchId: `branch-${thread.id}`, resultRevision: 1 });
      const mergeResult = await executeTool(createMergeTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.match(mergeResult.text, /merged 3 files/);
      assert.equal((await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, thread.id))?.integration, "merged");
      const repeated = await executeTool(createMergeTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.match(repeated.text, /already merged/);
      assert.equal(harness.getMergeCalls(), 1);
    } finally {
      await harness.dispose();
    }
  });

  it("pages a large retrieval artifact through the public read_thread tool", async () => {
    const artifactBody = Buffer.from("公开分页🙂".repeat(20_000), "utf8");
    const harness = await setup({ artifactBody });
    try {
      const thread = await harness.threadRegistry.createThread({
        ...threadInput("large retrieval"),
        preset: "retrieval",
        worktree: "none",
      });
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.setPendingEvidence(WORKSPACE_ID, thread.id, run.id, {
        question: "large retrieval",
        scope: [],
        facts: [{
          claim: "large durable body",
          status: "source-checked",
          sources: [{
            kind: "url",
            url: "https://example.com/large",
            check: "source-valid",
            artifact: { durability: "durable", hash: "sha256-large", byteLength: artifactBody.byteLength, recordId: "artifact:large", recordType: "retrieval.artifact", workspaceId: WORKSPACE_ID },
          }],
        }],
        unknowns: [],
        attempted: [],
        completion: "delivered",
      });
      await harness.threadRegistry.endRun(WORKSPACE_ID, thread.id, run.id, "success");
      const page = await executeTool(createReadThreadTool(harness.bridge, SESSION_ID), {
        threadId: thread.id,
        what: "report",
        offset: 0,
        length: 251,
      });
      assert.ok(Buffer.byteLength(page.text, "utf8") <= 254);
      assert.equal(page.text.includes(artifactBody.toString("utf8")), false);
      assert.deepEqual(page.details, {
        hasReport: true,
        transcriptRef: { runtimeId: "pi", sessionId: "", fromEntryId: null, toEntryId: null },
        nextOffset: Buffer.byteLength(page.text, "utf8"),
        eof: false,
      });
      assert.ok(harness.artifactSliceReads.length <= 1);
      assert.ok(harness.artifactSliceReads.every((read) => read.length <= 257));
    } finally {
      await harness.dispose();
    }
  });

  it("kill ends the current Run instead of rewriting it as an unstarted thread", async () => {
    const harness = await setup();
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("stop"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      const result = await executeTool(createKillTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.match(result.text, /killed/);
      assert.equal((await harness.threadRegistry.getActiveRun(WORKSPACE_ID, thread.id))?.outcome, "cancelled");
      assert.equal((await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, thread.id))?.lifecycle, "settled");
    } finally {
      await harness.dispose();
    }
  });

  it("bounds dependency watching without imposing a second deadline on root-slot readmission", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 50 });
      const request = harness.emittedRequests.find((entry) => entry.method === "thread.wait");
      assert.equal(request?.timeoutMs, 0);
      assert.equal((request?.params as { timeoutMs?: number }).timeoutMs, 50);
    } finally {
      await harness.dispose();
    }
  });
});
