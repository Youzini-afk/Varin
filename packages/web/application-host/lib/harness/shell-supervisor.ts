import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sliceUtf8ByBytes, type OutputSlice, type ShellExecResult, type ShellExecTiming } from "@varin/protocol";
import type { CreateTerminalSessionInput, TerminalHandle, TerminalSessionApi } from "../terminal/session-api.js";
import type { OutputStore } from "./output-store.js";

export type ShellInterpreterKind = "git-bash" | "bash" | "wsl" | "powershell" | "remote";

export interface ShellInterpreter {
  kind: ShellInterpreterKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  distro?: string;
}

export interface DiscoveredShells {
  gitBashPath?: string;
  wslDistros?: string[];
  hasBash?: boolean;
  hasPowerShell?: boolean;
}

export interface SelectInterpreterInput {
  platform: NodeJS.Platform;
  workspaceRoot: string;
  setting: "auto" | "git-bash" | "powershell" | "wsl";
  discovered: DiscoveredShells;
  remote: boolean;
}

const WSL_PATH_PATTERN = /^\\\\wsl(\$|\.localhost)\\([^\\]+)/i;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A timer is only a wake-up hint; the accepted deadline decides when to detach. */
const scheduleAtDeadline = (deadlineAt: number, onDeadline: () => void): (() => void) => {
  let timer: ReturnType<typeof setTimeout>;
  const check = (): void => {
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS));
      return;
    }
    onDeadline();
  };
  timer = setTimeout(check, Math.min(Math.max(0, deadlineAt - Date.now()), MAX_TIMER_DELAY_MS));
  return () => clearTimeout(timer);
};

