import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateThreadInput } from "./thread-registry.js";
import { createThreadRegistry } from "./thread-registry.js";
import { createEnvironmentGetService, createEnvironmentSetService } from "./environment-services.js";
import { createComputerObserveService } from "./computer-services.js";
import { createShellExecService } from "./harness-services.js";
import type { HarnessServiceContext } from "./router.js";

const dirs: string[] = [];
const dataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "env-services-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ctx = (sessionId: string): HarnessServiceContext => ({
  actor: {
    authorityInstanceId: "authority-1",
    grantedCapabilities: ["control.thread", "process.shell", "read.computer"],
    sessionId,
    workerGeneration: 1,
    workerId: "worker-1",
    workspaceId: "ws-1",
  },
  authorizedPaths: [],
  sessionId,
  workspaceId: "ws-1",
  signal: new AbortController().signal,
});

const createInput = (): CreateThreadInput => ({
  scopeId: "ws-1",
  parent: { kind: "session", id: "root-session" },
  brief: "work",
  kind: "implementation",
  createdBy: "user",
  concurrency: 4,
  worktree: "none",
  tools: [],
  permissions: {},
  autoRun: true,
});

/** A session whose Run is bound to the given Thread. */
const bindSession = async (
  registry: ReturnType<typeof createThreadRegistry>,
  threadId: string,
  sessionId: string,
): Promise<void> => {
  const run = await registry.startRun("ws-1", threadId);
  await registry.markRunRunning("ws-1", threadId, run.id, sessionId);
};

