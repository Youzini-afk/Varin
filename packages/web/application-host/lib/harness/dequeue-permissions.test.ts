import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergePolicies, normalizeFrozenHarnessPermissions } from "@varin/protocol";
import type { SessionSnapshot, SessionStats, SessionSummary } from "@varin/protocol";
import { createOnThreadDequeued } from "./thread-dequeue.js";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "./thread-runtime.js";

const WORKSPACE = "workspace-1";
const PARENT = { kind: "session" as const, id: "parent-1" };

const snapshot = (sessionId: string): SessionSnapshot => ({
  activeTools: ["read", "edit"],
  busy: false,
  cwd: "/workspace/thread",
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: "one-at-a-time",
  isCompacting: false,
  isStreaming: false,
  leafId: "entry-1",
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
  workspace: { authorityId: "runtime-workspace-1", id: "runtime-workspace-1", kind: "workspace" },
});

const summary = (sessionId: string): SessionSummary => ({
  allMessagesText: "",
  createdAt: "2026-09-11T00:00:00.000Z",
  cwd: "/workspace",
  firstMessage: "",
  id: sessionId,
  messageCount: 0,
  persisted: true,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  updatedAt: "2026-09-11T00:00:00.000Z",
});

const stats: SessionStats = {
  cost: 0,
  sessionId: "queued-child",
  tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  totalMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  assistantMessages: 0,
  userMessages: 0,
};

const createInput = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  scopeId: WORKSPACE,
  parent: PARENT,
  brief: "queued work",
  preset: "hard-implement",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 1,
  autoRun: true,
  worktree: "isolated",
  model: { providerId: "test-provider", modelId: "test-model" },
  tools: ["read", "edit"],
  permissions: { mode: "accept-edits" },
  ...overrides,
});

describe("dequeued thread permissions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("passes frozen accept-edits through the production dequeue callback into session.create", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-dequeue-permissions-"));
    roots.push(dataDir);
    const created: Array<{ permissions?: unknown }> = [];
    const sessionAdapter: ThreadSessionAdapter = {
      create: vi.fn(async (input) => {
        created.push(input);
        return snapshot("queued-child");
      }),
      open: vi.fn(async (input) => snapshot(input.sessionId ?? "opened")),
      prompt: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      snapshot: vi.fn(async (sessionId) => snapshot(sessionId)),
      summary: vi.fn(async (sessionId) => summary(sessionId)),
      stats: vi.fn(async () => stats),
      entries: vi.fn(async (sessionId, scope: "all" | "branch" = "branch") => ({
        sessionId,
        scope,
        leafId: "entry-1",
        entries: [],
      })),
    };
    let registry = createThreadRegistry({ dataDir, hostId: "host-1", maxConcurrency: 1 });
    const runtime = createThreadRuntime({
      registry,
      sessions: sessionAdapter,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      worktrees: {
        prepare: async () => ({ cwd: "/workspace/thread", worktree: { path: "/workspace/thread", base: "base" } }),
        snapshot: async (worktree) => ({ ...worktree, branch: "varin/thread", resultCommit: "result" }),
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "host-1",
      maxConcurrency: 1,
      onThreadDequeued: createOnThreadDequeued({
        getRegistry: () => registry,
        getRuntime: () => runtime,
      }),
    });
    try {
      const first = await registry.createThread(createInput({ brief: "first", permissions: { mode: "normal" } }));
      const firstRun = await registry.startRun(WORKSPACE, first.id);
      await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "first-child");
      const queued = await registry.createThread(createInput({ brief: "queued accept-edits" }));
      await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, {
        conclusion: "done",
        changedFiles: [],
        unresolved: [],
        deviations: [],
        confidence: 1,
        transcriptRef: { runtimeId: "pi", sessionId: "first-child", fromEntryId: null, toEntryId: null },
        blocksSnapshot: {},
      });
      await vi.waitFor(() => {
        expect(sessionAdapter.create).toHaveBeenCalled();
      });
      expect(sessionAdapter.create).toHaveBeenCalledWith(expect.objectContaining({
        permissions: normalizeFrozenHarnessPermissions(queued.manifest.permissions),
      }));
      const frozen = normalizeFrozenHarnessPermissions(created[0]?.permissions);
      expect(frozen).toEqual({ mode: "accept-edits", rules: [] });
      expect(mergePolicies(frozen, { mode: "bypass" }).mode).toBe("accept-edits");
      expect(mergePolicies(normalizeFrozenHarnessPermissions({}), { mode: "bypass" }).mode).toBe("normal");
    } finally {
      await runtime.dispose();
      await registry.dispose();
    }
  });

  it("carries the frozen input origin and inherited context into a dequeued spawn", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-dequeue-inherit-"));
    roots.push(dataDir);
    const prompts: string[] = [];
    const sessionAdapter: ThreadSessionAdapter = {
      create: vi.fn(async () => snapshot("queued-child")),
      open: vi.fn(async (input) => snapshot(input.sessionId ?? "opened")),
      prompt: vi.fn(async (_sessionId, text) => { prompts.push(text); }),
      send: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      snapshot: vi.fn(async (sessionId) => snapshot(sessionId)),
      summary: vi.fn(async (sessionId) => summary(sessionId)),
      stats: vi.fn(async () => stats),
      entries: vi.fn(async (sessionId, scope: "all" | "branch" = "branch") => ({
        sessionId,
        scope,
        leafId: "entry-1",
        entries: [],
      })),
    };
    let registry = createThreadRegistry({ dataDir, hostId: "host-1", maxConcurrency: 1 });
    const runtime = createThreadRuntime({
      registry,
      sessions: sessionAdapter,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      worktrees: {
        prepare: async () => ({ cwd: "/workspace/thread", worktree: { path: "/workspace/thread", base: "base" } }),
        snapshot: async (worktree) => ({ ...worktree, branch: "varin/thread", resultCommit: "result" }),
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "host-1",
      maxConcurrency: 1,
      onThreadDequeued: createOnThreadDequeued({
        getRegistry: () => registry,
        getRuntime: () => runtime,
      }),
    });
    try {
      const first = await registry.createThread(createInput({ brief: "first" }));
      const firstRun = await registry.startRun(WORKSPACE, first.id);
      await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "first-child");
      const queued = await registry.createThread(createInput({
        brief: "queued inherit work",
        inputOrigin: "inherit",
        inheritedContext: {
          fromSessionId: "parent-1",
          capturedAt: "2026-09-15T00:00:00.000Z",
          text: "[committed summary]\nPARENT SUMMARY",
          anchors: ["anchor-1"],
        },
      }));
      await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, {
        conclusion: "done",
        changedFiles: [],
        unresolved: [],
        deviations: [],
        confidence: 1,
        transcriptRef: { runtimeId: "pi", sessionId: "first-child", fromEntryId: null, toEntryId: null },
        blocksSnapshot: {},
      });
      await vi.waitFor(() => {
        expect(prompts.length).toBeGreaterThan(0);
      });
      expect(prompts.at(-1)).toContain('<inherited-context from-session="parent-1">');
      expect(prompts.at(-1)).toContain("PARENT SUMMARY");
      const run = await registry.getActiveRun(WORKSPACE, queued.id);
      expect(run?.frozen?.inputOrigin).toBe("inherit");
    } finally {
      await runtime.dispose();
      await registry.dispose();
    }
  });
});
