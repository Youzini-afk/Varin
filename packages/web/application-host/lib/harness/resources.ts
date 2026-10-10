/**
 * Resource facts: machines, commitments and observed usage (7C/7D-2, D-300).
 *
 * Capacity, committed reservations and sampled usage are separate durable
 * records, each carrying its own provenance and observation time. A request is
 * not a commitment — `admit` owns allocation and reconciliation only restores
 * its original confirmed receipt. Per-machine serialization prevents concurrent
 * submissions from claiming the same remaining capacity. An unread usage dimension is never
 * treated as free.
 */
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type {
  ExperimentResourceRequest,
  ResourceCommitmentView,
  ResourceListResult,
  ResourceMachineView,
} from "@varin/protocol";
import {
  allocateGpuDevices,
  probeNvidiaSmi,
  type GpuAllocation,
  type GpuDeviceFact,
  type GpuProbeResult,
} from "./gpu-resources.js";

const MACHINE_PREFIX = "resource.machine:";
const COMMITMENT_PREFIX = "resource.commitment:";
const SAMPLE_PREFIX = "resource.sample:";
const LOCAL_MACHINE_ID = "local";
/** Host-local catalog namespace shared by every owning workspace. */
const RESOURCE_WORKSPACE_ID = "__varin_host_resources__";
const SAMPLE_STALE_MS = 120_000;

export interface LocalMachineProbe {
  cpuCores: number;
  memoryMb: number;
  usedMemoryMb: number;
  /** 0-100 across all cores, or undefined when not measured. */
  cpuPercent?: number;
}

const createDefaultProbe = (): (() => LocalMachineProbe) => {
  let previous: { total: number; idle: number } | undefined;
  return () => {
    const cpuSnapshots = os.cpus();
    const cores = cpuSnapshots.length;
    const memoryMb = Math.round(os.totalmem() / (1024 * 1024));
    const usedMemoryMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));
    const totals = cpuSnapshots.reduce((sum, cpu) => (
      sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
    ), 0);
    const idle = cpuSnapshots.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const cpuPercent = previous && totals > previous.total && idle >= previous.idle
      ? Math.min(100, Math.max(0, Math.round((1 - ((idle - previous.idle) / (totals - previous.total))) * 100)))
      : undefined;
    previous = { total: totals, idle };
    return {
      cpuCores: cores,
      memoryMb,
      usedMemoryMb,
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
    };
  };
};

export interface ResourceAdmission {
  status: "confirmed" | "insufficient";
  commitmentId?: string;
  /** Concrete device binding. The spawn target must apply this environment. */
  gpuAllocation?: GpuAllocation;
  /** Remaining capacity after confirmed commitments, when known. */
  remaining?: ExperimentResourceRequest;
  reason?: string;
}

/** Observation of the original allocation, never a new admission request. */
export type ResourceAdmissionReconciliation =
  | { status: "confirmed"; commitmentId: string; gpuAllocation?: GpuAllocation }
  | { status: "not-admitted" }
  | { status: "unknown" };

/** Resource authority implemented by an execution target, not this coordinator. */
export interface ExternalResourceAuthority {
  readonly authorityId: string;
  admit(input: {
    workspaceId: string;
    machineId: string;
    attemptId: string;
    resources: ExperimentResourceRequest;
  }): Promise<ResourceAdmission>;
  reconcileAdmission?(input: {
    workspaceId: string;
    machineId: string;
    attemptId: string;
    resources: ExperimentResourceRequest;
  }): Promise<ResourceAdmissionReconciliation>;
  release(input: {
    workspaceId: string;
    machineId: string;
    attemptId?: string;
    commitmentId: string;
    reason: string;
  }): Promise<void>;
}

/**
 * Registration of a non-local execution target by connection management
 * (SSH instance, remote Varin Host, cluster). A freshly registered machine
 * is offline with unknown connection until a real probe reports otherwise —
 * registration alone never claims capacity or reachability.
 */
export interface ResourceMachineRegistration {
  /** Stable machine identity; generated when omitted. */
  machineId?: string;
  kind: string;
  label?: string;
  /** Which experiment backend reaches this machine (e.g. "varin-host", "slurm"). */
  backend?: string;
  state?: "available" | "degraded" | "offline";
  capacity?: {
    cpuCores?: number;
    memoryMb?: number;
    gpus?: Array<{ index: number; uuid?: string; name?: string; memoryMb?: number }>;
  };
  connection?: { status: "connected" | "degraded" | "offline" | "unknown"; detail?: string };
  /** Credential-free target identity. Connection secrets remain in the trusted resolver. */
  target?: ResourceMachineView["target"];
}

interface ResourceServiceDeps {
  client: KernelClient;
  /** Monotonic clock injection for tests. */
  now?: () => number;
  probeLocal?: () => LocalMachineProbe;
  onError?: (error: Error) => void;
  /** Machine/commitment fact changed — drives UI refresh. Samples never emit. */
  onChange?: (workspaceId: string) => void;
  /** Capacity was returned; Host may reconcile queued attempts in each known workspace. */
  onCapacityAvailable?: (workspaceId: string) => void | Promise<void>;
  /** On-demand host GPU facts; the default is a fixed nvidia-smi probe. */
  probeLocalGpu?: () => Promise<GpuProbeResult>;
  /** Resolve the target-side allocator for managed machines. */
  resolveExternalAuthority?: (
    machineId: string,
    machine: KernelRecordResult,
  ) => Promise<ExternalResourceAuthority | null> | ExternalResourceAuthority | null;
  /** Refresh connection-managed target facts before presenting resources. */
  refreshTargets?: (workspaceId: string) => Promise<void> | void;
}

export const resourceMachineRecordId = (machineId: string): string => `${MACHINE_PREFIX}${machineId}`;

const recordIdFor = {
  machine: (id: string) => `${MACHINE_PREFIX}${id}`,
  commitment: (id: string) => `${COMMITMENT_PREFIX}${id}`,
  sample: (machineId: string) => `${SAMPLE_PREFIX}${machineId}`,
};

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const num = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const nonNegative = (value: unknown): number | undefined => {
  const parsed = num(value);
  return parsed === undefined || parsed < 0 ? undefined : parsed;
};

const percent = (value: unknown): number | undefined => {
  const parsed = num(value);
  return parsed === undefined || parsed < 0 || parsed > 100 ? undefined : parsed;
};

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const gpuUuid = (value: unknown): string | undefined => {
  const parsed = str(value);
  return parsed && /^GPU-[^\s,]+$/i.test(parsed) ? parsed : undefined;
};

