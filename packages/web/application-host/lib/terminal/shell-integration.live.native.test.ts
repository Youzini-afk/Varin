import { existsSync, readlinkSync } from "node:fs";
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createIsolatedTerminalSessionApi } from "./isolated-session-api.test-helper.js";
import type { TerminalCommandRecord } from "./session-api.js";
import { createPlatformEnvironmentRuntime } from '../platform/environment-runtime.js';
import { hasNativeProcessKernel } from '../process/native-process.test-helper.js';

const gitBashCandidates = [
  process.env.VARIN_TERMINAL_SHELL,
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
].filter((value): value is string => typeof value === "string" && value.length > 0);

const powershellPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const resolveLiveShell = (): { family: "bash" | "powershell"; path: string; shell: "bash" | "powershell" } | null => {
  for (const candidate of gitBashCandidates) {
    if (existsSync(candidate) && /bash/i.test(candidate)) {
      return { family: "bash", path: candidate, shell: "bash" };
    }
  }
  if (existsSync(powershellPath)) {
    return { family: "powershell", path: powershellPath, shell: "powershell" };
  }
  return null;
};

const liveShell = resolveLiveShell();
const storeAlias = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
let storePowerShell: string | undefined;
try { storePowerShell = process.platform === 'win32' ? readlinkSync(storeAlias) : undefined; } catch { /* Store PowerShell is optional. */ }

describe("live shell integration", () => {
  it.skipIf(!storePowerShell || !hasNativeProcessKernel)('discovers Store PowerShell and runs a Unicode command through the native user terminal', async () => {
    const previous = process.env.VARIN_TERMINAL_SHELL;
    process.env.VARIN_TERMINAL_SHELL = storeAlias;
    const platform = createPlatformEnvironmentRuntime();
    const runtime = createIsolatedTerminalSessionApi({ isExecutable: platform.isExecutable,
      searchPathFor: platform.searchPathFor, buildAugmentedPath: () => path.dirname(storeAlias) });
    const commands: TerminalCommandRecord[] = [];
    const observation = runtime.subscribeCommands(command => commands.push(command));
    try {
      const handle = await runtime.createTerminalSession({ sessionId: 'store-pwsh', cwd: tmpdir(), owner: 'user', shell: 'pwsh' });
      let output = '';
      const data = handle.onData(text => { output += text; });
      await vi.waitFor(() => expect(runtime.inspectSession(handle.id)?.integration).toBe('ready'), { timeout: 15_000 });
      await handle.write("Write-Output '中文🙂'\r".repeat(2));
      await vi.waitFor(() => expect(commands.filter(command => command.command.includes('中文🙂') && command.exitCode === 0)).toHaveLength(2), { timeout: 15_000 });
      expect(output).toContain('中文🙂');
      data.dispose();
      await handle.destroy();
    } finally {
      observation.dispose();
      try { await runtime.shutdown(); }
      finally { if (previous === undefined) delete process.env.VARIN_TERMINAL_SHELL; else process.env.VARIN_TERMINAL_SHELL = previous; }
    }
  }, 35_000);
  it.skipIf(!liveShell)("observes a real user-terminal command on Windows Git Bash or PowerShell", async () => {
    const shell = liveShell!;
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'varin-live-shell-'));
    const started = performance.now();
    const phase = (name: string) => console.info(`[live shell] ${name}: ${Math.round(performance.now() - started)}ms`);
    const runtime = createIsolatedTerminalSessionApi({
      isExecutable: (value: string) => existsSync(value),
      searchPathFor: (name: string) => {
        if (name.toLowerCase().includes("bash") && shell.family === "bash") return shell.path;
        if (name.toLowerCase().includes("powershell")) return powershellPath;
        return existsSync(name) ? name : null;
      },
      buildAugmentedPath: () => process.env.PATH ?? "",
    });
    const seen: TerminalCommandRecord[] = [];
    const subscription = runtime.subscribeCommands((event) => { seen.push(event); });
    try {
      phase('creating');
      const handle = await runtime.createTerminalSession({
        sessionId: "live-user",
        cwd,
        owner: "user",
        shell: shell.shell,
      });
      phase('created');
      await vi.waitFor(() => expect(runtime.inspectSession(handle.id)?.integration).toBe('ready'), { timeout: 15_000 });
      phase('integration ready');
      await handle.write("echo varin-live-probe\r");
      phase('input acknowledged');
      await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({
        command: expect.stringContaining("echo varin-live-probe"),
        owner: "user",
        integration: "osc-633",
        terminalId: "live-user",
        exitCode: 0,
      })), { timeout: 15_000 });
      phase('command observed');
      await handle.destroy();
      phase('destroyed');
    } finally {
      subscription.dispose();
      phase('shutting down');
      await runtime.shutdown();
      phase('shutdown complete');
      await fs.rm(cwd, { recursive: true, force: true });
    }
  // Match the Store-shell case: startup, two observed phases and native teardown
  // cannot share the old 20s outer budget while each phase permits 15s.
  }, 35_000);
});
