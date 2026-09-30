import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ExperimentResourceRequest } from "@varin/protocol";
import { sliceUtf8ByBytes, type ShellExecResult, type ShellReadResult } from "@varin/protocol";
import os from "node:os";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelBranchState, KernelRecordResult } from "../kernel/protocol.generated.js";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import type { ResourceService } from "./resources.js";
import {
  MANAGED_REMOTE_PROTOCOL_VERSION,
  type ManagedRemoteAdmissionReceipt,
  type ManagedRemoteAdmissionRequest,
  type ManagedRemoteIdentity,
  type ManagedRemoteJobObservation,
  type ManagedRemoteJobReceipt,
  type ManagedRemoteJobSubmit,
  type ManagedRemoteMaterialEntry,
  type ManagedRemoteMaterialManifest,
  type ManagedRemoteMaterialProbe,
  type ManagedRemoteMaterialReceipt,
  type ManagedRemoteOutputReceipt,
  type ManagedRemoteReadReceipt,
} from "./managed-remote-types.js";

const WORKSPACE_ID = "__varin_managed_remote__";
const MATERIAL_PREFIX = "managed.remote.material:";
const OBJECT_PREFIX = "managed.remote.object:";
const JOB_PREFIX = "managed.remote.job:";
const OUTPUT_PREFIX = "managed.remote.output:";
const ADMISSION_PREFIX = "managed.remote.admission:";
const SHELL_PREFIX = "managed.remote.shell:";
const ACTIVE_JOB_STATES = new Set(["accepted", "running", "stopping", "unknown"]);
const SERVICE_CAPABILITIES = [
  "storage.read", "storage.write", "storage.maintenance",
  "recovery", "recovery.maintenance", "process", "process.maintenance",
];
const TARGET_BASE_ENVIRONMENT = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec",
  "HOME", "USER", "LOGNAME", "USERPROFILE", "SHELL",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL",
]);