describe("execution environment binding", () => {
  it("sets, persists and resolves the Thread environment for its session", async () => {
    const dir = dataDir();
    const registry = createThreadRegistry({ dataDir: dir, hostId: "host-1" });
    try {
      const thread = await registry.createThread(createInput());
      await bindSession(registry, thread.id, "session-1");
      const host = {
        threadRegistry: registry,
        managedRemoteTargets: { targetFor: async (_scope: string, id: string) => ({ machineId: id }) },
        computerService: { list: async () => ({ machines: [], desktops: [{ id: "desk-1" }], defaultDesktopId: "desk-1" }) },
      };
      const set = createEnvironmentSetService(host as never);
      const setResult = await set.handle({ workTarget: "machine-9", desktopId: "desk-1" }, ctx("session-1"));
      expect(setResult.threadId).toBe(thread.id);
      expect(setResult.environment).toMatchObject({ workTarget: "machine-9", desktopId: "desk-1" });
      expect(setResult.previous).toBeNull();
      expect(setResult.handoff).toMatch(/machine-9/);

      // The binding is durable registry state, not a session cache.
      const reopened = createThreadRegistry({ dataDir: dir, hostId: "host-1" });
      try {
        const resolved = await reopened.threadEnvironmentForSession("session-1");
        expect(resolved).toMatchObject({ threadId: thread.id, environment: { workTarget: "machine-9", desktopId: "desk-1" } });
      } finally {
        await reopened.dispose();
      }
      const get = createEnvironmentGetService(host as never);
      expect(await get.handle({}, ctx("session-1"))).toEqual({
        threadId: thread.id,
        environment: { workTarget: "machine-9", desktopId: "desk-1", updatedAt: expect.any(String) },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("reports a real handoff and keeps the binding pinned per accepted call", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const thread = await registry.createThread(createInput());
      await bindSession(registry, thread.id, "session-1");
      const shellExec = vi.fn(async () => ({ kind: "completed" as const, exitCode: 0, stdout: "", stderr: "", durationMs: 1, cwd: "/root" }));
      const host = {
        threadRegistry: registry,
        managedRemoteTargets: {
          targetFor: async (_scope: string, id: string) => ({ machineId: id }),
          shellExec,
        },
        getShellSupervisor: () => null,
        getInterpreter: () => null,
      };
      const set = createEnvironmentSetService(host as never);
      const exec = createShellExecService(host as never);

      const first = await set.handle({ workTarget: "machine-a" }, ctx("session-1"));
      expect(first.handoff).toMatch(/machine-a/);
      // A command admitted under machine-a resolves and pins that target.
      await exec.handle({ command: "echo one", toolCallId: "call-1" }, ctx("session-1"));
      expect(shellExec).toHaveBeenLastCalledWith("ws-1", "machine-a", expect.objectContaining({ command: "echo one" }), expect.anything());

      // Rebinding moves only later-admitted calls — and says so.
      const second = await set.handle({ workTarget: "machine-b" }, ctx("session-1"));
      expect(second.previous).toMatchObject({ workTarget: "machine-a" });
      expect(second.handoff).toMatch(/already accepted on machine-a/);
      await exec.handle({ command: "echo two", toolCallId: "call-2" }, ctx("session-1"));
      expect(shellExec).toHaveBeenLastCalledWith("ws-1", "machine-b", expect.objectContaining({ command: "echo two" }), expect.anything());

      // An explicit target still wins over the binding.
      await exec.handle({ command: "echo three", target: "machine-c", toolCallId: "call-3" }, ctx("session-1"));
      expect(shellExec).toHaveBeenLastCalledWith("ws-1", "machine-c", expect.objectContaining({ command: "echo three" }), expect.anything());

      // A no-change update does not invent a handoff.
      const again = await set.handle({ workTarget: "machine-b" }, ctx("session-1"));
      expect(again.handoff).toBeNull();
    } finally {
      await registry.dispose();
    }
  });

  it("rejects unknown targets instead of recording a dead binding", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const thread = await registry.createThread(createInput());
      await bindSession(registry, thread.id, "session-1");
      const host = {
        threadRegistry: registry,
        managedRemoteTargets: { targetFor: async () => null },
        computerService: { list: async () => ({ machines: [], desktops: [{ id: "desk-1" }] }) },
      };
      const set = createEnvironmentSetService(host as never);
      await expect(set.handle({ workTarget: "ghost" }, ctx("session-1"))).rejects.toThrow(/machine|target/i);
      await expect(set.handle({ desktopId: "ghost" }, ctx("session-1"))).rejects.toThrow(/desktop/i);
      expect(await registry.getThreadById("ws-1", thread.id)).not.toHaveProperty("environment");
    } finally {
      await registry.dispose();
    }
  });

  it("clears a field with null while keeping the other", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const thread = await registry.createThread(createInput());
      await bindSession(registry, thread.id, "session-1");
      const host = {
        threadRegistry: registry,
        managedRemoteTargets: { targetFor: async (_s: string, id: string) => ({ machineId: id }) },
        computerService: { list: async () => ({ machines: [], desktops: [{ id: "desk-1" }] }) },
      };
      const set = createEnvironmentSetService(host as never);
      await set.handle({ workTarget: "machine-a", desktopId: "desk-1" }, ctx("session-1"));
      const cleared = await set.handle({ workTarget: null }, ctx("session-1"));
      expect(cleared.environment).toMatchObject({ desktopId: "desk-1" });
      expect(cleared.environment).not.toHaveProperty("workTarget");
      const emptied = await set.handle({ desktopId: null }, ctx("session-1"));
      expect(emptied.environment).toBeNull();
      expect(await registry.getThreadById("ws-1", thread.id)).not.toHaveProperty("environment");
    } finally {
      await registry.dispose();
    }
  });

  it("routes computer observations through the bound desktop without retargeting", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const thread = await registry.createThread(createInput());
      await bindSession(registry, thread.id, "session-1");
      const observe = vi.fn(async () => ({ observation: { id: "obs-1" } }));
      const host = {
        threadRegistry: registry,
        computerService: {
          list: async () => ({ machines: [], desktops: [{ id: "desk-9" }] }),
          observe,
        },
      };
      const set = createEnvironmentSetService(host as never);
      await set.handle({ desktopId: "desk-9" }, ctx("session-1"));
      const service = createComputerObserveService(host as never);
      await service.handle({ app: "Notepad" }, ctx("session-1"));
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ desktopId: "desk-9", app: "Notepad" }));
      // An explicit desktopId still wins over the binding.
      await service.handle({ app: "Notepad", desktopId: "desk-else" }, ctx("session-1"));
      expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ desktopId: "desk-else" }));
    } finally {
      await registry.dispose();
    }
  });

  it("answers with no binding for sessions outside the Thread catalog and rejects set", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const host = { threadRegistry: registry };
      const get = createEnvironmentGetService(host as never);
      expect(await get.handle({}, ctx("unbound-session"))).toEqual({ threadId: null, environment: null });
      const set = createEnvironmentSetService(host as never);
      await expect(set.handle({ workTarget: "m" }, ctx("unbound-session"))).rejects.toThrow(/Thread/);
    } finally {
      await registry.dispose();
    }
  });

  it("dispatches carry and inherit the environment binding", async () => {
    const registry = createThreadRegistry({ dataDir: dataDir(), hostId: "host-1" });
    try {
      const parent = await registry.createThread({
        ...createInput(),
        environment: { workTarget: "machine-parent", desktopId: "desk-p" },
      });
      expect(parent.environment).toMatchObject({ workTarget: "machine-parent", desktopId: "desk-p" });
      const child = await registry.createThread({
        ...createInput(),
        parent: { kind: "thread", id: parent.id },
      });
      // A child without an explicit binding inherits its parent's placement.
      expect(child.environment).toMatchObject({ workTarget: "machine-parent", desktopId: "desk-p" });
      const other = await registry.createThread({
        ...createInput(),
        parent: { kind: "thread", id: parent.id },
        environment: { workTarget: "machine-other" },
      });
      expect(other.environment).toMatchObject({ workTarget: "machine-other" });
      expect(other.environment).not.toHaveProperty("desktopId");
    } finally {
      await registry.dispose();
    }
  });
});
