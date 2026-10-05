import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessActorContext, HarnessActorIdentity, HarnessServiceMap } from "@varin/protocol";
import { createDocumentAuthority } from "../documents/authority.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createShellExecService, registerHarnessServices } from "./harness-services.js";
import { createHarnessRouter, type HarnessServiceContext } from "./router.js";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.test-helper.js";
import { discoverShells } from "./shell-discovery.js";
import { createHarnessServiceHost } from "./service-host.js";
import { createVerificationCoordinator } from "./verification-coordinator.js";
import type { ResultVerificationBundle, WorkingStateRootStore } from "./working-state/types.js";

const nativeAuthorityIt = process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1" ? it : it.skip;

const actor = (sessionId: string): HarnessActorIdentity => ({
  authorityInstanceId: "authority-1",
  sessionId,
  workerId: "worker-1",
  workerGeneration: 1,
});

const serviceContext = (sessionId: string, workspaceId: string): HarnessServiceContext => {
  const current: HarnessActorContext = {
    ...actor(sessionId),
    workspaceId,
    grantedCapabilities: ["process.shell"],
  };
  return {
    actor: current,
    authorizedPaths: [],
    sessionId,
    workspaceId,
    signal: new AbortController().signal,
  };
};

const hosts: Array<ReturnType<typeof createHarnessServiceHost>> = [];
const terminals: Array<ReturnType<typeof createIsolatedTerminalSessionApi>> = [];
const dirs: string[] = [];

// Windows runners may report the same directory through an 8.3 alias or its
// long name. Assert the directory identity, which is what shell cwd promises.
const expectCwd = (result: unknown, expected: string): void => {
  const cwd = (result as { cwd?: unknown }).cwd;
  expect(typeof cwd).toBe("string");
  const actual = statSync(cwd as string, { bigint: true });
  const target = statSync(expected, { bigint: true });
  expect(actual.isDirectory()).toBe(true);
  expect({ dev: actual.dev, ino: actual.ino }).toEqual({ dev: target.dev, ino: target.ino });
};

