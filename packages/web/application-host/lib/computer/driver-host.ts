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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerCapabilities, ComputerPlatform } from "@varin/protocol";
import { remapAsarUnpackedPath } from "../structure/runtime-path.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const STDERR_TAIL_MAX_CHARS = 4000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

// Set the transport encoding before PowerShell loads a file: startup failures
// must use the same UTF-8 protocol as successful driver responses.
const WINDOWS_DRIVER_BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
try { & $env:VARIN_COMPUTER_DRIVER_ENTRY }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

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
    | "release_input"
    /** Whole-desktop frame capture for view subscribers (BC5.B). */
    | "capture_frame"
    /** Absolute-coordinate human input through the control lane (BC5.C). */
    | "inject_input"
    /** Open a URL/path/application on the desktop's own machine (EE). */
    | "open"
    /** CDP attach to the visible Chromium session (EE §7.2). */
    | "browser"
    | "office";
  [key: string]: unknown;
}

export interface DriverResponse {
  /** Preflight rejection proved no input was sent; other failed responses remain uncertain. */
  rejected?: boolean;
  id: string | null;
  ok: boolean;
  /** The driver aborted the operation at an internal checkpoint (BC4.A). */
  cancelled?: boolean;
  error?: string;
  text?: string;
  apps?: Array<{
    name: string;
    pid: number;
    windowTitle?: string;
    windows?: Array<Record<string, unknown>>;
  }>;
  snapshot?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /** Whole-desktop frame returned by `capture_frame` (BC5.B). */
  frame?: {
    mime?: string;
    base64?: string;
    bounds?: Record<string, unknown>;
    capturedAt?: string;
  };
  /** Launched process id returned by `open` (EE). */
  pid?: number;
}

export interface DriverSpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Explicit override, immutable assets in this compiled Host generation, then
 * the source checkout for uncompiled development. Packaged code and drivers
 * are published together and do not depend on a source checkout.
 */
export function computerDriverDir(): string {
  if (process.env.VARIN_COMPUTER_DRIVER_DIR) return remapAsarUnpackedPath(process.env.VARIN_COMPUTER_DRIVER_DIR);
  const generationAssets = remapAsarUnpackedPath(fileURLToPath(new URL("../../computer-driver", import.meta.url)));
  if (existsSync(generationAssets)) return generationAssets;
  const sourceCheckout = fileURLToPath(new URL("../../../../computer-driver", import.meta.url));
  if (existsSync(sourceCheckout)) return sourceCheckout;
  return generationAssets;
}

/** Spawn spec for this platform's resident driver, or null when unsupported. */
export function localDriverSpawnSpec(platform: ComputerPlatform, driverDir = computerDriverDir()): DriverSpawnSpec | null {
  // Node can read virtual ASAR paths; external interpreters require real files.
  driverDir = remapAsarUnpackedPath(driverDir);
  if (platform === "windows") {
    const script = path.join(driverDir, "windows", "driver-host.ps1");
    if (!existsSync(script)) return null;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_DRIVER_BOOTSTRAP],
      env: { ...process.env, VARIN_COMPUTER_DRIVER_ENTRY: script },
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
  if (platform === "macos") {
    const script = path.join(driverDir, "macos", "driver-host.js");
    if (!existsSync(script)) return null;
    // JXA driver: CGWindowList + System Events + CGEvent via osascript.
    // Unverified platform — the driver reports conservative capabilities.
    return {
      command: "osascript",
      args: ["-l", "JavaScript", script],
      cwd: path.dirname(script),
    };
  }
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
  /**
   * Interrupt the in-flight request at the driver's next internal checkpoint
   * (BC4.A). stdin stays sequential, so cancellation travels through a flag
   * file the long operations poll; returns false when nothing is in flight.
   */
  cancel(): boolean;
  /** The last successful capabilities probe, if any. */
  readonly capabilities: ComputerCapabilities | null;
  alive(): boolean;
  dispose(): void | Promise<void>;
}

export function createDriverSession(spec: DriverSpawnSpec): ComputerDriverSession {
  let child: ChildProcess | null = null;
  let buffer = "";
  let active: PendingDriverRequest | null = null;
  const queue: PendingDriverRequest[] = [];
  let stderrTail = "";
  let caps: ComputerCapabilities | null = null;
  let disposed = false;
  const retiring = new Set<Promise<unknown>>();
  // Side-channel cancellation: long native ops poll <dir>/<id>.cancel so a
  // cancel lands mid-operation even while stdin is unread.
  const cancelDir = path.join(os.tmpdir(), `varin-computer-driver-${process.pid}-${randomUUID()}`);
  const clearCancelDir = () => {
    try { rmSync(cancelDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

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
    if (target) {
      // A failed caller wait does not prove the native helper stopped emitting
      // input. Replacement/disposal must await actual process closure.
      const closed = new Promise<void>((resolve) => target.once("close", () => resolve()));
      retiring.add(closed);
      void closed.finally(() => retiring.delete(closed));
      target.kill();
    }
  };

  const ensureChild = (): ChildProcess => {
    if (isAlive() && child) return child;
    buffer = "";
    stderrTail = "";
    mkdirSync(cancelDir, { recursive: true });
    const spawned = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...(spec.env ?? process.env), VARIN_DRIVER_CANCEL_DIR: cancelDir },
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
      if (child !== spawned) return;
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS);
    });
    spawned.on("error", () => {
      if (child !== spawned) return;
      stop(new Error(`Computer driver failed to start: ${spec.command}`));
    });
    spawned.on("close", (code, signal) => {
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

  const cancel: ComputerDriverSession["cancel"] = () => {
    const inFlight = active;
    if (!inFlight) return false;
    try {
      mkdirSync(cancelDir, { recursive: true });
      writeFileSync(path.join(cancelDir, `${inFlight.id}.cancel`), "cancel\n");
      return true;
    } catch {
      return false;
    }
  };

  // Wrap: cache the capabilities probe per session lifetime.
  const wrapped: ComputerDriverSession = {
    request: async (op, options) => {
      const response = await request(op, options);
      if (op.tool === "capabilities" && response.ok && response.capabilities) {
        caps = response.capabilities as unknown as ComputerCapabilities;
      }
      return response;
    },
    cancel,
    get capabilities() { return caps; },
    alive: isAlive,
    dispose: async () => {
      disposed = true;
      stop(new Error("Computer driver disposed"));
      await Promise.allSettled([...retiring]);
      clearCancelDir();
    },
  };
  return wrapped;
}
