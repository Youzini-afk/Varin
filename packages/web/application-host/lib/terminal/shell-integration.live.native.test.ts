import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createIsolatedTerminalSessionApi } from "./isolated-session-api.test-helper.js";
import type { TerminalCommandRecord } from "./session-api.js";

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

describe("live shell integration", () => {
  it.skipIf(!liveShell)("observes a real user-terminal command on Windows Git Bash or PowerShell", async () => {
    const shell = liveShell!;
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
      const handle = await runtime.createTerminalSession({
        sessionId: "live-user",
        cwd: tmpdir(),
        owner: "user",
        shell: shell.shell,
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && runtime.inspectSession("live-user")?.integration !== "ready") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      handle.write("echo varin-live-probe\r");
      while (Date.now() < deadline && seen.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen[0]).toMatchObject({
        command: expect.stringContaining("echo varin-live-probe"),
        owner: "user",
        integration: "osc-633",
        terminalId: "live-user",
      });
      expect(Number.isInteger(seen[0]?.exitCode)).toBe(true);
      await handle.destroy();
    } finally {
      subscription.dispose();
      await runtime.shutdown();
    }
  }, 20_000);
});
