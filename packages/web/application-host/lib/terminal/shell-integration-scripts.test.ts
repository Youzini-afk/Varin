import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POWERSHELL_COMMAND_START_CAPTURE,
  POWERSHELL_EXIT_CAPTURE,
  shellIntegrationFamily,
  shellIntegrationLaunch,
} from "./shell-integration-scripts.js";

const powershellPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const zshCandidate = process.env.VARIN_TEST_ZSH ?? "zsh";
const hasZsh = !spawnSync(zshCandidate, ["--version"], { encoding: "utf8" }).error;
const hasPowerShell = process.platform === "win32" && existsSync(powershellPath);
const bashPath = [
  process.env.VARIN_TERMINAL_SHELL,
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "/bin/bash",
].find((candidate) => typeof candidate === "string" && existsSync(candidate));

describe("shell integration launch", () => {
  it("injects an init file for bash and a script file for PowerShell", () => {
    const bash = shellIntegrationLaunch("/usr/bin/bash", ["-l"], true, "user-bash:1");
    expect(bash?.args).toEqual(["-l", "--init-file", expect.stringContaining("bash-")]);
    expect(bash?.env.VARIN_SHELL_INTEGRATION_KIND).toBe("bash");
    expect(bash?.env.VARIN_SHELL_INTEGRATION_ID).toBe("user-bash:1");

    const pwsh = shellIntegrationLaunch("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [], false, "term-ps:1");
    expect(pwsh?.args).toEqual([
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      expect.stringMatching(/powershell-.*\.ps1$/),
    ]);
    expect(pwsh?.env.VARIN_SHELL_INTEGRATION_ID).toBe("term-ps:1");
  });

  it("uses ZDOTDIR for zsh, does not inject cmd, and does not treat sh as bash", () => {
    const zsh = shellIntegrationLaunch("/bin/zsh", ["-l"], true, "term-zsh:1");
    expect(zsh?.args).toEqual(["-l"]);
    expect(zsh?.env.ZDOTDIR).toEqual(expect.stringContaining("zsh-"));
    expect(zsh?.env.VARIN_ZDOTDIR).toBe(zsh?.env.ZDOTDIR);
    expect(shellIntegrationFamily("cmd.exe")).toBeNull();
    expect(shellIntegrationLaunch("cmd.exe", [], false, "x")).toBeNull();
    expect(shellIntegrationFamily("/bin/sh")).toBeNull();
    expect(shellIntegrationFamily("sh.exe")).toBeNull();
    expect(shellIntegrationLaunch("/bin/sh", ["-l"], false, "term-sh:1")).toBeNull();
  });

  it.skipIf(!hasZsh)("lets each user zsh file observe the original ZDOTDIR", () => {
    const candidate = zshCandidate;
    const userDir = mkdtempSync(join(tmpdir(), "varin-zsh-user-"));
    const observed = join(userDir, "observed");
    const shellQuote = (value: string): string => `'${value.replace(/'/gu, "'\\''")}'`;
    const previousZdotdir = process.env.ZDOTDIR;
    try {
      for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
        writeFileSync(join(userDir, file), `print -r -- '${file}:$ZDOTDIR' >> ${shellQuote(observed)}\n`);
      }
      process.env.ZDOTDIR = userDir;
      const launch = shellIntegrationLaunch(candidate, ["-l"], true, "term-zsh:raw-zdotdir");
      const result = spawnSync(candidate, [...(launch?.args ?? []), "-i", "-c", "exit"], {
        env: { ...process.env, ...launch?.env },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(readFileSync(observed, "utf8").trim().split(/\r?\n/u)).toEqual([
        ".zshenv", ".zprofile", ".zshrc", ".zlogin",
      ].map((file) => `${file}:${userDir}`));
    } finally {
      if (previousZdotdir === undefined) delete process.env.ZDOTDIR;
      else process.env.ZDOTDIR = previousZdotdir;
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasPowerShell)("does not reuse native exit 7 for a later failed cmdlet", () => {
    const probe = join(tmpdir(), `varin-missing-${Date.now()}`);
    const result = spawnSync(powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
        ${POWERSHELL_COMMAND_START_CAPTURE}
        cmd.exe /c exit 7
        ${POWERSHELL_EXIT_CAPTURE}
        $native = $code
        Get-Item -LiteralPath '${probe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Out-Null
        ${POWERSHELL_EXIT_CAPTURE}
        $cmdlet = $code
        Write-Output 'ok' | Out-Null
        ${POWERSHELL_EXIT_CAPTURE}
        Write-Output "$native,$cmdlet,$code"
      `,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe("7,1,0");
  });

  it.skipIf(!hasPowerShell)("reports 1 for a consecutive identical native status when precision is unknowable", () => {
    const result = spawnSync(powershellPath, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
        ${POWERSHELL_COMMAND_START_CAPTURE}
        cmd.exe /c exit 7
        ${POWERSHELL_EXIT_CAPTURE}
        $first = $code
        cmd.exe /c exit 7
        ${POWERSHELL_EXIT_CAPTURE}
        $second = $code
        Write-Output "$first,$second"
      `,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    // PowerShell exposes only the current LASTEXITCODE, without a generation
    // counter. The second identical 7 is therefore unknown and conservatively
    // maps to 1 instead of pretending the old status belongs to this command.
    expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe("7,1");
  });

  it.skipIf(!bashPath)("keeps a custom Bash PROMPT_COMMAND array and DEBUG trap after sourcing the init file", () => {
    const bash = bashPath!;
    const launch = shellIntegrationLaunch(bash, [], false, "term-bash:live");
    const script = String(launch?.args[1]).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const result = spawnSync(bash, [
      "-lc",
      `PROMPT_COMMAND=("echo USER_PROMPT_RAN"); trap 'echo USER_DEBUG_RAN' DEBUG; . "${script.replace(/"/g, '\\"')}"; declare -p PROMPT_COMMAND; trap -p DEBUG`,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("declare -a PROMPT_COMMAND");
    expect(result.stdout).toContain("__varin_prompt_command");
    expect(result.stdout).toContain("echo USER_PROMPT_RAN");
    expect(result.stdout).toContain("USER_DEBUG_RAN");
  });
});
