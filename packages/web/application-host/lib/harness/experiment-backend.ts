/**
 * Experiment backend seam (7D-3, D-300).
 *
 * One contract covers what the design requires of every execution target:
 * idempotent submit keyed by the durable attempt id, query/attach by the
 * backend-native job identity, output streaming by cursor, supported
 * controls, and result collection. The local backend binds the Rust kernel
 * process service; a managed remote machine binds a remote kernel/Host
 * reached through the existing connection management, and a cluster backend
 * binds its native scheduler — none of them may fake pause/resume/checkpoint
 * or a `reserve` they cannot honour.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { KernelScopedClient } from "../kernel/kernel-client.js";
import type { GpuAllocation } from "./gpu-resources.js";

/** Execution site resolved by the backend: where the job actually runs. */
export interface ExperimentBackendSite {
  /** Owning workspace — durable records live here, on this Host's kernel. */
  workspaceId: string;
  /** Backend-native file root identity for the execution directory. */
  rootId: string;
  /** Canonical execution root path on the backend machine. */
  canonicalRoot: string;
  /** Backend-private transport context (kernel grant, remote client, …). */
  transport: unknown;
  /** Stable public target identity when execution is not local. */
  machineId?: string;
}

export interface BackendJobHandle {
  /** Backend-native durable identity — kernel process id, Slurm job id… never a bare PID. */
  backendJobId: string;
  kernelEpoch?: string;
  pid?: number;
  executionRootId?: string;
  executionCanonicalRoot?: string;
  executionCwd?: string;
}

export interface BackendObservation {
  status: "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown" | "released";
  /** True while the backend may still produce output for this job. */
  writerActive: boolean;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  executionRootId?: string;
  executionCanonicalRoot?: string;
  executionCwd?: string;
}

export interface BackendReadResult {
  chunks: Array<{ channel: "stdout" | "stderr"; bytesBase64: string }>;
  nextCursor: number;
  endCursor: number;
  observation: BackendObservation;
}

/** Content already streamed into the owning kernel object store. */
export interface BackendCollectedObject {
  objectHash: string;
  byteLength: number;
  ownerId: string;
}

export interface BackendRemoteObject {
  outputId: string;
  path: string;
  objectHash: string;
  byteLength: number;
}

export interface ExperimentBackend {
  /** Stable backend identity recorded on the attempt and job records. */
  readonly backend: string;
  /**
   * Controls the backend actually implements. `cancel` means confirmed
   * termination of the whole job (process tree or native job);
   * `attach` means a restarted Host can rebind to a running job;
   * `collect` means declared outputs can be fetched after exit.
   */
  readonly controls: readonly ("cancel" | "attach" | "collect")[];
  /**
   * Submit the job. Must be idempotent on `request.backendJobId`: a retry
   * after a lost response rebinds to the already-submitted job instead of
   * starting a second copy. The caller derives `backendJobId` deterministically
   * from the attempt id; a scheduler that assigns its own identity uses it as
   * the lookup key and returns its native id on the handle.
   */
  spawn(site: ExperimentBackendSite, request: {
    attemptId: string;
    /** Deterministic durable identity the caller asks the backend to bind. */
    backendJobId: string;
    cwd: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
    resources: import("@varin/protocol").ExperimentResourceRequest;
    gpuAllocation?: GpuAllocation;
  }): Promise<{ handle: BackendJobHandle; observation: BackendObservation }>;
  /**
   * Query the durable backend identity. Throws when the backend cannot
   * confirm the job. The caller keeps the attempt and allocation pending for
   * later reconciliation; an observation outage is not an execution terminal.
   */
  inspect(site: ExperimentBackendSite, backendJobId: string): Promise<BackendObservation>;
  /** Read output chunks after `cursor` plus the current job observation. */
  read(site: ExperimentBackendSite, backendJobId: string, cursor: number): Promise<BackendReadResult>;
  /** Confirmed termination request covering the entire job. */
  kill(site: ExperimentBackendSite, backendJobId: string): Promise<void>;
  /** Release backend-side job bookkeeping after finalization. */
  release(site: ExperimentBackendSite, backendJobId: string): Promise<void>;
  /**
   * Read a declared output file relative to the execution root. Paths are
   * validated at submit; the backend still rejects escapes as
   * defence-in-depth.
   */
  collectFile(site: ExperimentBackendSite, relativePath: string, backendJobId: string): Promise<Buffer | BackendCollectedObject | BackendRemoteObject>;
  /** Read an immutable target-retained output by byte range. */
  readCollectedObject?(
    site: ExperimentBackendSite,
    outputId: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; nextOffset: number; eof: boolean }>;
}