export function selectInterpreter(input: SelectInterpreterInput): ShellInterpreter | { unavailable: { reason: string; hint: string } } {
  const { platform, workspaceRoot, setting, discovered, remote } = input;

  if (remote) {
    return { kind: "remote", command: "bash", args: ["-l"], env: {} };
  }

  if (setting === "powershell") {
    if (platform !== "win32") {
      return { unavailable: { reason: "PowerShell is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    }
    if (discovered.hasPowerShell === false) {
      return { unavailable: { reason: "PowerShell not found", hint: "Install Windows PowerShell or set harness.shell to auto / git-bash." } };
    }
    // Keep a real interactive process attached to the PTY. `-Command -`
    // exits under ConPTY because stdin is not a redirected pipe.
    return { kind: "powershell", command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit"], env: {} };
  }

  if (setting === "wsl") {
    if (platform !== "win32") return { unavailable: { reason: "WSL is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    const distro = discovered.wslDistros?.[0];
    if (!distro) return { unavailable: { reason: "No WSL distribution found", hint: "Install WSL from https://learn.microsoft.com/en-us/windows/wsl/install" } };
    return { kind: "wsl", command: "wsl.exe", args: ["-d", distro, "--", "bash", "-l"], env: {}, distro };
  }

  if (setting === "git-bash") {
    if (platform !== "win32") return { unavailable: { reason: "Git Bash is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    if (!discovered.gitBashPath) return { unavailable: { reason: "Git for Windows not found", hint: 'Install Git for Windows from https://git-scm.com/download/win, or set harness.shell to "powershell" if that interpreter is installed.' } };
    // Discovery records the executable to spawn. Prefer usr\bin\bash.exe there
    // so this path is not rewritten when only the bin\ launcher exists.
    return { kind: "git-bash", command: discovered.gitBashPath, args: ["-l"], env: { MSYS_NO_PATHCONV: "1" } };
  }

  // Auto detection
  if (platform === "win32") {
    const wslMatch = workspaceRoot.match(WSL_PATH_PATTERN);
    if (wslMatch && wslMatch[2]) {
      const distro = wslMatch[2];
      return { kind: "wsl", command: "wsl.exe", args: ["-d", distro, "--", "bash", "-l"], env: {}, distro };
    }
    if (discovered.gitBashPath) {
      return { kind: "git-bash", command: discovered.gitBashPath, args: ["-l"], env: { MSYS_NO_PATHCONV: "1" } };
    }
    return { unavailable: { reason: "Git for Windows not found", hint: 'Install Git for Windows from https://git-scm.com/download/win, or set harness.shell to "powershell" if that interpreter is installed.' } };
  }

  if (discovered.hasBash !== false) {
    return { kind: "bash", command: "bash", args: ["-l"], env: {} };
  }

  return { unavailable: { reason: "No suitable shell found", hint: "Install bash or set harness.shell explicitly." } };
}

type OutputControlState = "text" | "escape" | "csi" | "osc" | "osc-escape";

const stripOutputChunk = (text: string, initial: OutputControlState): { text: string; state: OutputControlState } => {
  let state = initial;
  let visible = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (state === "text") {
      if (char === "\x1b") state = "escape";
      else visible += char;
    } else if (state === "escape") {
      if (char === "[") state = "csi";
      else if (char === "]") state = "osc";
      else state = "text";
    } else if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "text";
    } else if (state === "osc") {
      if (char === "\x07") state = "text";
      else if (char === "\x1b") state = "osc-escape";
    } else if (char === "\\") {
      state = "text";
    } else {
      state = char === "\x1b" ? "osc-escape" : "osc";
    }
  }
  return { text: visible, state };
};

export function stripControlSequences(text: string): string {
  return stripOutputChunk(text, "text").text;
}

const SENTINEL = "__VARIN_SENTINEL_";

// Every control record is short and newline-terminated. The cwd itself is
// frozen at admission; C only confirms whether the shell entered that cwd.
// Sending paths through a PTY loses data when ConPTY wraps/repaints long lines.
const commandSentinelPattern = (token: string): RegExp => (
  new RegExp(`${SENTINEL}${token}:(B|C:[01]|E:\\d+)(?=\\r?\\n)`, "g")
);

interface CommandOutputFrame {
  token: string;
  frameBuffer: string;
  outputStarted: boolean;
  outputControlState: OutputControlState;
}

/** Commit only payload bytes: echoed input and incomplete records are not output. */
function parseCommandOutput(command: CommandOutputFrame, chunk: string): { text: string; cwdEntered?: boolean; exitCode?: number } {
  const normalized = stripOutputChunk(chunk, command.outputControlState);
  command.outputControlState = normalized.state;
  command.frameBuffer += normalized.text;
  const result: { text: string; cwdEntered?: boolean; exitCode?: number } = { text: "" };
  const pattern = commandSentinelPattern(command.token);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command.frameBuffer)) !== null) {
    if (command.outputStarted) result.text += command.frameBuffer.slice(0, match.index);
    const record = match[1]!;
    const end = match.index + match[0].length;
    command.frameBuffer = command.frameBuffer.slice(end + (command.frameBuffer[end] === "\r" ? 2 : 1));
    pattern.lastIndex = 0;
    if (record === "B") command.outputStarted = true;
    else if (record.startsWith("C:")) result.cwdEntered = record === "C:1";
    else if (record.startsWith("E:")) {
      result.exitCode = Number(record.slice(2));
      command.frameBuffer = "";
      return result;
    }
  }
  // Records can be split anywhere across PTY chunks. Before B, input echo
  // cannot advance a read cursor; afterward, only a possible record is held.
  const marker = `${SENTINEL}${command.token}`;
  let keepFrom = command.frameBuffer.length;
  const lastMarker = command.frameBuffer.lastIndexOf(marker);
  if (lastMarker >= 0 && /^(?::(?:B|C(?::[01]?)?|E(?::\d*)?)?)?\r?$/.test(command.frameBuffer.slice(lastMarker + marker.length))) {
    keepFrom = lastMarker;
  } else {
    for (let size = Math.min(marker.length - 1, command.frameBuffer.length); size > 0; size--) {
      if (command.frameBuffer.endsWith(marker.slice(0, size))) { keepFrom -= size; break; }
    }
  }
  if (command.outputStarted) result.text += command.frameBuffer.slice(0, keepFrom);
  command.frameBuffer = command.frameBuffer.slice(keepFrom);
  return result;
}

const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const quotePosixShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * RR3: the user command travels as one self-contained payload token, never
 * interpolated into the supervisor's control syntax. POSIX shells receive an
 * ANSI-C `$'…'` string handed to `eval`; PowerShell receives a base64 payload
 * decoded into `Invoke-Expression`. In both cases the control line parses
 * without depending on the payload's content, so heredocs without a trailing
 * newline, tail comments, complex quoting, and unterminated constructs are
 * confined to the payload evaluation — the epilogue sentinels always run.
 * The user payload cannot alter the PTY shell's cwd/environment. A real PTY
 * exit still reports process death independently of the command sentinels.
 */

const quoteAnsiC = (value: string): string => {
  let out = "$'";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "'") out += "\\'";
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `${out}'`;
};

function buildCommandWrapper(command: string, token: string, kind: ShellInterpreterKind, cwd: string): string {
  if (kind === "powershell") {
    // Assemble markers at runtime. A ConPTY can echo the submitted control
    // line; no complete marker may appear there or the parser could mistake it
    // for command output before PowerShell executes it.
    const markerBase = quotePowerShell(`${SENTINEL}${token}`);
    const beginMarker = `$__varin_${token}_begin_marker`;
    const cwdMarker = `$__varin_${token}_cwd_marker`;
    const endMarker = `$__varin_${token}_end_marker`;
    const commandSuccess = `$global:__varin_${token}_success`;
    const commandExit = `$global:__varin_${token}_exit`;
    // Capture status inside the payload: Invoke-Expression itself reports
    // success for a native command that returned a nonzero exit code.
    const payload = Buffer.from(`${command}\n; ${commandSuccess} = $?; ${commandExit} = $LASTEXITCODE`, "utf8").toString("base64");
    const invoke = [
      `& { try { Invoke-Expression $__varin_payload } catch { ${commandSuccess} = $false; ${commandExit} = 1; Write-Output $_ } }`,
      `$__varin_success = ${commandSuccess}`,
      `$__varin_exit = ${commandExit}`,
      `Remove-Variable -Scope Global -Name '__varin_${token}_success' -ErrorAction SilentlyContinue`,
      `Remove-Variable -Scope Global -Name '__varin_${token}_exit' -ErrorAction SilentlyContinue`,
    ].join("; ");
    const execute = `try { Set-Location -LiteralPath ${quotePowerShell(cwd)} -ErrorAction Stop; $__varin_cwd_entered = 1; ${invoke} } catch { $__varin_success = $false; $__varin_exit = 1; Write-Output $_ }`;
    return [
      `$__varin_payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}'))`,
      // `cwd` in the result means where this invocation started. Payload
      // `Set-Location` calls remain private to this command and do not rewrite it.
      "$__varin_original_location = (Get-Location).ProviderPath; $__varin_original_environment = [System.Environment]::GetEnvironmentVariables(); $__varin_cwd_entered = 0",
      "$__varin_success = $true; $__varin_exit = 0; $global:LASTEXITCODE = 0",
      `${beginMarker} = ${markerBase} + ':B'; ${cwdMarker} = ${markerBase} + ':C:'; ${endMarker} = ${markerBase} + ':E:'`,
      `Write-Output ${beginMarker}`,
      execute,
      "$__varin_code = if ($__varin_success) { 0 } elseif ($__varin_exit -is [int] -and $__varin_exit -ne 0) { [int]$__varin_exit } else { 1 }",
      "try { Set-Location -LiteralPath $__varin_original_location -ErrorAction Stop } catch { $__varin_success = $false; $__varin_code = 1; Write-Output $_ }",
      "$__varin_current_environment = [System.Environment]::GetEnvironmentVariables(); foreach ($__varin_name in @($__varin_current_environment.Keys)) { if (-not $__varin_original_environment.Contains($__varin_name)) { [System.Environment]::SetEnvironmentVariable([string]$__varin_name, $null) } }; foreach ($__varin_name in $__varin_original_environment.Keys) { [System.Environment]::SetEnvironmentVariable([string]$__varin_name, [string]$__varin_original_environment[$__varin_name]) }",
      "$__varin_code = if ($__varin_success) { 0 } elseif ($__varin_exit -is [int] -and $__varin_exit -ne 0) { [int]$__varin_exit } else { 1 }",
      "Write-Output ''",
      `Write-Output (${cwdMarker} + $__varin_cwd_entered)`,
      `Write-Output (${endMarker} + $__varin_code)`,
    ].join("; ");
  }
  // Keep the command inside a child shell so `cd`, exports, variable changes,
  // `exit`, and `exec` cannot mutate or terminate the PTY's reusable shell.
  // The payload's own trailing newline keeps heredocs and tail comments inside
  // eval, while the outer sentinels still run after the child exits.
  const payload = quoteAnsiC(`${command}\n`);
  // Construct full markers only when executing, so echoed wrapper text cannot
  // be mistaken for command output. Emit the directory result before eval:
  // even a payload that calls exit/exec cannot suppress that confirmation.
  return `__varin_marker='${SENTINEL}${token}'; echo "$__varin_marker:B"; ( if cd -- ${quotePosixShell(cwd)}; then echo "$__varin_marker:C:1"; eval ${payload}; else __ec=$?; echo "$__varin_marker:C:0"; exit "$__ec"; fi ); __ec=$?; printf '\\n%s\\n' "$__varin_marker:E:$__ec"`;
}

// ── PTY Provider ────────────────────────────────────────────────────

export interface PtyProcess {
  kill(signal?: NodeJS.Signals): void;
  onData(handler: (data: string) => void): { dispose?(): void };
  onExit(handler: (event: { exitCode: number | null; signal: number }) => void): { dispose?(): void };
  pid?: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

export interface PtyProvider {
  backend: string;
  spawn(executable: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

export function createTerminalSessionApiFromPtyProvider(ptyProvider: PtyProvider): TerminalSessionApi {
  const handles = new Map<string, TerminalHandle>();
  let nextId = 0;
  let nextHarnessId = 0;
  return {
    async createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalHandle> {
      const id = input.sessionId?.trim()
        || (input.owner === "harness" ? `sh_${++nextHarnessId}` : `term_${++nextId}`);
      const existing = handles.get(id);
      if (existing?.status === "running") return existing;
      const spawn = input.spawn ?? { executable: "bash", args: [] };
      const ptyProcess = ptyProvider.spawn(spawn.executable, spawn.args, {
        cols: input.cols ?? 120,
        rows: input.rows ?? 40,
        cwd: input.cwd,
        env: { ...globalThis.process.env, ...spawn.env },
      });
      const dataHandlers = new Set<(data: string) => void>();
      const exitHandlers = new Set<(event: { exitCode: number | null; signal: number }) => void>();
      let status: TerminalHandle["status"] = "running";
      let exitCode: number | null = null;
      let signal: number | null = null;
      ptyProcess.onData((data) => { for (const handler of dataHandlers) handler(data); });
      ptyProcess.onExit((event) => {
        status = "exited";
        exitCode = event.exitCode;
        signal = event.signal;
        for (const handler of exitHandlers) handler(event);
      });
      const handle: TerminalHandle = {
        get id() { return id; },
        get cwd() { return input.cwd; },
        get status() { return status; },
        write(data: string) { ptyProcess.write(data); },
        resize(cols: number, rows: number) { ptyProcess.resize(cols, rows); },
        onData(handler) {
          dataHandlers.add(handler);
          return { dispose: () => { dataHandlers.delete(handler); } };
        },
        onCommand() {
          return { dispose: () => undefined };
        },
        onExit(handler) {
          if (status === "exited") {
            let active = true;
            const event = { exitCode: exitCode ?? 0, signal: signal ?? 0 };
            queueMicrotask(() => { if (active) handler(event); });
            return { dispose: () => { active = false; } };
          }
          exitHandlers.add(handler);
          return { dispose: () => { exitHandlers.delete(handler); } };
        },
        waitForExit() {
          if (status === "exited") return Promise.resolve({ exitCode, signal });
          return new Promise((resolve) => {
            const disposable = handle.onExit((event) => {
              disposable.dispose();
              resolve({ exitCode: event.exitCode, signal: event.signal });
            });
          });
        },
        async terminate() {
          ptyProcess.kill();
        },
        async destroy() {
          try { ptyProcess.kill(); } catch { /* already gone */ }
          handles.delete(id);
        },
      };
      handles.set(id, handle);
      return handle;
    },
    attachTerminalSession(id: string) {
      return handles.get(id) ?? null;
    },
    inspectSession(id: string) {
      const handle = handles.get(id);
      if (!handle) return null;
      return {
        id: handle.id,
        cwd: handle.cwd,
        integration: "not-observed" as const,
        owner: "harness" as const,
        retainWhenDetached: true,
        status: handle.status,
      };
    },
    subscribeCommands() {
      return { dispose: () => undefined };
    },
  };
}

// ── Shell Supervisor (PTY-based) ────────────────────────────────────

export interface ShellSupervisorOptions {
  interpreter: ShellInterpreter;
  outputStore: OutputStore;
  sessionId: string;
  env?: Record<string, string>;
  cwd?: string;
  cols?: number;
  rows?: number;
  registerWriter?: () => Promise<{ close: () => Promise<void> } | null>;
  createTerminalSession?: TerminalSessionApi["createTerminalSession"];
  commandLifecycle?: ShellCommandLifecycle;
  /** Deterministic test seam wrapping a fake PTY. Production uses terminal runtime. */
  ptyProvider?: PtyProvider;
}

export interface ShellCommandStartedEvent {
  command: string;
  commandRunId: string;
  executionId: string;
  cwd: string;
  startedAt: number;
  toolCallId?: string;
}

export interface ShellCommandCompletedEvent extends ShellCommandStartedEvent {
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
  /** Post-accept stage marks; endedAt matches the terminal/exit instant. */
  timing?: ShellExecTiming;
}

export interface ShellCommandOutputEvent extends ShellCommandStartedEvent {
  /** UTF-8 byte offset in the normalized command output. */
  offset: number;
  /** Newly observed normalized output bytes. */
  text: string;
  at: number;
}

export interface ShellCommandLifecycle {
  started?(event: ShellCommandStartedEvent): void | Promise<void>;
  output?(event: ShellCommandOutputEvent): void | Promise<void>;
  completed?(event: ShellCommandCompletedEvent): void | Promise<void>;
}

interface BackgroundShell extends CommandOutputFrame {
  id: string;
  token: string;
  executionId: string;
  commandRunId: string;
  startedAt: number;
  command: string;
  output: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  cancelRequested: boolean;
  lifecycleCompleted: boolean;
  lifecyclePromise?: Promise<void>;
  lastOutputAt: number | null;
  observedOutputBytes: number;
  outputControlState: OutputControlState;
  outputHandle?: string;
  writer: { close: () => Promise<void> } | null;
  writerClosePromise?: Promise<void>;
  handle: TerminalHandle;
  toolCallId?: string;
  timing: ShellExecTiming;
}

export type ShellSupervisor = ReturnType<typeof createShellSupervisor>;

export function createShellSupervisor(deps: ShellSupervisorOptions) {
  const { interpreter, outputStore, sessionId } = deps;
  const cols = deps.cols ?? 120;
  const rows = deps.rows ?? 40;
  const baseEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    PYTHONUNBUFFERED: "1",
    TERM: "xterm-256color",
    ...deps.env,
    ...interpreter.env,
  };
  if (process.platform === "linux") baseEnv.DEBIAN_FRONTEND = "noninteractive";

  // git-bash reports $PWD in POSIX form (/d/work/repo). Translate drive-letter
  // mounts so the tracked cwd stays a native path the host can stat and spawn
  // under; other MSYS mounts and real POSIX shells are left untouched.
  const normalizeShellCwd = (cwd: string): string => {
    if (interpreter.kind !== "git-bash") return cwd;
    if (/^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(cwd)) return path.win32.normalize(cwd);
    const match = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(cwd);
    if (!match) return cwd;
    return `${match[1]!.toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}`;
  };

  const shellCwdForCommand = (cwd: string): string => interpreter.kind === "git-bash"
    ? cwd.replace(/\\/g, "/")
    : cwd;

  const resolveExistingDirectory = async (raw: string): Promise<string | null> => {
    const candidate = normalizeShellCwd(raw);
    try {
      const stats = await fs.promises.stat(candidate);
      return stats.isDirectory() ? candidate : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  };

  // The shell process is reusable, but each accepted command has its own cwd.
  // lastCwd records the last command's resolved cwd for recovery only; it is
  // never the implicit cwd of a later command when an anchor is available.
  let anchorCwd: string | undefined;
  const resolveSpawnCwd = async (preferredCwd?: string): Promise<string> => {
    const seen = new Set<string>();
    const candidates = [preferredCwd, anchorCwd, lastCwd, deps.cwd];
    if (!deps.cwd) candidates.push(process.cwd());
    for (const raw of candidates) {
      if (!raw) continue;
      const candidate = normalizeShellCwd(raw);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const resolved = await resolveExistingDirectory(candidate);
      if (resolved) return resolved;
    }
    throw new Error("No usable working directory remains for this shell session");
  };

  const backgroundShells = new Map<string, BackgroundShell>();
  const shellChangeWaiters = new Map<string, Set<() => void>>();
  interface AcceptedExecution {
    command: string;
    cwd: string | undefined;
    executionId: string;
    promise?: Promise<ShellExecResult>;
    timing: ShellExecTiming;
    phase: "preparing" | "running" | "background" | "completed" | "failed";
    responseResult?: ShellExecResult;
    result?: ShellExecResult;
    failure?: unknown;
  }
  // Both stable execution ids and Pi tool-call ids resolve to the same
  // acceptance record. The map is Host-session local and never re-executes.
  const acceptedExecutions = new Map<string, AcceptedExecution>();
  let activeBackground: BackgroundShell | null = null;
  let disposed = false;
  let sessionHandle: TerminalHandle | null = null;
  const liveHandles = new Set<TerminalHandle>();
  const unavailableHandles = new Map<TerminalHandle, Error>();
  const handleBindings = new Map<TerminalHandle, Set<{ dispose?(): void }>>();
  const terminalApi: TerminalSessionApi | null = deps.createTerminalSession
    ? {
      createTerminalSession: deps.createTerminalSession,
      attachTerminalSession: (id) => {
        if (sessionHandle?.id === id) return sessionHandle;
        for (const background of backgroundShells.values()) {
          if (background.handle.id === id) return background.handle;
        }
        return null;
      },
      inspectSession: () => null,
      subscribeCommands: () => ({ dispose: () => undefined }),
    }
    : deps.ptyProvider
      ? createTerminalSessionApiFromPtyProvider(deps.ptyProvider)
      : null;
  let lastCwd = deps.cwd ?? process.cwd();
  let outputBuffer = "";
  let shellReady = false;
  let shellReadyPromise: Promise<void> | null = null;
  let shellReadyResolve: (() => void) | null = null;
  let shellReadyReject: ((error: unknown) => void) | null = null;
  // Pending command state
  type ShellWriter = { close: () => Promise<void> };
  interface PendingCommand extends CommandOutputFrame {
    token: string;
    executionId: string;
    commandRunId: string;
    command: string;
    resolve: (result: ShellExecResult) => void;
    reject: (error: Error) => void;
    cancelTimeout: () => void;
    cwd: string;
    writer: ShellWriter | null;
    startedAt: number;
    observedOutputBytes: number;
    outputControlState: OutputControlState;
    toolCallId?: string;
    abortCleanup?: () => void;
    timing: ShellExecTiming;
  }
  let pendingCommand: PendingCommand | null = null;
  // A command can be between ensureShell()/registerWriter() and assigning
  // pendingCommand. Keep that interval exclusive as well.
  let commandStarting = false;
  let commandStartingCwd: string | null = null;
  let disposeRequested = false;
  let stopping = false;
  let stoppingDirectory: string | null = null;
  let stopped = false;
  let disposePromise: Promise<void> | null = null;
  let finalizingStop: Promise<boolean> | null = null;
  let commandStartPromise: Promise<void> | null = null;
  const startingWriters = new Set<ShellWriter>();
  const lingeringWriters = new Map<ShellWriter, string>();
  const commandLifecyclePromises = new Set<Promise<void>>();

  const acceptedExecution = (id: string): AcceptedExecution | undefined => (
    acceptedExecutions.get(id)
    ?? [...acceptedExecutions.values()].find((execution) => execution.executionId === id)
  );

  const compactAcceptedResult = (result: ShellExecResult): ShellExecResult => {
    if (result.kind === "completed" && result.handle) {
      // The authenticated output handle owns the paged body for its normal
      // OutputStore lifetime. Do not pin a second full copy in this index.
      return { ...result, stdout: "" };
    }
    if (result.kind === "background" && Buffer.byteLength(result.outputSoFar, "utf8") > 32_768) {
      // The live background shell remains the output authority while running;
      // completion moves a large body into OutputStore and clears its buffer.
      return { ...result, outputSoFar: "" };
    }
    return result;
  };

  const trackCommandLifecycle = (work: Promise<void>): Promise<void> => {
    commandLifecyclePromises.add(work);
    void work.then(
      () => commandLifecyclePromises.delete(work),
      () => commandLifecyclePromises.delete(work),
    );
    return work;
  };

  const notifyShellChanged = (id: string): void => {
    const waiters = shellChangeWaiters.get(id);
    if (!waiters) return;
    shellChangeWaiters.delete(id);
    for (const wake of waiters) wake();
  };

  const closeCommandWriter = async (writer: ShellWriter | null, cwd: string): Promise<void> => {
    if (!writer) return;
    try {
      await writer.close();
      lingeringWriters.delete(writer);
    } catch (error) {
      lingeringWriters.set(writer, cwd);
      throw error;
    }
  };

  const notifyCommandStarted = async (event: ShellCommandStartedEvent): Promise<void> => {
    try { await deps.commandLifecycle?.started?.(event); } catch { /* observers cannot change shell behavior */ }
  };

  const notifyCommandCompleted = (event: ShellCommandCompletedEvent): Promise<void> => {
    const priorOutputWrites = [...commandLifecyclePromises];
    return trackCommandLifecycle(
      Promise.all(priorOutputWrites).then(async () => {
      try { await deps.commandLifecycle?.completed?.(event); } catch { /* observers cannot change shell behavior */ }
      }),
    );
  };

  const notifyCommandOutput = (event: ShellCommandOutputEvent): Promise<void> => trackCommandLifecycle(
    Promise.resolve().then(async () => {
      try { await deps.commandLifecycle?.output?.(event); } catch { /* observers cannot change shell behavior */ }
    }),
  );

  const publishOutputDelta = (
    command: Pick<ShellCommandStartedEvent, "command" | "commandRunId" | "executionId" | "cwd" | "startedAt" | "toolCallId">
      & { observedOutputBytes: number; timing?: ShellExecTiming },
    chunk: string,
  ): void => {
    if (!chunk) return;
    if (command.timing && command.timing.firstOutputAt === undefined) {
      command.timing.firstOutputAt = Date.now();
    }
    const offset = command.observedOutputBytes;
    command.observedOutputBytes += Buffer.byteLength(chunk, "utf8");
    void notifyCommandOutput({
      command: command.command,
      commandRunId: command.commandRunId,
      executionId: command.executionId,
      cwd: command.cwd,
      startedAt: command.startedAt,
      offset,
      text: chunk,
      at: Date.now(),
      ...(command.toolCallId === undefined ? {} : { toolCallId: command.toolCallId }),
    });
    notifyShellChanged(command.executionId);
  };

  const closeBackgroundWriter = (background: BackgroundShell): Promise<void> => {
    if (background.writerClosePromise) return background.writerClosePromise;
    const writer = background.writer;
    if (!writer) return Promise.resolve();
    const closing = writer.close().then(() => {
      if (background.writer === writer) background.writer = null;
    });
    background.writerClosePromise = closing;
    void closing.then(
      () => { if (background.writerClosePromise === closing) delete background.writerClosePromise; },
      () => { if (background.writerClosePromise === closing) delete background.writerClosePromise; },
    );
    return closing;
  };

  const completeBackgroundCommand = (background: BackgroundShell, exitCode: number | null): Promise<void> => {
    if (background.lifecycleCompleted) return background.lifecyclePromise ?? closeBackgroundWriter(background);
    background.lifecycleCompleted = true;
    background.exited = true;
    background.exitCode = exitCode;
    if (background.outputStarted && background.frameBuffer) {
      background.output += background.frameBuffer;
      publishOutputDelta(background, background.frameBuffer);
      background.frameBuffer = "";
    }
    background.timing.endedAt = Date.now();
    const accepted = acceptedExecution(background.executionId);
    if (accepted) accepted.phase = "completed";
    const outputPreview = stripControlSequences(background.output);
    if (Buffer.byteLength(outputPreview, "utf8") > 32_768) {
      background.outputHandle = outputStore.store(sessionId, outputPreview, "bash").ref.handle;
      // The original body is now addressable through the paged store. Keep the
      // PTY map for status/control identity, not a second unbounded body copy.
      background.output = "";
    }
    const completed = notifyCommandCompleted({
      command: background.command,
      commandRunId: background.commandRunId,
      executionId: background.executionId,
      cwd: background.cwd,
      startedAt: background.startedAt,
      endedAt: Date.now(),
      exitCode,
      cancelled: background.cancelRequested,
      outputPreview,
      ...(background.outputHandle === undefined ? {} : { outputHandle: background.outputHandle }),
      ...(background.toolCallId === undefined ? {} : { toolCallId: background.toolCallId }),
      timing: { ...background.timing },
    });
    const lifecycle = trackCommandLifecycle(completed.then(() => closeBackgroundWriter(background)));
    background.lifecyclePromise = lifecycle;
    notifyShellChanged(background.id);
    notifyShellChanged(background.executionId);
    void lifecycle.then(
      () => { if (background.lifecyclePromise === lifecycle) delete background.lifecyclePromise; },
      () => { if (background.lifecyclePromise === lifecycle) delete background.lifecyclePromise; },
    );
    return lifecycle;
  };

  const unbindHandle = (handle: TerminalHandle): void => {
    const disposables = handleBindings.get(handle);
    if (disposables) {
      for (const disposable of disposables) {
        try { disposable.dispose?.(); } catch { /* already disposed */ }
      }
      handleBindings.delete(handle);
    }
    liveHandles.delete(handle);
  };

  const clearAllBindings = (): void => {
    for (const handle of [...handleBindings.keys()]) unbindHandle(handle);
  };

  const trackDisposable = (handle: TerminalHandle, disposable: { dispose?(): void }): void => {
    let disposables = handleBindings.get(handle);
    if (!disposables) {
      disposables = new Set();
      handleBindings.set(handle, disposables);
    }
    disposables.add(disposable);
  };

  const closePendingWriterAfterStop = async (pending: PendingCommand): Promise<void> => {
    const writer = pending.writer;
    if (!writer) return;
    await writer.close();
    pending.writer = null;
  };

  const closeBackgroundWriterAfterStop = async (background: BackgroundShell): Promise<void> => {
    const writer = background.writer;
    if (!writer) return;
    await writer.close();
    background.writer = null;
  };

  /**
   * Release command state only after the PTY has emitted its exit event. A
   * rejected writer close leaves the entry visible so worktree reclamation
   * keeps its protection and a later disposal attempt can retry the close.
   */
  const finalizeStoppedResources = async (): Promise<boolean> => {
    if (finalizingStop) return finalizingStop;
    const work = (async (): Promise<boolean> => {
      // onExit can arrive while a command is still acquiring its writer.
      // Keep the stopping state until that setup has handed over its resources.
      if (commandStartPromise) await commandStartPromise;
      const pending = pendingCommand;
      const backgrounds = [...backgroundShells.values()];
      const starting = [...startingWriters];
      try {
        await Promise.all([...commandLifecyclePromises]);
        const lingering = [...lingeringWriters.entries()];
        if (pending) await closePendingWriterAfterStop(pending);
        await Promise.all(backgrounds.map((background) => closeBackgroundWriterAfterStop(background)));
        await Promise.all(starting.map(async (writer) => {
          await writer.close();
          if (startingWriters.has(writer)) startingWriters.delete(writer);
        }));
        await Promise.all(lingering.map(([writer, cwd]) => closeCommandWriter(writer, cwd)));
      } catch {
        return false;
      }

      if (pendingCommand === pending && pending) {
        pendingCommand = null;
        pending.resolve({
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        });
      }
      for (const background of backgrounds) {
        if (backgroundShells.get(background.id) === background) backgroundShells.delete(background.id);
      }
      if (backgrounds.includes(activeBackground as BackgroundShell)) activeBackground = null;
      stopping = false;
      stoppingDirectory = null;
      stopped = true;
      disposeRequested = false;
      return true;
    })().finally(() => {
      finalizingStop = null;
    });
    finalizingStop = work;
    return work;
  };

  const resolveTerminalApi = (): TerminalSessionApi => {
    if (terminalApi) return terminalApi;
    throw new Error("Terminal runtime is not available");
  };

  const bindSessionHandle = (handle: TerminalHandle, initMarker: string): void => {
    let initBuffer = "";
    liveHandles.add(handle);
    const isCurrentSession = (): boolean => sessionHandle === handle;
    trackDisposable(handle, handle.onData((data: string) => {
      if (pendingCommand && isCurrentSession()) {
        const command = pendingCommand;
        const parsed = parseCommandOutput(command, data);
        outputBuffer += parsed.text;
        if (parsed.cwdEntered === false) command.cwd = handle.cwd;
        if (parsed.cwdEntered !== undefined) lastCwd = command.cwd;
        publishOutputDelta(command, parsed.text);
        if (parsed.exitCode !== undefined) completeCommand(parsed.exitCode, disposeRequested);
        return;
      }
      const background = backgroundShells.get(handle.id);
      if (background && !background.exited) {
        const parsed = parseCommandOutput(background, data);
        background.output += parsed.text;
        if (parsed.cwdEntered === false) background.cwd = handle.cwd;
        if (parsed.cwdEntered !== undefined) lastCwd = background.cwd;
        publishOutputDelta(background, parsed.text);
        if (parsed.exitCode !== undefined) {
          void completeBackgroundCommand(background, parsed.exitCode).catch(() => undefined);
          if (activeBackground === background) activeBackground = null;
        }
        background.lastOutputAt = Date.now();
        notifyShellChanged(background.id);
        return;
      }
      if (isCurrentSession() && !shellReady) {
        initBuffer += data;
        const cleaned = stripControlSequences(initBuffer);
        if (cleaned.includes(initMarker)) {
          shellReady = true;
          shellReadyResolve?.();
          shellReadyResolve = null;
          shellReadyReject = null;
        }
      }
    }));

    if (handle.onError) trackDisposable(handle, handle.onError((error) => {
      unavailableHandles.set(handle, error);
      if (isCurrentSession()) {
        shellReady = false;
        shellReadyReject?.(error);
        if (pendingCommand) { pendingCommand.cancelTimeout(); pendingCommand.reject(error); }
      }
      // Keep handles and writers until a real exit, not merely a broken pipe.
    }));

    trackDisposable(handle, handle.onExit((event) => {
      unavailableHandles.delete(handle);
      const wasCurrent = isCurrentSession();
      const wasInitializing = wasCurrent && !shellReady;
      liveHandles.delete(handle);
      if (wasCurrent) {
        sessionHandle = null;
        shellReady = false;
        shellReadyPromise = null;
      }
      if (wasInitializing) {
        const rejectReadyNow = shellReadyReject;
        shellReadyResolve = null;
        shellReadyReject = null;
        shellReadyPromise = null;
        rejectReadyNow?.(new Error(`Shell exited before ready (code ${event.exitCode})`));
        if (disposeRequested && liveHandles.size === 0) void finalizeStoppedResources();
        return;
      }
      if (disposeRequested) {
        const ownsPending = pendingCommand?.commandRunId === handle.id;
        if (ownsPending) {
          pendingCommand!.cancelTimeout();
          completeCommand(event.exitCode, true, true);
        }
        const background = backgroundShells.get(handle.id);
        if (background) {
          void completeBackgroundCommand(background, event.exitCode).catch(() => undefined);
          notifyShellChanged(background.id);
        }
        if (liveHandles.size === 0) void finalizeStoppedResources();
        return;
      }
      if (pendingCommand && wasCurrent) {
        pendingCommand.cancelTimeout();
        completeCommand(event.exitCode, false);
      }
      const background = backgroundShells.get(handle.id);
      if (background) {
        void completeBackgroundCommand(background, event.exitCode).catch(() => undefined);
        notifyShellChanged(background.id);
        if (activeBackground === background) activeBackground = null;
      }
    }));
  };

  const ensureShell = async (preferredCwd?: string): Promise<void> => {
    if (disposed) throw new Error("Shell supervisor has been disposed");
    if (sessionHandle && unavailableHandles.has(sessionHandle)) throw unavailableHandles.get(sessionHandle)!;
    if (shellReady && sessionHandle?.status === "running") return;
    if (sessionHandle?.status === "running") return shellReadyPromise ?? Promise.resolve();

    const initToken = randomBytes(8).toString("hex");
    const initMarker = `__VARIN_READY_${initToken}__`;

    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Disposal can reject readiness while spawn preparation is still awaiting
    // filesystem/terminal work. Observe it now; callers still receive rejection.
    void ready.catch(() => undefined);
    shellReadyPromise = ready;
    shellReadyResolve = resolveReady;
    shellReadyReject = rejectReady;
    shellReady = false;

    try {
      const api = resolveTerminalApi();
      if (disposed) throw new Error("Shell supervisor has been disposed");
      const spawnArgs = interpreter.kind === "powershell"
        ? [...interpreter.args, "-Command", `Write-Output ${quotePowerShell(initMarker)}`]
        : interpreter.args;
      const spawnCwd = await resolveSpawnCwd(preferredCwd);
      sessionHandle = await api.createTerminalSession({
        cwd: spawnCwd,
        cols,
        rows,
        owner: "harness",
        retainWhenDetached: true,
        registerProcessWriter: false,
        spawn: {
          executable: interpreter.command,
          args: spawnArgs,
          env: { ...process.env, ...baseEnv } as Record<string, string>,
        },
      });
      lastCwd = spawnCwd;
      bindSessionHandle(sessionHandle, initMarker);
      if (interpreter.kind !== "powershell") sessionHandle.write(`echo ${initMarker}\n`);
      return ready;
    } catch (error) {
      const handle = sessionHandle;
      sessionHandle = null;
      shellReadyPromise = null;
      shellReadyResolve = null;
      shellReadyReject = null;
      if (handle) unbindHandle(handle);
      try { await handle?.destroy(); } catch { /* already exited */ }
      rejectReady(error);
      return ready;
    }
  };

  const completeCommand = (exitCode: number | null, cancelled: boolean, disposedResult = false): void => {
    if (!pendingCommand) return;
    pendingCommand.cancelTimeout();
    pendingCommand.abortCleanup?.();
    const cmd = pendingCommand;
    pendingCommand = null;

    if (cmd.outputStarted && cmd.frameBuffer) {
      outputBuffer += cmd.frameBuffer;
      publishOutputDelta(cmd, cmd.frameBuffer);
      cmd.frameBuffer = "";
    }

    const cleanedOutput = stripControlSequences(outputBuffer);
    outputBuffer = "";
    let handle: string | null = null;
    let shown: { head: number; tail: number; total: number } | null = null;
    const totalBytes = Buffer.byteLength(cleanedOutput, "utf8");
    if (totalBytes > 32768) {
      const stored = outputStore.store(sessionId, cleanedOutput, "bash");
      handle = stored.ref.handle;
      shown = { head: 0, tail: 0, total: stored.total };
    }

    cmd.timing.endedAt = Date.now();
    const result: ShellExecResult = disposedResult
      ? {
        kind: "spawn-failed",
        reason: "disposed",
        interpreter: interpreter.command,
        hint: "Shell supervisor has been disposed",
      }
      : {
        kind: "completed",
        exitCode,
        durationMs: Date.now() - cmd.startedAt,
        cwd: cmd.cwd,
        stdout: cleanedOutput,
        stderr: "",
        handle,
        shown,
        ...(cmd.toolCallId === undefined ? {} : { toolCallId: cmd.toolCallId }),
        executionId: cmd.executionId,
        timing: { ...cmd.timing },
      };
    // Real exit/output remains observable while lifecycle hooks finish.
    const accepted = acceptedExecution(cmd.executionId);
    if (accepted) {
      accepted.result = compactAcceptedResult(result);
      accepted.phase = result.kind === "completed" ? "completed" : "failed";
    }
    notifyShellChanged(cmd.executionId);
    const completion = notifyCommandCompleted({
      command: cmd.command,
      commandRunId: cmd.commandRunId,
      executionId: cmd.executionId,
      cwd: cmd.cwd,
      startedAt: cmd.startedAt,
      endedAt: Date.now(),
      exitCode,
      cancelled,
      ...(handle ? { outputHandle: handle } : {}),
      outputPreview: cleanedOutput,
      ...(cmd.toolCallId === undefined ? {} : { toolCallId: cmd.toolCallId }),
      timing: { ...cmd.timing },
    }).then(async () => {
      try { await closeCommandWriter(cmd.writer, cmd.cwd); } catch { /* retained for disposal retry */ }
      cmd.resolve(result);
    });
    trackCommandLifecycle(completion);
  };

  const cancelUnwrittenCommand = ({
    command,
    commandRunId,
    executionId,
    cwd,
    startedAt,
    writer,
    outputPreview = "",
    toolCallId,
  }: {
    command: string;
    commandRunId: string;
    executionId: string;
    cwd: string;
    startedAt: number;
    writer: ShellWriter | null;
    outputPreview?: string;
    toolCallId?: string;
  }): void => {
    const completion = notifyCommandCompleted({
      command,
      commandRunId,
      executionId,
      cwd,
      startedAt,
      endedAt: Date.now(),
      exitCode: -1,
      cancelled: true,
      outputPreview,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }).then(async () => {
      try { await closeCommandWriter(writer, cwd); } catch { /* retained for disposal retry */ }
    });
    trackCommandLifecycle(completion);
  };

  const execCommand = async (
    command: string,
    options: { cwd?: string; defaultAnchorCwd?: string; waitMs: number; toolCallId?: string; signal?: AbortSignal },
    accepted: AcceptedExecution,
  ): Promise<ShellExecResult> => {
    if (disposed) return { kind: "spawn-failed", reason: "disposed", interpreter: interpreter.command, hint: "Shell supervisor has been disposed" };
    if (pendingCommand || commandStarting) throw new Error("Another command is already running");

    const timing = accepted.timing;
    // Freeze the default directory at command admission. A prior payload may
    // have changed its child shell's cwd, but that state never selects the next
    // command's directory.
    const admittedAnchor = options.defaultAnchorCwd ?? anchorCwd ?? deps.cwd ?? process.cwd();
    const selectedCwd = options.cwd ?? admittedAnchor;
    commandStarting = true;
    let startFinished = false;
    let finishStart: () => void = () => undefined;
    const startPromise = new Promise<void>((resolve) => { finishStart = resolve; });
    commandStartPromise = startPromise;
    try {
      // Do not let a new wrapper cross the previous command's completion
      // callback and writer-release boundary.
      await Promise.all([...commandLifecyclePromises]);
      const requestedCwd = await resolveExistingDirectory(selectedCwd);
      if (!requestedCwd) {
        commandStarting = false;
        return {
          kind: "spawn-failed",
          reason: "invalid-cwd",
          interpreter: interpreter.command,
          hint: `Invalid working directory: ${selectedCwd}`,
        };
      }
      commandStartingCwd = requestedCwd;
      await ensureShell(requestedCwd);
      if (!sessionHandle) {
        commandStarting = false;
        return { kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" };
      }

      const token = randomBytes(8).toString("hex");
      const executionId = accepted.executionId;
      const wrapped = buildCommandWrapper(command, token, interpreter.kind, shellCwdForCommand(requestedCwd));
      const cwd = requestedCwd;
      const startedAt = Date.now();
      const commandRunId = sessionHandle.id;

      // Register writer for the duration of command execution
      const writer = deps.registerWriter ? await deps.registerWriter() : null;
      if (writer) startingWriters.add(writer);
      if (disposed) {
        commandStarting = false;
        if (writer) {
          if (stopped) {
            try {
              await writer.close();
              startingWriters.delete(writer);
            } catch {
              // Keep the writer tracked so disposal can retry the close.
            }
          }
        }
        finishStart();
        startFinished = true;
        return {
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        };
      }

      await notifyCommandStarted({
        command,
        commandRunId,
        executionId,
        cwd,
        startedAt,
        ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
      });
      if (disposed) {
        commandStarting = false;
        if (writer && stopped) {
          try { await writer.close(); startingWriters.delete(writer); } catch { /* disposal retries the close */ }
        }
        cancelUnwrittenCommand({ command, commandRunId, executionId, cwd, startedAt, writer: writer && !stopped ? writer : null,
          ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }) });
        finishStart();
        startFinished = true;
        return {
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        };
      }

      return new Promise<ShellExecResult>((resolvePromise, rejectPromise) => {
        outputBuffer = "";
        const detachToBackground = (): void => {
          if (pendingCommand?.token !== token) return;
          cancelTimeout();
          pendingCommand.abortCleanup?.();
          const handle = sessionHandle;
          if (!handle) {
            pendingCommand = null;
            resolvePromise({
              kind: "spawn-failed",
              reason: "no-shell",
              interpreter: interpreter.command,
              hint: "Shell not initialized",
            });
            return;
          }
          const id = handle.id;
          const bgShell: BackgroundShell = {
            id,
            token,
            executionId,
            commandRunId: id,
            startedAt,
            command,
            output: outputBuffer,
            cwd: pendingCommand?.cwd ?? cwd,
            exited: false,
            exitCode: null,
            cancelRequested: false,
            lifecycleCompleted: false,
            lastOutputAt: stripControlSequences(outputBuffer).length > 0 ? Date.now() : null,
            observedOutputBytes: pendingCommand?.observedOutputBytes ?? 0,
            outputControlState: pendingCommand?.outputControlState ?? "text",
            frameBuffer: pendingCommand?.frameBuffer ?? "",
            outputStarted: pendingCommand?.outputStarted ?? false,
            writer,
            handle,
            timing,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          };
          backgroundShells.set(id, bgShell);
          activeBackground = bgShell;
          lastCwd = bgShell.cwd;
          sessionHandle = null;
          shellReady = false;
          shellReadyPromise = null;
          pendingCommand = null;
          outputBuffer = "";

          timing.detachedAt = Date.now();
          const cleanedOutput = stripControlSequences(bgShell.output);
          const result: ShellExecResult = {
            kind: "background",
            id,
            waitedMs: Math.max(0, Date.now() - timing.acceptedAt),
            cwd: bgShell.cwd,
            outputSoFar: cleanedOutput,
            command,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
            executionId,
            timing: { ...timing },
          };
          accepted.result = compactAcceptedResult(result);
          accepted.phase = "background";
          resolvePromise(result);
          notifyShellChanged(id);
          notifyShellChanged(executionId);
        };
        const cancelTimeout = scheduleAtDeadline(timing.acceptedAt + options.waitMs, detachToBackground);
        const onAbort = (): void => detachToBackground();

        pendingCommand = {
          token,
          executionId,
          commandRunId,
          command,
          resolve: resolvePromise,
          reject: rejectPromise,
          cancelTimeout,
          cwd,
          writer,
          startedAt,
          timing,
          observedOutputBytes: 0,
          outputControlState: "text",
          frameBuffer: "",
          outputStarted: false,
          ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          ...(options.signal === undefined ? {} : {
            abortCleanup: () => options.signal?.removeEventListener("abort", onAbort),
          }),
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) queueMicrotask(detachToBackground);
        if (writer) startingWriters.delete(writer);
        commandStartingCwd = null;
        finishStart();
        startFinished = true;
        commandStarting = false;

        const shell = sessionHandle;
        if (!shell) {
          cancelTimeout();
          pendingCommand?.abortCleanup?.();
          pendingCommand = null;
          commandStarting = false;
          cancelUnwrittenCommand({ command, commandRunId, executionId: token, cwd, startedAt, writer,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }) });
          resolvePromise({ kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" });
          return;
        }
        try {
          timing.sentAt = Date.now();
          accepted.phase = "running";
          shell.write(`${wrapped}${interpreter.kind === "powershell" ? "\r\n" : "\n"}`);
          notifyShellChanged(executionId);
        } catch (error) {
          cancelTimeout();
          pendingCommand?.abortCleanup?.();
          pendingCommand = null;
          commandStarting = false;
          accepted.phase = "failed";
          cancelUnwrittenCommand({
            command,
            commandRunId,
            executionId: token,
            cwd,
            startedAt,
            writer,
            outputPreview: stripControlSequences(outputBuffer),
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          });
          resolvePromise({
            kind: "spawn-failed",
            reason: error instanceof Error ? error.message : String(error),
            interpreter: interpreter.command,
            hint: "Shell rejected the command",
          });
        }
      });
    } catch (error) {
      commandStarting = false;
      throw error;
    } finally {
      commandStartingCwd = null;
      if (!startFinished) finishStart();
      if (commandStartPromise === startPromise) commandStartPromise = null;
    }
  };

  const exec = (
    command: string,
    options: { cwd?: string; defaultAnchorCwd?: string; waitMs: number; toolCallId?: string; signal?: AbortSignal },
  ): Promise<ShellExecResult> => {
    const toolCallId = options.toolCallId;
    if (toolCallId) {
      const existing = acceptedExecutions.get(toolCallId);
      if (existing) {
        if (existing.command !== command || existing.cwd !== options.cwd) {
          throw new Error(`Tool call ${toolCallId} is already bound to another command or working directory`);
        }
        if (existing.promise) return existing.promise;
        if (existing.responseResult) return Promise.resolve(existing.responseResult);
        if (existing.failure !== undefined) return Promise.reject(existing.failure);
        if (existing.result) return Promise.resolve(existing.result);
        return Promise.reject(new Error(`Tool call ${toolCallId} has no recoverable shell response`));
      }
    }

    const executionId = `exec_${randomBytes(16).toString("hex")}`;
    const timing: ShellExecTiming = { acceptedAt: Date.now() };
    let resolveResponse!: (result: ShellExecResult) => void;
    let rejectResponse!: (error: unknown) => void;
    const promise = new Promise<ShellExecResult>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const accepted: AcceptedExecution = {
      command,
      cwd: options.cwd,
      executionId,
      promise,
      timing,
      phase: "preparing",
    };
    acceptedExecutions.set(executionId, accepted);
    if (toolCallId) acceptedExecutions.set(toolCallId, accepted);

    let responseSettled = false;
    const settleResponse = (result: ShellExecResult): void => {
      if (responseSettled) return;
      responseSettled = true;
      cancelPreparationTimer();
      const respondedAt = Date.now();
      timing.respondedAt = respondedAt;
      const returned = "timing" in result
        ? { ...result, timing: { ...result.timing, respondedAt } }
        : result;
      accepted.responseResult = compactAcceptedResult(returned);
      delete accepted.promise;
      if (accepted.result && "executionId" in accepted.result && accepted.result.executionId === executionId) {
        accepted.result = compactAcceptedResult(returned);
      }
      resolveResponse(returned);
    };
    const waitBudget = Math.max(0, options.waitMs);
    const onPreparationBudget = (): void => {
      if (accepted.result) {
        settleResponse(accepted.result);
        return;
      }
      if (accepted.phase !== "preparing") return;
      const detachedAt = Date.now();
      timing.detachedAt = detachedAt;
      settleResponse({
        kind: "preparing",
        id: executionId,
        command,
        waitedMs: Math.max(0, detachedAt - timing.acceptedAt),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        executionId,
        timing: { ...timing },
      });
      notifyShellChanged(executionId);
    };
    const cancelPreparationTimer = scheduleAtDeadline(timing.acceptedAt + waitBudget, onPreparationBudget);

    void execCommand(command, options, accepted).then((result) => {
      accepted.result = compactAcceptedResult(result);
      accepted.phase = result.kind === "completed" ? "completed"
        : result.kind === "background" ? "background"
          : result.kind === "preparing" ? "preparing" : "failed";
      settleResponse(result);
      notifyShellChanged(executionId);
    }, (error: unknown) => {
      accepted.failure = error;
      accepted.phase = "failed";
      if (!responseSettled) {
        responseSettled = true;
        cancelPreparationTimer();
        delete accepted.promise;
        rejectResponse(error);
      }
      notifyShellChanged(executionId);
    });
    return promise;
  };

  const read = async (id: string, offset: number = 0, length: number = 32768): Promise<OutputSlice & { running: boolean; exitCode?: number; executionId?: string; cwd?: string; lastOutputAt?: number; command?: string; shellId?: string; spawnFailed?: string; unavailable?: string; phase?: "preparing" }> => {
    const accepted = acceptedExecution(id);
    const recovered = accepted?.result;
    if (recovered?.kind === "background" && recovered.id !== id) {
      const result = await read(recovered.id, offset, length);
      return { ...result, shellId: recovered.id };
    }
    if (recovered?.kind === "spawn-failed") {
      // The identity is known but never produced output — honest terminal
      // state, not "not found".
      return {
        text: "", offset, length: 0, nextOffset: offset, total: 0, eof: true,
        running: false, spawnFailed: recovered.reason,
      };
    }
    if (recovered?.kind === "completed") {
      return { ...readCompletedOutput(recovered, offset, length), running: false,
        ...(recovered.executionId === undefined ? {} : { executionId: recovered.executionId }),
        cwd: recovered.cwd,
        ...(recovered.exitCode === null ? {} : { exitCode: recovered.exitCode }) };
    }
    if (accepted?.failure !== undefined) {
      const reason = accepted.failure instanceof Error ? accepted.failure.message : String(accepted.failure);
      return {
        text: "", offset, length: 0, nextOffset: offset, total: 0, eof: true,
        running: false, spawnFailed: reason, executionId: accepted.executionId,
      };
    }
    // Check background shells
    const bg = backgroundShells.get(id);
    if (bg) {
      if (unavailableHandles.has(bg.handle)) throw unavailableHandles.get(bg.handle)!;
      const slice = readBackgroundOutput(bg, offset, length);
      return {
        ...slice,
        running: !bg.exited,
        command: bg.command,
        executionId: bg.executionId,
        cwd: bg.cwd,
        ...(bg.exitCode !== null ? { exitCode: bg.exitCode } : {}),
        ...(bg.lastOutputAt !== null ? { lastOutputAt: bg.lastOutputAt } : {}),
      };
    }
    if (accepted && !accepted.result) {
      const live = accepted.phase === "running"
        ? readExecutionOutput(accepted.executionId, offset, length)
        : null;
      if (live) return { ...live, command: accepted.command, executionId: accepted.executionId };
      return {
        ...sliceUtf8ByBytes("", offset, length), eof: false, running: true,
        ...(accepted.phase === "preparing" ? { phase: "preparing" as const } : {}),
        command: accepted.command,
        executionId: accepted.executionId,
      };
    }
    // Execution ids (from lifecycle events / tool details) resolve to live
    // pending and background commands as well.
    const byExecution = readExecutionOutput(id, offset, length);
    if (byExecution) return byExecution;
    // Check output store (out_ handles)
    if (/^exec_[0-9a-f]{32}$/u.test(id) || /^sh_\d+$/u.test(id)) {
      return {
        text: "", offset, length: 0, nextOffset: offset, total: 0, eof: false,
        running: false,
        ...(id.startsWith("exec_") ? { executionId: id } : {}),
        unavailable: "This shell reference is unavailable in the current Host generation; live execution output was not retained across its restart or session replacement.",
      };
    }
    const result = outputStore.read(sessionId, id, offset, length);
    if (result.status === "ready") return { ...result.slice, running: false };
    if (result.status === "expired") throw new Error(`Output expired: ${id}`);
    throw new Error(`Shell not found: ${id}`);
  };

  const waitForOutput = async (
    id: string,
    offset: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const accepted = acceptedExecution(id);
    const initialPhase = accepted?.phase;
    const recovered = accepted?.result;
    const shellId = recovered?.kind === "background" ? recovered.id : id;
    const hasChange = (): boolean => {
      const currentAccepted = acceptedExecution(id);
      if (currentAccepted) {
        if (currentAccepted.failure !== undefined || currentAccepted.phase === "completed" || currentAccepted.phase === "failed") return true;
        if (currentAccepted.phase !== initialPhase) return true;
        if (currentAccepted.phase === "preparing") return false;
        const live = readExecutionOutput(currentAccepted.executionId, offset, 0);
        return live === null || live.total > offset;
      }
      const background = backgroundShells.get(shellId);
      if (!background) return true;
      if (unavailableHandles.has(background.handle) || background.exited) return true;
      return background.observedOutputBytes > offset;
    };
    if (waitMs <= 0 || hasChange()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waitId = accepted?.executionId ?? shellId;
      const waiters = shellChangeWaiters.get(waitId) ?? new Set<() => void>();
      shellChangeWaiters.set(waitId, waiters);
      const cleanup = (): void => {
        cancelTimeout();
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0 && shellChangeWaiters.get(waitId) === waiters) shellChangeWaiters.delete(waitId);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const wake = (): void => finish();
      const onAbort = (): void => finish(new Error("Shell output wait aborted"));
      waiters.add(wake);
      const cancelTimeout = scheduleAtDeadline(Date.now() + waitMs, wake);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the event-subscription race: output may have arrived between the
      // first check and registering this waiter.
      if (hasChange()) wake();
    });
  };

  const write = async (id: string, text: string): Promise<boolean> => {
    const recovered = acceptedExecutions.get(id)?.result;
    const bg = backgroundShells.get(recovered?.kind === "background" ? recovered.id : id);
    if (!bg || bg.exited) return false;
    try {
      bg.handle.write(text);
      return true;
    } catch {
      return false;
    }
  };

  const kill = async (id: string): Promise<boolean> => {
    const recovered = acceptedExecutions.get(id)?.result;
    const bg = backgroundShells.get(recovered?.kind === "background" ? recovered.id : id);
    if (!bg) return false;
    if (bg.exited) {
      try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
      return true;
    }
    if (bg.handle.status === "exited") {
      try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
      return bg.exited;
    }
    bg.cancelRequested = true;
    // A background handle is no longer the foreground session. Terminate that
    // exact PTY through the runtime, which owns process-tree escalation and
    // the real exit event. A successful write or interrupt alone is not a kill.
    try {
      await bg.handle.terminate(true);
    } catch {
      return false;
    }
    if (!bg.exited && (bg.handle.status as TerminalHandle["status"]) !== "exited") return false;
    try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
    return bg.exited;
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    if (stopped) return Promise.resolve();

    disposeRequested = true;
    disposed = true;
    stopping = true;
    stoppingDirectory = deps.cwd ?? process.cwd();
    const commandStart = commandStartPromise;
    const work = (async (): Promise<void> => {
      for (const id of [...shellChangeWaiters.keys()]) notifyShellChanged(id);
      const rejectReady = shellReadyReject;
      shellReadyResolve = null;
      shellReadyReject = null;
      shellReadyPromise = null;
      shellReady = false;
      rejectReady?.(new Error("Shell supervisor has been disposed"));
      if (pendingCommand) {
        pendingCommand.cancelTimeout();
        pendingCommand.abortCleanup?.();
      }

      const handles = [
        ...(sessionHandle ? [sessionHandle] : []),
        ...[...backgroundShells.values()].map((background) => background.handle),
      ];
      sessionHandle = null;
      shellReady = false;
      shellReadyPromise = null;
      let stopFailed = false;
      let stopError: unknown;
      for (const handle of handles) {
        let waiterDispose: (() => void) | undefined;
        const exited = new Promise<void>((resolve, reject) => {
          let settled = false;
          let subscription: { dispose?(): void } | undefined;
          const timer = setTimeout(() => {
            settle(new Error("Shell process did not exit during disposal"));
          }, 3000);
          const settle = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            if (error === undefined) resolve();
            else reject(error);
          };
          waiterDispose = () => {
            if (timer) clearTimeout(timer);
            try { subscription?.dispose?.(); } catch { /* already disposed */ }
          };
          try {
            subscription = handle.onExit(() => {
              if (timer) clearTimeout(timer);
              settle();
            });
          } catch (error) {
            if (timer) clearTimeout(timer);
            settle(error);
          }
        });
        try {
          await handle.terminate();
          await exited;
          await handle.destroy();
        } catch (error) {
          waiterDispose?.();
          void exited.catch(() => undefined);
          stopFailed = true;
          stopError = error;
          break;
        }
        waiterDispose?.();
      }
      if (!stopFailed) clearAllBindings();

      // A command may still be awaiting writer registration. Let that setup
      // observe disposal and settle before finalizing the stopped resources;
      // otherwise a late writer could appear after dispose resolves.
      if (commandStart) await commandStart;
      if (stopFailed) throw stopError ?? new Error("Shell process did not stop during disposal");
      const finalized = await finalizeStoppedResources();
      if (!finalized) throw new Error("Shell writers did not close after process exit");


    })();
    disposePromise = work.finally(() => {
      disposePromise = null;
    });
    return disposePromise;
  };

  const hasActiveCommandAt = (directory: string): boolean => {
    const target = path.resolve(directory);
    const overlaps = (cwd: string): boolean => {
      const resolved = path.resolve(cwd);
      const left = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const right = process.platform === "win32" ? target.toLowerCase() : target;
      const relative = path.relative(left, right);
      const reverse = path.relative(right, left);
      const contained = (value: string): boolean => value === ""
        || (value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
      return contained(relative) || contained(reverse);
    };
    const admittedRoot = deps.cwd ?? process.cwd();
    if (stopping && stoppingDirectory && overlaps(stoppingDirectory)) return true;
    if (commandStarting && (commandStartingCwd ? overlaps(commandStartingCwd) : overlaps(admittedRoot))) return true;
    if (pendingCommand && (overlaps(pendingCommand.cwd) || overlaps(admittedRoot))) return true;
    for (const background of backgroundShells.values()) {
      if ((!background.exited || background.writer !== null || background.writerClosePromise !== undefined)
        && (overlaps(background.cwd) || overlaps(admittedRoot))) return true;
    }
    for (const cwd of lingeringWriters.values()) if (overlaps(cwd) || overlaps(admittedRoot)) return true;
    return false;
  };

  const inspectExecution = (executionId: string): { running: boolean; exitCode?: number } | null => {
    if (pendingCommand?.executionId === executionId) return { running: true };
    for (const background of backgroundShells.values()) {
      if (background.executionId !== executionId) continue;
      return {
        running: !background.exited,
        ...(background.exitCode === null ? {} : { exitCode: background.exitCode }),
      };
    }
    for (const accepted of acceptedExecutions.values()) {
      const result = accepted.result;
      if (!result || result.kind === "spawn-failed" || result.executionId !== executionId) continue;
      if (result.kind === "completed") {
        return {
          running: false,
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        };
      }
      const background = backgroundShells.get(result.id);
      if (background) {
        return {
          running: !background.exited,
          ...(background.exitCode === null ? {} : { exitCode: background.exitCode }),
        };
      }
    }
    return null;
  };

  function readCompletedOutput(result: Extract<ShellExecResult, { kind: "completed" }>, offset: number, length: number): OutputSlice {
    if (result.handle) {
      const stored = outputStore.read(sessionId, result.handle, offset, length);
      if (stored.status === "ready") return stored.slice;
      throw new Error(stored.status === "expired" ? `Output expired: ${result.handle}` : `Output unavailable: ${result.handle}`);
    }
    return sliceUtf8ByBytes(`${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`, offset, length);
  }

  function readBackgroundOutput(background: BackgroundShell, offset: number, length: number): OutputSlice {
    if (!background.outputHandle) {
      return sliceUtf8ByBytes(stripControlSequences(background.output), offset, length);
    }
    const stored = outputStore.read(sessionId, background.outputHandle, offset, length);
    if (stored.status === "ready") return stored.slice;
    throw new Error(stored.status === "expired"
      ? `Output expired: ${background.outputHandle}`
      : `Output unavailable: ${background.outputHandle}`);
  }

  const readExecutionOutput = (executionId: string, offset = 0, length = 32 * 1024): (OutputSlice & {
    running: boolean;
    exitCode?: number;
    cwd?: string;
  }) | null => {
    if (pendingCommand?.executionId === executionId) {
      return { ...sliceUtf8ByBytes(stripControlSequences(outputBuffer), offset, length), running: true, cwd: pendingCommand.cwd };
    }
    for (const background of backgroundShells.values()) {
      if (background.executionId !== executionId) continue;
      return {
        ...readBackgroundOutput(background, offset, length),
        running: !background.exited,
        cwd: background.cwd,
        ...(background.exitCode === null ? {} : { exitCode: background.exitCode }),
      };
    }
    for (const accepted of acceptedExecutions.values()) {
      const result = accepted.result;
      if (!result || result.kind !== "completed" || result.executionId !== executionId) continue;
      return {
        ...readCompletedOutput(result, offset, length),
          running: false,
          cwd: result.cwd,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      };
    }
    return null;
  };

  const setAnchorCwd = (directory: string | undefined): void => {
    if (anchorCwd === directory) return;
    anchorCwd = directory;
  };

  return {
    exec,
    read,
    waitForOutput,
    write,
    kill,
    dispose,
    hasActiveCommandAt,
    inspectExecution,
    readExecutionOutput,
    setAnchorCwd,
  };
}
