import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessActorContext, HarnessServiceMap, SessionSnapshot, SessionStats } from "@varin/protocol";
import { createDocumentAuthority } from "../documents/authority.js";
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import type { LocalWorkingStateStorageContext as WorkspaceRecoveryStorageContext } from "./working-state/working-state-store.js";
import { createObservationCursorStore } from "./observation-cursors.js";
import { createHarnessRouter } from "./router.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createHarnessServiceHost } from "./service-host.js";
import { registerHarnessServices } from "./harness-services.js";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "./thread-runtime.js";
import { createThreadWorktreeRuntime } from "./thread-worktree.js";
import { ThreadExecutionViewRegistry } from "./working-state/execution-view.js";
import { WorkingStateStore } from "./working-state/working-state-store.js";
import { asTestWorkingStateRootAccess, type TestWorkspaceWorkingStateAccess } from "./working-state/working-state-root-adapter.test-helper.js";
import { projectZone2Threads } from "./zone2-threads.js";

const git = (cwd: string, args: string[]): string => (
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
);

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

describe("owning vs execution workspace identity", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("dispatches a grandchild through the public router into the owning catalog when Documents assigns a different execution workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "varin-workspace-identity-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "kept.txt"), "owning-base\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const parentHead = git(repo, ["rev-parse", "HEAD"]);
    const parentBranches = git(repo, ["branch"]);

    const documents = createDocumentAuthority({
      hostId: "host",
      dataDir: join(root, "documents"),
      isAllowedRoot: async () => true,
    });
    const owning = await documents.resolveWorkspace({ path: repo });
    const recoveryRoot = join(root, "recovery");
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error("Missing recovery catalog");
    const context: WorkspaceRecoveryStorageContext = {
      database,
      root: recoveryRoot,
      fileStore: createRecoveryFileStore(),
      identity: {
        authorityId: "host",
        canonicalRoot: repo,
        filesystemProfile: "test",
        workspaceId: owning.workspaceId,
      },
      resourceOperationGate: { run: async (_resources, operation) => operation() },
    };
    const legacyWorkingStates: TestWorkspaceWorkingStateAccess = {
      withStore: async (_workspaceId, _purpose, operation) => operation(await WorkingStateStore.open(context), context),
    };
    const workingStates = asTestWorkingStateRootAccess(legacyWorkingStates);
    const registry = createThreadRegistry({ hostId: "host", dataDir: join(root, "threads") });
    const worktrees = createThreadWorktreeRuntime({
      createWorktree: async () => { throw new Error("named Git worktree create is not used for virtual materialize"); },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    const created: Array<{ sessionId: string; cwd: string; workspaceId: string }> = [];
    const snapshotFor = (sessionId: string, cwd: string, workspaceId: string): SessionSnapshot => ({
      sessionId,
      cwd,
      workspace: { authorityId: workspaceId, id: workspaceId, kind: "workspace" },
      activeTools: ["read", "write", "dispatch", "threads", "wait"],
      busy: false,
      features: { revision: 0, schemaVersion: 1 },
      followUp: [],
      followUpMode: "one-at-a-time",
      steering: [],
      steeringMode: "all",
      leafId: null,
      isCompacting: false,
      isStreaming: false,
      pendingMessageCount: 0,
      retryAttempt: 0,
      thinkingLevel: "off",
    });
    const stats: SessionStats = {
      sessionId: "unused",
      cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      totalMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      assistantMessages: 0,
      userMessages: 0,
    };
    const sessions: ThreadSessionAdapter = {
      create: vi.fn(async (input) => {
        const sessionId = `pi-session-${created.length + 1}`;
        created.push({ sessionId, cwd: input.cwd, workspaceId: input.workspaceId });
        return snapshotFor(sessionId, input.cwd, input.workspaceId);
      }),
      open: vi.fn(async (input) => snapshotFor(input.sessionId, input.cwd, input.workspaceId)),
      prompt: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      snapshot: async (sessionId) => {
        const found = created.find((entry) => entry.sessionId === sessionId);
        if (!found) throw new Error(`Unknown session ${sessionId}`);
        return snapshotFor(sessionId, found.cwd, found.workspaceId);
      },
      stats: async () => stats,
      summary: async (sessionId) => ({
        id: sessionId,
        allMessagesText: "",
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:00Z",
        cwd: created.find((entry) => entry.sessionId === sessionId)?.cwd ?? repo,
        firstMessage: "",
        messageCount: 0,
        persisted: true,
        sessionFile: join(root, `${sessionId}.jsonl`),
      }),
      entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
    };
    const views = new ThreadExecutionViewRegistry();
    const runtime = createThreadRuntime({
      registry,
      sessions,
      worktrees,
      workingStates,
      executionViews: views,
      resolveWorkspaceRoot: async (workspaceId) => (await documents.inspectWorkspace(workspaceId)).root,
      resolveRuntimeWorkspaceId: async (cwd) => (await documents.resolveWorkspace({ path: cwd })).workspaceId,
    });

    const parent = { kind: "session" as const, id: "root-session" };
    const input = {
      scopeId: owning.workspaceId,
      parent,
      brief: "parent implementer",
      preset: "hard-implement",
      kind: "implementation" as const,
      createdBy: "agent" as const,
      concurrency: 4,
      autoRun: true,
      worktree: "isolated" as const,
      tools: ["read", "write", "dispatch", "threads", "wait", "read_thread", "send", "kill", "merge"],
      permissions: {},
    };

    let response: unknown;
    const parentThread = await registry.createThread(input);
    await runtime.prepareIsolatedBranch({
      scopeId: owning.workspaceId,
      parent,
      threadId: parentThread.id,
    });
    const parentRun = await registry.startRun(owning.workspaceId, parentThread.id);
    await runtime.spawn({ ...input, threadId: parentThread.id, runId: parentRun.id });
    const parentSession = created[0];
    if (!parentSession) throw new Error("session.create did not run");
    const execution = await documents.resolveWorkspace({ path: parentSession.cwd });
    expect(parentSession.workspaceId).toBe(execution.workspaceId);
    expect(execution.workspaceId).not.toBe(owning.workspaceId);
    expect(await registry.getThreadForSession(execution.workspaceId, parentSession.sessionId)).toBeNull();
    const parentBinding = await registry.getSessionBinding(parentSession.sessionId);
    expect(parentBinding?.owningScopeId).toBe(owning.workspaceId);
    expect(parentBinding).toMatchObject({
      threadId: parentThread.id,
      sessionId: parentSession.sessionId,
    });

    const actor: HarnessActorContext = {
      authorityInstanceId: "host",
      sessionId: parentSession.sessionId,
      workerId: "worker",
      workerGeneration: 1,
      workspaceId: execution.workspaceId,
      grantedCapabilities: ["control.thread"],
      runId: parentRun.id,
    };
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      pathAuthority: createHarnessPathAuthority({ authorityId: "host", documents }),
      resolveWorkspaceRoot: async (workspaceId) => {
        try {
          return (await documents.inspectWorkspace(workspaceId)).root;
        } catch {
          return null;
        }
      },
      threadRegistry: registry,
      threadSpawnSession: (spawnInput) => runtime.spawn(spawnInput),
      threadPrepareIsolatedBranch: (prepareInput) => runtime.prepareIsolatedBranch(prepareInput),
    });
    host.registerSession({ actor, grantedCapabilities: ["control.thread", "context.session"],
      workspaceId: execution.workspaceId, workspaceRoot: parentSession.cwd,
      authorityWorkspaceRoot: parentSession.cwd });
    const router = createHarnessRouter({
      resolveActor: async () => actor,
      respond: async (_sessionId, _requestId, result) => { response = result; },
    });
    registerHarnessServices(router, host);

    const request = async <M extends "thread.dispatch" | "thread.list" | "thread.wait">(
      method: M,
      params: HarnessServiceMap[M]["params"],
    ) => {
      await router.processEvent({
        kind: "host",
        actor,
        envelope: {
          kind: "event",
          event: "harness.request",
          data: { requestId: crypto.randomUUID(), method, params },
        },
      });
      return response as
        | { ok: true; result: HarnessServiceMap[M]["result"] }
        | { ok: false; error: { code: string; message: string } };
    };

    try {
      const dispatched = await request("thread.dispatch", { preset: "check", task: "Inspect the parent branch" });
      expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ ok: true, result: { queued: false } });
      if (!dispatched.ok) throw new Error(dispatched.error.message);
      const grandchildId = dispatched.result.threadId;
      expect(await registry.getThread(owning.workspaceId, { kind: "thread", id: parentThread.id }, grandchildId)).toMatchObject({
        parent: { kind: "thread", id: parentThread.id },
        workspaceId: owning.workspaceId,
      });
      expect(await registry.listThreads(execution.workspaceId, { kind: "thread", id: parentThread.id })).toEqual([]);
      await vi.waitFor(async () => {
        const run = await registry.getActiveRun(owning.workspaceId, grandchildId);
        expect(run?.workerState).toBe("running");
        expect(run?.sessionId).toBeTruthy();
      });

      const listed = await request("thread.list", {});
      expect(listed).toMatchObject({ ok: true });
      if (!listed.ok) throw new Error(listed.error.message);
      expect(listed.result.threads.map((thread) => thread.id)).toEqual([grandchildId]);

      const waited = await request("thread.wait", { timeoutMs: 50 });
      expect(waited).toMatchObject({ ok: true });
      if (!waited.ok) throw new Error(waited.error.message);
      expect(waited.result.text).toContain(grandchildId);

      const zone2 = await projectZone2Threads({
        registry,
        cursors: createObservationCursorStore(),
      }, { sessionId: parentSession.sessionId, scopeId: execution.workspaceId });
      expect(zone2.status === "ready" ? zone2.items.map((item) => item.id) : []).toEqual([grandchildId]);

      const grandchildRun = await registry.getActiveRun(owning.workspaceId, grandchildId);
      if (!grandchildRun) throw new Error("grandchild run missing");
      await registry.endRun(owning.workspaceId, grandchildId, grandchildRun.id, "lost", "worker lost");
      const binding = await registry.getSessionBinding(parentSession.sessionId);
      if (!binding) throw new Error("parent session binding missing after dispatch");
      await runtime.resumeLostForParent(binding.owningScopeId, { kind: "thread", id: binding.threadId });
      await vi.waitFor(async () => {
        expect(sessions.open).toHaveBeenCalled();
        expect(await registry.getActiveRun(owning.workspaceId, grandchildId)).toMatchObject({
          workerState: "running",
        });
      });

      const materialized = await runtime.materializeExecutionView(parentSession.sessionId);
      expect(materialized.status).toBe("materialized");
      const live = materialized.status === "materialized" ? materialized.path : "";
      expect(existsSync(join(live, "kept.txt"))).toBe(true);
      expect(normalizePath(git(live, ["rev-parse", "--show-toplevel"])).toLowerCase()).toBe(normalizePath(live).toLowerCase());
      expect(normalizePath(git(live, ["rev-parse", "--show-toplevel"])).toLowerCase()).not.toBe(normalizePath(repo).toLowerCase());
      const parentStatus = git(repo, ["status", "--porcelain"]);
      git(live, ["status", "--porcelain"]);
      git(live, ["reset", "--hard"]);
      writeFileSync(join(live, "child-commit.txt"), "isolated\n");
      git(live, ["add", "child-commit.txt"]);
      git(live, ["-c", "user.name=Child", "-c", "user.email=child@example.com", "commit", "--no-verify", "--no-gpg-sign", "-m", "child only"]);
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(parentHead);
      expect(git(repo, ["status", "--porcelain"])).toBe(parentStatus);
      expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("owning-base\n");
      expect(git(repo, ["branch"])).toBe(parentBranches);
    } finally {
      router.dispose();
      await host.dispose();
      await runtime.dispose();
      await registry.dispose();
      await documents.dispose();
      database.close();
    }
  }, 45_000);
});
