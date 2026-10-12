import type { SpawnOptions, SpawnOptionsWithStdioTuple, StdioPipe } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

/** Trusted Host source admission; not accepted from process requests or extension JSON. */
export interface ManagedProcessIdentity {
  workspaceId: string;
  executionWorkspaceId: string;
  canonicalRoot: string;
}
export type ManagedProcessAdmission = (signal: AbortSignal) => Promise<ManagedProcessIdentity>;

/** A stream adapter to an owned process, not permission to spawn or kill a PID. */
export interface ManagedProcessHandle extends EventEmitter {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  readonly exitConfirmed?: boolean;
  readonly completion?: Promise<void>;
  requestTermination?(force?: boolean): Promise<void>;
  kill(signal?: NodeJS.Signals | number): boolean;
}
export interface ManagedPipedProcessHandle extends ManagedProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}
export type ManagedSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ManagedProcessHandle | Promise<ManagedProcessHandle>;
export type ManagedPipeSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>) => ManagedPipedProcessHandle | Promise<ManagedPipedProcessHandle>;

/** Native completion never substitutes a kill request for a process-tree receipt. */
export function waitForManagedExit(child: ManagedProcessHandle | null): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.completion) return child.completion;
  if (child.exitConfirmed || typeof child.exitCode === "number" || child.signalCode) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { child.off("exit", done); child.off("close", done); resolve(); };
    child.once("exit", done); child.once("close", done);
  });
}

/** Refusal or a deadline is a retained failure, never an exit receipt. */
export async function terminateManagedProcess(child: ManagedProcessHandle | null, force = false, timeoutMs = 5000): Promise<void> {
  if (!child) return;
  const exited = waitForManagedExit(child);
  void exited.catch(() => undefined);
  // Disposed protocol consumers no longer drain these streams themselves.
  child.stdout?.resume();
  child.stderr?.resume();
  if (child.requestTermination) await child.requestTermination(force);
  else if (!child.exitConfirmed && typeof child.exitCode !== "number" && !child.signalCode) child.kill(force ? "SIGKILL" : "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Process termination is unconfirmed; its writer and directory are retained")), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}


/** Product startup state only. The native backend remains the process authority. */
export interface ManagedProcessOwner<T extends ManagedProcessHandle = ManagedProcessHandle> {
  child: T | null;
  launchController?: AbortController;
  pendingSpawn?: Promise<T>;
}

/** A failed handoff may still have an owned child; callers must retain it. */
export class ManagedProcessLaunchError extends Error {
  constructor(readonly child: ManagedProcessHandle, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ManagedProcessLaunchError";
  }
}

export function launchOwnedProcess<T extends ManagedProcessHandle>(
  owner: ManagedProcessOwner<T>,
  launch: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = owner.launchController ??= new AbortController();
  const pending = (async () => {
    controller.signal.throwIfAborted();
    try {
      const child = await launch(controller.signal);
      owner.child = child;
      if (controller.signal.aborted) {
        await terminateManagedProcess(child, true);
        if (owner.child === child) owner.child = null;
        controller.signal.throwIfAborted();
      }
      return child;
    } catch (error) {
      if (error instanceof ManagedProcessLaunchError) owner.child = error.child as T;
      throw error;
    }
  })();
  owner.pendingSpawn = pending;
  void pending.finally(() => {
    if (owner.pendingSpawn === pending) delete owner.pendingSpawn;
  }).catch(() => undefined);
  return pending;
}

/** Cancellation includes a launch already awaiting admission or its first receipt. */
export async function terminateOwnedProcess(owner: ManagedProcessOwner, force = false): Promise<void> {
  (owner.launchController ??= new AbortController()).abort();
  await owner.pendingSpawn?.catch(() => undefined);
  const child = owner.child;
  await terminateManagedProcess(child, force);
  if (owner.child === child) owner.child = null;
}

export function managedExitConfirmed(child: ManagedProcessHandle | null): boolean {
  return !child || (child.exitConfirmed ?? (typeof child.exitCode === "number" || child.signalCode !== null));
}