const createHost = (
  options: Parameters<typeof createHarnessServiceHost>[0],
): ReturnType<typeof createHarnessServiceHost> => {
  const terminal = createIsolatedTerminalSessionApi();
  terminals.push(terminal);
  const host = createHarnessServiceHost({
    ...options,
    createTerminalSession: (input) => terminal.createTerminalSession(input),
  });
  hosts.push(host);
  return host;
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(terminals.splice(0).map((terminal) => terminal.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("production shell assembly", () => {
  nativeAuthorityIt("authorizes and executes an external cwd without changing the bound session's default", async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-external-cwd-"));
    dirs.push(root);
    const project = join(root, "project");
    const external = join(root, "external directory");
    mkdirSync(project); mkdirSync(external);
    const documents = createDocumentAuthority({ hostId: "host", dataDir: join(root, "data"),
      isAllowedRoot: async () => true, isTrusted: async () => true });
    const { workspaceId } = await documents.resolveWorkspace({ path: project });
    const pathAuthority = createHarnessPathAuthority({ authorityId: "host", documents });
    const host = createHost({ search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root, pathAuthority });
    const identity = actor("external-cwd-session");
    host.registerSession({ actor: identity, grantedCapabilities: ["process.shell", "context.session"],
      workspaceId, workspaceRoot: project, shellSetting: process.platform === "win32" ? "powershell" : "auto" });
    let response: unknown;
    const router = createHarnessRouter({
      resolveActor: current => host.resolveActor(current),
      authorizeWorkspacePath: (current, input, options) => pathAuthority.resolve(current, input, options),
      respond: async (_session, _request, result) => { response = result; },
    });
    registerHarnessServices(router, host);
    const request = async <M extends "permission.inspect" | "shell.exec" | "shell.read">(method: M, params: HarnessServiceMap[M]["params"]) => {
      await router.processEvent({ kind: "host", actor: identity, envelope: { kind: "event", event: "harness.request",
        data: { requestId: crypto.randomUUID(), method, params } } });
      return response as { ok: boolean; result?: HarnessServiceMap[M]["result"]; error?: { message: string } };
    };
    const execute = async (command: string, cwd?: string) => {
      const started = await request("shell.exec", { command, ...(cwd ? { cwd } : {}), waitMs: 0 });
      expect(started.ok, started.error?.message).toBe(true);
      const result = started.result;
      if (!result || result.kind === "spawn-failed") throw new Error(JSON.stringify(started));
      if (result.kind === "completed") {
        expect(result.exitCode).toBe(0);
        return result;
      }
      while (true) {
        const observed = await request("shell.read", { id: result.id, waitMs: 1000 });
        expect(observed.ok, observed.error?.message).toBe(true);
        if (!observed.result) throw new Error("Missing shell observation");
        if (!observed.result.running) {
          expect(observed.result.exitCode, observed.result.text).toBe(0);
          return observed.result;
        }
      }
    };
    try {
      const inspected = await request("permission.inspect", { tool: "bash", source: { kind: "harness", id: "harness:bash" },
        action: "process", cwd: project, paths: [external], networkTargets: [], threadScopes: [], evidenceComplete: true });
      expect(inspected, JSON.stringify(inspected)).toMatchObject({ ok: true });
      expect(inspected.result?.paths[0]?.workspaceId).not.toBe(workspaceId);
      const command = process.platform === "win32"
        ? "Set-Content -LiteralPath 'created.txt' -Value 'external-command'"
        : "printf 'external-command\\n' > created.txt";
      const executed = await execute(command, external);
      expectCwd(executed, external);
      expect(readFileSync(join(external, "created.txt"), "utf8").trim()).toBe("external-command");
      expect(existsSync(join(project, "created.txt"))).toBe(false);
      const next = await execute("echo default-cwd");
      expectCwd(next, project);
      expect((await host.resolveActor(identity))?.workspaceId).toBe(workspaceId);
    } finally {
      router.dispose();
      await documents.dispose();
    }
  });

  it("discovers once at Host construction and keeps workspace settings from crossing", async () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "shell-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "shell-b-"));
    dirs.push(workspaceA, workspaceB);
    const host = createHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async (workspaceId) => workspaceId === "ws-a" ? workspaceA : workspaceB,
      discoverShells: () => ({
        gitBashPath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        hasBash: true,
        hasPowerShell: true,
      }),
    });
    host.registerSession({
      actor: actor("session-a"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-a",
      workspaceRoot: workspaceA,
      shellSetting: process.platform === "win32" ? "git-bash" : "auto",
    });
    host.registerSession({
      actor: actor("session-b"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-b",
      workspaceRoot: workspaceB,
      shellSetting: process.platform === "win32" ? "powershell" : "git-bash",
    });
    const gitBash = host.getInterpreter("session-a");
    const powershell = host.getInterpreter("session-b");
    if (process.platform === "win32") {
      expect(gitBash && "kind" in gitBash && gitBash.kind).toBe("git-bash");
      expect(gitBash && "command" in gitBash ? gitBash.command : "").toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
      expect(powershell && "kind" in powershell && powershell.kind).toBe("powershell");
    } else {
      expect(gitBash && "kind" in gitBash && gitBash.kind).toBe("bash");
      expect(powershell && "unavailable" in powershell && powershell.unavailable.reason).toMatch(/only available on Windows/);
    }
  });

  it("reports a missing interpreter from production discovery, not an injected path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-missing-"));
    dirs.push(workspace);
    const host = createHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      discoverShells: () => ({ hasBash: false, hasPowerShell: false }),
    });
    host.registerSession({
      actor: actor("session-missing"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-missing",
      workspaceRoot: workspace,
      shellSetting: process.platform === "win32" ? "git-bash" : "auto",
    });
    const interpreter = host.getInterpreter("session-missing");
    expect(interpreter && "unavailable" in interpreter).toBe(true);
    if (interpreter && "unavailable" in interpreter) {
      expect(interpreter.unavailable.reason).toMatch(process.platform === "win32" ? /Git for Windows not found/ : /No suitable shell found/);
    }
    const result = await createShellExecService(host).handle(
      { command: "echo should-not-run" },
      serviceContext("session-missing", "ws-missing"),
    );
    expect(result).toMatchObject({
      kind: "spawn-failed",
      reason: expect.stringMatching(process.platform === "win32" ? /Git for Windows not found/ : /No suitable shell found/),
    });
  });

  nativeAuthorityIt("executes through public shell.exec after real Host discovery", async () => {
    const discovered = discoverShells();
    if (process.platform === "win32") {
      expect(discovered.gitBashPath, "Git Bash should be discovered on this Windows machine").toBeTruthy();
      expect(discovered.gitBashPath).toMatch(/bash\.exe$/i);
      expect(discovered.gitBashPath).not.toMatch(/\\usr\\usr\\bin\\bash\.exe$/i);
    } else if (!discovered.hasBash) {
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), "shell-assembly-"));
    dirs.push(workspace);
    const host = createHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
    });
    host.registerSession({
      actor: actor("session-live"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-live",
      workspaceRoot: workspace,
      shellSetting: "auto",
    });
    const interpreter = host.getInterpreter("session-live");
    expect(interpreter && "kind" in interpreter).toBe(true);
    const result = await createShellExecService(host).handle(
      { command: "echo varin-shell-assembly", waitMs: 15_000 },
      serviceContext("session-live", "ws-live"),
    );
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/varin-shell-assembly/);
    }
  }, 30_000);

  nativeAuthorityIt("isolates cwd and environment between independent commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-context-")); dirs.push(root);
    const first = join(root, "first"), second = join(root, "second");
    mkdirSync(first); mkdirSync(second); mkdirSync(join(second, "nested"));
    const envName = `VARIN_TEST_SHELL_SCOPE_${process.pid}`;
    const pathAuthority = createHarnessPathAuthority({ authorityId: "host", documents: { inspectWorkspace: async () => ({ root }) } });
    const host = createHost({ search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => root, pathAuthority });
    host.registerSession({ actor: actor("session-context"), grantedCapabilities: ["process.shell", "context.session"],
      workspaceId: "ws-context", workspaceRoot: first, authorityWorkspaceRoot: root, shellSetting: "auto" });
    const run = async (command: string, cwd?: string) => {
      const ctx = serviceContext("session-context", "ws-context");
      ctx.actor = (await host.resolveActor(actor("session-context")))!;
      return createShellExecService(host).handle({ command, ...(cwd === undefined ? {} : { cwd }), waitMs: 10_000 }, ctx);
    };
    expect(await run(`unset ${envName}; export ${envName}=retained; cat <<'EOF'\nheredoc-marker\nEOF`))
      .toMatchObject({ kind: "completed", exitCode: 0, stdout: expect.stringContaining("heredoc-marker") });
    const initial = await run(`printf '<%s>\\n' "\${${envName}-unset}"; pwd`);
    expect(initial).toMatchObject({ kind: "completed", exitCode: 0, stdout: expect.stringContaining("<unset>") });
    expectCwd(initial, first);
    const nested = await run("cd ../second/nested # tail comment\npwd");
    expect(nested).toMatchObject({ kind: "completed", exitCode: 0 });
    if (nested.kind === "completed") expect(nested.stdout).toMatch(/second[\\/]nested/);
    expectCwd(nested, first);
    const pwd = await run("pwd");
    expect(pwd).toMatchObject({ kind: "completed" });
    if (pwd.kind === "completed") expect(pwd.stdout).toMatch(/[\\/]first\r?$/m);
    expectCwd(pwd, first);
    const explicit = await run("pwd", second);
    expect(explicit).toMatchObject({ kind: "completed" });
    if (explicit.kind === "completed") expect(explicit.stdout).toMatch(/[\\/]second\r?$/m);
    expectCwd(explicit, second);
    const afterExplicit = await run("pwd");
    expect(afterExplicit).toMatchObject({ kind: "completed" });
    if (afterExplicit.kind === "completed") expect(afterExplicit.stdout).toMatch(/[\\/]first\r?$/m);
    const syntax = await run("if then");
    expect(syntax.kind).toBe("completed");
    if (syntax.kind === "completed") expect(syntax.exitCode).not.toBe(0);
    expect(await run("echo after-syntax")).toMatchObject({ kind: "completed", exitCode: 0,
      stdout: expect.stringContaining("after-syntax") });
  }, 45_000);

  it.skipIf(process.env.VARIN_REQUIRE_RELEASE_KERNEL !== "1" || process.platform !== "win32")("executes consecutive commands and preserves non-zero exit through PowerShell", async () => {
    const discovered = discoverShells();
    expect(discovered.hasPowerShell, "PowerShell should be discovered on this Windows machine").toBe(true);
    // Keep the real path long enough to wrap a path-bearing PTY control record.
    const workspace = mkdtempSync(join(tmpdir(), "shell-powershell-directory-long-enough-to-wrap-the-control-record-"));
    const nested = join(workspace, "nested"); mkdirSync(nested);
    const envName = `VARIN_TEST_PS_SCOPE_${process.pid}`;
    const vanished = join(workspace, "vanished"); mkdirSync(vanished);
    let deleteSelectedCwd = false;
    dirs.push(workspace);
    const host = createHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      registerWriter: async () => {
        if (deleteSelectedCwd) { deleteSelectedCwd = false; rmSync(vanished, { recursive: true }); }
        return { close: async () => undefined };
      },
    });
    host.registerSession({
      actor: actor("session-powershell"),
      grantedCapabilities: ["process.shell"],
      workspaceId: "ws-powershell",
      workspaceRoot: workspace,
      shellSetting: "powershell",
    });
    const ctx = serviceContext("session-powershell", "ws-powershell");
    const first = await createShellExecService(host).handle(
      { command: `Remove-Item Env:${envName} -ErrorAction SilentlyContinue; $env:${envName} = 'retained'; Set-Location -LiteralPath '${nested.replace(/'/g, "''")}' ; Set-Content -LiteralPath cwd-proof.txt -Value varin-powershell-one; Write-Output varin-powershell-one; (Get-Location).Path`, cwd: workspace, waitMs: 15_000 },
      ctx,
    );
    const second = await createShellExecService(host).handle(
      { command: `if (Test-Path Env:${envName}) { Write-Output "leaked:$env:${envName}" } else { Write-Output clean }; (Get-Location).Path`, waitMs: 15_000 },
      ctx,
    );
    const failed = await createShellExecService(host).handle(
      { command: "cmd.exe /c exit 7", waitMs: 15_000 },
      ctx,
    );
    expect(first).toMatchObject({ kind: "completed", exitCode: 0 });
    expect(second).toMatchObject({ kind: "completed", exitCode: 0, stdout: expect.stringContaining("clean") });
    expectCwd(first, workspace);
    expectCwd(second, workspace);
    expect(failed).toMatchObject({ kind: "completed", exitCode: 7 });
    const supervisor = host.getShellSupervisor("session-powershell")!;
    expect(await supervisor.exec("Write-Output after-native-error", { waitMs: 10_000 }))
      .toMatchObject({ kind: "completed", exitCode: 0 });
    expect(await supervisor.exec("if (", { waitMs: 10_000 }))
      .toMatchObject({ kind: "completed", exitCode: 1 });
    deleteSelectedCwd = true;
    const missingCwd = await supervisor.exec("Set-Content -LiteralPath marker.txt -Value wrong", { cwd: vanished, waitMs: 10_000 });
    expect(missingCwd).toMatchObject({ kind: "completed", exitCode: 1 });
    expectCwd(missingCwd, workspace);
    expect(existsSync(join(workspace, "marker.txt"))).toBe(false);
    if (first.kind === "completed") {
      expect(first.stdout).toContain("varin-powershell-one");
      expect(readFileSync(join(nested, "cwd-proof.txt"), "utf8").trim()).toBe("varin-powershell-one");
    }
    if (second.kind === "completed") expect(second.stdout).toContain("clean");
  }, 45_000);

  nativeAuthorityIt("completes background verification from the real command lifecycle without shell.read", async () => {
    const discovered = discoverShells();
    if (process.platform === "win32") {
      expect(discovered.gitBashPath, "Git Bash should be discovered on this Windows machine").toBeTruthy();
    } else if (!discovered.hasBash) {
      return;
    }
    const workspace = mkdtempSync(join(tmpdir(), "shell-verification-"));
    dirs.push(workspace);
    const verification = createVerificationCoordinator();
    const completed = vi.spyOn(verification, "completeCommand");
    const host = createHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      verification,
    });
    host.registerSession({
      actor: actor("session-verification"), grantedCapabilities: ["process.shell"],
      workspaceId: "ws-verification", workspaceRoot: workspace, shellSetting: "auto",
    });
    host.verification.attachThreadSession("session-verification", {
      workspaceId: "ws-verification", threadId: "thread-1", runId: "run-1",
      worktreePath: workspace, branchId: "thread-1",
      captureIdentity: async () => ({ treeHash: "tree-1" }),
    });
    const result = await createShellExecService(host).handle(
      { command: "sleep 0.2; printf 'done\\n'", cwd: workspace, waitMs: 20 },
      serviceContext("session-verification", "ws-verification"),
    );
    expect(["background", "preparing"]).toContain(result.kind);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    let child: ResultVerificationBundle | null = null;
    const store = {
      getResult: () => ({ branchId: "thread-1", root: "tree-1", resultRevision: 1, createdAt: new Date().toISOString() }),
      resultTreeIdentity: () => "tree-1",
      putChildVerification: async (_threadId: string, bundle: ResultVerificationBundle) => { child = bundle; },
      getChildVerification: () => child,
      listChildVerifications: () => child ? [child] : [],
      getParentVerification: () => null,
      listParentVerifications: () => [],
      getReviewRecord: () => null,
      listReviewRecords: () => [],
    } as unknown as WorkingStateRootStore;
    const projection = await host.verification.bindPublishedResult(store, {
      workspaceId: "ws-verification", threadId: "thread-1", runId: "run-1", branchId: "thread-1",
      resultRevision: 1, worktreePath: workspace,
    });
    expect(projection.childChecks?.commands).toEqual([
      expect.objectContaining({ command: "sleep 0.2; printf 'done\\n'", exitCode: 0, relation: "same-run-matching-result" }),
    ]);
  }, 30_000);
});
