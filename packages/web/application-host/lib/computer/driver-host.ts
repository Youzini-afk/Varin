/**
 * Computer Use driver supervisor (BC4).
 *
 * A desktop's platform driver is one resident helper process speaking a
 * line-delimited JSON protocol on stdin/stdout — the managed connection the
 * product plan requires in place of per-action interpreter restarts. This
 * module owns spawn, request/response correlation, stderr capture, and the
 * single input-helper lifetime (capture may restart); higher layers own catalogs,
 * observations, and cancellation semantics.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import type { ComputerCapabilities, ComputerPlatform, ComputerGesture, ComputerActionReceipt } from "@varin/protocol";
export type DriverGesture = Pick<ComputerGesture, 'phase' | 'point' | 'to' | 'target' | 'mechanism'>;
import { remapAsarUnpackedPath } from "../structure/runtime-path.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const STDERR_TAIL_MAX_CHARS = 4000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Versioned native Windows contract; Linux/macOS retain their existing wire. */
export const WINDOWS_COMPUTER_PROTOCOL_VERSION = 1;

/** The op vocabulary shared by every platform driver (README.md). */
export interface DriverRequest {
  id: string;
  tool:
    | "ping"
    | "capabilities"
    | "list_apps"
    | "get_app_state"
    | "query_elements"
    | "release_elements"
    | "set_checked"
    | "set_expanded"
    | "select"
    | "scroll_into_view"
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
  protocolVersion?: number;
  build?: { version: string; architecture: string; buildId?: string };
  receipt?: ComputerActionReceipt;
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
  properties?: import("@varin/protocol").ComputerQueryResult["properties"];
  unavailableProperties?: import("@varin/protocol").ComputerProperty[];
  complete?: boolean;
  nextOffset?: number;
  reason?: string;
  code?: string;
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
  /** Windows native build identity, verified before dispatching desktop work. */
  nativeWindows?: { version: string; architecture: 'x64' | 'arm64'; buildId?: string };
  /** Optional transport address for controlled process fixtures. Production uses a random named pipe. */
  controlPipe?: string;
  /** One platform authorization/capture owner, with a separate read-only wire lane. */
  sharedDesktopSession?: boolean;
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
  // Node can read virtual ASAR paths; native executables and interpreters need real files.
  driverDir = remapAsarUnpackedPath(driverDir);
  if (platform === "windows") {
    const windowsDir = existsSync(path.join(driverDir, "windows", "VarinComputer.exe"))
      ? path.join(driverDir, "windows") : path.join(driverDir, "windows", "build");
    const executable = path.join(windowsDir, "VarinComputer.exe");
    if (!existsSync(executable)) return null;
    const manifestPath = path.join(windowsDir, "manifest.json");
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>; }
    catch { throw new Error(`Windows Computer helper manifest is missing or invalid: ${manifestPath}. Run bun run computer:build on Windows.`); }
    if (manifest.schema !== 1 || manifest.protocolVersion !== WINDOWS_COMPUTER_PROTOCOL_VERSION
      || manifest.executable !== 'VarinComputer.exe' || typeof manifest.version !== 'string'
      || !['x64', 'arm64'].includes(String(manifest.architecture)) || typeof manifest.buildId !== 'string') {
      throw new Error('Windows Computer helper build/protocol manifest is incompatible; rebuild this Application Host');
    }
    if (process.platform === 'win32' && manifest.architecture !== process.arch) {
      throw new Error(`Windows Computer helper architecture ${manifest.architecture} does not match this Host (${process.arch})`);
    }
    return { command: executable, args: [], cwd: path.dirname(executable),
      nativeWindows: { version: manifest.version, architecture: manifest.architecture as 'x64' | 'arm64', buildId: manifest.buildId } };
  }
  if (platform === "linux") {
    const script = path.join(driverDir, "linux", "driver-host.py");
    if (!existsSync(script)) return null;
    return {
      command: "python3",
      sharedDesktopSession: process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY),
      args: [script],
      cwd: path.dirname(script),
    };
  }
  if (platform === "macos") {
    const executable = path.join(driverDir, "macos", "Varin Computer.app", "Contents", "MacOS", "VarinComputer");
    if (!existsSync(executable)) return null;
    return { command: executable, args: [], sharedDesktopSession: true, cwd: path.dirname(executable) };
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
  onGesture?: (event: DriverGesture) => void;
  beforeDispatch?: () => void;
  cleanupAbort?: () => void;
}

