import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createShellSupervisor,
  selectInterpreter,
  stripControlSequences,
  type DiscoveredShells,
  type PtyProcess,
  type PtyProvider,
  type ShellCommandCompletedEvent,
  type ShellCommandStartedEvent,
} from "./shell-supervisor.js";
import { createOutputStore } from "./output-store.js";

const EMPTY_DISCOVERED: DiscoveredShells = {};
type TestSupervisor = ReturnType<typeof createShellSupervisor>;

const waitForRuntimeShellId = async (supervisor: TestSupervisor, id: string): Promise<string> => {
  if (id.startsWith("sh_")) return id;
  let shellId: string | undefined;
  await vi.waitFor(async () => {
    shellId = (await supervisor.read(id)).shellId;
    expect(shellId).toMatch(/^sh_/);
  });
  return shellId!;
};

describe("selectInterpreter", () => {
  it("returns remote on remote=true regardless of platform", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: true,
    });
    expect("kind" in result && result.kind).toBe("remote");
  });

  it("returns git-bash on win32 + auto when gitBashPath is found", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("git-bash");
  });

  it("returns unavailable on win32 + auto when no git bash", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.unavailable.reason).toMatch(/Git for Windows/);
    }
  });

  it("returns wsl on win32 + auto when workspaceRoot is a WSL path", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "\\\\wsl.localhost\\Ubuntu\\home\\user\\project",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("wsl");
    if ("kind" in result && result.kind === "wsl") {
      expect(result.distro).toBe("Ubuntu");
    }
  });

  it("returns wsl on win32 + wsl setting with distros", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "wsl",
      discovered: { wslDistros: ["Ubuntu"] },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("wsl");
  });

  it("returns unavailable on win32 + wsl setting without distros", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "wsl",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
  });

  it("returns powershell on win32 + powershell setting", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "powershell",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("powershell");
    expect(result).toMatchObject({
      kind: "powershell",
      args: ["-NoLogo", "-NoProfile", "-NoExit"],
    });
  });

  it("returns unavailable for powershell on non-Windows", () => {
    const result = selectInterpreter({
      platform: "darwin",
      workspaceRoot: "/workspace",
      setting: "powershell",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
  });

  it("returns bash on darwin + auto", () => {
    const result = selectInterpreter({
      platform: "darwin",
      workspaceRoot: "/workspace",
      setting: "auto",
      discovered: { hasBash: true },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("bash");
  });

  it("returns bash on linux + auto", () => {
    const result = selectInterpreter({
      platform: "linux",
      workspaceRoot: "/workspace",
      setting: "auto",
      discovered: { hasBash: true },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("bash");
  });

  it("returns git-bash on win32 + git-bash setting with path", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "git-bash",
      discovered: { gitBashPath: "C:\\Git\\bin\\bash.exe" },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("git-bash");
    if ("kind" in result && result.kind === "git-bash") {
      expect(result.env.MSYS_NO_PATHCONV).toBe("1");
      expect(result.command).toBe("C:\\Git\\bin\\bash.exe");
    }
  });

  it("does not rewrite usr\\bin\\bash.exe into usr\\usr\\bin", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: { gitBashPath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" },
      remote: false,
    });
    expect(result).toMatchObject({
      kind: "git-bash",
      command: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    });
  });

  it("returns unavailable when powershell is explicitly missing", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "powershell",
      discovered: { hasPowerShell: false },
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.unavailable.reason).toMatch(/PowerShell not found/);
    }
  });
});

