import { describe, expect, it, vi } from "vitest";
import type { HarnessActorIdentity, PiSessionEntry } from "@varin/protocol";
import { COMPACTION_QUERY_CAPABILITIES, COMPACTION_QUERY_METHODS } from "@varin/protocol";
import * as shellRuntime from "./shell-supervisor.js";
import {
  createHarnessServiceHost,
  deriveHarnessCapabilities,
} from "./service-host.js";

const ACTOR: HarnessActorIdentity = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 3,
};

describe("harness service host authorization", () => {
  it("does not gate command start or completion on slow knowledge observations", async () => {
    const createShell = vi.spyOn(shellRuntime, "createShellSupervisor");
    let release!: () => void;
    const storage = new Promise<void>(resolve => { release = resolve; });
    let startObserved = false;
    let completionObserved = false;
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: { hasBash: true, gitBashPath: "bash.exe" },
      onShellStarted: async () => { startObserved = true; await storage; },
      onShellCompleted: async () => { completionObserved = true; await storage; },
    });
    const event = { command: "echo alive", commandRunId: "terminal-1", executionId: "execution-1", cwd: "D:/workspace", startedAt: 1 };
    host.registerSession({ actor: ACTOR, grantedCapabilities: ["process.shell"], workspaceId: "workspace-1", workspaceRoot: "D:/workspace" });
    const lifecycle = createShell.mock.calls.at(-1)![0].commandLifecycle!;
    let started = false;
    let completed = false;
    const starting = Promise.resolve(lifecycle.started!(event)).then(() => { started = true; });
    let finishing = Promise.resolve();
    try {
      await expect.poll(() => startObserved && started, { timeout: 1000 }).toBe(true);
      finishing = Promise.resolve(lifecycle.completed!({ ...event, endedAt: 2, exitCode: 0, cancelled: false })).then(() => { completed = true; });
      await expect.poll(() => completionObserved && completed, { timeout: 1000 }).toBe(true);
    } finally {
      release();
      await Promise.all([starting, finishing]);
      await host.dispose();
      createShell.mockRestore();
    }
  });

  it("keeps a dropped session's command observable until shell shutdown finishes", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: { hasBash: true, gitBashPath: "bash.exe" },
    });
    host.registerSession({ actor: ACTOR, grantedCapabilities: ["process.shell"], workspaceId: "workspace-1", workspaceRoot: "D:/workspace" });
    const supervisor = host.getShellSupervisor(ACTOR.sessionId)!;
    let finish!: () => void;
    let active = true;
    const stopped = new Promise<void>((resolve) => { finish = () => { active = false; resolve(); }; });
    vi.spyOn(supervisor, "dispose").mockImplementation(() => stopped);
    vi.spyOn(supervisor, "hasActiveCommandAt").mockImplementation(() => active);
    try {
      host.dropSession(ACTOR.sessionId);
      expect(host.getShellSupervisor(ACTOR.sessionId)).toBeNull();
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(true);
      let closed = false;
      const closing = host.closeSessionShell(ACTOR.sessionId).then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await closing;
      expect(supervisor.dispose).toHaveBeenCalledTimes(1);
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(false);
    } finally {
      finish();
      await host.dispose();
    }
  });

  it("preserves failed shell shutdown for observation and an explicit retry", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: { hasBash: true, gitBashPath: "bash.exe" },
    });
    host.registerSession({ actor: ACTOR, grantedCapabilities: ["process.shell"], workspaceId: "workspace-1", workspaceRoot: "D:/workspace" });
    const supervisor = host.getShellSupervisor(ACTOR.sessionId)!;
    let active = true;
    const shutdown = vi.spyOn(supervisor, "dispose")
      .mockRejectedValueOnce(new Error("PTY has not exited"))
      .mockImplementation(async () => { active = false; });
    vi.spyOn(supervisor, "hasActiveCommandAt").mockImplementation(() => active);
    try {
      await expect(host.closeSessionShell(ACTOR.sessionId)).rejects.toThrow("PTY has not exited");
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(true);
      await host.closeSessionShell(ACTOR.sessionId);
      expect(shutdown).toHaveBeenCalledTimes(2);
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it("derives structural authority from the tools frozen into the session", () => {
    expect(deriveHarnessCapabilities(["bash", "grep", "webfetch", "apply_patch"], {
      threadRuntime: false,
    })).toEqual([
      "context.session",
      "read.lsp",
      "read.output",
      "read.search",
      "read.web",
      "process.shell",
      "write.document",
      "control.environment",
    ]);
    expect(deriveHarnessCapabilities(["dispatch"], { threadRuntime: false })).not.toContain("control.thread");
    expect(deriveHarnessCapabilities(["dispatch"], { threadRuntime: true })).toContain("control.thread");
    expect(deriveHarnessCapabilities(["submit_facts"], { threadRuntime: true })).toContain("control.thread");
    expect(deriveHarnessCapabilities(["submit_facts"], { threadRuntime: false })).not.toContain("control.thread");
    expect(deriveHarnessCapabilities(["edit"], { threadRuntime: false })).toContain("write.document");
    expect(deriveHarnessCapabilities(["explore"], { threadRuntime: false })).toContain("read.search");
    expect(deriveHarnessCapabilities(["read"], { documentRead: true, threadRuntime: false })).toContain("read.document");
    expect(deriveHarnessCapabilities(["read"], { documentRead: false, threadRuntime: false })).not.toContain("read.document");
    const researchReader = deriveHarnessCapabilities(["resources", "research_source"], { threadRuntime: true, experiments: true });
    expect(researchReader).toContain("read.experiment");
    expect(researchReader).toContain("write.research-source");
    expect(researchReader).not.toContain("control.experiment");
    expect(deriveHarnessCapabilities(["experiment"], { threadRuntime: true, experiments: true })).toContain("control.experiment");
    expect(deriveHarnessCapabilities(["scheduled_task"], { threadRuntime: false, scheduledTasks: false })).not.toContain("read.schedule");
    expect(deriveHarnessCapabilities([], { threadRuntime: false, scheduledTasks: true })).not.toContain("control.schedule");
  });

  it("accepts only the registered broker principal and preserves the current run", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: { ...ACTOR, workspaceScope: ["packages/web"] },
        grantedCapabilities: ["read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      host.observationCursors.set(ACTOR.sessionId, "shell", "sh_1", { offset: 10 });
      host.observationCursors.set(ACTOR.sessionId, "diagnostics", "D:/workspace/a.ts", { diagnostics: [] });
      host.registerSession({
        actor: { ...ACTOR, workspaceScope: ["packages/web"] },
        grantedCapabilities: ["read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      expect(host.observationCursors.get(ACTOR.sessionId, "shell", "sh_1")?.value).toEqual({ offset: 10 });
      expect(host.observationCursors.get(ACTOR.sessionId, "diagnostics", "D:/workspace/a.ts")).not.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, runId: "run-2" })).resolves.toEqual({
        ...ACTOR,
        runId: "run-2",
        workspaceId: "workspace-1",
        workspaceScope: ["packages/web"],
        grantedCapabilities: ["read.output"],
        cwd: "D:/workspace",
        authorityRoot: "D:/workspace",
      });
      await expect(host.resolveActor({ ...ACTOR, workerId: "stale-worker" })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, workerGeneration: 2 })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, authorityInstanceId: "stale-authority" })).resolves.toBeNull();
      host.observationCursors.set(ACTOR.sessionId, "shell", "sh_1", { offset: 10 });
      host.dropSession(ACTOR.sessionId);
      await expect(host.resolveActor(ACTOR)).resolves.toBeNull();
      expect(host.observationCursors.get(ACTOR.sessionId, "shell", "sh_1")).toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it("drops explore queries when the same session is registered again", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["read.search"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      const stored = host.exploreQueryStore.start({
        actor: {
          authorityInstanceId: ACTOR.authorityInstanceId,
          sessionId: ACTOR.sessionId,
          workerId: ACTOR.workerId,
          workerGeneration: ACTOR.workerGeneration,
          workspaceId: "workspace-1",
        },
        inputContext: { source: "disk" },
        input: { question: "needle" },
        deps: {
          rgSearch: async () => [],
          readFile: async () => ({ status: "ready", content: "needle", revision: "r1", source: "disk" }),
        },
        deadlineAt: Date.now() + 5_000,
        controller: new AbortController(),
      });
      expect(host.exploreQueryStore.get(ACTOR.sessionId, stored.id)).toBeDefined();
      host.registerSession({
        actor: { ...ACTOR, workerGeneration: 4 },
        grantedCapabilities: ["read.search"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      expect(host.exploreQueryStore.get(ACTOR.sessionId, stored.id)).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("preserves the ThreadRun binding while a worker generation is re-registered", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace/thread",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: { ...ACTOR, runId: "run-1" }, grantedCapabilities: ["process.shell"],
        workspaceId: "workspace-1", workspaceRoot: "D:/workspace/thread",
      });
      host.verification.attachThreadSession(ACTOR.sessionId, {
        workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1",
        worktreePath: "D:/workspace/thread", branchId: "thread-1",
        captureIdentity: async () => ({ treeHash: "tree" }),
      });
      host.dropSession(ACTOR.sessionId);
      expect(host.verification.sessionBinding(ACTOR.sessionId)).toMatchObject({
        scope: "child", threadId: "thread-1", runId: "run-1",
      });
      host.registerSession({
        actor: { ...ACTOR, workerGeneration: 2, runId: "run-1" }, grantedCapabilities: ["process.shell"],
        workspaceId: "workspace-1", workspaceRoot: "D:/workspace/thread",
      });
      expect(host.verification.sessionBinding(ACTOR.sessionId)).toMatchObject({
        scope: "child", threadId: "thread-1", runId: "run-1",
        actor: { workerGeneration: 2, runId: "run-1" },
      });
    } finally {
      await host.dispose();
    }
  });

  it("scopes a session's compaction worker to read-only queries bounded at the frozen leaf", async () => {
    const entries: PiSessionEntry[] = (["e1", "e2", "e3", "e4"] as const).map((id, index) => ({
      id,
      parentId: index === 0 ? null : `e${index}`,
      timestamp: "2026-01-01T00:00:00Z",
      type: "message",
      message: { role: "user", content: `entry ${id} body`, timestamp: index },
    })) as unknown as PiSessionEntry[];
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
      threadHistoryEntries: async (sessionId) => ({
        sessionId, entries, leafId: "e4", scope: "branch",
      }),
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["context.session", "read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      const auxIdentity: HarnessActorIdentity = { ...ACTOR, workerId: "worker-compaction" };
      host.registerAuxiliaryActor(ACTOR, auxIdentity.workerId, "e3");

      // The auxiliary identity resolves with the frozen allowlist only.
      const aux = await host.resolveActor(auxIdentity);
      expect(aux).not.toBeNull();
      expect(aux?.allowedMethods).toEqual([...COMPACTION_QUERY_METHODS]);
      expect(aux?.grantedCapabilities).toEqual([...COMPACTION_QUERY_CAPABILITIES]);
      expect(aux?.workspaceId).toBe("workspace-1");
      // Identity must match exactly: same session, wrong worker or generation is not the aux actor.
      await expect(host.resolveActor({ ...auxIdentity, workerGeneration: 99 })).resolves.toBeNull();
      await expect(host.resolveActor({ ...auxIdentity, sessionId: "other" })).resolves.toBeNull();

      // Frozen-range history reads stop at the leaf recorded at task freeze.
      const overview = await host.compactionHistory(aux!, {});
      expect(overview.details.boundEntry).toBe("e3");
      expect(overview.details.boundFound).toBe(true);
      expect(overview.details.total).toBe(3);
      const missed = await host.compactionHistory(aux!, { entry: "e4" });
      expect(missed.details.found).toBe(false);
      const hit = await host.compactionHistory(aux!, { query: "e2 body" });
      expect(hit.details.matches).toBe(1);

      host.registerAuxiliaryActor(ACTOR, "worker-compaction-missing-leaf", "gone");
      const missingLeaf = await host.resolveActor({ ...auxIdentity, workerId: "worker-compaction-missing-leaf" });
      await expect(host.compactionHistory(missingLeaf!, {})).rejects.toThrow(/frozen history leaf is no longer available/);

      // The parent session actor itself cannot use the bounded read.
      const parent = await host.resolveActor({ ...ACTOR, runId: "run-9" });
      await expect(host.compactionHistory(parent!, {})).rejects.toThrow(/restricted/);

      // The auxiliary worker's exit must not retire the session registration.
      host.dropSession(ACTOR.sessionId, auxIdentity);
      await expect(host.resolveActor({ ...ACTOR, runId: "run-9" })).resolves.not.toBeNull();
      await expect(host.resolveActor(auxIdentity)).resolves.not.toBeNull();

      // Retiring just the auxiliary worker keeps the session alive.
      host.dropAuxiliaryActor(auxIdentity.workerId);
      await expect(host.resolveActor(auxIdentity)).resolves.toBeNull();
      await expect(host.resolveActor(ACTOR)).resolves.not.toBeNull();

      // The real session worker's exit retires both registrations.
      host.registerAuxiliaryActor(ACTOR, "worker-compaction-2", "e3");
      host.dropSession(ACTOR.sessionId, { ...ACTOR, runId: "run-9" });
      await expect(host.resolveActor(ACTOR)).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, workerId: "worker-compaction-2" })).resolves.toBeNull();
    } finally {
      await host.dispose();
    }
  });
});

describe("HR0 unbound session admission", () => {
  it("registers a no-project session and resolves its actor with a launch-dir authority root", async () => {
    const launch = "D:/external/launch";
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => { throw new Error("no project workspace"); },
      discoveredShells: { hasBash: false },
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["read.output"],
        workspaceId: null,
        workspaceRoot: launch,
      });
      const resolved = await host.resolveActor({ ...ACTOR, runId: "run-1" });
      expect(resolved).toMatchObject({
        sessionId: ACTOR.sessionId,
        workspaceId: null,
        authorityRoot: launch,
        cwd: launch,
      });
    } finally {
      await host.dispose();
    }
  });

  it("does not block unbound admission when the launch directory is unreachable", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => { throw new Error("offline"); },
      discoveredShells: { hasBash: false },
      pathAuthority: { resolve: async () => null } as never,
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["read.output"],
        workspaceId: null,
        workspaceRoot: "Z:/offline/share",
      });
      const resolved = await host.resolveActor({ ...ACTOR, runId: "run-1" });
      expect(resolved?.workspaceId).toBeNull();
      expect(resolved?.authorityRoot).toBe("Z:/offline/share");
    } finally {
      await host.dispose();
    }
  });
});