export interface ComputerDriverSession {
  /** Serialize ops: one request in flight at a time — the desktop input stream is inherently ordered. */
  request(op: Omit<DriverRequest, "id">, options?: { timeoutMs?: number; signal?: AbortSignal; onGesture?: (event: DriverGesture) => void; beforeDispatch?: () => void }): Promise<DriverResponse>;
  /**
   * Interrupt the in-flight request at the driver's next internal checkpoint
   * (BC4.A). Windows uses its persistent native control pipe; other platforms
   * retain their flag-file channel. Returns false when nothing is in flight.
   */
  cancel(): boolean;
  /** Read-only capture on the same native session, independent of ordered input. */
  capture?(options?: { timeoutMs?: number }): Promise<DriverResponse>;
  /** Stops the input owner through a channel independent of UIA/stdin. */
  interrupt?(options?: { restoreFocus?: boolean }): Promise<{ released: boolean }>;
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
  let captureActive: PendingDriverRequest | null = null;
  let capturePending: Promise<DriverResponse> | null = null;
  let stderrTail = "";
  let caps: ComputerCapabilities | null = null;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let started = false;
  let interruption: Promise<{ released: boolean }> | undefined;
  let initialization: Promise<void> | undefined;
  let control: Socket | null = null;
  let controlBuffer = '';
  const controlPending = new Map<string, { resolve(value: { released: boolean }): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
  const role = spec.env?.VARIN_DRIVER_ROLE ?? 'input';
  const controlPipe = spec.nativeWindows && role === 'input'
    ? spec.controlPipe ?? `\\\\.\\pipe\\varin-computer-${randomUUID()}` : undefined;
  const closeControl = (error: Error) => {
    const socket = control; control = null; socket?.destroy();
    for (const pending of controlPending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    controlPending.clear(); controlBuffer = '';
  };
  const retiring = new Set<Promise<unknown>>();
  // Linux/macOS keep their existing per-request flag cancellation channel.
  // Windows owns one duplex control pipe and never creates these files.
  const cancelDir = path.join(os.tmpdir(), `varin-computer-driver-${process.pid}-${randomUUID()}`);
  const clearCancelDir = () => {
    try { rmSync(cancelDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  const isAlive = () => child !== null && !child.killed && child.exitCode === null;

  const failAll = (error: Error) => {
    if (active) { clearTimeout(active.timeout); active.cleanupAbort?.(); active.reject(error); active = null; }
    if (captureActive) { clearTimeout(captureActive.timeout); captureActive.reject(error); captureActive = null; }
    for (const queued of queue.splice(0)) { queued.cleanupAbort?.(); queued.reject(error); }
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
    const capture = captureActive?.id === message.id;
    const p = capture ? captureActive : active;
    if (!p || message.id !== p.id) return;
    const progress = message as unknown as Record<string, unknown>;
    if (progress.type === 'gesture') {
      if (capture) return;
      if (!['target', 'dispatched'].includes(String(progress.phase))) return;
      const point = (value: unknown) => {
        if (!value || typeof value !== 'object') return undefined;
        const v = value as Record<string, unknown>;
        return typeof v.x === 'number' && Number.isFinite(v.x) && typeof v.y === 'number' && Number.isFinite(v.y) ? { x: v.x, y: v.y } : undefined;
      };
      const at = point(progress.point); const to = point(progress.to); const rect = point(progress.target);
      const bounds = progress.target as Record<string, unknown> | undefined;
      const target = rect && typeof bounds?.width === 'number' && Number.isFinite(bounds.width) && bounds.width > 0
        && typeof bounds.height === 'number' && Number.isFinite(bounds.height) && bounds.height > 0 ? { ...rect, width: bounds.width, height: bounds.height } : undefined;
      const mechanism = ['pointer', 'keyboard', 'semantic'].includes(String(progress.mechanism)) ? progress.mechanism as ComputerGesture['mechanism'] : undefined;
      try { p.onGesture?.({ phase: progress.phase as DriverGesture['phase'], ...(mechanism ? { mechanism } : {}), ...(at ? { point: at } : {}), ...(to ? { to } : {}), ...(target ? { target } : {}) }); } catch { /* effects never change native input */ }
      return;
    }
    if (typeof message.ok !== "boolean") {
      stop(new Error("Computer driver returned a malformed response"));
      return;
    }
    if (capture) captureActive = null; else active = null;
    clearTimeout(p.timeout);
    p.cleanupAbort?.();
    p.resolve(message);
    pump();
  };

  const pump = () => {
    if (disposed || interruption || active || queue.length === 0) return;
    const next = queue.shift()!;
    active = next;
    try { next.beforeDispatch?.(); }
    catch (error) {
      active = null; next.cleanupAbort?.(); next.reject(error instanceof Error ? error : new Error(String(error))); pump(); return;
    }
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
    closeControl(error);
    if (role === 'capture') initialization = undefined;
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
    if (started && spec.env?.VARIN_DRIVER_ROLE !== 'capture') throw new Error('The original Computer input helper exited; acquire a new session without reusing its physical release identity');
    buffer = "";
    stderrTail = "";
    if (!spec.nativeWindows) mkdirSync(cancelDir, { recursive: true });
    const spawned = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...(spec.env ?? process.env), ...(spec.nativeWindows
        ? { VARIN_DRIVER_ROLE: role, ...(controlPipe ? { VARIN_DRIVER_CONTROL_PIPE: controlPipe } : {}) }
        : { VARIN_DRIVER_CANCEL_DIR: cancelDir }) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawned;
    started = true;
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
    spawned.on("error", (error) => {
      if (child !== spawned) return;
      stop(new Error(`Computer driver failed to start: ${spec.command}: ${error.message}`, { cause: error }));
    });
    spawned.on("close", (code, signal) => {
      if (child !== spawned) return;
      child = null;
      if (role === 'capture') initialization = undefined;
      closeControl(new Error("Computer control connection closed with its original helper"));
      const tail = stderrTail.trim();
      failAll(new Error(
        `Computer driver exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ''})`
        + (tail ? `: ${tail.slice(-400)}` : ""),
      ));
    });
    return spawned;
  };

  const request: ComputerDriverSession["request"] = (op, options = {}) => new Promise<DriverResponse>((resolve, reject) => {
    if (disposed || interruption) {
      reject(new Error("Computer driver session is disposed or interrupted"));
      return;
    }
    if (options.signal?.aborted) { reject(options.signal.reason); return; }
    const next: PendingDriverRequest = { id: randomUUID(), op: structuredClone(op), timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, resolve, reject,
      ...(options.onGesture ? { onGesture: options.onGesture } : {}), ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}) };
    if (options.signal) {
      const signal = options.signal;
      const abort = () => {
        const index = queue.indexOf(next);
        if (index >= 0) { queue.splice(index, 1); next.cleanupAbort?.(); reject(signal.reason); }
        // Keep ownership until the original read actually returns. Cancelling
        // this read must never release input or target a later queued request.
        else if (active === next) cancelRequest(next.id);
      };
      next.cleanupAbort = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
    }
    queue.push(next);
    pump();
  });

  const sendControl = (command: Record<string, unknown>): Promise<{ released: boolean }> => new Promise((resolve, reject) => {
    if (!control || control.destroyed) { reject(new Error('Computer input control channel is unavailable')); return; }
    const id = randomUUID();
    const timeout = setTimeout(() => { controlPending.delete(id); reject(new Error('Computer input release acknowledgement timed out')); }, DEFAULT_REQUEST_TIMEOUT_MS);
    controlPending.set(id, { resolve, reject, timeout });
    control.write(JSON.stringify({ ...command, id }) + '\n', error => {
      if (!error) return;
      const pending = controlPending.get(id);
      if (pending) { clearTimeout(pending.timeout); controlPending.delete(id); pending.reject(error); }
    });
  });

  const connectControl = (): Promise<void> => new Promise((resolve, reject) => {
    if (!controlPipe) { resolve(); return; }
    const socket = createConnection(controlPipe);
    control = socket; socket.setEncoding('utf8');
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Computer input control connection timed out')); }, DEFAULT_REQUEST_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(deadline); resolve(); });
    socket.on('error', error => { clearTimeout(deadline); reject(error); if (control === socket) stop(error); });
    socket.on('close', () => { clearTimeout(deadline); if (control === socket) stop(new Error('Computer input control channel closed; original input outcome is unknown')); });
    socket.on('data', (chunk: string) => {
      if (control !== socket) return;
      controlBuffer += chunk;
      if (Buffer.byteLength(controlBuffer) > MAX_FRAME_BYTES) { stop(new Error('Computer control response exceeded the frame limit')); return; }
      for (;;) {
        const newline = controlBuffer.indexOf('\n'); if (newline < 0) break;
        const line = controlBuffer.slice(0, newline); controlBuffer = controlBuffer.slice(newline + 1);
        let message: { id?: string; ok?: boolean; released?: boolean; error?: string };
        try { message = JSON.parse(line); } catch { stop(new Error('Malformed Computer control response')); return; }
        const pending = message.id && controlPending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timeout); controlPending.delete(message.id!);
        if (message.ok !== true || typeof message.released !== 'boolean') pending.reject(new Error(message.error ?? 'Computer input release failed'));
        else pending.resolve({ released: message.released });
      }
    });
  });

  const initialize = (): Promise<void> => {
    if (!spec.nativeWindows) return Promise.resolve();
    if (!initialization) initialization = (async () => {
      const ready = await request({ tool: 'ping' });
      const expected = spec.nativeWindows!;
      if (!ready.ok || ready.protocolVersion !== WINDOWS_COMPUTER_PROTOCOL_VERSION
        || ready.build?.version !== expected.version || ready.build?.architecture !== expected.architecture
        || (expected.buildId && ready.build?.buildId !== expected.buildId)) {
        throw new Error(ready.error ?? 'Windows Computer helper protocol or build identity does not match this Host');
      }
      await connectControl();
    })().catch(error => { stop(error instanceof Error ? error : new Error(String(error))); throw error; });
    return initialization;
  };

  const cancelRequest = (requestId: string): boolean => {
    if (spec.nativeWindows) {
      if (!control || control.destroyed) return false;
      void sendControl({ command: 'cancel', requestId }).catch(error => {
        if (!disposed) stop(error instanceof Error ? error : new Error(String(error)));
      });
      return true;
    }
    try {
      mkdirSync(cancelDir, { recursive: true });
      writeFileSync(path.join(cancelDir, `${requestId}.cancel`), "cancel\n");
      return true;
    } catch { return false; }
  };
  const cancel: ComputerDriverSession["cancel"] = () => active ? cancelRequest(active.id) : false;

  // Coalesce concurrent viewers, but never queue their frame behind a long input.
  // Only capture_frame may use this lane; it cannot replace an Agent observation.
  const capture: NonNullable<ComputerDriverSession["capture"]> = (options = {}) => {
    if (capturePending) return capturePending;
    const pending = new Promise<DriverResponse>((resolve, reject) => {
      if (disposed) { reject(new Error("Computer driver session is disposed")); return; }
      const next: PendingDriverRequest = { id: randomUUID(), op: { tool: 'capture_frame' },
        timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, resolve, reject };
      captureActive = next;
      try {
        const target = ensureChild();
        next.timeout = setTimeout(() => stop(new Error('Computer capture stopped responding; the native session is unavailable')), next.timeoutMs);
        target.stdin!.write(JSON.stringify({ ...next.op, id: next.id }) + "\n", error => { if (error && child === target) stop(error); });
      } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    capturePending = pending;
    void pending.finally(() => { if (capturePending === pending) capturePending = null; }).catch(() => {});
    return pending;
  };

  // Wrap: cache the capabilities probe per session lifetime.
  const wrapped: ComputerDriverSession = {
    request: async (op, options) => {
      if (spec.nativeWindows) {
        await Promise.allSettled([...retiring]);
        await initialize();
      }
      const response = await request(op, options).catch(async error => {
        // A read deadline may stop a wedged helper. Its request-scoped caller
        // still owns native resources until that original process has exited.
        if (options?.signal && !isAlive()) await Promise.allSettled([...retiring]);
        throw error;
      });
      if (op.tool === "capabilities" && response.ok && response.capabilities) {
        caps = response.capabilities as unknown as ComputerCapabilities;
      }
      return response;
    },
    cancel,
    ...(spec.sharedDesktopSession ? { capture } : {}),
    ...(spec.nativeWindows && role === 'input' ? { interrupt: (options?: { restoreFocus?: boolean }) => {
      if (interruption) return interruption;
      interruption = (async () => {
        if (!isAlive()) return { released: !started };
        let released = false;
        try {
          // Startup may still be establishing the same original control connection.
          await initialization;
          released = (await sendControl({ command: 'interrupt', restoreFocus: options?.restoreFocus !== false })).released;
        } catch { /* Failure is not proof of physical release. */ }
        // The original native owner is fenced before its acknowledgement; actual
        // process closure is also required before another owner can be acquired.
        await wrapped.dispose();
        return { released };
      })();
      return interruption;
    } } : {}),
    get capabilities() { return caps; },
    alive: isAlive,
    dispose: () => {
      if (disposal) return disposal;
      // Fence new requests synchronously, including queued callbacks. Direct
      // reset/disposal also asks the original native input owner to release;
      // this does not manufacture a release receipt for higher-level callers.
      disposed = true;
      disposal = (async () => {
        if (spec.nativeWindows && role === 'input' && !interruption && isAlive()) {
          try {
            await initialization;
            await sendControl({ command: 'interrupt', restoreFocus: false });
          } catch { /* Preserve unknown cleanup; still await the original exit. */ }
        }
        stop(new Error("Computer driver disposed"));
        await Promise.allSettled([...retiring]);
        clearCancelDir();
      })();
      return disposal;
    },
  };
  return wrapped;
}