describe("stripControlSequences", () => {
  it("removes CSI sequences", () => {
    expect(stripControlSequences("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("removes OSC sequences", () => {
    expect(stripControlSequences("\x1b]0;title\x07text")).toBe("text");
  });

  it("removes bare escape sequences", () => {
    expect(stripControlSequences("\x1b[?25htext\x1b[?25l")).toBe("text");
  });

  it("preserves regular text", () => {
    expect(stripControlSequences("hello world")).toBe("hello world");
  });

  it("handles mixed sequences", () => {
    expect(stripControlSequences("\x1b[1mbold\x1b[0m \x1b]0;title\x07 normal")).toBe("bold  normal");
  });

  it("does not expose an incomplete control sequence as output text", () => {
    expect(stripControlSequences("ready\x1b[31")).toBe("ready");
  });
});

describe("background shell output", () => {
  it.each(["foreground", "background"] as const)("waits for complete cwd and exit markers in %s output", async (mode) => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const emit = (data: string) => { for (const handler of dataHandlers) handler(data); };
    let commandWritten!: (token: string) => void;
    const commandReady = new Promise<string>((resolve) => { commandWritten = resolve; });
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) { queueMicrotask(() => emit(`${ready}\n`)); return; }
        const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
        if (token) commandWritten(token);
      },
    };
    const outputStore = createOutputStore();
    const completedEvents: ShellCommandCompletedEvent[] = [];
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: `split-markers-${mode}`,
      cwd: tmpdir(),
      ptyProvider: { backend: "fake", spawn: () => process },
      commandLifecycle: { completed: (event) => { completedEvents.push(event); } },
    });
    try {
      const execution = supervisor.exec("command", { waitMs: mode === "background" ? 0 : 10_000 });
      const token = await commandReady;
      if (mode === "background") {
        const result = await execution;
        expect(["preparing", "background"]).toContain(result.kind);
        if (result.kind !== "preparing" && result.kind !== "background") throw new Error("expected pending execution");
        await waitForRuntimeShellId(supervisor, result.id);
      }
      emit(`__VARIN_SENTINEL_${token}:B\nbody\n__VARIN_SENTINEL_${token}:C:`);
      emit(`1\r\n__VARIN_SENTINEL_${token}:E:2`);
      expect(completedEvents).toHaveLength(0);
      emit("7\r");
      expect(completedEvents).toHaveLength(0);
      emit("\n");
      if (mode === "foreground") {
        expect(await execution).toMatchObject({ kind: "completed", cwd: tmpdir(), exitCode: 27 });
      }
      await vi.waitFor(() => expect(completedEvents).toHaveLength(1));
      expect(completedEvents[0]).toMatchObject({ cwd: tmpdir(), exitCode: 27 });
      const output = await supervisor.read(completedEvents[0]!.executionId);
      expect(output).toMatchObject({ running: false, exitCode: 27 });
      expect(output.text).toContain("body");
      expect(output.text).not.toContain("VARIN_SENTINEL");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("keeps collecting output and observes the exit sentinel after a command backgrounds", async () => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const largeChunk = "x".repeat(40_000);
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
          return;
        }
        const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
        if (!token) return;
        queueMicrotask(() => { for (const handler of dataHandlers) handler(`__VARIN_SENTINEL_${token}:B\n${largeChunk}`); });
        setTimeout(() => {
          for (const handler of dataHandlers) handler(` tail-marker\n__VARIN_SENTINEL_${token}:C:1\n__VARIN_SENTINEL_${token}:E:0\n`);
        }, 30);
      },
    };
    const ptyProvider: PtyProvider = { backend: "fake", spawn: () => process };
    const outputStore = createOutputStore();
    const startedEvents: ShellCommandStartedEvent[] = [];
    const completedEvents: ShellCommandCompletedEvent[] = [];
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "background-test",
      ptyProvider,
      commandLifecycle: {
        started: (event) => { startedEvents.push(event); },
        completed: (event) => { completedEvents.push(event); },
      },
    });
    try {
      const result = await supervisor.exec("slow command", { waitMs: 5 });
      expect(["preparing", "background"]).toContain(result.kind);
      if (result.kind !== "preparing" && result.kind !== "background") throw new Error("expected a pending shell execution");
      const shellId = await waitForRuntimeShellId(supervisor, result.id);
      await vi.waitFor(() => expect(startedEvents).toHaveLength(1));
      expect(startedEvents[0]).toMatchObject({ command: "slow command", commandRunId: "sh_1", executionId: expect.any(String) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({ command: "slow command", commandRunId: "sh_1", exitCode: 0, cancelled: false });
      expect(completedEvents[0]?.outputHandle).toMatch(/^out_/);
      const read = await supervisor.read(shellId, 0, 100_000);
      expect(read.text).toContain(largeChunk);
      expect(read.text).toContain("tail-marker");
      expect(read).toMatchObject({ running: false, exitCode: 0 });
      expect(read.text).not.toContain("VARIN_SENTINEL");
      const byHandle = await supervisor.read(completedEvents[0]!.outputHandle!, 0, 100_000);
      expect(byHandle.text).toBe(read.text);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("protects the session cwd when a command backgrounds without an explicit cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-protect-"));
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
        }
      },
    };
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore: createOutputStore(),
      sessionId: "protect-cwd",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const started = await supervisor.exec("never completes", { waitMs: 5 });
      expect(["preparing", "background"]).toContain(started.kind);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(true);
      expect(supervisor.hasActiveCommandAt(join(workspace, "nested-worktree"))).toBe(true);
      expect(supervisor.hasActiveCommandAt(join(workspace, "..", "unrelated-worktree"))).toBe(false);
    } finally {
      await supervisor.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("shell respawn working directory", () => {
  // Mimics the terminal runtime's cwd validation: spawn rejects directories
  // that do not exist.
  const controlledShell = (
    shouldComplete: (commandIndex: number) => boolean = () => true,
  ): {
    provider: PtyProvider;
    spawnCwds: string[];
    processes: PtyProcess[];
    writes: string[];
  } => {
    const spawnCwds: string[] = [];
    const processes: PtyProcess[] = [];
    const writes: string[] = [];
    let commandIndex = 0;
    const provider: PtyProvider = {
      backend: "fake",
      spawn: (_executable, _args, options) => {
        const cwd = String(options.cwd);
        if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
          throw new Error("Invalid working directory");
        }
        spawnCwds.push(cwd);
        const dataHandlers = new Set<(data: string) => void>();
        const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
        const process: PtyProcess = {
          kill: () => { for (const handler of exitHandlers) handler({ exitCode: 143, signal: 15 }); },
          onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
          onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
          resize: () => undefined,
          write: (data) => {
            writes.push(data);
            const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
            if (ready) {
              queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
              return;
            }
            const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
            if (!token) return;
            const index = commandIndex++;
            queueMicrotask(() => {
              for (const handler of dataHandlers) {
                handler([
                  `__VARIN_SENTINEL_${token}:B`,
                  `__VARIN_SENTINEL_${token}:C:1`,
                  ...(shouldComplete(index) ? [`__VARIN_SENTINEL_${token}:E:0`] : []),
                  "",
                ].join("\n"));
              }
            });
          },
        };
        processes.push(process);
        return process;
      },
    };
    return { provider, spawnCwds, processes, writes };
  };

  it("falls back to the session cwd when the tracked shell cwd no longer exists", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    const vanished = join(workspace, "vanished");
    mkdirSync(vanished);
    const { provider, spawnCwds, processes } = controlledShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "respawn-stale-cwd",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      const first = await supervisor.exec("command in temporary directory", { waitMs: 1000, cwd: vanished });
      expect(first).toMatchObject({ kind: "completed", exitCode: 0 });
      rmSync(vanished, { recursive: true, force: true });
      processes[0]!.kill();
      const second = await supervisor.exec("echo ok", { waitMs: 1000 });
      expect(second).toMatchObject({ kind: "completed", exitCode: 0 });
      expect(spawnCwds).toEqual([vanished, workspace]);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses the requested cwd when respawning with an invalid tracked cwd", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    const vanished = join(workspace, "vanished");
    const rescue = join(workspace, "rescue");
    mkdirSync(vanished);
    mkdirSync(rescue);
    const { provider, spawnCwds, processes } = controlledShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "respawn-preferred-cwd",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      await supervisor.exec("command in temporary directory", { waitMs: 1000, cwd: vanished });
      rmSync(vanished, { recursive: true, force: true });
      processes[0]!.kill();
      const second = await supervisor.exec("echo ok", { waitMs: 1000, cwd: rescue });
      expect(second).toMatchObject({ kind: "completed", exitCode: 0 });
      expect(spawnCwds[1]).toBe(rescue);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retries the request's frozen cwd after a failed directory switch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-anchor-confirm-"));
    const selected = join(workspace, "selected");
    mkdirSync(selected);
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const writes: string[] = [];
    let selectedCwdFailures = 0;
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        writes.push(data);
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
          return;
        }
        const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
        if (!token) return;
        const failedSwitch = data.includes(`cd -- '${selected}'; then`) && selectedCwdFailures++ === 0;
        queueMicrotask(() => {
          for (const handler of dataHandlers) {
            handler([
              ...(failedSwitch ? [] : [`__VARIN_SENTINEL_${token}:B`]),
              ...(failedSwitch ? [] : ["payload-ran"]),
              `__VARIN_SENTINEL_${token}:C:${failedSwitch ? 0 : 1}`,
              `__VARIN_SENTINEL_${token}:E:${failedSwitch ? 1 : 0}`,
              "",
            ].join("\n"));
          }
        });
      },
    };
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "anchor-confirmation",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      supervisor.setAnchorCwd(workspace);
      await expect(supervisor.exec("initial", { waitMs: 1000 })).resolves.toMatchObject({
        kind: "completed", exitCode: 0, cwd: workspace,
      });

      supervisor.setAnchorCwd(selected);
      const rejectedSwitch = await supervisor.exec("must-not-run", { waitMs: 1000 });
      expect(rejectedSwitch).toMatchObject({ kind: "completed", exitCode: 1, cwd: workspace });
      if (rejectedSwitch.kind === "completed") expect(rejectedSwitch.stdout.trim()).toBe("");

      const retriedSwitch = await supervisor.exec("after-retry", { waitMs: 1000 });
      expect(retriedSwitch).toMatchObject({ kind: "completed", exitCode: 0, cwd: selected });
      if (retriedSwitch.kind === "completed") expect(retriedSwitch.stdout.trim()).toBe("payload-ran");
      expect(writes.filter((write) => write.includes(`cd -- '${selected}'; then`))).toHaveLength(2);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("normalizes git-bash cwd state and recovers after killing the background shell", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    // A caller can supply git-bash /c/... mounts; spawn still gets a native path.
    const posixWorkspace = `/${workspace[0]!.toLowerCase()}${workspace.slice(2).replaceAll("\\", "/")}`;
    const { provider, spawnCwds } = controlledShell((index) => index !== 1);
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "git-bash", command: "bash.exe", args: ["-l"], env: {} },
      outputStore,
      sessionId: "respawn-posix-cwd",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      const first = await supervisor.exec("echo first", { waitMs: 1000, cwd: posixWorkspace });
      expect(first).toMatchObject({ kind: "completed", exitCode: 0, cwd: workspace });

      const background = await supervisor.exec("grep forever", { waitMs: 5 });
      expect(["preparing", "background"]).toContain(background.kind);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(true);
      if (background.kind !== "background" && background.kind !== "preparing") throw new Error("expected pending shell execution");
      const backgroundShellId = await waitForRuntimeShellId(supervisor, background.id);
      await expect(supervisor.kill(backgroundShellId)).resolves.toBe(true);

      const recovered = await supervisor.exec("echo ok", { waitMs: 1000 });
      expect(recovered).toMatchObject({ kind: "completed", exitCode: 0, cwd: workspace });
      expect(spawnCwds).toEqual([workspace, workspace]);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails an explicit missing cwd before writing a command into the live shell", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    const missing = join(workspace, "missing");
    const { provider, spawnCwds } = controlledShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "explicit-missing-cwd",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 1000 })).resolves.toMatchObject({ kind: "completed" });
      await expect(supervisor.exec("echo should-not-run", { waitMs: 1000, cwd: missing })).resolves.toMatchObject({
        kind: "spawn-failed",
        reason: "invalid-cwd",
      });
      expect(spawnCwds).toEqual([workspace]);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not fall back to the Host cwd when the session root no longer exists", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    const { provider, processes, spawnCwds } = controlledShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "missing-session-root",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 1000 })).resolves.toMatchObject({ kind: "completed" });
      processes[0]!.kill();
      rmSync(workspace, { recursive: true, force: true });
      await expect(supervisor.exec("echo should-not-run", { waitMs: 1000 }))
        .resolves.toMatchObject({ kind: "spawn-failed", reason: "invalid-cwd" });
      expect(spawnCwds).toEqual([workspace]);
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("renders a native requested cwd in a form git-bash can cd into", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-cwd-"));
    const child = join(workspace, "child");
    mkdirSync(child);
    const { provider, writes } = controlledShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "git-bash", command: "bash.exe", args: ["-l"], env: {} },
      outputStore,
      sessionId: "git-bash-explicit-cwd",
      cwd: workspace,
      ptyProvider: provider,
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 1000 })).resolves.toMatchObject({ cwd: workspace });
      await expect(supervisor.exec("echo second", { waitMs: 1000, cwd: child })).resolves.toMatchObject({ cwd: child });
      const commandWrite = writes.find((write) => write.includes("echo second"));
      expect(commandWrite).toContain(`cd -- '${child.replaceAll("\\", "/")}'; then`);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("shell-supervisor initialization and cancellation", () => {
  type Mode = "init-fails" | "init-write-fails" | "never-ready" | "pending";

  const fakeProcess = (mode: Mode): PtyProcess => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    let exited = false;
    return {
      kill: () => {
        if (exited) return;
        exited = true;
        for (const handler of exitHandlers) handler({ exitCode: 143, signal: 15 });
      },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready && mode === "pending") {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
        }
        if (ready && mode === "init-fails") {
          queueMicrotask(() => { for (const handler of exitHandlers) handler({ exitCode: 17, signal: 0 }); });
        }
        if (ready && mode === "init-write-fails") throw new Error("init write failed");
      },
    };
  };

  it("rejects initialization and allows a later retry instead of hanging", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-failure",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("init-fails") },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow(/Shell exited before ready|disposed/);
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow(/Shell exited before ready|disposed/);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("reports a provider failure without leaving an unhandled readiness promise", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "provider-failure",
      ptyProvider: { backend: "fake", spawn: () => { throw new Error("spawn failed"); } },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow("spawn failed");
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow("spawn failed");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("cleans up when the initial marker write fails", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-write-failure",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("init-write-fails") },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow("init write failed");
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow("init write failed");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("resolves an in-flight command and closes its writer when disposed", async () => {
    const outputStore = createOutputStore();
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "command-dispose",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("pending") },
      registerWriter: async () => ({ close: async () => { writerClosed++; } }),
    });
    const resultPromise = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.dispose();
    await expect(resultPromise).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
    expect(writerClosed).toBe(1);
    outputStore.dispose();
  });

  it("cancels a shell that is still waiting for its initial marker", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-dispose",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("never-ready") },
    });
    const resultPromise = supervisor.exec("echo never", { waitMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.dispose();
    await expect(resultPromise).rejects.toThrow(/disposed/);
    outputStore.dispose();
  });
});

