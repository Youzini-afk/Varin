/**
 * Computer Use driver supervisor (BC4).
 *
 * A desktop's platform driver is one resident helper process speaking a
 * line-delimited JSON protocol on stdin/stdout — the managed connection the
 * product plan requires in place of per-action interpreter restarts. This
 * module owns spawn, request/response correlation, stderr capture, and the
 * restart-on-unexpected-exit boundary; higher layers own catalogs,
 * observations, and cancellation semantics.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ComputerCapabilities, ComputerPlatform } from "@varin/protocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const STDERR_TAIL_MAX_CHARS = 4000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** The op vocabulary shared by every platform driver (README.md). */
export interface DriverRequest {
  id: string;
  tool:
    | "ping"
    | "capabilities"
    | "list_apps"
    | "get_app_state"
    | "click"
    | "perform_secondary_action"
    | "scroll"
    | "drag"
    | "type_text"
    | "press_key"
    | "set_value"
    | "release_input";
  [key: string]: unknown;
}

export interface DriverResponse {
  id: string | null;
  ok: boolean;
  error?: string;
  text?: string;
  apps?: Array<{ name: string; pid: number; windowTitle?: string }>;
  snapshot?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

export interface DriverSpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Driver assets live beside the packages layout in development and in the
 * compiled `server/` tree (same relative depth). Packaged installs may
 * redirect this via VARIN_COMPUTER_DRIVER_DIR.
 */
export function computerDriverDir(): string {
  if (process.env.VARIN_COMPUTER_DRIVER_DIR) return process.env.VARIN_COMPUTER_DRIVER_DIR;
  return fileURLToPath(new URL("../../../../computer-driver", import.meta.url));
}

/** Spawn spec for this platform's resident driver, or null when unsupported. */
export function localDriverSpawnSpec(platform: ComputerPlatform, driverDir = computerDriverDir()): DriverSpawnSpec | null {
  if (platform === "windows") {
    const script = path.join(driverDir, "windows", "driver-host.ps1");
    if (!existsSync(script)) return null;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    };
  }
  if (platform === "linux") {
    const script = path.join(driverDir, "linux", "driver-host.py");
    if (!existsSync(script)) return null;
    return {
      command: "python3",
      args: [script],
      cwd: path.dirname(script),
    };
  }
  // macOS: the OCU Swift helper is the intended source; until a bundled
  // helper exists there is no local driver (reported honestly upstream).
  return null;
}

interface PendingDriverRequest {
  resolve(response: DriverResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ComputerDriverSession {
  /** Serialize ops: one request in flight at a time — the desktop input stream is inherently ordered. */
  request(op: Omit<DriverRequest, "id">, options?: { timeoutMs?: number }): Promise<DriverResponse>;
  /** The last successful capabilities probe, if any. */
  readonly capabilities: ComputerCapabilities | null;
  alive(): boolean;
  dispose(): void;
}

export function createDriverSession(spec: DriverSpawnSpec): ComputerDriverSession {
  let child: ChildProcess | null = null;
  let buffer = "";
  const pending = new Map<string, PendingDriverRequest>();
  const queue: Array<() => void> = [];
  let inFlight = false;
  let stderrTail = "";
  let caps: ComputerCapabilities | null = null;
  let intentionalClose = false;
  let disposed = false;

  const isAlive = () => child !== null && !child.killed && child.exitCode === null;

  const failAll = (error: Error) => {
    for (const [, p] of pending) {
      clearTimeout(p.timeout);
      p.reject(error);
    }
    pending.clear();
    inFlight = false;
    // Queued ops retry on a fresh spawn through the normal pump path.
    pump();
  };

  const onLine = (line: string) => {
    let message: DriverResponse;
    try {
      message = JSON.parse(line) as DriverResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "string" || message.id === null) return;
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clearTimeout(p.timeout);
    inFlight = false;
    p.resolve(message);
    pump();
  };

  const sendNext = (run: () => void) => {
    queue.push(run);
    pump();
  };

  const pump = () => {
    if (inFlight || queue.length === 0) return;
    const run = queue.shift();
    if (!run) return;
    inFlight = true;
    run();
  };

  const ensureChild = (): ChildProcess => {
    if (isAlive() && child) return child;
    intentionalClose = false;
    buffer = "";
    stderrTail = "";
    const spawned = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawned;
    spawned.stdout?.setEncoding("utf8");
    spawned.stderr?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        buffer = "";
        failAll(new Error("Computer driver response exceeded the frame limit"));
        spawned.kill();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
      }
    });
    spawned.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
    });
    spawned.on("error", () => {
      if (child === spawned) child = null;
      failAll(new Error(`Computer driver failed to start: ${spec.command}`));
    });
    spawned.on("exit", (code, signal) => {
      if (child !== spawned) return;
      child = null;
      if (intentionalClose) return;
      const tail = stderrTail.trim();
      failAll(new Error(
        `Computer driver exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ''})`
        + (tail ? `: ${tail.slice(-400)}` : ""),
      ));
    });
    return spawned;
  };

  const request: ComputerDriverSession["request"] = (op, options = {}) => new Promise<DriverResponse>((resolve, reject) => {
    if (disposed) {
      reject(new Error("Computer driver session is disposed"));
      return;
    }
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      inFlight = false;
      // A wedged driver is replaced: a stuck op cannot hold the desktop's
      // input queue hostage.
      if (child && !intentionalClose) {
        try { child.kill(); } catch { /* ignore */ }
      }
      reject(new Error(`Computer driver request timed out: ${op.tool}`));
      pump();
    }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    sendNext(() => {
      let target: ChildProcess;
      try {
        target = ensureChild();
      } catch (error) {
        clearTimeout(timeout);
        inFlight = false;
        reject(error instanceof Error ? error : new Error(String(error)));
        pump();
        return;
      }
      pending.set(id, { resolve, reject, timeout });
      try {
        target.stdin?.write(JSON.stringify({ ...op, id }) + "\n");
      } catch (error) {
        pending.delete(id);
        clearTimeout(timeout);
        inFlight = false;
        reject(error instanceof Error ? error : new Error(String(error)));
        pump();
      }
    });
  });

  // Wrap: cache the capabilities probe per session lifetime.
  const wrapped: ComputerDriverSession = {
    request: async (op, options) => {
      const response = await request(op, options);
      if (op.tool === "capabilities" && response.ok && response.capabilities) {
        caps = response.capabilities as unknown as ComputerCapabilities;
      }
      return response;
    },
    get capabilities() { return caps; },
    alive: isAlive,
    dispose: () => {
      disposed = true;
      intentionalClose = true;
      failAll(new Error("Computer driver disposed"));
      if (child) {
        try { child.kill(); } catch { /* ignore */ }
        child = null;
      }
    },
  };
  return wrapped;
}
