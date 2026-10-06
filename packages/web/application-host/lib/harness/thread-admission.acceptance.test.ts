import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadDispatchService, createThreadWaitService } from "./thread-services.js";
import type { HarnessServiceContext } from "./router.js";

const context = (): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "admission-audit",
    grantedCapabilities: ["control.thread"],
    sessionId: "parent",
    workerGeneration: 1,
    workerId: "parent-worker",
    workspaceId: "workspace",
  },
  authorizedPaths: [],
  sessionId: "parent",
  signal: new AbortController().signal,
  workspaceId: "workspace",
});

const baseline = {
  branchId: "fixed-baseline",
  worktree: {
    path: "/fixture/scratch",
    base: "fixture-base",
    viewMode: "virtual" as const,
    materialized: false,
    preparationStage: "ready" as const,
  },
};

describe("root execution admission — service/registry acceptance", () => {
  const input = (kind: "implementation" | "discussion" = "implementation"): CreateThreadInput => ({
    scopeId: "workspace", parent: { kind: "session", id: "parent" },
    brief: "admission", kind, createdBy: "agent", concurrency: 1,
    autoRun: true, worktree: kind === "discussion" ? "none" : "isolated",
    tools: ["read"], permissions: {},
  });

  it("the real wait service cannot return into a full root pool after attention changes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-wait-readmission-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      const owner = await registry.createThread({ ...input(), tools: ["wait"] });
      const ownerRun = await registry.startRun("workspace", owner.id);
      await registry.markRunRunning("workspace", owner.id, ownerRun.id, "waiting-session");
      const child = await registry.createThread({ ...input(), parent: { kind: "thread", id: owner.id } });
      const wait = createThreadWaitService({ threadRegistry: registry } as never);
      const ctx: HarnessServiceContext = {
        ...context(),
        actor: { ...context().actor, sessionId: "waiting-session" },
        sessionId: "waiting-session",
        signal: controller.signal,
      };
      let returned = false;
      pending = wait.handle({ timeoutMs: 1_000 }, ctx).then((result) => { returned = true; return result; });
      await vi.waitFor(async () => {
        expect((await registry.getActiveRun("workspace", owner.id))?.executionYielded).toBe(true);
      });
      const childRun = await registry.startRun("workspace", child.id);
      // Presentation changes are not an execution grant.
      await registry.setAttention("workspace", owner.id, "none");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(returned).toBe(false);
      expect(await registry.countActiveInRoot("workspace", input().parent)).toBe(1);
      await registry.endRun("workspace", child.id, childRun.id, "success", null);
      await pending;
      expect(returned).toBe(true);
      expect((await registry.getActiveRun("workspace", owner.id))?.executionYielded).toBe(false);
      expect(await registry.countActiveInRoot("workspace", input().parent)).toBe(1);
    } finally {
      controller.abort();
      await pending?.catch(() => undefined);
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("conversion cannot bypass admission or end the existing discussion on refusal", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-conversion-admission-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    try {
      const discussion = await registry.createThread(input("discussion"));
      const oldRun = await registry.startRun("workspace", discussion.id);
      await registry.markRunRunning("workspace", discussion.id, oldRun.id, "discussion-session");
      const blocker = await registry.createThread(input());
      await registry.startRun("workspace", blocker.id);
      await expect(registry.convertThread("workspace", discussion.id, {
        tools: ["read", "edit"], scope: [], worktree: { path: "/scratch", base: "base" },
      })).rejects.toMatchObject({ code: "capacity" });
      expect(await registry.getThreadById("workspace", discussion.id)).toMatchObject({
        kind: "discussion", activeRunId: oldRun.id,
      });
      expect(await registry.getActiveRun("workspace", discussion.id)).toMatchObject({
        id: oldRun.id, outcome: null, workerState: "running",
      });
      expect(await registry.listRuns("workspace", discussion.id)).toHaveLength(1);
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("a recovered Run cannot inherit the old Run's yielded execution slot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-recovered-admission-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    try {
      const thread = await registry.createThread(input());
      const lost = await registry.startRun("workspace", thread.id);
      await registry.markRunRunning("workspace", thread.id, lost.id, "lost-session");
      await registry.setAttention("workspace", thread.id, "thread", { kind: "thread", text: "old dependency" });
      await registry.reconcileWorkspace("workspace", new Set());
      const recovered = await registry.startRun("workspace", thread.id);
      expect(recovered.id).not.toBe(lost.id);
      expect((await registry.getThreadById("workspace", thread.id))?.waitingFor).toBeNull();
      expect(await registry.countActiveInRoot("workspace", { kind: "session", id: "parent" })).toBe(1);
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reserves the last root slot atomically after concurrent baseline captures", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-admission-audit-"));
    const workspaceRoot = join(dataDir, "workspace");
    await mkdir(workspaceRoot);
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    let captures = 0;
    let release!: () => void;
    const bothCapturing = new Promise<void>((resolve) => { release = resolve; });
    const spawn = vi.fn(async () => ({ sessionId: "child" }));
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: async () => {
        captures += 1;
        if (captures === 2) release();
        await bothCapturing;
        return baseline;
      },
    } as never);
    try {
      const results = await Promise.all(["first", "second"].map((task) => dispatch.handle({
        task,
        concurrency: 1,
        model: { providerId: "faux", modelId: "faux-model" },
        tools: ["read"],
      }, context())));
      expect(results.filter((result) => !result.queued)).toHaveLength(1);
      expect(results.filter((result) => result.queued)).toHaveLength(1);
      expect(spawn).toHaveBeenCalledOnce();
      expect(await registry.countActiveInRoot("workspace", { kind: "session", id: "parent" })).toBe(1);
      const queued = results.find((result) => result.queued)!;
      expect(await registry.getThread("workspace", { kind: "session", id: "parent" }, queued.threadId))
        .toMatchObject({ lifecycle: "queued", activeRunId: null });
    } finally {
      release();
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("kind:discussion dispatches a read-only consult thread with no worktree or baseline", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-consult-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    const spawn = vi.fn(async () => ({ sessionId: "consult" }));
    const prepare = vi.fn(async () => baseline);
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepare,
    } as never);
    try {
      const result = await dispatch.handle({
        task: "does the existing schema cover audit rows?",
        kind: "discussion",
        model: { providerId: "faux", modelId: "faux-model" },
        tools: ["read", "edit", "memory", "bash"],
      }, context());
      const thread = await registry.getThread("workspace", { kind: "session", id: "parent" }, result.threadId);
      expect(thread).toMatchObject({ kind: "discussion", lifecycle: "active" });
      expect(thread?.worktree ?? "none").toBe("none");
      // Write-capable and shell tools are clamped out of a consult Run.
      expect(thread?.manifest.tools ?? []).toContain("read");
      expect(thread?.manifest.tools ?? []).not.toContain("memory");
      expect(thread?.manifest.tools ?? []).not.toContain("edit");
      expect(thread?.manifest.tools ?? []).not.toContain("bash");
      expect(prepare).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("kind:discussion rejects preset, capability, and worktree combinations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-consult-reject-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(),
      threadPrepareIsolatedBranch: async () => baseline,
    } as never);
    try {
      await expect(dispatch.handle({
        task: "x", kind: "discussion", worktree: "shared",
        model: { providerId: "faux", modelId: "faux-model" },
      }, context())).rejects.toMatchObject({ harnessCode: "invalid-params" });
      await expect(dispatch.handle({
        task: "x", kind: "invalid" as never,
        model: { providerId: "faux", modelId: "faux-model" },
      }, context())).rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(await registry.listWorkspaceThreads("workspace")).toEqual([]);
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("deleting a Bot entry preserves admission for its independent work", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-bot-entry-lifecycle-"));
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    try {
      const root = await registry.createThread({ ...input("discussion"), purpose: "bot-root" });
      const rootRun = await registry.startRun("workspace", root.id);
      await registry.markRunRunning("workspace", root.id, rootRun.id, "old-bot-entry");
      const work = await registry.createThread({ ...input(), parent: { kind: "thread", id: root.id } });
      await registry.archiveThreadsForDeletedSessionAcrossWorkspaces("old-bot-entry");
      expect((await registry.getThreadById("workspace", root.id))?.lifecycle).toBe("settled");
      await expect(registry.startRun("workspace", work.id)).resolves.toMatchObject({ threadId: work.id });
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("releases a captured draft when inherit input capture fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-inherit-cleanup-"));
    const workspaceRoot = join(dataDir, "workspace");
    await mkdir(workspaceRoot);
    const registry = createThreadRegistry({ dataDir, hostId: "audit" });
    const cleanup = vi.fn(async () => undefined);
    const spawn = vi.fn();
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadCaptureDraftBaseline: async () => ({ draftBaselineId: "draft-owned", cleanup }),
      threadCaptureInputContext: async () => { throw new Error("parent input unavailable"); },
      threadPrepareIsolatedBranch: async () => baseline,
    } as never);
    try {
      await expect(dispatch.handle({
        task: "inherit safely",
        input: "inherit",
        model: { providerId: "faux", modelId: "faux-model" },
        tools: ["read"],
      }, {
        ...context(),
        inputContext: {
          source: "surface",
          roots: [{ workspaceId: "workspace", dirtyPaths: ["draft.ts"] }],
          snapshot: { status: "ready", ref: "draft-snapshot" },
        },
      })).rejects.toThrow("parent input unavailable");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      expect(await registry.listWorkspaceThreads("workspace")).toEqual([]);
    } finally {
      await registry.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
