import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage, SessionEntriesResult, SessionSnapshot, SessionStats, SessionSummary } from "@varin/protocol";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadRuntime, type ThreadRuntimeOptions, type ThreadSessionAdapter } from "./thread-runtime.js";
import { createUserThreadSendAdapter } from "./thread-ui-adapter.js";
import { registerHarnessThreadRoutes } from "./thread-routes.js";
import type { HarnessServiceHost } from "./service-host.js";

const WORKSPACE = "workspace-1";
const PARENT = { kind: "session", id: "parent-1" } as const;

const snapshot = (sessionId: string, cwd = "/workspace/thread"): SessionSnapshot => ({
  activeTools: ["read", "edit"],
  busy: false,
  cwd,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: "one-at-a-time",
  isCompacting: false,
  isStreaming: false,
  leafId: "entry-2",
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
  workspace: { authorityId: WORKSPACE, id: WORKSPACE, kind: "workspace" },
});

const summary = (sessionId: string): SessionSummary => ({
  allMessagesText: "",
  createdAt: "2026-09-04T00:00:00.000Z",
  cwd: "/workspace",
  firstMessage: "",
  id: sessionId,
  messageCount: 0,
  persisted: true,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  updatedAt: "2026-09-04T00:00:00.000Z",
});

const stats: SessionStats = {
  cost: 0.25,
  sessionId: "child-1",
  tokens: { cacheRead: 30, cacheWrite: 0, input: 100, output: 20, total: 150 },
  totalMessages: 2,
  toolCalls: 3,
  toolResults: 3,
  assistantMessages: 1,
  userMessages: 1,
};

