import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.test-helper.js";
import { createOutputStore } from "./output-store.js";
import { createShellSupervisor, type PtyProcess, type PtyProvider } from "./shell-supervisor.js";

interface FakeProcess extends PtyProcess {
  emitData(data: string): void;
  emitExit(exitCode?: number, signal?: number): void;
  writes: string[];
}

const createFakeProcess = (): FakeProcess => {
  const dataHandlers = new Set<(data: string) => void>();
  const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
  return {
    writes: [],
    write(data: string) {
      this.writes.push(data);
      const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
      if (ready) {
        queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
        return;
      }
      // The submitted wrapper constructs records at execution time, so its
      // echoed input contains the marker base without a complete :B record.
      const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
      if (!token) return;
      queueMicrotask(() => { for (const handler of dataHandlers) handler(`__VARIN_SENTINEL_${token}:B\nprompt>`); });
    },
    resize() {},
    kill() {
      for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 });
    },
    onData(handler) {
      dataHandlers.add(handler);
      return { dispose: () => dataHandlers.delete(handler) };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return { dispose: () => exitHandlers.delete(handler) };
    },
    emitData(data: string) {
      for (const handler of dataHandlers) handler(data);
    },
    emitExit(exitCode = 0, signal = 0) {
      for (const handler of exitHandlers) handler({ exitCode, signal });
    },
  };
};

describe("harness terminal runtime bridge", () => {
  const runtimes: Array<ReturnType<typeof createIsolatedTerminalSessionApi>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("lets the user attach and write to the same background process the agent observes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-term-"));
    dirs.push(workspace);
    const processes: FakeProcess[] = [];
    const ptyProvider: PtyProvider = {
      backend: "fake-pty",
      spawn: () => {
        const process = createFakeProcess();
        processes.push(process);
        return process;
      },
    };
    const runtime = createIsolatedTerminalSessionApi({
      loadPtyProvider: async () => ptyProvider,
      searchPathFor: () => "/bin/sh",
      isExecutable: () => true,
    });
    runtimes.push(runtime);
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: ["-l"], env: {} },
      outputStore,
      sessionId: "bridge",
      cwd: workspace,
      createTerminalSession: (input) => runtime.createTerminalSession(input),
    });
    try {
      const started = await supervisor.exec("read line", { waitMs: 5 });
      expect(started.kind === "background" || started.kind === "preparing").toBe(true);
      if (started.kind !== "background" && started.kind !== "preparing") throw new Error("expected a pending shell command");
      let shellId = started.kind === "background" ? started.id : undefined;
      const deadline = Date.now() + 5_000;
      while (!shellId) {
        shellId = (await supervisor.read(started.id)).shellId;
        if (!shellId && Date.now() > deadline) throw new Error("shell did not finish preparation");
        if (!shellId) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(shellId).toBe("sh_1");
      expect(processes).toHaveLength(1);
      expect(runtime.inspectSession(shellId)).toMatchObject({
        owner: "harness",
        retainWhenDetached: true,
        status: "running",
      });

      const attached = runtime.attachTerminalSession(shellId);
      expect(attached?.id).toBe(shellId);
      const view: string[] = [];
      attached?.onData((data) => { view.push(data); });

      const later = "user typed this\n";
      attached?.write(later);
      expect(processes[0]?.writes).toContain(later);
      expect(await supervisor.write(shellId, "agent-input")).toBe(true);
      expect(processes[0]?.writes).toContain("agent-input");

      processes[0]?.emitData("user typed this\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const observed = await supervisor.read(shellId);
      expect(observed.text).toContain("user typed this");
      expect(observed.running).toBe(true);
      expect(view.join("")).toContain("user typed this");

      const next = await supervisor.exec("echo later", { waitMs: 50 });
      expect(processes).toHaveLength(2);
      expect(runtime.inspectSession(shellId)?.status).toBe("running");
      expect(next.kind === "completed" || next.kind === "background" || next.kind === "preparing").toBe(true);

      processes[0]?.emitExit(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(supervisor.read(shellId)).resolves.toMatchObject({ running: false, exitCode: 0 });
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("allocates distinct runtime-owned shell ids for concurrent supervisors and skips a user id", async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "harness-term-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "harness-term-b-"));
    dirs.push(workspaceA, workspaceB);
    const processes: FakeProcess[] = [];
    const runtime = createIsolatedTerminalSessionApi({
      loadPtyProvider: async () => ({
        backend: "fake-pty",
        spawn: () => {
          const process = createFakeProcess();
          processes.push(process);
          return process;
        },
      }),
      searchPathFor: () => "/bin/sh",
      isExecutable: () => true,
    });
    runtimes.push(runtime);
    const outputStore = createOutputStore();
    const user = await runtime.createTerminalSession({
      sessionId: "sh_1",
      cwd: workspaceA,
      owner: "user",
      spawn: { executable: "/bin/user-shell", args: [] },
    });
    const first = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: ["-l"], env: {} },
      outputStore,
      sessionId: "agent-a",
      cwd: workspaceA,
      createTerminalSession: (input) => runtime.createTerminalSession(input),
    });
    const second = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: ["-l"], env: {} },
      outputStore,
      sessionId: "agent-b",
      cwd: workspaceB,
      createTerminalSession: (input) => runtime.createTerminalSession(input),
    });
    try {
      const [a, b] = await Promise.all([
        first.exec("first", { waitMs: 5 }),
        second.exec("second", { waitMs: 5 }),
      ]);
      expect(user.id).toBe("sh_1");
      expect(a.kind).toBe("background");
      expect(b.kind).toBe("background");
      if (a.kind !== "background" || b.kind !== "background") throw new Error("expected concurrent commands to detach");
      expect(new Set([a.id, b.id])).toEqual(new Set(["sh_2", "sh_3"]));
      expect(runtime.inspectSession(a.id)).toMatchObject({ owner: "harness", cwd: a.cwd });
      expect(runtime.inspectSession(b.id)).toMatchObject({ owner: "harness", cwd: b.cwd });
      expect(runtime.inspectSession("sh_1")).toMatchObject({ owner: "user", cwd: workspaceA });
      expect(new Set([
        runtime.inspectSession("sh_2")?.cwd,
        runtime.inspectSession("sh_3")?.cwd,
      ])).toEqual(new Set([workspaceA, workspaceB]));
      expect(processes).toHaveLength(3);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      outputStore.dispose();
    }
  });
});