describe("shell-supervisor disposal protection", () => {
  const controlledProcess = (options: {
    failSecondExitRegistration?: boolean;
    killThrows?: boolean;
    killEmitsExit?: boolean;
    readyDelayMs?: number;
  } = {}): PtyProcess & { emitData: (data: string) => void; emitExit: () => void } => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    let exitRegistrations = 0;
    return {
      emitData: (data) => { for (const handler of [...dataHandlers]) handler(data); },
      emitExit: () => { for (const handler of [...exitHandlers]) handler({ exitCode: 0, signal: 0 }); },
      kill: () => {
        if (options.killThrows) throw new Error("kill failed");
        if (options.killEmitsExit) {
          for (const handler of [...exitHandlers]) handler({ exitCode: 0, signal: 0 });
        }
      },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => {
        exitRegistrations++;
        if (options.failSecondExitRegistration && exitRegistrations > 1) throw new Error("exit wait registration failed");
        exitHandlers.add(handler);
        return { dispose: () => exitHandlers.delete(handler) };
      },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          const emitReady = () => { for (const handler of dataHandlers) handler(`${ready}\n`); };
          if (options.readyDelayMs) setTimeout(emitReady, options.readyDelayMs);
          else queueMicrotask(emitReady);
        }
      },
    };
  };

  it("returns a queryable identity for waitMs zero and waits for output without locking controls", async () => {
    const outputStore = createOutputStore();
    const process = controlledProcess({ readyDelayMs: 10 });
    let starts = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "output-wait",
      ptyProvider: { backend: "fake", spawn: () => process },
      commandLifecycle: { started: () => { starts += 1; } },
    });
    try {
      const started = await supervisor.exec("long command", { waitMs: 0, toolCallId: "call-1" });
      expect(started).toMatchObject({ kind: "preparing", id: expect.stringMatching(/^exec_[0-9a-f]{32}$/u), waitedMs: expect.any(Number), toolCallId: "call-1" });
      if (started.kind !== "preparing") throw new Error("expected accepted execution identity");
      await expect(supervisor.write(started.id, "too early\n")).resolves.toBe(false);
      await expect(supervisor.kill(started.id)).resolves.toBe(false);
      await expect(supervisor.exec("long command", { waitMs: 0, toolCallId: "call-1" })).resolves.toEqual(started);
      const shellId = await waitForRuntimeShellId(supervisor, started.id);
      expect(shellId).toBe("sh_1");
      await vi.waitFor(() => expect(starts).toBe(1));
      await expect(supervisor.read(started.id)).resolves.toMatchObject({ running: true, shellId });

      const newOutput = supervisor.waitForOutput(shellId, 0, 1_000);
      await expect(supervisor.write(shellId, "input\n")).resolves.toBe(true);
      process.emitData("new output\nsecond line\n");
      await expect(newOutput).resolves.toBeUndefined();
      const first = await supervisor.read(shellId);
      expect(first).toMatchObject({ running: true });
      expect(first.text).toBe("new output\nsecond line\n");
      await expect(supervisor.read("call-1")).resolves.toMatchObject({ shellId, text: first.text });
      await expect(supervisor.read(started.id)).resolves.toMatchObject({ shellId, text: first.text });

      const controller = new AbortController();
      const cancelledWait = supervisor.waitForOutput(shellId, first.nextOffset, 1_000, controller.signal);
      controller.abort();
      await expect(cancelledWait).rejects.toThrow("Shell output wait aborted");
      await expect(supervisor.read(shellId)).resolves.toMatchObject({ running: true });

      const exited = supervisor.waitForOutput(shellId, first.nextOffset, 1_000);
      process.emitExit();
      await expect(exited).resolves.toBeUndefined();
      await expect(supervisor.read(started.id)).resolves.toMatchObject({
        running: false, exitCode: 0, shellId, text: first.text, eof: true,
      });
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  it("turns a cancelled startup observation into a recoverable background command", async () => {
    const outputStore = createOutputStore();
    const process = controlledProcess();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "exec-cancel",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const controller = new AbortController();
      const execution = supervisor.exec("long command", {
        waitMs: 10_000,
        toolCallId: "call-cancel",
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(execution).resolves.toMatchObject({ kind: "background", id: "sh_1" });
      await expect(supervisor.read("call-cancel")).resolves.toMatchObject({ running: true, shellId: "sh_1" });
      process.emitExit();
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  const setup = async (options: {
    failSecondExitRegistration?: boolean;
    killThrows?: boolean;
  } = {}) => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-dispose-protection-"));
    const outputStore = createOutputStore();
    const process = controlledProcess(options);
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "dispose-protection",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => ({ close: async () => { writerClosed++; } }),
    });
    const command = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { command, outputStore, process, supervisor, workspace, get writerClosed() { return writerClosed; } };
  };

  it("reports an accepted execution unavailable after its session supervisor is replaced", async () => {
    const outputStore = createOutputStore();
    const firstProcess = controlledProcess({ killEmitsExit: true });
    const first = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "replaced-supervisor",
      ptyProvider: { backend: "fake", spawn: () => firstProcess },
    });
    let executionId: string;
    try {
      const accepted = await first.exec("long command", { waitMs: 0, toolCallId: "call-old-host" });
      if (accepted.kind !== "preparing" && accepted.kind !== "background") throw new Error("expected a pending execution");
      executionId = accepted.executionId!;
      await first.dispose();
      const replacement = createShellSupervisor({
        interpreter: { kind: "bash", command: "bash", args: [], env: {} },
        outputStore,
        sessionId: "replaced-supervisor",
        ptyProvider: { backend: "fake", spawn: () => controlledProcess() },
      });
      try {
        await expect(replacement.read(executionId)).resolves.toMatchObject({
          running: false,
          unavailable: expect.stringContaining("not retained"),
        });
      } finally { await replacement.dispose(); }
    } finally {
      await first.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  it("keeps the writer and active directory protected when exit confirmation fails", async () => {
    const state = await setup({ failSecondExitRegistration: true });
    try {
      await expect(state.supervisor.dispose()).rejects.toThrow("Shell process did not exit during disposal");
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("keeps the writer while exit is delayed, then releases it after confirmation", async () => {
    const state = await setup();
    try {
      const disposePromise = state.supervisor.dispose();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(disposePromise).resolves.toBeUndefined();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("consumes a kill failure waiter and keeps protection until a later exit", async () => {
    const state = await setup({ killThrows: true });
    try {
      await expect(state.supervisor.dispose()).rejects.toThrow("kill failed");
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("reports a failed kill when interrupt does not produce a terminal exit", async () => {
    const outputStore = createOutputStore();
    const process = controlledProcess();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "background-kill",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const started = await supervisor.exec("never completes", { waitMs: 0 });
      if (started.kind !== "preparing" && started.kind !== "background") throw new Error("expected pending execution");
      const shellId = await waitForRuntimeShellId(supervisor, started.id);
      await expect(supervisor.kill(shellId)).resolves.toBe(false);
      await expect(supervisor.read(shellId)).resolves.toMatchObject({ running: true });
      process.emitExit();
      await vi.waitFor(async () => {
        expect(await supervisor.read(shellId)).toMatchObject({ running: false, exitCode: 0 });
      });
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  it("returns from kill only after the background PTY exits", async () => {
    const outputStore = createOutputStore();
    const process = controlledProcess({ killEmitsExit: true });
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "background-kill-success",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const started = await supervisor.exec("never completes", { waitMs: 0 });
      if (started.kind !== "preparing" && started.kind !== "background") throw new Error("expected pending execution");
      const shellId = await waitForRuntimeShellId(supervisor, started.id);
      await expect(supervisor.kill(shellId)).resolves.toBe(true);
      await expect(supervisor.read(shellId)).resolves.toMatchObject({ running: false });
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  it("waits for a writer registration already in flight before disposal resolves", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-dispose-starting-"));
    const outputStore = createOutputStore();
    const process = controlledProcess();
    let resolveWriter: (writer: { close: () => Promise<void> }) => void = () => undefined;
    const writerPromise = new Promise<{ close: () => Promise<void> }>((resolve) => { resolveWriter = resolve; });
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "dispose-starting",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => writerPromise,
    });
    const command = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      let disposeDone = false;
      const disposePromise = supervisor.dispose().then(() => { disposeDone = true; });
      process.emitExit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(disposeDone).toBe(false);
      expect(writerClosed).toBe(0);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(true);
      resolveWriter({ close: async () => { writerClosed++; } });
      await expect(disposePromise).resolves.toBeUndefined();
      await expect(command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      expect(writerClosed).toBe(1);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(false);
    } finally {
      resolveWriter({ close: async () => { writerClosed++; } });
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the directory protected and retries when writer release fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-writer-retry-"));
    const outputStore = createOutputStore();
    const process = controlledProcess();
    let closeAttempts = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "writer-retry",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => ({
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("release failed");
        },
      }),
    });
    try {
      await expect(supervisor.exec("never completes", { waitMs: 5 })).resolves.toMatchObject({
        kind: "background",
        id: "sh_1",
      });
      process.emitExit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closeAttempts).toBe(1);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(true);

      await expect(supervisor.dispose()).resolves.toBeUndefined();
      expect(closeAttempts).toBe(2);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(false);
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});


describe("RR3 command payload framing and execution identity", () => {
  /** A fake PTY that records writes and answers a framed command. */
  const fakeShell = (onCommand?: (commandWrite: string) => string[]) => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const writes: string[] = [];
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        writes.push(data);
        const ready = data.match(/(__VARIN_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}
`); });
          return;
        }
        const token = data.match(/__VARIN_SENTINEL_([0-9a-f]+)/)?.[1];
        if (!token) return;
        const lines = onCommand?.(data) ?? ["payload-output", 0];
        queueMicrotask(() => {
          // Real shells stream output in chunks: begin + body arrive before
          // the cwd/exit sentinels so the foreground command stays live while
          // observing output.
          for (const handler of dataHandlers) handler(`__VARIN_SENTINEL_${token}:B\n${String(lines[0])}\n`);
        });
        queueMicrotask(() => {
          for (const handler of dataHandlers) {
            handler(`__VARIN_SENTINEL_${token}:C:1\n` + (lines[1] === undefined ? "" : `__VARIN_SENTINEL_${token}:E:${lines[1]}\n`));
          }
        });
      },
    };
    return { process, writes };
  };

  it("sends the user command as a self-contained eval payload, not inside the control syntax", async () => {
    const { process, writes } = fakeShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "framing",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      // A heredoc without a trailing newline followed by a tail comment — the
      // old `{ …; }` interpolation glued the epilogue onto the delimiter line.
      const heredoc = "cat <<EOF\nbody\nEOF # done";
      await supervisor.exec(heredoc, { waitMs: 1000 });
      const commandWrite = writes.find((write) => write.includes(":B"));
      expect(commandWrite).toBeDefined();
      expect(commandWrite).toContain("eval $'");
      expect(commandWrite).not.toContain("{ cat <<EOF");
      // The payload keeps the literal heredoc inside the quoted unit, with a
      // real newline appended inside the eval string.
      expect(commandWrite).toContain("cat <<EOF\\nbody\\nEOF # done\\n");
      // Control framing lives outside the payload on the same line.
      expect(commandWrite).toContain(':B"; eval $\'');
      expect(commandWrite).toContain("__ec=$?");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("recovers full output by call and execution ids, including before lifecycle acknowledgement", async () => {
    const body = "x".repeat(70_000) + "tail-marker";
    const { process } = fakeShell(() => [body, "0"]);
    const outputStore = createOutputStore();
    let finish!: () => void;
    const finished = new Promise<void>((r) => { finish = r; });
    let completion!: ShellCommandCompletedEvent;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore, sessionId: "recover-full", ptyProvider: { backend: "fake", spawn: () => process },
      commandLifecycle: { completed: (event) => { completion = event; return finished; } },
    });
    try {
      const pending = supervisor.exec("produce output", { toolCallId: "call-full", waitMs: 1000 });
      void pending.catch(() => undefined);
      await vi.waitFor(() => expect(completion).toBeDefined());
      const byCall = await supervisor.read("call-full", 0, 100_000);
      expect(byCall.running).toBe(false);
      expect(byCall.text).toContain(body);
      const byExecution = await supervisor.read(completion.executionId, 0, 100_000);
      expect(byExecution.text).toBe(byCall.text);
      const completed = await pending;
      if (completed.kind !== "completed" || !completed.handle) throw new Error("expected a paged output handle");
      expect(completed.handle).toMatch(/^out_/);
      let offset = 0;
      let restored = "";
      while (offset < Buffer.byteLength(body, "utf8")) {
        const page = await supervisor.read(completed.handle, offset, 32_768);
        restored += page.text;
        offset = page.nextOffset;
      }
      expect(restored).toBe(byCall.text);
      finish();
      await expect(pending).resolves.toMatchObject({ kind: "completed", exitCode: 0, handle: completed.handle });
      outputStore.dropSession("recover-full");
      await expect(supervisor.read(completed.handle)).rejects.toThrow(/Output expired/);
      await expect(supervisor.read("call-full")).rejects.toThrow(/Output expired/);
    } finally { finish(); await supervisor.dispose(); outputStore.dispose(); }
  });

  it("returns an independent preparing identity when the accepted wait budget expires during startup", async () => {
    const largeOutput = `payload-output\n${"z".repeat(40_000)}tail-marker`;
    const { process } = fakeShell(() => [largeOutput, "0"]);
    const outputStore = createOutputStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} }, outputStore,
      sessionId: "recover-startup", ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => { await gate; return { close: async () => undefined }; },
    });
    try {
      const observedAt = Date.now();
      const pending = supervisor.exec("echo later", { toolCallId: "call-startup", waitMs: 20 });
      const preparation = await pending;
      expect(preparation).toMatchObject({
        kind: "preparing",
        id: expect.stringMatching(/^exec_[0-9a-f]{32}$/),
        executionId: expect.stringMatching(/^exec_[0-9a-f]{32}$/),
        toolCallId: "call-startup",
      });
      if (preparation.kind !== "preparing") throw new Error("expected a preparation identity");
      const responseElapsedMs = Date.now() - observedAt;
      expect(preparation.id).toBe(preparation.executionId);
      expect(preparation.waitedMs).toBeGreaterThanOrEqual(20);
      expect(preparation.waitedMs).toBe(preparation.timing.detachedAt! - preparation.timing.acceptedAt);
      expect(responseElapsedMs).toBeLessThan(1000);
      expect(preparation.timing.acceptedAt).toBeLessThanOrEqual(preparation.timing.detachedAt!);
      expect(preparation.timing.detachedAt).toBeLessThanOrEqual(preparation.timing.respondedAt!);
      expect(await supervisor.read("call-startup")).toMatchObject({ running: true, phase: "preparing", eof: false });
      expect(await supervisor.read(preparation.id)).toMatchObject({ running: true, phase: "preparing", executionId: preparation.id });
      await expect(supervisor.write(preparation.id, "input\n")).resolves.toBe(false);
      await expect(supervisor.kill(preparation.id)).resolves.toBe(false);
      await expect(supervisor.exec("echo later", { toolCallId: "call-startup", waitMs: 20 })).resolves.toEqual(preparation);
      release();
      await vi.waitFor(async () => {
        await expect(supervisor.read(preparation.id)).resolves.toMatchObject({ running: false, exitCode: 0 });
      });
      const restored = await supervisor.read(preparation.id, 0, 100_000);
      expect(restored.text).toContain(largeOutput);
      expect(restored.text).toContain("tail-marker");
      expect(await supervisor.read("call-startup", 0, 100_000)).toMatchObject({
        running: false,
        exitCode: 0,
        text: restored.text,
      });
    } finally { release(); await supervisor.dispose(); outputStore.dispose(); }
  });

  it("reports an unsettled accepted execution as running, not 'not found'", async () => {
    // Command never finishes — the accepted toolCallId still resolves to the
    // live foreground output.
    const { process } = fakeShell(() => ["partial-output", undefined as never]);
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "pending-read",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const pending = supervisor.exec("long running", { waitMs: 60_000, toolCallId: "call_live" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const slice = await supervisor.read("call_live");
      expect(slice).toMatchObject({ running: true, command: "long running" });
      expect(slice.text).toContain("partial-output");
      // Simulated lost receipt: kill the process mid-flight; the same
      // toolCallId still returns the real terminal exit afterwards.
      process.kill();
      const result = await pending;
      expect(result).toMatchObject({ kind: "completed", exitCode: 0 });
      const after = await supervisor.read("call_live");
      expect(after).toMatchObject({ running: false, exitCode: 0 });
      expect(after.text).toContain("partial-output");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("reports a known accepted id that spawn-failed instead of 'not found'", async () => {
    const { process } = fakeShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "spawn-failed-read",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const result = await supervisor.exec("echo x", { waitMs: 1000, cwd: "/no/such/dir/here", toolCallId: "call_bad" });
      expect(result.kind).toBe("spawn-failed");
      const slice = await supervisor.read("call_bad");
      expect(slice).toMatchObject({ running: false, spawnFailed: "invalid-cwd", eof: true });
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("stamps stage timing on completed results", async () => {
    const { process } = fakeShell();
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "timing",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const result = await supervisor.exec("echo hi", { waitMs: 1000 });
      expect(result).toMatchObject({ kind: "completed", exitCode: 0 });
      const timing = result.kind === "completed" ? result.timing : undefined;
      expect(timing).toBeDefined();
      expect(timing!.acceptedAt).toBeLessThanOrEqual(timing!.sentAt!);
      expect(timing!.sentAt).toBeLessThanOrEqual(timing!.endedAt!);
      expect(timing!.firstOutputAt).toBeDefined();
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });
});