const asResources = (value: unknown): ExperimentResourceRequest => {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const cpuCores = nonNegative(raw.cpuCores);
  const memoryMb = nonNegative(raw.memoryMb);
  const gpuCount = nonNegative(raw.gpuCount);
  const gpuMemoryMb = nonNegative(raw.gpuMemoryMb);
  return {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(gpuCount === undefined ? {} : { gpuCount }),
    ...(gpuMemoryMb === undefined ? {} : { gpuMemoryMb }),
    ...(typeof raw.longRunning === "boolean" ? { longRunning: raw.longRunning } : {}),
  };
};

const gpuCapacity = (capacity: Record<string, unknown>): { count?: number; memoryMb?: number } => {
  if (!Array.isArray(capacity.gpus)) return {};
  const entries = capacity.gpus.filter((gpu): gpu is Record<string, unknown> => (
    !!gpu && typeof gpu === "object"
  ));
  if (entries.length !== capacity.gpus.length) return {};
  const count = entries.length;
  const memories = entries.map((gpu) => nonNegative(gpu.memoryMb));
  const memoryMb = memories.every((memory): memory is number => memory !== undefined)
    ? memories.reduce((sum, memory) => sum + memory, 0)
    : undefined;
  return {
    count,
    ...(memoryMb === undefined ? {} : { memoryMb }),
  };
};

const gpuDevices = (capacity: Record<string, unknown>): GpuDeviceFact[] => {
  if (!Array.isArray(capacity.gpus)) return [];
  return capacity.gpus.flatMap((gpu): GpuDeviceFact[] => {
    if (!gpu || typeof gpu !== "object") return [];
    const entry = gpu as Record<string, unknown>;
    const index = nonNegative(entry.index);
    const uuid = gpuUuid(entry.uuid);
    if (index === undefined || !Number.isInteger(index) || !uuid) return [];
    const memoryMb = nonNegative(entry.memoryMb);
    const name = str(entry.name);
    return [{
      index,
      uuid,
      ...(name ? { name } : {}),
      ...(memoryMb === undefined ? {} : { memoryMb }),
    }];
  });
};

const asGpuAllocation = (value: unknown): GpuAllocation | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.devices)) return undefined;
  const devices = raw.devices.flatMap((device): GpuAllocation["devices"] => {
    if (!device || typeof device !== "object" || Array.isArray(device)) return [];
    const entry = device as Record<string, unknown>;
    const index = nonNegative(entry.index);
    const uuid = gpuUuid(entry.uuid);
    if (index === undefined || !Number.isInteger(index) || !uuid) return [];
    const memoryMb = nonNegative(entry.memoryMb);
    const name = str(entry.name);
    return [{
      index,
      uuid,
      ...(name ? { name } : {}),
      ...(memoryMb === undefined ? {} : { memoryMb }),
    }];
  });
  if (devices.length !== raw.devices.length || devices.length === 0) return undefined;
  const environment = raw.environment && typeof raw.environment === "object" && !Array.isArray(raw.environment)
    ? raw.environment as Record<string, unknown> : {};
  if (environment.name !== "CUDA_VISIBLE_DEVICES" || typeof environment.value !== "string") return undefined;
  if (environment.value !== devices.map((device) => device.uuid).join(",")) return undefined;
  return { devices, environment: { name: "CUDA_VISIBLE_DEVICES", value: environment.value } };
};

const gpuProbeRecord = (result: GpuProbeResult, checkedAt: number): Record<string, unknown> => ({
  status: result.status,
  ...(result.status === "unavailable" ? { reason: result.reason } : {}),
  ...(result.status === "unavailable" && result.detail ? { detail: result.detail } : {}),
  checkedAt,
});

const gpuCapacityForProbe = (result: GpuProbeResult): Array<Record<string, unknown>> | undefined => (
  result.status === "available"
    ? result.devices.map((device) => ({
        index: device.index,
        uuid: device.uuid,
        ...(device.name ? { name: device.name } : {}),
        ...(device.memoryMb === undefined ? {} : { memoryMb: device.memoryMb }),
      }))
    : undefined
);

const gpuUsageForProbe = (result: GpuProbeResult): Array<Record<string, unknown>> | undefined => (
  result.status === "available"
    ? result.devices.map((device) => ({
        index: device.index,
        uuid: device.uuid,
        ...(device.name ? { name: device.name } : {}),
        ...(device.memoryMb === undefined ? {} : { memoryMb: device.memoryMb }),
        ...(device.usedMemoryMb === undefined ? {} : { usedMemoryMb: device.usedMemoryMb }),
        ...(device.utilizationPercent === undefined ? {} : { utilizationPercent: device.utilizationPercent }),
      }))
    : undefined
);

const resourceDimensions = ["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const;
type ResourceDimension = typeof resourceDimensions[number];

export const validateResources = (value: ExperimentResourceRequest): ExperimentResourceRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resource request must be an object");
  }
  const normalized: ExperimentResourceRequest = {};
  for (const key of resourceDimensions) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new Error(`resource request ${key} must be finite`);
    }
    if (raw < 0) throw new Error(`resource request ${key} cannot be negative`);
    if (raw > 0) normalized[key] = raw;
  }
  if (value.longRunning !== undefined) {
    if (typeof value.longRunning !== "boolean") throw new Error("resource request longRunning must be boolean");
    normalized.longRunning = value.longRunning;
  }
  return normalized;
};

const hasResourceDimension = (resources: ExperimentResourceRequest): boolean => (
  resourceDimensions.some((key) => resources[key] !== undefined && resources[key]! > 0)
);

const sameResources = (left: ExperimentResourceRequest, right: ExperimentResourceRequest): boolean => (
  resourceDimensions.every((key) => left[key] === right[key])
  && left.longRunning === right.longRunning
);

const commitmentIdFor = (workspaceId: string, machineId: string, attemptId: string): string => (
  `commit-${createHash("sha256").update(`${workspaceId}\0${machineId}\0${attemptId}`).digest("hex").slice(0, 32)}`
);

const remainingCapacity = (
  capacity: Record<string, unknown>,
  committed: ExperimentResourceRequest[],
): ExperimentResourceRequest => {
  const remaining: ExperimentResourceRequest = {};
  const gpus = gpuCapacity(capacity);
  const totals: Record<ResourceDimension, number | undefined> = {
    cpuCores: nonNegative(capacity.cpuCores),
    memoryMb: nonNegative(capacity.memoryMb),
    gpuCount: gpus.count,
    gpuMemoryMb: gpus.memoryMb,
  };
  for (const key of resourceDimensions) {
    const total = totals[key];
    if (total === undefined) continue;
    const used = committed.reduce((sum, entry) => sum + (entry[key] ?? 0), 0);
    remaining[key] = Math.max(0, total - used);
  }
  return remaining;
};

interface CommitmentFact {
  view: ResourceCommitmentView;
  ownerWorkspaceId?: string;
  gpuAllocation?: GpuAllocation;
}