const digest = (...values: string[]): string => createHash("sha256").update(values.join("\0")).digest("hex");
const recordPayload = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const value = JSON.parse(record.payloadJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const normalizedRelative = (value: string, label: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the managed root`);
  }
  return normalized;
};
const materialRecordId = (materialId: string) => `${MATERIAL_PREFIX}${digest(materialId)}`;
const objectRecordId = (objectHash: string) => `${OBJECT_PREFIX}${objectHash.replace(/^sha256-/, "")}`;
const jobRecordId = (principalId: string, coordinatorHostId: string, backendJobId: string) => `${JOB_PREFIX}${digest(principalId, coordinatorHostId, backendJobId)}`;
const outputRecordId = (jobId: string, relativePath: string) => `${OUTPUT_PREFIX}${digest(jobId, relativePath)}`;
const admissionRecordId = (principalId: string, input: Pick<ManagedRemoteAdmissionRequest, "coordinatorHostId" | "workspaceId" | "attemptId">) => (
  `${ADMISSION_PREFIX}${digest(principalId, input.coordinatorHostId, input.workspaceId, input.attemptId)}`
);
const processIdFor = (principalId: string, coordinatorHostId: string, backendJobId: string) => `remote-${digest(principalId, coordinatorHostId, backendJobId).slice(0, 40)}`;
const commitmentAttemptId = (principalId: string, input: Pick<ManagedRemoteAdmissionRequest, "coordinatorHostId" | "workspaceId" | "attemptId">) => (
  `remote-${digest(principalId, input.coordinatorHostId, input.workspaceId, input.attemptId).slice(0, 40)}`
);
const resourcesRequired = (resources: ExperimentResourceRequest): boolean => (
  (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const).some((key) => (resources[key] ?? 0) > 0)
);
const shellRecordId = (principalId: string, coordinatorHostId: string, toolCallId: string) => `${SHELL_PREFIX}${digest(principalId, coordinatorHostId, toolCallId)}`;

const validState = (state: KernelBranchState): KernelBranchState => {
  if (state.kind === "regular-file") {
    if (!/^sha256-[0-9a-f]{64}$/.test(state.objectHash) || !Number.isSafeInteger(state.byteLength) || state.byteLength < 0) {
      throw new Error("Managed material contains an invalid file object");
    }
    return state;
  }
  if (state.kind === "directory" || state.kind === "symlink") return state;
  throw new Error(`Managed material cannot contain ${state.kind} entries`);
};

const normalizeManifest = (manifest: ManagedRemoteMaterialManifest): ManagedRemoteMaterialManifest => {
  const coordinatorHostId = manifest.coordinatorHostId?.trim();
  const materialId = manifest.materialId?.trim();
  if (!coordinatorHostId || !materialId) throw new Error("Managed material identity is required");
  const seen = new Set<string>();
  const entries = manifest.entries.map((entry): ManagedRemoteMaterialEntry => {
    const entryPath = normalizedRelative(entry.path, "Managed material path");
    if (seen.has(entryPath)) throw new Error(`Managed material repeats path ${entryPath}`);
    seen.add(entryPath);
    return { path: entryPath, state: validState(entry.state) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const cwd = manifest.cwd === undefined || manifest.cwd === "" ? undefined : normalizedRelative(manifest.cwd, "Managed material cwd");
  return { coordinatorHostId, materialId, entries, ...(cwd ? { cwd } : {}) };
};

const observationOf = (snapshot: Record<string, unknown>): ManagedRemoteJobObservation => {
  const reason = text(snapshot.reason);
  return {
    status: (["starting", "running", "exited", "failed", "cancelled", "unknown", "released"] as const)
      .find((state) => state === snapshot.status) ?? "unknown",
    writerActive: snapshot.writerActive === true,
    ...(snapshot.exitCode === null || typeof snapshot.exitCode === "number" ? { exitCode: snapshot.exitCode as number | null } : {}),
    ...(snapshot.signal === null || typeof snapshot.signal === "string" ? { signal: snapshot.signal as string | null } : {}),
    ...(reason ? { reason } : {}),
  };
};

export interface ManagedRemoteExecutionServiceOptions {
  client: KernelClient;
  hostId: string;
  resources: ResourceService;
  now?: () => number;
  onError?: (error: Error) => void;
}

export function createManagedRemoteExecutionService(options: ManagedRemoteExecutionServiceOptions) {
  const now = options.now ?? (() => Date.now());
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  let contextPromise: Promise<KernelScopedClient> | null = null;
  const monitors = new Map<string, Promise<void>>();

  const context = async (): Promise<KernelScopedClient> => {
    contextPromise ??= (async () => {
      await options.client.start();
      return options.client.scoped(await options.client.issueGrant({
        grantId: `managed-remote:${options.hostId}:${randomUUID()}`,
        owningWorkspace: WORKSPACE_ID,
        executionWorkspace: WORKSPACE_ID,
        capabilities: SERVICE_CAPABILITIES,
        pathScopes: [""],
      }));
    })();
    return contextPromise;
  };

  const putRecord = async (input: {
    recordId: string;
    recordType: string;
    state: string;
    payload: Record<string, unknown>;
    references?: Array<{ slot: string; objectHash: string }>;
    ownerIds?: string[];
    expectedRecordRevision?: number;
  }): Promise<KernelRecordResult> => (await context()).putRecord({
    operationId: `${input.recordType}:${randomUUID()}`,
    recordId: input.recordId,
    workspaceId: WORKSPACE_ID,
    recordType: input.recordType,
    state: input.state,
    payloadJson: JSON.stringify(input.payload),
    references: input.references ?? [],
    ownerIds: input.ownerIds ?? [],
    ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
  });

  const listRecords = async (recordType: string): Promise<KernelRecordResult[]> => {
    const scoped = await context();
    const records: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({ workspaceId: WORKSPACE_ID, recordType, pageSize: 128, ...(cursor === undefined ? {} : { cursor }) });
      records.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records;
  };

  const identity = async (): Promise<ManagedRemoteIdentity> => {
    const machine = await options.resources.getMachine(WORKSPACE_ID, "local")
      ?? await options.resources.listMachines(WORKSPACE_ID).then((entries) => entries.find((entry) => entry.machineId === "local") ?? null);
    if (!machine) throw new Error("Managed remote target resource identity is unavailable");
    return {
      protocolVersion: MANAGED_REMOTE_PROTOCOL_VERSION,
      hostId: options.hostId,
      capabilities: ["materials", "process", "attach", "cancel", "logs", "outputs", "resource-admission", "remote-shell"],
      machine,
    };
  };

  const ownerForOutput = async (outputId: string): Promise<{ coordinatorHostId: string; principalId: string }> => {
    const record = await (await context()).getRecord(WORKSPACE_ID, `${OUTPUT_PREFIX}${outputId}`);
    const payload = record ? recordPayload(record) : {};
    const coordinatorHostId = text(payload.coordinatorHostId);
    const principalId = text(payload.principalId);
    if (!coordinatorHostId || !principalId) throw new Error("Managed remote output is unavailable");
    return { coordinatorHostId, principalId };
  };

  const lifecycle = async () => {
    const jobs = await listRecords("managed.remote.job");
    const activeJobs = jobs.filter((record) => ACTIVE_JOB_STATES.has(record.state)).length;
    return {
      hostId: options.hostId,
      activeJobs,
      keepAliveRequired: activeJobs > 0,
      acceptedJobsSurviveClientDisconnect: true,
    };
  };

  const probeMaterial = async (raw: ManagedRemoteMaterialManifest): Promise<ManagedRemoteMaterialProbe> => {
    const manifest = normalizeManifest(raw);
    const scoped = await context();
    const existing = await scoped.getRecord(WORKSPACE_ID, materialRecordId(manifest.materialId));
    if (existing?.state === "ready") {
      const payload = recordPayload(existing);
      if (text(payload.materialId) !== manifest.materialId) {
        throw new Error("Managed material identity is already bound to another input");
      }
      const rootId = text(payload.rootId);
      const canonicalRoot = text(payload.canonicalRoot);
      return {
        ready: true,
        missingObjects: [],
        ...(rootId ? { rootId } : {}),
        ...(canonicalRoot ? { canonicalRoot } : {}),
        cwd: manifest.cwd ?? "",
      };
    }
    const objects = new Map<string, number>();
    for (const entry of manifest.entries) {
      if (entry.state.kind === "regular-file") objects.set(entry.state.objectHash, entry.state.byteLength);
    }
    const missingObjects: Array<{ objectHash: string; byteLength: number }> = [];
    for (const [objectHash, byteLength] of objects) {
      const record = await scoped.getRecord(WORKSPACE_ID, objectRecordId(objectHash));
      const payload = record ? recordPayload(record) : {};
      if (record?.state !== "available" || text(payload.objectHash) !== objectHash || number(payload.byteLength) !== byteLength) {
        missingObjects.push({ objectHash, byteLength });
      }
    }
    return { ready: false, missingObjects };
  };

  const putObject = async (
    coordinatorHostId: string,
    objectHash: string,
    byteLength: number,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ objectHash: string; byteLength: number; reused: boolean }> => {
    if (!coordinatorHostId.trim()) throw new Error("Coordinator identity is required");
    if (!/^sha256-[0-9a-f]{64}$/.test(objectHash) || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("Managed object identity is invalid");
    }
    const scoped = await context();
    const recordId = objectRecordId(objectHash);
    const existing = await scoped.getRecord(WORKSPACE_ID, recordId);
    if (existing?.state === "available") {
      const payload = recordPayload(existing);
      if (text(payload.objectHash) !== objectHash || number(payload.byteLength) !== byteLength) throw new Error("Managed object identity conflicts with retained content");
      return { objectHash, byteLength, reused: true };
    }
    const blob = await scoped.putBlobStream(body, {
      operationId: `managed-remote-object:${objectHash}`,
      byteLength,
      expectedHash: objectHash,
    }, signal);
    try {
      await putRecord({
        recordId,
        recordType: "managed.remote.object",
        state: "available",
        payload: { id: recordId.slice(OBJECT_PREFIX.length), objectHash, byteLength, firstCoordinatorHostId: coordinatorHostId, createdAt: now() },
        references: [{ slot: "content", objectHash }],
        ownerIds: [blob.ownerId],
      });
    } catch (error) {
      const raced = await scoped.getRecord(WORKSPACE_ID, recordId).catch(() => null);
      if (raced?.state !== "available" || text(recordPayload(raced).objectHash) !== objectHash) {
        await scoped.releaseBlob(blob.ownerId).catch(() => undefined);
        throw error;
      }
      await scoped.releaseBlob(blob.ownerId).catch(() => undefined);
    }
    return { objectHash, byteLength, reused: false };
  };

  const commitMaterial = async (raw: ManagedRemoteMaterialManifest): Promise<ManagedRemoteMaterialReceipt> => {
    const manifest = normalizeManifest(raw);
    const probe = await probeMaterial(manifest);
    if (probe.ready && probe.rootId && probe.canonicalRoot) {
      return { materialId: manifest.materialId, root: manifest.materialId, rootId: probe.rootId, canonicalRoot: probe.canonicalRoot, cwd: probe.cwd ?? "", reused: true };
    }
    if (probe.missingObjects.length > 0) throw new Error(`Managed material is missing ${probe.missingObjects.length} object(s)`);
    const scoped = await context();
    const branchId = `managed-material-${digest(manifest.materialId).slice(0, 40)}`;
    const created = await scoped.createBranch({
      operationId: `managed-remote-material:${manifest.materialId}`,
      branchId,
      workspaceId: WORKSPACE_ID,
      entries: manifest.entries.map((entry) => entry.state.kind === "regular-file"
        ? { path: entry.path, state: entry.state, sourceRecordId: objectRecordId(entry.state.objectHash), sourceSlot: "content" }
        : { path: entry.path, state: entry.state }),
      draftBasePaths: [],
      captureScopes: [],
    });
    const root = text(created.root);
    if (!root || root !== manifest.materialId) throw new Error("Managed material root does not match the coordinator snapshot");
    const handshake = options.client.handshake ?? await options.client.start();
    const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
    const materialRoot = path.join(storageRoot, "managed", "remote", "materials", digest(manifest.materialId));
    const container = await scoped.fileRootRegister({ workspaceId: WORKSPACE_ID, executionWorkspaceId: WORKSPACE_ID, canonicalRoot: storageRoot });
    const containerRootId = text(container.rootId);
    if (!containerRootId) throw new Error("Managed storage root registration returned no identity");
    const relativeTarget = path.relative(storageRoot, materialRoot).replaceAll("\\", "/");
    const materialized = await scoped.fileMaterialize({
      operationId: `managed-remote-materialize:${manifest.materialId}`,
      workspaceId: WORKSPACE_ID,
      rootId: containerRootId,
      path: relativeTarget,
      sourceRoot: manifest.materialId,
    });
    if (materialized.status !== "materialized") throw new Error(`Managed material was not materialized: ${String(materialized.reason ?? "conflict")}`);
    const target = await scoped.fileRootRegister({ workspaceId: WORKSPACE_ID, executionWorkspaceId: WORKSPACE_ID, canonicalRoot: materialRoot });
    const rootId = text(target.rootId);
    if (!rootId) throw new Error("Managed material root registration returned no identity");
    await putRecord({
      recordId: materialRecordId(manifest.materialId),
      recordType: "managed.remote.material",
      state: "ready",
      payload: {
        id: digest(manifest.materialId), coordinatorHostId: manifest.coordinatorHostId,
        materialId: manifest.materialId, branchId, root: manifest.materialId,
        rootId, canonicalRoot: materialRoot,
        pathCount: manifest.entries.length, createdAt: now(),
      },
    });
    return { materialId: manifest.materialId, root: manifest.materialId, rootId, canonicalRoot: materialRoot, cwd: manifest.cwd ?? "", reused: false };
  };

  const admit = async (input: ManagedRemoteAdmissionRequest, principalId: string): Promise<ManagedRemoteAdmissionReceipt> => {
    if (!input.coordinatorHostId?.trim() || !input.workspaceId?.trim() || !input.attemptId?.trim()) throw new Error("Remote admission identity is required");
    const actualMachineId = `managed:${options.hostId}`;
    const receipt = await options.resources.admit(WORKSPACE_ID, "local", input.resources ?? {}, commitmentAttemptId(principalId, input));
    if (receipt.status === "confirmed" && receipt.commitmentId) {
      const scoped = await context();
      const recordId = admissionRecordId(principalId, input);
      const prior = await scoped.getRecord(WORKSPACE_ID, recordId);
      if (prior) {
        const payload = recordPayload(prior);
        if (text(payload.commitmentId) !== receipt.commitmentId || text(payload.machineId) !== actualMachineId) {
          throw new Error("Remote admission identity conflicts with its retained receipt");
        }
      } else {
        await putRecord({
          recordId,
          recordType: "managed.remote.admission",
          state: "confirmed",
          payload: {
            id: recordId.slice(ADMISSION_PREFIX.length), principalId, coordinatorHostId: input.coordinatorHostId,
            sourceWorkspaceId: input.workspaceId, machineId: actualMachineId, attemptId: input.attemptId,
            commitmentId: receipt.commitmentId, resources: input.resources ?? {}, confirmedAt: now(),
          },
        });
      }
    }
    return receipt;
  };

  const releaseAdmission = async (input: ManagedRemoteAdmissionRequest & { commitmentId: string; reason: string }, principalId: string): Promise<void> => {
    const scoped = await context();
    const recordId = admissionRecordId(principalId, input);
    const receipt = await scoped.getRecord(WORKSPACE_ID, recordId);
    const payload = receipt ? recordPayload(receipt) : {};
    if (!receipt || text(payload.principalId) !== principalId || text(payload.commitmentId) !== input.commitmentId
      || text(payload.coordinatorHostId) !== input.coordinatorHostId
      || text(payload.sourceWorkspaceId) !== input.workspaceId
      || text(payload.machineId) !== `managed:${options.hostId}`
      || text(payload.attemptId) !== input.attemptId) {
      throw new Error("Remote admission release does not match its retained receipt");
    }
    await options.resources.release(WORKSPACE_ID, input.commitmentId, input.reason || "coordinator released remote commitment");
    if (receipt.state !== "released") {
      await putRecord({
        recordId,
        recordType: "managed.remote.admission",
        state: "released",
        expectedRecordRevision: receipt.recordRevision,
        payload: { ...payload, releasedAt: now(), releaseReason: input.reason },
      });
    }
  };

  const getJob = async (principalId: string, coordinatorHostId: string, backendJobId: string): Promise<{ scoped: KernelScopedClient; record: KernelRecordResult; payload: Record<string, unknown> }> => {
    const scoped = await context();
    const record = await scoped.getRecord(WORKSPACE_ID, jobRecordId(principalId, coordinatorHostId, backendJobId));
    if (!record) throw new Error(`Unknown managed remote job: ${backendJobId}`);
    return { scoped, record, payload: recordPayload(record) };
  };

  const updateJob = async (record: KernelRecordResult, state: string, changes: Record<string, unknown>): Promise<KernelRecordResult> => {
    const payload = recordPayload(record);
    return putRecord({
      recordId: record.recordId,
      recordType: "managed.remote.job",
      state,
      expectedRecordRevision: record.recordRevision,
      payload: { ...payload, ...changes },
    });
  };

  const settleJob = async (record: KernelRecordResult, observation: ManagedRemoteJobObservation): Promise<void> => {
    if (observation.writerActive || observation.status === "running" || observation.status === "starting" || observation.status === "unknown") return;
    const payload = recordPayload(record);
    const commitmentId = text(payload.commitmentId);
    if (commitmentId && payload.commitmentReleased !== true) {
      try {
        await options.resources.release(WORKSPACE_ID, commitmentId, "managed remote process confirmed terminated");
        const fresh = await (await context()).getRecord(WORKSPACE_ID, record.recordId);
        if (fresh) await updateJob(fresh, observation.status, { commitmentReleased: true, commitmentReleasedAt: now() });
      } catch (error) { report(error); }
    }
  };

  const monitor = (principalId: string, coordinatorHostId: string, backendJobId: string): void => {
    const key = `${principalId}\0${coordinatorHostId}\0${backendJobId}`;
    if (monitors.has(key)) return;
    const running = (async () => {
      for (;;) {
        let job: Awaited<ReturnType<typeof getJob>>;
        try { job = await getJob(principalId, coordinatorHostId, backendJobId); } catch { return; }
        if (!ACTIVE_JOB_STATES.has(job.record.state)) return;
        const processId = text(job.payload.processId);
        if (!processId) return;
        try {
          const observation = observationOf(await job.scoped.processInspect({ workspaceId: WORKSPACE_ID, processId }) as unknown as Record<string, unknown>);
          if (!observation.writerActive && observation.status !== "running" && observation.status !== "starting" && observation.status !== "unknown") {
            await updateJob(job.record, observation.status, { endedAt: now(), exitCode: observation.exitCode, signal: observation.signal, reason: observation.reason });
            await settleJob(job.record, observation);
            return;
          }
        } catch (error) { report(error); }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })().finally(() => { monitors.delete(key); });
    monitors.set(key, running);
  };

  const submitJob = async (input: ManagedRemoteJobSubmit & { resources?: ExperimentResourceRequest }, principalId: string): Promise<ManagedRemoteJobReceipt> => {
    const coordinatorHostId = input.coordinatorHostId?.trim();
    const backendJobId = input.backendJobId?.trim();
    if (!coordinatorHostId || !backendJobId || !input.sourceWorkspaceId?.trim() || !input.attemptId?.trim() || !input.materialId?.trim() || !input.command?.trim()) {
      throw new Error("Managed remote job identity and command are required");
    }
    if (!Array.isArray(input.args) || !input.args.every((entry) => typeof entry === "string")
      || !Array.isArray(input.env) || !input.env.every((entry) => entry && typeof entry.name === "string" && typeof entry.value === "string")) {
      throw new Error("Managed remote job args/env are invalid");
    }
    const cwd = input.cwd === "" ? "" : normalizedRelative(input.cwd, "Managed remote job cwd");
    const requestedResources = input.resources ?? {};
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => TARGET_BASE_ENVIRONMENT.has(entry[0]) && typeof entry[1] === "string"));
    for (const entry of input.env) environment[entry.name] = entry.value;
    if (input.gpuAllocation) {
      // Target-confirmed device binding wins over caller environment input.
      environment[input.gpuAllocation.environment.name] = input.gpuAllocation.environment.value;
    }
    delete environment.NODE_CHANNEL_FD;
    const environmentEntries = Object.entries(environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right));
    const environmentDigest = digest(JSON.stringify(environmentEntries));
    const submissionDigest = digest(
      input.sourceWorkspaceId,
      input.materialId,
      cwd,
      input.command,
      JSON.stringify(input.args),
      JSON.stringify([...input.env].sort((left, right) => left.name.localeCompare(right.name))),
      JSON.stringify(Object.fromEntries(Object.entries(requestedResources).sort(([left], [right]) => left.localeCompare(right)))),
      JSON.stringify(input.gpuAllocation ?? null),
    );
    const scoped = await context();
    const material = await scoped.getRecord(WORKSPACE_ID, materialRecordId(input.materialId));
    const materialPayload = material ? recordPayload(material) : {};
    if (material?.state !== "ready" || text(materialPayload.materialId) !== input.materialId) throw new Error("Managed remote material is not ready");
    if (cwd) {
      const branchId = text(materialPayload.branchId);
      if (!branchId) throw new Error("Managed remote material has no branch identity");
      const branch = await scoped.readBranch({ branchId, paths: [cwd], includeEntries: true });
      if (!branch.entries.some((entry) => entry.path === cwd && entry.state.kind === "directory")) {
        throw new Error(`Managed remote cwd is not a captured directory: ${cwd}`);
      }
    }
    const recordId = jobRecordId(principalId, coordinatorHostId, backendJobId);
    let record = await scoped.getRecord(WORKSPACE_ID, recordId);
    if (record) {
      const payload = recordPayload(record);
      if (text(payload.submissionDigest) !== submissionDigest || text(payload.attemptId) !== input.attemptId
        || text(payload.sourceWorkspaceId) !== input.sourceWorkspaceId) {
        throw new Error("Managed remote job identity is already bound to another submission");
      }
      const processId = text(payload.processId);
      if (!processId) throw new Error("Managed remote job has no process identity");
      try {
        const snapshot = await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId });
        const observation = observationOf(snapshot as unknown as Record<string, unknown>);
        monitor(principalId, coordinatorHostId, backendJobId);
        return {
          backendJobId,
          observation,
          executionRootId: text(payload.attemptRootId) ?? "",
          executionCanonicalRoot: text(payload.attemptRoot) ?? "",
          executionCwd: text(payload.cwd) ?? "",
          ...(snapshot.kernelEpoch ? { kernelEpoch: snapshot.kernelEpoch } : {}),
          ...(snapshot.pid !== undefined && snapshot.pid !== null ? { pid: snapshot.pid } : {}),
        };
      } catch (error) {
        if (record.state !== "accepted") throw error;
        if (text(payload.environmentDigest) !== environmentDigest) {
          throw new Error("Managed remote target environment changed before the accepted job could start");
        }
      }
    }
    let commitmentId: string | undefined = record ? text(recordPayload(record).commitmentId) : undefined;
    if (!commitmentId && resourcesRequired(requestedResources)) {
      const admission = await admit({
        coordinatorHostId, workspaceId: input.sourceWorkspaceId, machineId: "local", attemptId: input.attemptId,
        resources: requestedResources,
      }, principalId);
      if (admission.status !== "confirmed" || !admission.commitmentId) throw new Error(admission.reason ?? "Managed remote resources are unavailable");
      const gpuRequested = (requestedResources.gpuCount ?? 0) > 0 || (requestedResources.gpuMemoryMb ?? 0) > 0;
      if (gpuRequested && (!admission.gpuAllocation || JSON.stringify(admission.gpuAllocation) !== JSON.stringify(input.gpuAllocation))) {
        await options.resources.release(WORKSPACE_ID, admission.commitmentId, "managed submit GPU allocation receipt mismatch").catch(report);
        throw new Error("Managed remote GPU allocation does not match the target-confirmed device binding");
      }
      commitmentId = admission.commitmentId;
    }
    const handshake = options.client.handshake ?? await options.client.start();
    const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
    const attemptRoot = path.join(storageRoot, "managed", "remote", "attempts", digest(principalId, coordinatorHostId, backendJobId));
    const processId = processIdFor(principalId, coordinatorHostId, backendJobId);
    if (!record) {
      try {
        record = await putRecord({
          recordId,
          recordType: "managed.remote.job",
          state: "accepted",
          payload: {
            id: recordId.slice(JOB_PREFIX.length), principalId, coordinatorHostId, sourceWorkspaceId: input.sourceWorkspaceId, attemptId: input.attemptId,
            backendJobId, processId, materialId: input.materialId, cwd, submissionDigest, environmentDigest,
            resources: requestedResources, ...(input.gpuAllocation ? { gpuAllocation: input.gpuAllocation } : {}), attemptRoot,
            ...(commitmentId ? { commitmentId } : {}), createdAt: now(),
          },
        });
      } catch (error) {
        const raced = await scoped.getRecord(WORKSPACE_ID, recordId);
        if (!raced || text(recordPayload(raced).submissionDigest) !== submissionDigest) throw error;
        record = raced;
      }
    }
    const container = await scoped.fileRootRegister({ workspaceId: WORKSPACE_ID, executionWorkspaceId: WORKSPACE_ID, canonicalRoot: storageRoot });
    const containerRootId = text(container.rootId);
    if (!containerRootId) throw new Error("Managed remote storage root has no identity");
    const relativeTarget = path.relative(storageRoot, attemptRoot).replaceAll("\\", "/");
    const materialized = await scoped.fileMaterialize({
      operationId: `managed-remote-attempt:${digest(principalId, coordinatorHostId, backendJobId)}`,
      workspaceId: WORKSPACE_ID,
      rootId: containerRootId,
      path: relativeTarget,
      sourceRoot: input.materialId,
    });
    if (materialized.status !== "materialized") throw new Error(`Managed remote attempt was not materialized: ${String(materialized.reason ?? "conflict")}`);
    const attemptRootRegistration = await scoped.fileRootRegister({ workspaceId: WORKSPACE_ID, executionWorkspaceId: WORKSPACE_ID, canonicalRoot: attemptRoot });
    const attemptRootId = text(attemptRootRegistration.rootId);
    if (!attemptRootId) throw new Error("Managed remote attempt root has no identity");
    if (!text(recordPayload(record).attemptRootId)) record = await updateJob(record, "accepted", { attemptRootId });
    const snapshot = await scoped.processSpawn({
      workspaceId: WORKSPACE_ID,
      processId,
      rootId: attemptRootId,
      cwd,
      command: input.command,
      args: input.args,
      env: environmentEntries.map(([name, value]) => ({ name, value })),
      mode: "pipe",
    });
    const observation = observationOf(snapshot as unknown as Record<string, unknown>);
    const current = await scoped.getRecord(WORKSPACE_ID, recordId);
    if (current && current.state === "accepted") {
      await updateJob(current, observation.status === "starting" ? "running" : observation.status, { startedAt: now() });
    }
    monitor(principalId, coordinatorHostId, backendJobId);
    const kernelEpoch = text((snapshot as unknown as Record<string, unknown>).kernelEpoch);
    const pid = number((snapshot as unknown as Record<string, unknown>).pid);
    return {
      backendJobId,
      observation,
      executionRootId: attemptRootId,
      executionCanonicalRoot: attemptRoot,
      executionCwd: cwd,
      ...(kernelEpoch ? { kernelEpoch } : {}),
      ...(pid !== undefined ? { pid } : {}),
    };
  };

  const inspectJob = async (principalId: string, coordinatorHostId: string, backendJobId: string): Promise<ManagedRemoteJobObservation> => {
    const { scoped, record, payload } = await getJob(principalId, coordinatorHostId, backendJobId);
    if (record.state === "released") return { status: "released", writerActive: false };
    const processId = text(payload.processId);
    if (!processId) throw new Error("Managed remote job has no process identity");
    const observation = observationOf(await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId }) as unknown as Record<string, unknown>);
    await settleJob(record, observation);
    const executionRootId = text(payload.attemptRootId);
    const executionCanonicalRoot = text(payload.attemptRoot);
    return {
      ...observation,
      ...(executionRootId ? { executionRootId } : {}),
      ...(executionCanonicalRoot ? { executionCanonicalRoot } : {}),
      executionCwd: text(payload.cwd) ?? "",
    };
  };

  const readJob = async (principalId: string, coordinatorHostId: string, backendJobId: string, cursor: number): Promise<ManagedRemoteReadReceipt> => {
    const { scoped, payload } = await getJob(principalId, coordinatorHostId, backendJobId);
    const processId = text(payload.processId);
    if (!processId) throw new Error("Managed remote job has no process identity");
    const result = await scoped.processRead({ workspaceId: WORKSPACE_ID, processId, cursor });
    const executionRootId = text(payload.attemptRootId);
    const executionCanonicalRoot = text(payload.attemptRoot);
    const observation = {
      ...observationOf(result.process as unknown as Record<string, unknown>),
      ...(executionRootId ? { executionRootId } : {}),
      ...(executionCanonicalRoot ? { executionCanonicalRoot } : {}),
      executionCwd: text(payload.cwd) ?? "",
    };
    return { chunks: result.chunks, nextCursor: result.nextCursor, endCursor: result.endCursor, observation };
  };

  const killJob = async (principalId: string, coordinatorHostId: string, backendJobId: string): Promise<ManagedRemoteJobObservation> => {
    const { scoped, record, payload } = await getJob(principalId, coordinatorHostId, backendJobId);
    const processId = text(payload.processId);
    if (!processId) throw new Error("Managed remote job has no process identity");
    if (ACTIVE_JOB_STATES.has(record.state)) await updateJob(record, "stopping", { cancelRequested: true });
    await scoped.processKill({ workspaceId: WORKSPACE_ID, processId, force: true });
    const snapshot = await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId });
    const observation = observationOf(snapshot as unknown as Record<string, unknown>);
    monitor(principalId, coordinatorHostId, backendJobId);
    return observation;
  };

  const releaseJob = async (principalId: string, coordinatorHostId: string, backendJobId: string): Promise<void> => {
    const { scoped, record, payload } = await getJob(principalId, coordinatorHostId, backendJobId);
    const processId = text(payload.processId);
    if (!processId) throw new Error("Managed remote job has no process identity");
    const observation = observationOf(await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId }) as unknown as Record<string, unknown>);
    if (observation.writerActive || observation.status === "starting" || observation.status === "running" || observation.status === "unknown") {
      throw new Error("Managed remote job is still active or unconfirmed");
    }
    await settleJob(record, observation);
    await scoped.processRelease({ workspaceId: WORKSPACE_ID, processId });
    const fresh = await scoped.getRecord(WORKSPACE_ID, record.recordId);
    if (fresh && fresh.state !== "released") await updateJob(fresh, "released", { releasedAt: now() });
  };

  const collectOutput = async (principalId: string, coordinatorHostId: string, backendJobId: string, requestedPath: string): Promise<ManagedRemoteOutputReceipt> => {
    const relativePath = normalizedRelative(requestedPath, "Managed remote output path");
    const { scoped, record, payload } = await getJob(principalId, coordinatorHostId, backendJobId);
    const priorId = outputRecordId(record.recordId, relativePath);
    const prior = await scoped.getRecord(WORKSPACE_ID, priorId);
    if (prior?.state === "available") {
      const value = recordPayload(prior);
      const objectHash = text(value.objectHash);
      const byteLength = number(value.byteLength);
      if (objectHash && byteLength !== undefined) return { outputId: priorId.slice(OUTPUT_PREFIX.length), path: relativePath, objectHash, byteLength };
    }
    const rootId = text(payload.attemptRootId);
    if (!rootId) throw new Error("Managed remote job has no output root identity");
    const captured = await scoped.fileCapture({
      operationId: `managed-remote-output:${digest(record.recordId, relativePath)}`,
      workspaceId: WORKSPACE_ID,
      rootId,
      path: relativePath,
      store: true,
    });
    const ownerId = text(captured.ownerId);
    if (!ownerId || typeof captured.stateJson !== "string") throw new Error("Managed remote output was not retained");
    const state = JSON.parse(captured.stateJson) as KernelBranchState;
    if (state.kind !== "regular-file") {
      await scoped.releaseBlob(ownerId).catch(() => undefined);
      throw new Error("Managed remote output is not a regular file");
    }
    await putRecord({
      recordId: priorId,
      recordType: "managed.remote.output",
      state: "available",
      payload: {
        id: priorId.slice(OUTPUT_PREFIX.length), jobId: record.recordId.slice(JOB_PREFIX.length),
        principalId, coordinatorHostId, backendJobId, path: relativePath,
        objectHash: state.objectHash, byteLength: state.byteLength, createdAt: now(),
      },
      references: [{ slot: "content", objectHash: state.objectHash }],
      ownerIds: [ownerId],
    });
    return { outputId: priorId.slice(OUTPUT_PREFIX.length), path: relativePath, objectHash: state.objectHash, byteLength: state.byteLength };
  };

  const readOutput = async (outputId: string, offset: number, length: number) => {
    const scoped = await context();
    const record = await scoped.getRecord(WORKSPACE_ID, `${OUTPUT_PREFIX}${outputId}`);
    const payload = record ? recordPayload(record) : {};
    const objectHash = text(payload.objectHash);
    if (record?.state !== "available" || !objectHash) throw new Error("Managed remote output is unavailable");
    return scoped.getBlob(objectHash, { recordId: record.recordId, slot: "content" }, { offset, length });
  };

  const shellSnapshot = async (scoped: KernelScopedClient, processId: string) => {
    let cursor = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let observation: ManagedRemoteJobObservation = { status: "unknown", writerActive: true };
    for (;;) {
      const page = await scoped.processRead({ workspaceId: WORKSPACE_ID, processId, cursor });
      for (const chunk of page.chunks) (chunk.channel === "stderr" ? stderr : stdout).push(Buffer.from(chunk.bytesBase64, "base64"));
      observation = observationOf(page.process as unknown as Record<string, unknown>);
      if (page.nextCursor >= page.endCursor) break;
      if (page.nextCursor <= cursor) throw new Error("Managed remote shell output cursor did not advance");
      cursor = page.nextCursor;
    }
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), observation };
  };

  const shellRecord = async (principalId: string, coordinatorHostId: string, processId: string) => {
    const scoped = await context();
    if (!processId.startsWith("managed-shell-")) throw new Error("Managed remote shell identity is invalid");
    const record = await scoped.getRecord(WORKSPACE_ID, `${SHELL_PREFIX}${processId.slice("managed-shell-".length)}`);
    const payload = record ? recordPayload(record) : {};
    if (!record || text(payload.principalId) !== principalId || text(payload.coordinatorHostId) !== coordinatorHostId || text(payload.processId) !== processId) {
      throw new Error("Managed remote shell belongs to another authenticated connection");
    }
    return { scoped, record, payload };
  };

  const shellScopeTails = new Map<string, Promise<unknown>>();
  const withShellScope = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const pending = (shellScopeTails.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    shellScopeTails.set(key, pending);
    try { return await pending; }
    finally { if (shellScopeTails.get(key) === pending) shellScopeTails.delete(key); }
  };
  const scopeRecordId = (principalId: string, coordinatorHostId: string, scopeId: string) =>
    `managed.remote.scope:${digest(principalId, coordinatorHostId, scopeId)}`;
  const shellExec = async (principalId: string, input: { coordinatorHostId: string; toolCallId: string; command: string; cwd?: string; waitMs: number; ownerScopeId?: string }, signal?: AbortSignal): Promise<ShellExecResult> => withShellScope(
    scopeRecordId(principalId, input.coordinatorHostId, input.ownerScopeId ?? input.toolCallId), async () => {
    signal?.throwIfAborted();
    const coordinatorHostId = input.coordinatorHostId.trim();
    const toolCallId = input.toolCallId.trim();
    const command = input.command.trim();
    if (!coordinatorHostId || !toolCallId || !command) throw new Error("Managed remote shell identity and command are required");
    const canonicalCwd = await canonicalizePathIdentity(input.cwd?.trim() || os.homedir());
    const scoped = await context();
    if (input.ownerScopeId) {
      const scope = await scoped.getRecord(WORKSPACE_ID, scopeRecordId(principalId, coordinatorHostId, input.ownerScopeId));
      if (scope?.state === "sleeping") throw new Error("The owning Bot is asleep");
    }
    const recordId = shellRecordId(principalId, coordinatorHostId, toolCallId);
    const processId = `managed-shell-${recordId.slice(SHELL_PREFIX.length)}`;
    let record = await scoped.getRecord(WORKSPACE_ID, recordId);
    if (record) {
      const payload = recordPayload(record);
      if (text(payload.command) !== command || text(payload.canonicalCwd) !== canonicalCwd) throw new Error("Remote shell tool call is already bound to another command or cwd");
      if ((text(payload.ownerScopeId) ?? null) !== (input.ownerScopeId ?? null)) throw new Error("Remote shell tool call belongs to another work owner");
    } else {
      signal?.throwIfAborted();
      record = await putRecord({
        recordId, recordType: "managed.remote.shell", state: "accepted",
        payload: { id: recordId.slice(SHELL_PREFIX.length), principalId, coordinatorHostId, toolCallId, processId, command, canonicalCwd,
          ...(input.ownerScopeId ? { ownerScopeId: input.ownerScopeId } : {}), createdAt: now() },
      });
    }
    signal?.throwIfAborted();
    const root = await scoped.fileRootRegister({ workspaceId: WORKSPACE_ID, executionWorkspaceId: WORKSPACE_ID, canonicalRoot: canonicalCwd });
    const rootId = text(root.rootId);
    if (!rootId) throw new Error("Managed remote shell cwd has no root identity");
    record = await putRecord({ recordId, recordType: "managed.remote.shell", state: "accepted",
      payload: { ...recordPayload(record), rootId }, expectedRecordRevision: record.recordRevision });
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const args = windows ? ["/d", "/s", "/c", command] : ["-lc", command];
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => TARGET_BASE_ENVIRONMENT.has(entry[0]) && typeof entry[1] === "string"));
    const startedAt = now();
    signal?.throwIfAborted();
    await scoped.processSpawn({
      workspaceId: WORKSPACE_ID, processId, rootId, cwd: "", command: executable, args,
      env: Object.entries(environment).map(([name, value]) => ({ name, value })), mode: "pipe",
    });
    const deadline = startedAt + Math.max(0, input.waitMs);
    let snapshot = await shellSnapshot(scoped, processId);
    while (snapshot.observation.writerActive && now() < deadline) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - now()))));
      snapshot = await shellSnapshot(scoped, processId);
    }
    signal?.throwIfAborted();
    if (!snapshot.observation.writerActive && snapshot.observation.status !== "unknown") {
      return {
        kind: "completed", exitCode: snapshot.observation.exitCode ?? null, durationMs: Math.max(0, now() - startedAt),
        cwd: canonicalCwd, stdout: snapshot.stdout, stderr: snapshot.stderr, handle: null, shown: null,
        toolCallId, executionId: processId,
      };
    }
    return { kind: "background", id: processId, waitedMs: Math.max(0, now() - startedAt), cwd: canonicalCwd, outputSoFar: snapshot.stdout, command, toolCallId, executionId: processId };
  });

  const setShellScopeSleeping = async (principalId: string, coordinatorHostId: string, scopeId: string, sleeping: boolean) => {
    const recordId = scopeRecordId(principalId, coordinatorHostId, scopeId);
    return withShellScope(recordId, async () => {
      const scoped = await context();
      const previous = await scoped.getRecord(WORKSPACE_ID, recordId);
      await putRecord({ recordId, recordType: "managed.remote.scope", state: sleeping ? "sleeping" : "awake",
        payload: { id: recordId.slice('managed.remote.scope:'.length), principalId, coordinatorHostId, scopeId }, ...(previous ? { expectedRecordRevision: previous.recordRevision } : {}) });
      if (!sleeping) return { sleeping };
      const failures: unknown[] = [];
      for (const record of await listRecords("managed.remote.shell")) {
        const payload = recordPayload(record);
        if (payload.principalId !== principalId || payload.coordinatorHostId !== coordinatorHostId || payload.ownerScopeId !== scopeId) continue;
        try {
          const processId = text(payload.processId)!;
          const rootId = text(payload.rootId);
          // Scope serialization means a missing process cannot start after this
          // scan. No root receipt means admission never reached process.spawn.
          if (!rootId) continue;
          let cursor: number | undefined;
          let found = false;
          do {
            const page = await scoped.processList({ workspaceId: WORKSPACE_ID, rootId, ...(cursor === undefined ? {} : { cursor }) });
            found ||= page.processes.some((process) => process.processId === processId);
            cursor = page.nextCursor ?? undefined;
          } while (!found && cursor !== undefined);
          if (!found) continue;
          const state = observationOf(await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId }) as unknown as Record<string, unknown>);
          if (!state.writerActive && state.status !== "unknown") continue;
          await scoped.processKill({ workspaceId: WORKSPACE_ID, processId, force: true });
          let stopped = await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId });
          // process.kill acknowledges the signal; the OS process tree may take
          // another turn to release its writers. Await that observed fact.
          while (stopped.writerActive) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            stopped = await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId });
          }
          if (observationOf(stopped as unknown as Record<string, unknown>).status === 'unknown') {
            throw new Error(`Remote process termination is unknown: ${processId}`);
          }
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Some remote processes could not be stopped");
      return { sleeping };
    });
  };

  const shellRead = async (principalId: string, coordinatorHostId: string, processId: string, offset: number, length: number, waitMs = 0, signal?: AbortSignal): Promise<ShellReadResult> => {
    signal?.throwIfAborted();
    const { scoped, payload } = await shellRecord(principalId, coordinatorHostId, processId);
    let snapshot = await shellSnapshot(scoped, processId);
    const initialLength = Buffer.byteLength(`${snapshot.stdout}${snapshot.stderr}`, "utf8");
    const deadline = now() + Math.max(0, waitMs);
    while (snapshot.observation.writerActive && now() < deadline && initialLength <= offset) {
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - now()))));
      snapshot = await shellSnapshot(scoped, processId);
      if (Buffer.byteLength(`${snapshot.stdout}${snapshot.stderr}`, "utf8") > offset) break;
    }
    signal?.throwIfAborted();
    const combined = `${snapshot.stdout}${snapshot.stderr ? `\n[stderr]\n${snapshot.stderr}` : ""}`;
    const slice = sliceUtf8ByBytes(combined, offset, length);
    const command = text(payload.command);
    return {
      ...slice,
      running: snapshot.observation.writerActive,
      cancelled: snapshot.observation.status === "cancelled",
      ...(snapshot.observation.exitCode === undefined || snapshot.observation.exitCode === null ? {} : { exitCode: snapshot.observation.exitCode }),
      executionId: processId,
      shellId: processId,
      ...(command ? { command } : {}),
    };
  };

  const shellWrite = async (principalId: string, coordinatorHostId: string, processId: string, inputText: string) => {
    const { scoped } = await shellRecord(principalId, coordinatorHostId, processId);
    const current = await scoped.processRead({ workspaceId: WORKSPACE_ID, processId, cursor: 0, maxBytes: 0 });
    const result = await scoped.processWrite({ workspaceId: WORKSPACE_ID, processId, sequence: current.inputSequence, bytesBase64: Buffer.from(inputText).toString("base64") });
    return { accepted: result.queued === true };
  };

  const shellKill = async (principalId: string, coordinatorHostId: string, processId: string) => {
    const { scoped } = await shellRecord(principalId, coordinatorHostId, processId);
    await scoped.processKill({ workspaceId: WORKSPACE_ID, processId, force: true });
    const result = await scoped.processInspect({ workspaceId: WORKSPACE_ID, processId });
    return { killed: result.writerActive === false && result.status !== 'unknown' };
  };

  const reconcile = async (): Promise<void> => {
    for (const record of await listRecords("managed.remote.job")) {
      if (!ACTIVE_JOB_STATES.has(record.state)) continue;
      const payload = recordPayload(record);
      const coordinatorHostId = text(payload.coordinatorHostId);
      const backendJobId = text(payload.backendJobId);
      const principalId = text(payload.principalId);
      if (principalId && coordinatorHostId && backendJobId) monitor(principalId, coordinatorHostId, backendJobId);
    }
  };

  return {
    hostId: options.hostId,
    identity, lifecycle, ownerForOutput, probeMaterial, putObject, commitMaterial,
    admit, releaseAdmission,
    submitJob, inspectJob, readJob, killJob, releaseJob,
    collectOutput, readOutput,
    shellExec, shellRead, shellWrite, shellKill, setShellScopeSleeping,
    reconcile,
  };
}

export type ManagedRemoteExecutionService = ReturnType<typeof createManagedRemoteExecutionService>;

export const requestBodyChunks = (request: Readable): AsyncIterable<Uint8Array> => (async function* () {
  for await (const chunk of request) yield typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
})();
