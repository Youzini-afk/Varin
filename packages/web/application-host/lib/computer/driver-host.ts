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
  id: string;
  op: Omit<DriverRequest, "id">;
  timeoutMs: number;
  resolve(response: DriverResponse): void;
  reject(error: Error): void;
  timeout?: ReturnType<typeof setTimeout>;
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
  let active: PendingDriverRequest | null = null;
  const queue: PendingDriverRequest[] = [];
  let stderrTail = "";
  let caps: ComputerCapabilities | null = null;
  let disposed = false;

  const isAlive = () => child !== null && !child.killed && child.exitCode === null;

  const failAll = (error: Error) => {
    if (active) { clearTimeout(active.timeout); active.reject(error); active = null; }
    for (const queued of queue.splice(0)) queued.reject(error);
    caps = null;
  };

  const onLine = (line: string) => {
    let message: DriverResponse;
    try {
      message = JSON.parse(line) as DriverResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "string" || message.id === null) return;
    const p = active;
    if (!p || message.id !== p.id) return;
    if (typeof message.ok !== "boolean") {
      stop(new Error("Computer driver returned a malformed response"));
      return;
    }
    active = null;
    clearTimeout(p.timeout);
    p.resolve(message);
    pump();
  };

  const pump = () => {
    if (disposed || active || queue.length === 0) return;
    const next = queue.shift()!;
    active = next;
    try {
      const target = ensureChild();
      // Waiting in the queue must never expire and later send a rejected op.
      next.timeout = setTimeout(() => stop(new Error(
        `Computer driver request timed out: ${next.op.tool}; its effect is unknown`,
      )), next.timeoutMs);
      target.stdin!.write(JSON.stringify({ ...next.op, id: next.id }) + "\n", (error) => {
        if (error && child === target) stop(error);
      });
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const stop = (error: Error): void => {
    const target = child;
    child = null;
    failAll(error);
    target?.kill();
  };

  const ensureChild = (): ChildProcess => {
    if (isAlive() && child) return child;
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
      if (child !== spawned) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        buffer = "";
        stop(new Error("Computer driver response exceeded the frame limit; its effect is unknown"));
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
      if (child !== spawned) return;
      stop(new Error(`Computer driver failed to start: ${spec.command}`));
    });
    spawned.on("exit", (code, signal) => {
      if (child !== spawned) return;
      child = null;
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
    queue.push({ id: randomUUID(), op: structuredClone(op), timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, resolve, reject });
    pump();
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
      stop(new Error("Computer driver disposed"));
    },
  };
  return wrapped;
}