const lockChains = new WeakMap<object, Map<string, Promise<void>>>();

const withMachineLock = async <Result>(client: KernelClient, machineId: string, task: () => Promise<Result>): Promise<Result> => {
  let chains = lockChains.get(client);
  if (!chains) {
    chains = new Map();
    lockChains.set(client, chains);
  }
  const previous = chains.get(machineId) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tail = current.then(() => undefined, () => undefined);
  chains.set(machineId, tail);
  void tail.then(() => {
    if (chains?.get(machineId) === tail) chains.delete(machineId);
  });
  return current;
};

export function createResourceService(deps: ResourceServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const probe = deps.probeLocal ?? createDefaultProbe();
  const probeGpu = deps.probeLocalGpu ?? probeNvidiaSmi;
  const contexts = new Map<string, Promise<KernelScopedClient>>();
  const knownWorkspaces = new Set<string>();
  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error instanceof Error ? error : new Error(String(error)));
  };
  const observeGpu = async (): Promise<GpuProbeResult> => {
    try {
      return await probeGpu();
    } catch (error) {
      return { status: "unavailable", reason: "error", detail: error instanceof Error ? error.message : String(error) };
    }
  };
  const rememberWorkspace = (workspaceId: string) => {
    if (workspaceId && workspaceId !== RESOURCE_WORKSPACE_ID) knownWorkspaces.add(workspaceId);
  };

  /**
   * Committed `resource.sample` facts — observers (follow-up metric waits)
   * react to durable samples rather than probing machines themselves.
   */
  const sampleListeners = new Set<(sample: {
    machineId: string;
    observedAt: number;
    usage: {
      memoryMb?: number;
      cpuPercent?: number;
      gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }>;
    };
  }) => void>();
  const emitSample = (record: KernelRecordResult) => {
    const payload = payloadOf(record);
    const machineId = str(payload.machineId);
    const usage = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
      ? payload.usage as { memoryMb?: number; cpuPercent?: number; gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }> }
      : {};
    if (!machineId) return;
    const sample = { machineId, observedAt: num(payload.observedAt) ?? now(), usage };
    for (const listener of sampleListeners) {
      try { listener(sample); } catch { /* observers must not break sampling */ }
    }
  };
  const subscribeSamples = (listener: (sample: {
    machineId: string;
    observedAt: number;
    usage: { memoryMb?: number; cpuPercent?: number; gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }> };
  }) => void): (() => void) => {
    sampleListeners.add(listener);
    return () => { sampleListeners.delete(listener); };
  };
  const getMachineSample = async (machineId: string) => {
    const scoped = await globalContext();
    const record = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.sample(machineId)).catch(() => null);
    if (!record) return null;
    const payload = payloadOf(record);
    const usage = payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)
      ? payload.usage as { memoryMb?: number; cpuPercent?: number; gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }> }
      : {};
    return { machineId, observedAt: num(payload.observedAt) ?? record.updatedAt ?? now(), usage };
  };
  const changed = (workspaceId: string) => {
    rememberWorkspace(workspaceId);
    for (const target of knownWorkspaces) {
      try { deps.onChange?.(target); } catch { /* observer errors must not break writes */ }
    }
  };
  const capacityAvailable = (workspaceId: string) => {
    rememberWorkspace(workspaceId);
    for (const target of knownWorkspaces) {
      try {
        void Promise.resolve(deps.onCapacityAvailable?.(target)).catch(report);
      } catch (error) {
        report(error);
      }
    }
  };

  const context = (workspaceId: string): Promise<KernelScopedClient> => {
    const existing = contexts.get(workspaceId);
    if (existing) return existing;
    const creating = (async () => {
      const grant = await deps.client.issueGrant({
        grantId: `resource:${randomUUID()}`,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return deps.client.scoped(grant);
    })();
    contexts.set(workspaceId, creating);
    void creating.catch(() => { if (contexts.get(workspaceId) === creating) contexts.delete(workspaceId); });
    return creating;
  };

  const globalContext = (): Promise<KernelScopedClient> => {
    const existing = contexts.get(RESOURCE_WORKSPACE_ID);
    if (existing) return existing;
    const creating = (async () => {
      const grant = await deps.client.issueGrant({
        grantId: `resource-host:${randomUUID()}`,
        owningWorkspace: RESOURCE_WORKSPACE_ID,
        executionWorkspace: RESOURCE_WORKSPACE_ID,
        capabilities: ["storage.read", "storage.write", "storage.maintenance"],
        pathScopes: [""],
      });
      return deps.client.scoped(grant);
    })();
    contexts.set(RESOURCE_WORKSPACE_ID, creating);
    void creating.catch(() => {
      if (contexts.get(RESOURCE_WORKSPACE_ID) === creating) contexts.delete(RESOURCE_WORKSPACE_ID);
    });
    return creating;
  };

  const allRecords = async (
    scoped: KernelScopedClient,
    workspaceId: string,
    recordType: string,
  ): Promise<KernelRecordResult[]> => {
    const all: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType, pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return all;
  };

  const putRecord = async (
    workspaceId: string,
    input: {
      recordId: string;
      recordType: string;
      state: string;
      payload: Record<string, unknown>;
      sessionId?: string;
      threadId?: string;
      runId?: string;
      expectedRecordRevision?: number;
    },
  ): Promise<KernelRecordResult> => {
    const scoped = workspaceId === RESOURCE_WORKSPACE_ID
      ? await globalContext()
      : await context(workspaceId);
    return scoped.putRecord({
      operationId: `${input.recordType}:${randomUUID()}`,
      recordId: input.recordId,
      workspaceId,
      recordType: input.recordType,
      state: input.state,
      payloadJson: JSON.stringify(input.payload),
      ownerIds: [],
      references: [],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
    });
  };

  const putGlobalRecord = async (input: Parameters<typeof putRecord>[1]): Promise<KernelRecordResult> => (
    putRecord(RESOURCE_WORKSPACE_ID, input)
  );

  const ensureLocalMachineUnsafe = async (): Promise<KernelRecordResult> => {
    const recordId = recordIdFor.machine(LOCAL_MACHINE_ID);
    const scoped = await globalContext();
    const existing = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordId);
    const observed = probe();
    const gpu = await observeGpu();
    const cpuCores = nonNegative(observed.cpuCores);
    const memoryMb = nonNegative(observed.memoryMb);
    if (cpuCores === undefined || memoryMb === undefined) {
      throw new Error("local machine probe returned invalid capacity");
    }
    const capacity = {
      cpuCores,
      memoryMb,
      ...(gpuCapacityForProbe(gpu) ? { gpus: gpuCapacityForProbe(gpu) } : {}),
    };
    const checkedAt = now();
    if (existing) {
      const payload = payloadOf(existing);
      const prior = payload.capacity && typeof payload.capacity === "object"
        ? payload.capacity as Record<string, unknown>
        : {};
      const priorConnection = payload.connection && typeof payload.connection === "object"
        ? payload.connection as Record<string, unknown>
        : {};
      const priorGpuProbe = payload.gpuProbe && typeof payload.gpuProbe === "object"
        ? payload.gpuProbe as Record<string, unknown>
        : {};
      const priorCapacity = JSON.stringify(prior);
      const nextCapacity = JSON.stringify(capacity);
      const nextGpuProbe = gpuProbeRecord(gpu, checkedAt);
      if (nonNegative(prior.cpuCores) === capacity.cpuCores
        && nonNegative(prior.memoryMb) === capacity.memoryMb
        && priorCapacity === nextCapacity
        && priorGpuProbe.status === nextGpuProbe.status
        && priorGpuProbe.reason === nextGpuProbe.reason
        && priorGpuProbe.detail === nextGpuProbe.detail
        && priorConnection.status === "connected") {
        return existing;
      }
      return putGlobalRecord({
        recordId,
        recordType: "resource.machine",
        state: "available",
        expectedRecordRevision: existing.recordRevision,
        payload: {
          ...payload,
          capacity,
          gpuProbe: nextGpuProbe,
          connection: { status: "connected", checkedAt: checkedAt },
        },
      });
    }
    return putGlobalRecord({
      recordId,
      recordType: "resource.machine",
      state: "available",
      payload: {
        id: LOCAL_MACHINE_ID,
        kind: "local",
        label: "Local machine",
        capacity,
        gpuProbe: gpuProbeRecord(gpu, checkedAt),
        connection: { status: "connected", checkedAt: checkedAt },
      },
    });
  };

  const ensureLocalMachine = (_workspaceId: string): Promise<KernelRecordResult> => {
    rememberWorkspace(_workspaceId);
    return withMachineLock(deps.client, LOCAL_MACHINE_ID, ensureLocalMachineUnsafe);
  };

  const sampleLocalMachineUnsafe = async (): Promise<KernelRecordResult> => {
    const recordId = recordIdFor.sample(LOCAL_MACHINE_ID);
    const scoped = await globalContext();
    const existing = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordId);
    const observed = probe();
    const gpu = await observeGpu();
    const usedMemoryMb = nonNegative(observed.usedMemoryMb);
    if (usedMemoryMb === undefined) throw new Error("local machine probe returned invalid memory usage");
    const record = await putGlobalRecord({
      recordId,
      recordType: "resource.sample",
      state: "observed",
      ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
      payload: {
        machineId: LOCAL_MACHINE_ID,
        observedAt: now(),
        source: "host-os",
        usage: {
          memoryMb: usedMemoryMb,
          ...(percent(observed.cpuPercent) === undefined ? {} : { cpuPercent: percent(observed.cpuPercent) }),
          ...(gpuUsageForProbe(gpu) ? { gpus: gpuUsageForProbe(gpu) } : {}),
        },
        gpuProbe: gpuProbeRecord(gpu, now()),
      },
    });
    emitSample(record);
    return record;
  };

  const sampleLocalMachine = (_workspaceId: string): Promise<KernelRecordResult> => {
    rememberWorkspace(_workspaceId);
    return withMachineLock(deps.client, LOCAL_MACHINE_ID, sampleLocalMachineUnsafe);
  };

  const commitmentFact = (record: KernelRecordResult): CommitmentFact | null => {
    const payload = payloadOf(record);
    const machineId = str(payload.machineId);
    if (!machineId) return null;
    const attemptId = str(payload.attemptId);
    const confirmedAt = num(payload.confirmedAt);
    const releasedAt = num(payload.releasedAt);
    const ownerWorkspaceId = str(payload.workspaceId);
    const gpuAllocation = asGpuAllocation(payload.gpuAllocation);
    return {
      ...(ownerWorkspaceId === undefined ? {} : { ownerWorkspaceId }),
      ...(gpuAllocation ? { gpuAllocation } : {}),
      view: {
        commitmentId: record.recordId.slice(COMMITMENT_PREFIX.length),
        machineId,
        ...(attemptId ? { attemptId } : {}),
        resources: asResources(payload.resources),
        ...(gpuAllocation ? { gpuAllocation } : {}),
        state: record.state as ResourceCommitmentView["state"],
        ...(confirmedAt === undefined ? {} : { confirmedAt }),
        ...(releasedAt === undefined ? {} : { releasedAt }),
      },
    };
  };

  const commitmentView = (fact: CommitmentFact, workspaceId: string): ResourceCommitmentView => {
    if (fact.ownerWorkspaceId === workspaceId) return fact.view;
    const shared = { ...fact.view };
    delete shared.attemptId;
    return shared;
  };

  const machineView = (
    record: KernelRecordResult,
    sample: KernelRecordResult | null,
    commitments: ResourceCommitmentView[],
    queued: ResourceMachineView["queued"],
  ): ResourceMachineView => {
    const payload = payloadOf(record);
    const connection = payload.connection && typeof payload.connection === "object"
      ? payload.connection as Record<string, unknown>
      : {};
    const capacity = payload.capacity && typeof payload.capacity === "object"
      ? payload.capacity as Record<string, unknown>
      : null;
    const samplePayload = sample ? payloadOf(sample) : null;
    const usage = samplePayload?.usage && typeof samplePayload.usage === "object"
      ? samplePayload.usage as Record<string, unknown>
      : null;
    const observedAt = num(samplePayload?.observedAt);
    const gpus = Array.isArray(capacity?.gpus)
      ? capacity.gpus.flatMap((gpu) => {
          if (!gpu || typeof gpu !== "object") return [];
          const entry = gpu as Record<string, unknown>;
          const index = nonNegative(entry.index);
          if (index === undefined || !Number.isInteger(index)) return [];
    const uuid = gpuUuid(entry.uuid);
          const name = str(entry.name);
          const memoryMb = nonNegative(entry.memoryMb);
          return [{
            index,
            ...(uuid ? { uuid } : {}),
            ...(name ? { name } : {}),
            ...(memoryMb === undefined ? {} : { memoryMb }),
          }];
        })
      : undefined;
    const usageGpus = Array.isArray(usage?.gpus)
      ? usage.gpus.flatMap((gpu) => {
          if (!gpu || typeof gpu !== "object") return [];
          const entry = gpu as Record<string, unknown>;
          const index = nonNegative(entry.index);
          if (index === undefined || !Number.isInteger(index)) return [];
          const uuid = gpuUuid(entry.uuid);
          const name = str(entry.name);
          const memoryMb = nonNegative(entry.memoryMb);
          const utilizationPercent = percent(entry.utilizationPercent);
          const usedMemoryMb = nonNegative(entry.usedMemoryMb);
          return [{
            index,
            ...(uuid ? { uuid } : {}),
            ...(name ? { name } : {}),
            ...(memoryMb === undefined ? {} : { memoryMb }),
            ...(utilizationPercent === undefined ? {} : { utilizationPercent }),
            ...(usedMemoryMb === undefined ? {} : { usedMemoryMb }),
          }];
        })
      : undefined;
    const label = str(payload.label);
    const rawTarget = payload.target && typeof payload.target === "object"
      ? payload.target as Record<string, unknown>
      : null;
    const targetHostId = str(rawTarget?.hostId);
    const targetConnectionId = str(rawTarget?.connectionId);
    const targetSource = rawTarget?.source === "ssh-instance" || rawTarget?.source === "configured-host"
      ? rawTarget.source
      : rawTarget?.source === "desktop-host" ? "desktop-host" : undefined;
    const targetCapabilities = Array.isArray(rawTarget?.capabilities)
      ? rawTarget.capabilities.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const coordinatorHostId = str(rawTarget?.coordinatorHostId);
    const detail = str(connection.detail);
    const rawGpuProbe = payload.gpuProbe && typeof payload.gpuProbe === "object"
      ? payload.gpuProbe as Record<string, unknown>
      : null;
    const gpuProbeStatus = rawGpuProbe?.status === "available"
      ? "available"
      : rawGpuProbe?.status === "unavailable"
        ? (rawGpuProbe.reason === "tool-missing" || rawGpuProbe.reason === "no-device" || rawGpuProbe.reason === "error"
            ? rawGpuProbe.reason : "error")
        : undefined;
    const gpuProbeDetail = str(rawGpuProbe?.detail);
    const cpuCapacity = nonNegative(capacity?.cpuCores);
    const memoryCapacity = nonNegative(capacity?.memoryMb);
    const usedCpuPercent = percent(usage?.cpuPercent);
    const usedMemoryMb = num(usage?.memoryMb);
    return {
      machineId: record.recordId.slice(MACHINE_PREFIX.length),
      kind: str(payload.kind) ?? "unknown",
      ...(label ? { label } : {}),
      state: record.state as ResourceMachineView["state"],
      connection: {
        status: (["connected", "degraded", "offline", "unknown"] as const)
          .find((value) => value === connection.status) ?? "unknown",
        checkedAt: num(connection.checkedAt) ?? record.updatedAt,
        ...(detail ? { detail } : {}),
      },
      ...(targetHostId && targetConnectionId && targetSource ? {
        target: {
          hostId: targetHostId,
          connectionId: targetConnectionId,
          source: targetSource,
          capabilities: targetCapabilities,
          ...(coordinatorHostId ? { coordinatorHostId } : {}),
          acceptedJobsSurviveClientDisconnect: rawTarget?.acceptedJobsSurviveClientDisconnect === true,
          unassignedWorkRequiresCoordinator: rawTarget?.unassignedWorkRequiresCoordinator !== false,
        },
      } : {}),
      ...(gpuProbeStatus ? {
        gpuProbe: {
          status: gpuProbeStatus,
          checkedAt: num(rawGpuProbe?.checkedAt) ?? record.updatedAt,
          ...(gpuProbeDetail ? { detail: gpuProbeDetail } : {}),
        },
      } : {}),
      ...(capacity ? {
        capacity: {
          ...(cpuCapacity === undefined ? {} : { cpuCores: cpuCapacity }),
          ...(memoryCapacity === undefined ? {} : { memoryMb: memoryCapacity }),
          ...(gpus ? { gpus } : {}),
          observedAt: record.updatedAt,
        },
      } : {}),
      ...(usage && observedAt !== undefined ? {
        usage: {
          ...(usedCpuPercent === undefined ? {} : { cpuPercent: usedCpuPercent }),
          ...(usedMemoryMb === undefined ? {} : { memoryMb: usedMemoryMb }),
          ...(usageGpus ? { gpus: usageGpus } : {}),
          observedAt,
          source: str(samplePayload?.source) ?? "unknown",
          stale: now() - observedAt > SAMPLE_STALE_MS,
        },
      } : {}),
      commitments,
      queued,
    };
  };

  const reconcileAdmission = async (
    workspaceId: string,
    machineId: string,
    resources: ExperimentResourceRequest,
    attemptId: string,
  ): Promise<ResourceAdmissionReconciliation> => {
    if (!workspaceId || !machineId || !attemptId) throw new Error("resource admission identity is required");
    const normalized = validateResources(resources);
    const gpuRequested = (normalized.gpuCount ?? 0) > 0 || (normalized.gpuMemoryMb ?? 0) > 0;
    return withMachineLock(deps.client, machineId, async () => {
      const scoped = await globalContext();
      const commitmentId = commitmentIdFor(workspaceId, machineId, attemptId);
      const existing = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.commitment(commitmentId));
      if (existing) {
        const fact = commitmentFact(existing);
        if (!fact || fact.ownerWorkspaceId !== workspaceId || fact.view.machineId !== machineId
          || fact.view.attemptId !== attemptId || !sameResources(fact.view.resources, normalized)) {
          throw new Error(`resource commitment identity conflict for ${commitmentId}`);
        }
        if (fact.view.state === "released") return { status: "not-admitted" };
        if (fact.view.state === "confirmed" && (!gpuRequested || fact.gpuAllocation)) return { status: "confirmed", commitmentId,
          ...(fact.gpuAllocation ? { gpuAllocation: fact.gpuAllocation } : {}) };
        return { status: "unknown" };
      }
      const machine = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.machine(machineId));
      const external = machine ? await deps.resolveExternalAuthority?.(machineId, machine) : null;
      if (!external?.reconcileAdmission) return { status: "unknown" };
      const receipt = await external.reconcileAdmission({ workspaceId, machineId, attemptId, resources: normalized });
      if (receipt.status === "unknown" || receipt.status === "not-admitted") return receipt;
      if (receipt.status !== "confirmed") throw new Error("Remote resource observation returned an invalid state");
      if (!receipt.commitmentId) throw new Error("Remote resource observation returned no commitment identity");
      if (gpuRequested && !receipt.gpuAllocation) return { status: "unknown" };
      // Restore the coordinator's original receipt from the target owner; do not reserve again.
      await putGlobalRecord({ recordId: recordIdFor.commitment(commitmentId), recordType: "resource.commitment", state: "confirmed",
        payload: { id: commitmentId, workspaceId, machineId, attemptId, resources: normalized,
          confirmedBy: external.authorityId, externalCommitmentId: receipt.commitmentId,
          ...(receipt.gpuAllocation ? { gpuAllocation: receipt.gpuAllocation } : {}), confirmedAt: now() } });
      changed(workspaceId);
      return { status: "confirmed", commitmentId, ...(receipt.gpuAllocation ? { gpuAllocation: receipt.gpuAllocation } : {}) };
    });
  };

  const admit = async (
    workspaceId: string,
    machineId: string,
    resources: ExperimentResourceRequest,
    attemptId: string,
  ): Promise<ResourceAdmission> => {
    if (!workspaceId || !machineId || !attemptId) throw new Error("resource admission identity is required");
    rememberWorkspace(workspaceId);
    const normalized = validateResources(resources);
    return withMachineLock(deps.client, machineId, async () => {
      if (machineId === LOCAL_MACHINE_ID) await ensureLocalMachineUnsafe();
      const scoped = await globalContext();
      const machine = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.machine(machineId));
      if (!machine || machine.state !== "available") {
        return { status: "insufficient", reason: `machine ${machineId} is ${machine?.state ?? "unknown"}` };
      }
      const machinePayload = payloadOf(machine);
      const connection = machinePayload.connection && typeof machinePayload.connection === "object"
        ? machinePayload.connection as Record<string, unknown>
        : {};
      if (connection.status !== "connected") {
        return { status: "insufficient", reason: `machine ${machineId} connection is ${str(connection.status) ?? "unknown"}` };
      }
      const capacity = (machinePayload.capacity ?? {}) as Record<string, unknown>;
      const commitmentId = commitmentIdFor(workspaceId, machineId, attemptId);
      const existing = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.commitment(commitmentId));
      if (existing) {
        const fact = commitmentFact(existing);
        if (!fact || fact.ownerWorkspaceId !== workspaceId || fact.view.machineId !== machineId || fact.view.attemptId !== attemptId) {
          throw new Error(`resource commitment identity conflict for ${commitmentId}`);
        }
        if (!sameResources(fact.view.resources, normalized)) {
          throw new Error(`attempt ${attemptId} already has a different resource commitment`);
        }
        if (fact.view.state === "confirmed" || fact.view.state === "requested") {
          const allCommitments = (await allRecords(scoped, RESOURCE_WORKSPACE_ID, "resource.commitment"))
            .filter((record) => record.state === "confirmed" || record.state === "requested")
            .map(commitmentFact)
            .filter((fact): fact is CommitmentFact => fact !== null && fact.view.machineId === machineId);
          const gpuRequested = (normalized.gpuCount ?? 0) > 0 || (normalized.gpuMemoryMb ?? 0) > 0;
          if (gpuRequested && !fact.gpuAllocation) {
            return {
              status: "insufficient",
              commitmentId,
              remaining: remainingCapacity(capacity, allCommitments.map((entry) => entry.view.resources)),
              reason: "the existing GPU commitment has no confirmed device allocation; resource reconciliation is required",
            };
          }
          return {
            status: "confirmed",
            commitmentId,
            ...(fact.gpuAllocation ? { gpuAllocation: fact.gpuAllocation } : {}),
            remaining: remainingCapacity(capacity, allCommitments.map((entry) => entry.view.resources)),
          };
        }
        return { status: "insufficient", reason: `attempt ${attemptId} has a ${fact.view.state} commitment` };
      }
      const external = deps.resolveExternalAuthority
        ? await deps.resolveExternalAuthority(machineId, machine)
        : null;
      if (str(machinePayload.backend) === "managed-remote" && !external) {
        return { status: "insufficient", reason: `resource authority for ${machineId} is unavailable` };
      }
      if (external) {
        const remote = await external.admit({ workspaceId, machineId, attemptId, resources: normalized });
        if (remote.status !== "confirmed") return remote;
        const gpuRequested = (normalized.gpuCount ?? 0) > 0 || (normalized.gpuMemoryMb ?? 0) > 0;
        if (gpuRequested && !remote.gpuAllocation) {
          if (remote.commitmentId) {
            await external.release({ workspaceId, machineId, attemptId, commitmentId: remote.commitmentId, reason: "managed target returned no GPU device allocation" }).catch(report);
          }
          return { status: "insufficient", reason: "managed target confirmed GPU resources without a device allocation" };
        }
        await putGlobalRecord({
          recordId: recordIdFor.commitment(commitmentId),
          recordType: "resource.commitment",
          state: "confirmed",
          payload: {
            id: commitmentId,
            workspaceId,
            machineId,
            attemptId,
            resources: normalized,
            confirmedBy: external.authorityId,
            externalCommitmentId: remote.commitmentId,
            ...(remote.gpuAllocation ? { gpuAllocation: remote.gpuAllocation } : {}),
            confirmedAt: now(),
          },
        });
        changed(workspaceId);
        return {
          status: "confirmed",
          commitmentId,
          ...(remote.gpuAllocation ? { gpuAllocation: remote.gpuAllocation } : {}),
          ...(remote.remaining ? { remaining: remote.remaining } : {}),
        };
      }
      const commitments = (await allRecords(scoped, RESOURCE_WORKSPACE_ID, "resource.commitment"))
        .filter((record) => record.state === "confirmed" || record.state === "requested")
        .map(commitmentFact)
        .filter((fact): fact is CommitmentFact => fact !== null && fact.view.machineId === machineId);
      const remaining = remainingCapacity(capacity, commitments.map((fact) => fact.view.resources));
      for (const dimension of resourceDimensions) {
        const wanted = normalized[dimension];
        if (wanted === undefined || wanted <= 0) continue;
        const gpus = gpuCapacity(capacity);
        const capacityTotal = dimension === "gpuCount" ? gpus.count
          : dimension === "gpuMemoryMb" ? gpus.memoryMb
          : nonNegative(capacity[dimension]);
        if (capacityTotal === undefined) {
          return { status: "insufficient", remaining, reason: `machine ${machineId} reports no ${dimension} capacity` };
        }
        if ((remaining[dimension] ?? 0) < wanted) {
          return { status: "insufficient", remaining, reason: `insufficient ${dimension} on ${machineId}` };
        }
      }
      if (!hasResourceDimension(normalized)) return { status: "confirmed" };
      const gpuRequested = (normalized.gpuCount ?? 0) > 0 || (normalized.gpuMemoryMb ?? 0) > 0;
      let gpuAllocation: GpuAllocation | undefined;
      if (gpuRequested) {
        const freshGpu = machineId === LOCAL_MACHINE_ID ? await observeGpu() : null;
        const inventory = freshGpu?.status === "available"
          ? freshGpu.devices
          : gpuDevices(capacity);
        const allocation = allocateGpuDevices(
          inventory,
          commitments.map((fact) => ({
            ...(fact.view.resources.gpuCount === undefined ? {} : { gpuCount: fact.view.resources.gpuCount }),
            ...(fact.gpuAllocation ? { allocation: fact.gpuAllocation } : {}),
          })),
          {
            ...(normalized.gpuCount === undefined ? {} : { gpuCount: normalized.gpuCount }),
            ...(normalized.gpuMemoryMb === undefined ? {} : { gpuMemoryMb: normalized.gpuMemoryMb }),
          },
        );
        if (allocation.status !== "confirmed") return { status: "insufficient", remaining, reason: allocation.reason };
        gpuAllocation = allocation.allocation;
      }
      await putGlobalRecord({
        recordId: recordIdFor.commitment(commitmentId),
        recordType: "resource.commitment",
        state: "confirmed",
        payload: {
          id: commitmentId,
          workspaceId,
          machineId,
          attemptId,
          resources: normalized,
          confirmedBy: "local-admission",
          ...(gpuAllocation ? { gpuAllocation } : {}),
          confirmedAt: now(),
        },
      });
      changed(workspaceId);
      return {
        status: "confirmed",
        commitmentId,
        ...(gpuAllocation ? { gpuAllocation } : {}),
        remaining: remainingCapacity(capacity, [...commitments.map((fact) => fact.view.resources), normalized]),
      };
    });
  };

  const release = async (workspaceId: string, commitmentId: string, reason: string): Promise<void> => {
    rememberWorkspace(workspaceId);
    const recordId = recordIdFor.commitment(commitmentId);
    const existing = await globalContext().then((scoped) => scoped.getRecord(RESOURCE_WORKSPACE_ID, recordId));
    const machineId = existing ? str(payloadOf(existing).machineId) : undefined;
    if (!machineId) return;
    await withMachineLock(deps.client, machineId, async () => {
      const scoped = await globalContext();
      const current = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordId);
      if (!current || (current.state !== "confirmed" && current.state !== "requested")) return;
      const fact = commitmentFact(current);
      if (!fact || fact.ownerWorkspaceId !== workspaceId) return;
      const payload = payloadOf(current);
      const machine = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.machine(machineId));
      const externalCommitmentId = str(payload.externalCommitmentId);
      if (machine && externalCommitmentId) {
        const external = deps.resolveExternalAuthority
          ? await deps.resolveExternalAuthority(machineId, machine)
          : null;
        if (!external) throw new Error(`resource authority for ${machineId} is unavailable`);
        await external.release({
          workspaceId,
          machineId,
          ...(fact.view.attemptId ? { attemptId: fact.view.attemptId } : {}),
          commitmentId: externalCommitmentId,
          reason,
        });
      }
      await putGlobalRecord({
        recordId,
        recordType: "resource.commitment",
        state: "released",
        expectedRecordRevision: current.recordRevision,
        payload: { ...payload, releasedAt: now(), releaseReason: reason },
      });
      changed(workspaceId);
      capacityAvailable(workspaceId);
    });
  };

  const listMachines = async (workspaceId: string): Promise<ResourceMachineView[]> => {
    rememberWorkspace(workspaceId);
    await ensureLocalMachine(workspaceId).catch(report);
    await sampleLocalMachine(workspaceId).catch(report);
    const scoped = await context(workspaceId);
    const resourceScoped = await globalContext();
    const [machines, samples, commitments, attempts] = await Promise.all([
      allRecords(resourceScoped, RESOURCE_WORKSPACE_ID, "resource.machine"),
      allRecords(resourceScoped, RESOURCE_WORKSPACE_ID, "resource.sample"),
      allRecords(resourceScoped, RESOURCE_WORKSPACE_ID, "resource.commitment"),
      allRecords(scoped, workspaceId, "experiment.attempt"),
    ]);
    const sampleByMachine = new Map(samples.map((record) => [record.recordId.slice(SAMPLE_PREFIX.length), record]));
    return machines.map((machine) => {
      const machineId = machine.recordId.slice(MACHINE_PREFIX.length);
      const active = commitments
        .map(commitmentFact)
        .filter((fact): fact is CommitmentFact => (
          fact !== null && fact.view.machineId === machineId && (fact.view.state === "confirmed" || fact.view.state === "requested")
        ));
      return machineView(
        machine,
        sampleByMachine.get(machineId) ?? null,
        active.map((fact) => commitmentView(fact, workspaceId)),
        queuedAttemptsFor(attempts, machineId),
      );
    });
  };

  // Queue facts are read from the experiment service's durable records;
  // this service presents them but never writes them.
  const queuedAttemptsFor = (
    attempts: KernelRecordResult[],
    machineId: string,
  ): ResourceMachineView["queued"] => (
    attempts
      .filter((record) => record.state === "queued")
      .flatMap((record) => {
        const payload = payloadOf(record);
        if ((str(payload.machineId) ?? LOCAL_MACHINE_ID) !== machineId) return [];
        const attemptId = str(payload.id);
        if (!attemptId) return [];
        const resources = payload.resources && typeof payload.resources === "object"
          ? asResources(payload.resources) : {};
        const reason = str(payload.queueReason);
        return [{
          attemptId,
          ...(Object.keys(resources).length ? { resources } : {}),
          ...(reason ? { reason } : {}),
          queuedAt: num(payload.createdAt) ?? record.createdAt,
        }];
      })
      .sort((a, b) => a.queuedAt - b.queuedAt)
  );

  const getMachine = async (workspaceId: string, machineId: string): Promise<ResourceMachineView | null> => {
    rememberWorkspace(workspaceId);
    const scoped = await globalContext();
    const record = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.machine(machineId));
    if (!record) return null;
    const workspaceScoped = await context(workspaceId);
    const [samples, commitments, attempts] = await Promise.all([
      allRecords(scoped, RESOURCE_WORKSPACE_ID, "resource.sample"),
      allRecords(scoped, RESOURCE_WORKSPACE_ID, "resource.commitment"),
      allRecords(workspaceScoped, workspaceId, "experiment.attempt"),
    ]);
    const sample = samples.find((entry) => entry.recordId === recordIdFor.sample(machineId)) ?? null;
    const active = commitments
      .map(commitmentFact)
      .filter((fact): fact is CommitmentFact => (
        fact !== null && fact.view.machineId === machineId && (fact.view.state === "confirmed" || fact.view.state === "requested")
      ));
    return machineView(record, sample, active.map((fact) => commitmentView(fact, workspaceId)), queuedAttemptsFor(attempts, machineId));
  };

  /** Host-only machine fact lookup for experiment backend resolution. */
  const getMachineRecord = async (workspaceId: string, machineId: string): Promise<KernelRecordResult | null> => {
    rememberWorkspace(workspaceId);
    const scoped = await globalContext();
    return scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.machine(machineId));
  };

  /**
   * Recover the durable GPU binding for a workspace-owned commitment after a
   * service or Host restart. A commitment from another workspace is never
   * disclosed through this lookup.
   */
  const getCommitmentAllocation = async (
    workspaceId: string,
    commitmentId: string,
  ): Promise<GpuAllocation | null> => {
    rememberWorkspace(workspaceId);
    const scoped = await globalContext();
    const record = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordIdFor.commitment(commitmentId));
    if (!record || (record.state !== "confirmed" && record.state !== "requested")) return null;
    const fact = commitmentFact(record);
    if (!fact || fact.ownerWorkspaceId !== workspaceId) return null;
    return fact.gpuAllocation ?? null;
  };

  const registerMachine = async (
    workspaceId: string,
    input: ResourceMachineRegistration,
  ): Promise<ResourceMachineView> => {
    rememberWorkspace(workspaceId);
    const kind = input.kind?.trim();
    if (!kind) throw new Error("machine registration requires a kind");
    const machineId = input.machineId?.trim() || `machine-${randomUUID().slice(0, 12)}`;
    if (machineId === LOCAL_MACHINE_ID) {
      throw new Error("the local machine is self-describing; it cannot be registered");
    }
    const validStates = ["available", "degraded", "offline", "retired"] as const;
    if (input.state !== undefined && !validStates.includes(input.state)) throw new Error("machine state is invalid");
    const validConnections = ["connected", "degraded", "offline", "unknown"] as const;
    if (input.connection && !validConnections.includes(input.connection.status)) throw new Error("machine connection status is invalid");
    const capacity = input.capacity
      ? {
          ...(input.capacity.cpuCores === undefined ? {} : {
            cpuCores: nonNegative(input.capacity.cpuCores) ?? (() => { throw new Error("machine cpu capacity is invalid"); })(),
          }),
          ...(input.capacity.memoryMb === undefined ? {} : {
            memoryMb: nonNegative(input.capacity.memoryMb) ?? (() => { throw new Error("machine memory capacity is invalid"); })(),
          }),
          ...(input.capacity.gpus === undefined ? {} : {
            gpus: input.capacity.gpus.map((gpu) => {
              const index = nonNegative(gpu?.index);
              if (index === undefined || !Number.isInteger(index)) throw new Error("machine GPU index is invalid");
              const uuid = gpuUuid(gpu?.uuid);
              if (gpu?.uuid !== undefined && !uuid) throw new Error("machine GPU UUID is invalid");
              const memoryMb = gpu?.memoryMb === undefined ? undefined : nonNegative(gpu.memoryMb);
              if (gpu?.memoryMb !== undefined && memoryMb === undefined) throw new Error("machine GPU memory is invalid");
              return {
                index,
                ...(uuid ? { uuid } : {}),
                ...(gpu?.name?.trim() ? { name: gpu.name.trim() } : {}),
                ...(memoryMb === undefined ? {} : { memoryMb }),
              };
            }),
          }),
        }
      : undefined;
    return withMachineLock(deps.client, machineId, async () => {
      const scoped = await globalContext();
      const recordId = recordIdFor.machine(machineId);
      const existing = await scoped.getRecord(RESOURCE_WORKSPACE_ID, recordId);
      const prior = existing ? payloadOf(existing) : {};
      const priorKind = str(prior.kind);
      if (priorKind && priorKind !== kind) {
        throw new Error(`machine ID ${machineId} already identifies a different machine`);
      }
      const backend = input.backend?.trim() || str(prior.backend);
      if (input.backend?.trim() && str(prior.backend) && input.backend.trim() !== str(prior.backend)) {
        throw new Error(`machine ID ${machineId} already identifies a different backend`);
      }
      const connection = input.connection
        ? { status: input.connection.status, checkedAt: now(), ...(input.connection.detail ? { detail: input.connection.detail } : {}) }
        : (prior.connection && typeof prior.connection === "object"
            ? prior.connection as Record<string, unknown>
            : { status: "unknown", checkedAt: now(), detail: "registered, never probed" });
      const state = input.state
        ?? (existing && validStates.includes(existing.state as typeof validStates[number]) ? existing.state as typeof validStates[number] : "offline");
      const record = await putGlobalRecord({
        recordId,
        recordType: "resource.machine",
        state,
        ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
        payload: {
          id: machineId,
          kind,
          ...(input.label?.trim() ? { label: input.label.trim() } : prior.label ? { label: prior.label } : {}),
          ...(backend ? { backend } : {}),
          ...(capacity ? { capacity } : prior.capacity ? { capacity: prior.capacity } : {}),
          ...(input.target ? { target: input.target } : prior.target ? { target: prior.target } : {}),
          connection,
        },
      });
      const view = await getMachine(workspaceId, str(payloadOf(record).id) ?? machineId);
      if (!view) throw new Error("registered machine is unreadable");
      changed(workspaceId);
      return view;
    });
  };

  const list = async (workspaceId: string): Promise<ResourceListResult> => {
    await deps.refreshTargets?.(workspaceId);
    const machines = await listMachines(workspaceId);
    const text = machines.length === 0
      ? "No execution targets are registered."
      : machines.map((machine) => {
          const capacityParts: string[] = [];
          if (machine.capacity?.cpuCores !== undefined) capacityParts.push(`${machine.capacity.cpuCores} cpu`);
          if (machine.capacity?.memoryMb !== undefined) capacityParts.push(`${Math.round(machine.capacity.memoryMb / 1024)} GiB`);
          if (machine.capacity?.gpus?.length) capacityParts.push(`${machine.capacity.gpus.length} gpu`);
          const capacity = capacityParts.length ? capacityParts.join("/") : "capacity unknown";
          const usage = machine.usage
            ? `used ${machine.usage.memoryMb !== undefined ? `${Math.round(machine.usage.memoryMb / 1024)} GiB mem` : "mem ?"}${machine.usage.stale ? " (stale)" : ""}`
            : "usage unread";
          const committed = machine.commitments.length
            ? `${machine.commitments.length} commitment(s)`
            : "no commitments";
          const queued = machine.queued.length
            ? ` · ${machine.queued.length} queued (${machine.queued.map((entry) => entry.attemptId).join(", ")})`
            : "";
          return `${machine.machineId} · ${machine.kind} · ${machine.state} · ${machine.connection.status} · ${capacity} · ${usage} · ${committed}${queued}`;
        }).join("\n");
    return { machines, generatedAt: now(), text };
  };

  return {
    ensureLocalMachine,
    sampleLocalMachine,
    listMachines,
    getMachine,
    getMachineRecord,
    getMachineSample,
    subscribeSamples,
    getCommitmentAllocation,
    registerMachine,
    list,
    admit,
    reconcileAdmission,
    release,
  };
}

export type ResourceService = ReturnType<typeof createResourceService>;