const assistantMessage = (text: string): PiMessage => ({
  api: "test",
  content: [{ type: "text", text }],
  model: "test-model",
  provider: "test-provider",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const createInput = (): CreateThreadInput => ({
  scopeId: WORKSPACE,
  parent: PARENT,
  brief: "Implement the feature",
  preset: "hard-implement",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  model: { providerId: "test-provider", modelId: "test-model" },
  scope: ["src"],
  tools: ["read", "edit"],
  permissions: {},
  systemPromptFragment: "Work carefully.",
});

/**
 * Public-chain acceptance: the real Express route, the same authenticated
 * UI adapter index.ts injects, the real send service, the real registry,
 * and the real runtime — only the session boundary is a fake adapter.
 */
describe("harness thread public send chain", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;
  let sessionAdapter: ThreadSessionAdapter;
  let runtime: ReturnType<typeof createThreadRuntime>;
  let sent: string[];
  let app: express.Express;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-public-send-"));
    registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    sent = [];
    sessionAdapter = {
      create: vi.fn(async () => snapshot("child-1")),
      open: vi.fn(async (input) => snapshot(input.sessionId, input.cwd)),
      prompt: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      send: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      notify: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      request: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      snapshot: vi.fn(async (sessionId) => snapshot(sessionId, sessionId === "parent-1" ? "/workspace" : "/workspace/thread")),
      summary: vi.fn(async (sessionId) => summary(sessionId)),
      stats: vi.fn(async () => stats),
      entries: vi.fn(async (sessionId, scope = "branch"): Promise<SessionEntriesResult> => ({
        sessionId,
        scope,
        leafId: "entry-2",
        entries: [
          { id: "entry-1", parentId: null, timestamp: "2026-09-04T00:00:00.000Z", type: "message", message: { role: "user", content: "task", timestamp: 0 } },
          { id: "entry-2", parentId: "entry-1", timestamp: "2026-09-04T00:01:00.000Z", type: "message", message: assistantMessage("done") },
        ],
      })),
    };
    runtime = createThreadRuntime({
      registry,
      sessions: sessionAdapter,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      readBlocks: async () => null,
      worktrees: {
        prepare: vi.fn(async (input: { mode: string }) => input.mode === "none"
          ? { cwd: "/workspace", worktree: null }
          : { cwd: "/workspace/thread", worktree: { path: "/workspace/thread", base: "base" } }) as ThreadRuntimeOptions["worktrees"]["prepare"],
        snapshot: async (worktree) => ({ ...worktree, branch: "varin/thread", resultCommit: "result" }),
        inspect: async () => ({ patch: "", untracked: [], changedFiles: ["a.ts"], diffStats: { files: 1, insertions: 2, deletions: 0 } }),
        merge: async () => ({ merged: 1, conflicts: [], conflictState: "none", changedFiles: ["a.ts"], diffStats: { files: 1, insertions: 2, deletions: 0 } }),
      },
    });

    // Use the production adapter, not a test copy of its actor construction.
    const host = {
      threadRegistry: registry,
      threadSendToSession: (sessionId: string, message: string, meta: { from: string; requestId?: string }) =>
        runtime.send(sessionId, message, meta),
      threadContinueRun: (input: Parameters<typeof runtime.continueRun>[0]) => runtime.continueRun(input),
    } as unknown as HarnessServiceHost;

    app = express();
    app.use(express.json());
    registerHarnessThreadRoutes(app, {
      registry,
      runtime,
      sendToThread: createUserThreadSendAdapter(() => host, runtime),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await registry.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async () => {
    const input = createInput();
    const thread = await registry.createThread(input);
    const run = await registry.startRun(WORKSPACE, thread.id);
    await runtime.spawn({ ...input, threadId: thread.id, runId: run.id });
    return { input, thread, run };
  };

  const settle = async () => {
    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_end", messages: [assistantMessage("Done")], willRetry: false } } },
    });
    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_settled" } } },
    });
    await runtime.drain();
  };

  it("delivers a user request to a settled thread through the public route and starts a continued Run", async () => {
    const { thread } = await start();
    await settle();
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.lifecycle).toBe("settled");

    const response = await request(app)
      .post(`/api/harness/sessions/parent-1/threads/${thread.id}/send`)
      .send({ message: "Please tighten the diff", kind: "request", requestId: "ui-req-1" })
      .expect(200);

    expect(response.body.result).toMatchObject({
      accepted: true,
      delivery: "delivered",
      messageId: "ui-req-1",
    });
    expect(typeof response.body.result.runId).toBe("string");
    expect(response.body.thread.lifecycle).toBe("active");
    // Continue mode reopens the retained session instead of creating one.
    expect(sessionAdapter.open).toHaveBeenCalled();
    const inbound = response.body.thread.messages?.find((m: { direction: string }) => m.direction === "in");
    expect(inbound).toMatchObject({ id: "ui-req-1", kind: "request", status: "delivered", from: { kind: "user" } });
  });

  it("delivers a user inform to an active thread through the same session boundary", async () => {
    const { thread } = await start();
    const response = await request(app)
      .post(`/api/harness/sessions/parent-1/threads/${thread.id}/send`)
      .send({ message: "Heads up: scope changed", kind: "inform" })
      .expect(200);
    expect(response.body.result).toMatchObject({ accepted: true, delivery: "delivered" });
    expect(sent.some((text) => text.includes("scope changed") && text.includes("the user"))).toBe(true);
    expect(sessionAdapter.notify).toHaveBeenCalledTimes(1);
    expect(sessionAdapter.prompt).toHaveBeenCalledTimes(1); // initial task only
    expect(sessionAdapter.send).not.toHaveBeenCalled();
  });

  it("replays an idempotent requestId without scheduling a second Run", async () => {
    const { thread } = await start();
    await settle();
    const first = await request(app)
      .post(`/api/harness/sessions/parent-1/threads/${thread.id}/send`)
      .send({ message: "Run again", kind: "request", requestId: "ui-req-dup" })
      .expect(200);
    const opens = (sessionAdapter.open as ReturnType<typeof vi.fn>).mock.calls.length;

    const replay = await request(app)
      .post(`/api/harness/sessions/parent-1/threads/${thread.id}/send`)
      .send({ message: "Run again", kind: "request", requestId: "ui-req-dup" })
      .expect(200);
    expect(replay.body.result.messageId).toBe(first.body.result.messageId);
    expect(replay.body.result.runId).toBe(first.body.result.runId);
    expect((sessionAdapter.open as ReturnType<typeof vi.fn>).mock.calls.length).toBe(opens);
  });

  it("denies messaging a thread outside the caller's root-task relationships", async () => {
    const { thread } = await start();
    const other = await registry.createThread({
      ...createInput(),
      parent: { kind: "session", id: "other-session" },
    });
    await request(app)
      .post(`/api/harness/sessions/parent-1/threads/${other.id}/send`)
      .send({ message: "not your child", kind: "request" })
      .expect(403);
    expect((await registry.getThread(WORKSPACE, { kind: "session", id: "other-session" }, other.id))?.lifecycle).not.toBe("archived");
    expect(thread.id).not.toBe(other.id);
  });
});