/** An adapter may certify preparation drain only from an actual settled effect or no-dispatch fact. */
export class ExperimentPreparationError extends Error {
  readonly drained: boolean;
  readonly retryable: boolean;
  constructor(message: string, options: { drained: boolean; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ExperimentPreparationError";
    this.drained = options.drained;
    this.retryable = options.retryable ?? true;
  }
}

/** A backend bound to the resolved execution site for one attempt. */
export interface ResolvedExperimentBackend {
  backend: ExperimentBackend;
  site: ExperimentBackendSite;
  /** Read the original preparation effect without starting or resending it. */
  reconcilePreparation?(request: {
    attemptId: string;
    input: import("./experiment-workspace.js").ExperimentInputSnapshot;
  }): Promise<"drained" | "unknown">;
  /** Prepare the immutable input on this execution target. */
  prepare(request: {
    attemptId: string;
    input: import("./experiment-workspace.js").ExperimentInputSnapshot;
    /** Cancels preparation only. Resolution does not prove a spawned job stopped. */
    signal?: AbortSignal;
  }): Promise<{
    backend?: ExperimentBackend;
    site: ExperimentBackendSite;
    cwd: string;
    inputRoot: string;
    reused?: boolean;
    /** Return preparation authority when no backend dispatch occurred. */
    releaseAuthority?: () => Promise<void>;
  }>;
}
/**
* The local backend: one Rust kernel process per attempt, supervised by the
* kernel guardian. `processSpawn` with the derived id is idempotent, the
* kernel keeps exit facts after the Host disconnects, and processRelease
* only runs after termination is confirmed — matching the local row of the
* D-300 backend table.
*/
export const createLocalExperimentBackend = (scoped: KernelScopedClient, releaseAuthority?: () => Promise<void>): ExperimentBackend => {
  let released = false;
  const backend: ExperimentBackend = {
    backend: "local",
    controls: ["cancel", "attach", "collect"],
    async spawn(site, request) {
      const environment = { ...process.env } as Record<string, string>;
      for (const entry of request.env)
        environment[entry.name] = entry.value;
      if (request.gpuAllocation) {
        environment[request.gpuAllocation.environment.name] = request.gpuAllocation.environment.value;
      }
      delete environment.NODE_CHANNEL_FD;
      const snapshot = await scoped.processSpawn({
        workspaceId: site.workspaceId,
        processId: request.backendJobId,
        rootId: site.rootId,
        cwd: request.cwd,
        command: request.command,
        args: request.args,
        env: Object.entries(environment)
          .filter((entry): entry is [
          string,
          string
        ] => typeof entry[1] === "string")
          .map(([name, value]) => ({ name, value })),
        mode: "pipe",
      });
      return {
        handle: {
          backendJobId: request.backendJobId,
          ...(snapshot.kernelEpoch !== undefined ? { kernelEpoch: snapshot.kernelEpoch } : {}),
          ...(snapshot.pid !== undefined && snapshot.pid !== null ? { pid: snapshot.pid } : {}),
        },
        observation: {
          status: snapshot.status,
          writerActive: snapshot.writerActive,
          ...(snapshot.reason ? { reason: snapshot.reason } : {}),
        },
      };
    },
    async inspect(site, backendJobId) {
      const snapshot = await scoped.processInspect({ workspaceId: site.workspaceId, rootId: site.rootId, processId: backendJobId });
      return {
        status: snapshot.status,
        writerActive: snapshot.writerActive,
        exitCode: snapshot.exitCode,
        signal: snapshot.signal,
        ...(snapshot.reason ? { reason: snapshot.reason } : {}),
      };
    },
    async read(site, backendJobId, cursor) {
      const result = await scoped.processRead({ workspaceId: site.workspaceId, rootId: site.rootId, processId: backendJobId, cursor });
      return {
        chunks: result.chunks.map((chunk) => ({
          channel: chunk.channel,
          bytesBase64: chunk.bytesBase64,
        })),
        nextCursor: result.nextCursor,
        endCursor: result.endCursor,
        observation: {
          status: result.process.status,
          writerActive: result.process.writerActive,
          exitCode: result.process.exitCode,
          signal: result.process.signal,
          ...(result.process.reason ? { reason: result.process.reason } : {}),
        },
      };
    },
    async kill(site, backendJobId) {
      await scoped.processKill({ workspaceId: site.workspaceId, rootId: site.rootId, processId: backendJobId, force: true });
    },
    async release(site, backendJobId) {
      if (!released) {
        await scoped.processRelease({ workspaceId: site.workspaceId, rootId: site.rootId, processId: backendJobId });
        released = true;
      }
      await releaseAuthority?.();
    },
    async collectFile(site, relativePath) {
      const normalized = relativePath.replaceAll("\\", "/");
      if (!normalized || path.isAbsolute(relativePath) || normalized.split("/").includes("..") || normalized.includes("\0")) {
        throw new Error(`output path escaped the experiment root: ${relativePath}`);
      }
      const captured = await scoped.fileCapture({
        operationId: `experiment-output-capture:${randomUUID()}`,
        workspaceId: site.workspaceId,
        rootId: site.rootId,
        path: normalized,
        store: true,
      });
      if (typeof captured.stateJson !== "string" || typeof captured.ownerId !== "string") {
        throw new Error(`kernel did not retain experiment output: ${relativePath}`);
      }
      let state: unknown;
      try {
        state = JSON.parse(captured.stateJson);
      }
      catch {
        throw new Error(`kernel returned malformed output state: ${relativePath}`);
      }
      if (!state || typeof state !== "object" || (state as {
        kind?: unknown;
      }).kind !== "regular-file"
        || typeof (state as {
          objectHash?: unknown;
        }).objectHash !== "string"
        || typeof (state as {
          byteLength?: unknown;
        }).byteLength !== "number") {
        await scoped.releaseBlob(captured.ownerId).catch(() => undefined);
        throw new Error(`experiment output is not a regular file: ${relativePath}`);
      }
      return {
        objectHash: (state as {
          objectHash: string;
        }).objectHash,
        byteLength: (state as {
          byteLength: number;
        }).byteLength,
        ownerId: captured.ownerId,
      };
    },
  };
  // The original backend retains its real Host calls until bookkeeping release. Retiring
  // a grant while a read/kill/collection promise is still active would cancel that owner.
  const active = new Set<Promise<unknown>>();
  let closing = false;
  const own = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing)
      return Promise.reject(new Error("Experiment backend caller has retired"));
    const pending = work();
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  };
  return {
    ...backend,
    spawn: (...args) => own(() => backend.spawn(...args)),
    inspect: (...args) => own(() => backend.inspect(...args)),
    read: (...args) => own(() => backend.read(...args)),
    kill: (...args) => own(() => backend.kill(...args)),
    collectFile: (...args) => own(() => backend.collectFile(...args)),
    async release(...args) { closing = true; await Promise.allSettled([...active]); await backend.release(...args); },
  };
};
