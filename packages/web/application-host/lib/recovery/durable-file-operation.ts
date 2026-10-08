import type { CapturedState, CaptureStateOptions, RecoveryFileStore, RecoveryIdentity, RecoveryState } from "./journal-files.js";
import type { RecoveryDurableOperationPort } from "./journal-engine.js";
import { parseRecoveryState, sameState } from "./journal-files.js";
import type { WorkingStateRootStore } from "../harness/working-state/types.js";

export interface DurableFileTarget {
  expected: RecoveryState;
  target: RecoveryState;
}

export interface DurableFileOperationSpec {
  id: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  targets: Record<string, DurableFileTarget>;
  /** Targets owned by a non-filesystem authority (currently Document Registry). */
  externalTargets?: Record<string, DurableFileTarget>;
  externalBindings?: Record<string, DurableExternalBinding>;
  conflictPaths: string[];
  diffStats: { files: number; insertions: number; deletions: number };
  executionId?: string;
  requireTurnBinding?: boolean;
  retryBinding?: DurableFileRetryBinding;
  /** Parent materialized directory when apply identity is not the owning workspace root. */
  applyCanonicalRoot?: string;
  /** Execution workspace that owns Documents/resource gate for applyCanonicalRoot. */
  applyExecutionWorkspaceId?: string;
}

export interface DurableExternalBinding {
  ownerId: string;
  ownerGeneration: number;
  ownerRegistrationId: string;
  documentInstanceId: string;
  baseRevision: string | null;
  beforeLocalEditRevision: number;
  beforeHash: string;
  afterLocalEditRevision?: number;
  afterHash?: string;
  encoding: string;
  bom: boolean;
  lineEnding: "lf" | "crlf" | "cr";
}

export interface DurableFileRetryBinding {
  branchId: string;
  parentStates: Record<string, RecoveryState>;
  childStates: Record<string, RecoveryState>;
  resultingParentStates: Record<string, RecoveryState>;
}

export interface DurableFileOperationResult {
  operationId: string;
  status: "applied" | "conflict" | "pending" | "compensated" | "needs-attention";
  appliedPaths: string[];
  conflictPaths: string[];
  compensatedPaths?: string[];
  needsAttentionPaths?: string[];
  diffStats: DurableFileOperationSpec["diffStats"];
  text: string;
}

export interface HostResourceOperation {
  resourceId: string;
  scope: "exact" | "subtree";
}

export interface HostResourceOperationGate {
  run<Result>(resources: readonly HostResourceOperation[], operation: () => Promise<Result>, options?: { signal?: AbortSignal }): Promise<Result>;
}

export interface HostFileResourceBackend {
  gateFor(identity: RecoveryIdentity): HostResourceOperationGate;
  captureDetailed(
    identity: RecoveryIdentity,
    inputPath: string,
    options?: CaptureStateOptions,
    operationId?: string,
  ): Promise<CapturedState & { ownerId?: string }>;
  applyStateDetailed(
    identity: RecoveryIdentity,
    relativePath: string,
    state: RecoveryState,
    options?: { expected?: RecoveryState; ownerId?: string; operationId?: string },
  ): Promise<{ status: "applied" | "conflict"; state: RecoveryState }>;
  writeBytes(
    identity: RecoveryIdentity,
    relativePath: string,
    bytes: Uint8Array,
    options?: { expected?: RecoveryState; mode?: number; operationId?: string },
  ): Promise<{ status: "applied" | "conflict"; state: RecoveryState }>;
  mkdir(identity: RecoveryIdentity, relativePath: string, recursive?: boolean): Promise<void>;
  remove(
    identity: RecoveryIdentity,
    relativePath: string,
    options?: { recursive?: boolean; force?: boolean; operationId?: string },
  ): Promise<void>;
  rename(
    identity: RecoveryIdentity,
    fromPath: string,
    toPath: string,
    options?: {
      targetMustBeMissing?: boolean;
      expectedFrom?: RecoveryState;
      expectedTo?: RecoveryState;
      operationId?: string;
    },
  ): Promise<"renamed" | "target-exists" | "conflict">;
  scanPaths(
    identity: RecoveryIdentity,
    relativePath?: string,
    scopes?: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<string[]>;
  measure(
    identity: RecoveryIdentity,
    relativePath?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ logicalBytes: number | null; allocatedBytes: number | null; unknown: boolean }>;
  materializeRoot(
    identity: RecoveryIdentity,
    relativePath: string,
    sourceRoot: string,
    options: { operationId: string; signal?: AbortSignal },
  ): Promise<{
    status: "materialized" | "conflict";
    reconciled: boolean;
    cow: { reflink: number; copy: number };
  }>;
}

export type ResolveDirectoryApplyContext = (directory: string, owningWorkspaceId?: string) => Promise<{
  workspaceId: string;
  resourceOperationGate: HostResourceOperationGate;
}>;

export interface DurableFileOperationContext {
  fileStore: RecoveryFileStore;
  fileResources?: HostFileResourceBackend;
  identity: RecoveryIdentity;
  resourceOperationGate: HostResourceOperationGate;
  root: string;
  resolveDirectoryApplyContext?: ResolveDirectoryApplyContext;
  durableRecoveryStore: RecoveryDurableOperationPort;
}

interface PersistedIntegrationData extends Record<string, unknown> {
  operationId: string;
  threadId: string;
  resultRevision: number | string;
  targets: Record<string, DurableFileTarget>;
  targetKinds: Record<string, "disk" | "surface" | "branch">;
  externalBindings: Record<string, DurableExternalBinding>;
  safety: Record<string, RecoveryState>;
  conflictPaths: string[];
  appliedPaths: string[];
  compensatedPaths: string[];
  needsAttentionPaths: string[];
  diffStats: DurableFileOperationSpec["diffStats"];
  failure?: string;
  executionId?: string;
  requireTurnBinding?: boolean;
  retryBinding?: DurableFileRetryBinding;
  applyCanonicalRoot?: string;
  applyExecutionWorkspaceId?: string;
  parentBranchId?: string;
  beforeWriteRevision?: number;
  afterWriteRevision?: number;
}

type KernelRecoveryOperation = Record<string, unknown>;

const kernelOperation = async (context: DurableFileOperationContext, operationId: string): Promise<KernelRecoveryOperation> => {
  const operation = await context.durableRecoveryStore.getOperation(context.identity.workspaceId, operationId);
  if (!operation) throw new Error(`Recovery operation not found: ${operationId}`);
  return operation;
};

const kernelOperationData = (operation: KernelRecoveryOperation): PersistedIntegrationData => (
  {
    ...((operation.data && typeof operation.data === "object" ? operation.data : {}) as PersistedIntegrationData),
    ...((operation.result && typeof operation.result === "object" ? operation.result : {}) as Partial<PersistedIntegrationData>),
  } as PersistedIntegrationData
);

const integrationTurnChanges = (data: PersistedIntegrationData): Record<string, { before: RecoveryState; after: RecoveryState }> => {
  const binding = data.retryBinding;
  const changes: Record<string, { before: RecoveryState; after: RecoveryState }> = {};
  for (const file of [...new Set(data.appliedPaths)].sort()) {
    const before = binding?.parentStates[file] ?? data.safety[file] ?? data.targets[file]?.expected;
    const after = binding?.resultingParentStates[file] ?? data.targets[file]?.target;
    if (!before || !after || sameState(before, after)) continue;
    changes[file] = { before: structuredClone(before), after: structuredClone(after) };
  }
  return changes;
};

const bindIntegrationTurn = async (
  durable: RecoveryDurableOperationPort,
  workspaceId: string,
  data: PersistedIntegrationData,
): Promise<boolean> => {
  if (!data.executionId || !data.requireTurnBinding) return true;
  if (!durable.recordIntegrationChanges) throw new Error("Rust recovery turn mutation writer is unavailable");
  return durable.recordIntegrationChanges({
    workspaceId,
    executionId: data.executionId,
    operationId: data.operationId,
    changes: integrationTurnChanges(data),
  });
};

const kernelFile = (operation: KernelRecoveryOperation, path: string): Record<string, unknown> => {
  const files = Array.isArray(operation.files) ? operation.files : [];
  const file = files.find((entry) => Boolean(entry) && typeof entry === "object" && (entry as Record<string, unknown>).path === path);
  if (!file || typeof file !== "object") throw new Error(`Recovery operation path not found: ${path}`);
  return file as Record<string, unknown>;
};

const kernelTransition = async (
  context: DurableFileOperationContext,
  operationId: string,
  path: string,
  phase: string,
  fields: { observedFingerprint?: string; expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {},
): Promise<KernelRecoveryOperation> => {
  const operation = await kernelOperation(context, operationId);
  const file = kernelFile(operation, path);
  const updated = await context.durableRecoveryStore!.updateOperationFile({
    operationId,
    workspaceId: context.identity.workspaceId,
    path,
    expectedRevision: Number(file.revision ?? 1),
    expectedPhase: String(file.phase ?? "pending"),
    phase,
    ...fields,
  });
  return { ...operation, revision: updated.revision ?? operation.revision, files: (Array.isArray(operation.files) ? operation.files : []).map((entry) => (
    entry && typeof entry === "object" && (entry as Record<string, unknown>).path === path
      ? { ...(entry as Record<string, unknown>), phase, revision: updated.revision }
      : entry
  )) };
};

const kernelComplete = async (
  context: DurableFileOperationContext,
  operationId: string,
  state: string,
  data?: Record<string, unknown>,
  failure?: string,
): Promise<KernelRecoveryOperation> => {
  const operation = await kernelOperation(context, operationId);
  return context.durableRecoveryStore!.completeOperation({
    operationId,
    workspaceId: context.identity.workspaceId,
    expectedRevision: Number(operation.revision ?? 1),
    state,
    ...(data ? { result: data } : {}),
    ...(failure ? { failure: { message: failure } } : {}),
  });
};

const kernelCompensateDisk = async (context: DurableFileOperationContext, operationId: string, data: PersistedIntegrationData): Promise<void> => {
  for (const file of data.appliedPaths ?? []) {
    if (data.targetKinds?.[file] !== "disk") continue;
    const target = data.targets?.[file]?.target;
    const safety = data.safety?.[file];
    if (!target || !safety) continue;
    await runPathOperation(context, file, "subtree", async () => {
      const current = (await capture(context, file, false)).state;
      if (sameState(current, safety)) {
        await kernelTransition(context, operationId, file, "safety-observed");
        if (!data.compensatedPaths.includes(file)) data.compensatedPaths.push(file);
        return;
      }
      if (!sameState(current, target)) {
        await kernelTransition(context, operationId, file, "needs-attention");
        if (!data.needsAttentionPaths.includes(file)) data.needsAttentionPaths.push(file);
        return;
      }
      await kernelTransition(context, operationId, file, "compensate-intent");
      await context.fileStore.applyState(context.identity, context.root, file, safety);
      const restored = (await capture(context, file, false)).state;
      if (!sameState(restored, safety)) throw new Error(`Compensation did not restore ${file}`);
      await kernelTransition(context, operationId, file, "safety-observed");
      if (!data.compensatedPaths.includes(file)) data.compensatedPaths.push(file);
    });
  }
};

const isBranchIntegration = (data: Pick<PersistedIntegrationData, "parentBranchId" | "targetKinds">): boolean => (
  typeof data.parentBranchId === "string" && data.parentBranchId.length > 0
  || Object.values(data.targetKinds ?? {}).some((kind) => kind === "branch")
);

const resolvePersistedApplyContext = async (
  context: DurableFileOperationContext,
  data: Pick<PersistedIntegrationData, "applyCanonicalRoot" | "applyExecutionWorkspaceId">,
): Promise<DurableFileOperationContext | "unresolved"> => {
  if (typeof data.applyCanonicalRoot !== "string" || data.applyCanonicalRoot.length === 0) return context;
  if (!context.resolveDirectoryApplyContext) return "unresolved";
  try {
    const resolved = await context.resolveDirectoryApplyContext(
      data.applyCanonicalRoot,
      context.identity.workspaceId,
    );
    if (
      typeof data.applyExecutionWorkspaceId === "string"
      && data.applyExecutionWorkspaceId.length > 0
      && data.applyExecutionWorkspaceId !== resolved.workspaceId
    ) {
      return "unresolved";
    }
    return {
      ...context,
      identity: {
        ...context.identity,
        canonicalRoot: data.applyCanonicalRoot,
      },
      resourceOperationGate: resolved.resourceOperationGate,
    };
  } catch {
    return "unresolved";
  }
};

const capture = (
  context: DurableFileOperationContext,
  file: string,
  store: boolean,
) => context.fileStore.captureState(context.identity, context.root, file, { store });

const runPathOperation = <Result>(
  context: DurableFileOperationContext,
  file: string,
  scope: HostResourceOperation["scope"],
  operation: () => Promise<Result>,
): Promise<Result> => context.resourceOperationGate.run([{ resourceId: file, scope }], operation);

/** Production path: persist intent and every file transition through the Rust recovery port. */
const applyKernelDurableFileOperation = async (
  context: DurableFileOperationContext,
  spec: DurableFileOperationSpec,
): Promise<DurableFileOperationResult> => {
  const durable = context.durableRecoveryStore;
  if (!durable) throw new Error("Rust recovery operation port is unavailable");
  if (spec.requireTurnBinding && !spec.executionId) throw new Error("Parent turn recovery binding is required for integration");
  if (spec.executionId) {
    if (!durable.listChanges) throw new Error("Rust recovery turn reader is unavailable");
    const selection = await durable.listChanges({ workspaceId: spec.workspaceId, executionId: spec.executionId });
    const binding = selection.turns.find((turn) => turn.executionId === spec.executionId);
    if (!binding) throw new Error("Parent turn recovery binding is unavailable for integration");
    if (spec.requireTurnBinding && binding.status !== "pending") {
      throw new Error(`Parent turn recovery binding is not active for integration (${binding.status})`);
    }
    if (spec.requireTurnBinding && !durable.recordIntegrationChanges) {
      throw new Error("Parent turn recovery mutation writer is unavailable for integration");
    }
  }
  const externalTargets = spec.externalTargets ?? {};
  const externalPaths = Object.keys(externalTargets).sort();
  const allTargets = { ...spec.targets, ...externalTargets };
  const targetKinds: Record<string, "disk" | "surface"> = Object.fromEntries([
    ...Object.keys(spec.targets).map((file) => [file, "disk" as const]),
    ...Object.keys(externalTargets).map((file) => [file, "surface" as const]),
  ]);
  const safety: Record<string, RecoveryState> = {};
  const drift: string[] = [];
  for (const [file, states] of Object.entries(spec.targets)) {
    const current = await capture(context, file, true);
    safety[file] = current.state;
    if (!sameState(current.state, states.expected)) drift.push(file);
  }
  for (const [file, states] of Object.entries(externalTargets)) safety[file] = states.expected;
  if (drift.length > 0) {
    return { operationId: spec.id, status: "conflict", appliedPaths: [], conflictPaths: [...new Set([...spec.conflictPaths, ...drift])], diffStats: spec.diffStats, text: `Parent workspace changed before integration: ${drift.join(", ")}` };
  }
  const data: PersistedIntegrationData = {
    operationId: spec.id, threadId: spec.threadId, resultRevision: spec.resultRevision,
    targets: allTargets, targetKinds, externalBindings: structuredClone(spec.externalBindings ?? {}), safety,
    conflictPaths: [...spec.conflictPaths], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: spec.diffStats,
    ...(spec.executionId ? { executionId: spec.executionId } : {}), ...(spec.requireTurnBinding ? { requireTurnBinding: true } : {}),
    ...(spec.retryBinding ? { retryBinding: structuredClone(spec.retryBinding) } : {}),
    ...(spec.applyCanonicalRoot ? { applyCanonicalRoot: spec.applyCanonicalRoot } : {}),
    ...(spec.applyExecutionWorkspaceId ? { applyExecutionWorkspaceId: spec.applyExecutionWorkspaceId } : {}),
  };
  const created = await durable.createOperation({ operationId: spec.id, workspaceId: spec.workspaceId, kind: "integration", state: "applying", data, targets: allTargets, surfacePaths: externalPaths });
  let operationRevision = Number(created.revision ?? 1);
  const phases = new Map<string, { revision: number; phase: string }>(
    (Array.isArray(created.files) ? created.files : []).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const file = value as Record<string, unknown>;
      return typeof file.path === "string"
        ? [[file.path, { revision: Number(file.revision ?? 1), phase: String(file.phase ?? "pending") }] as const]
        : [];
    }),
  );
  const transition = async (file: string, phase: string, extra: { expected?: RecoveryState; target?: RecoveryState; safety?: RecoveryState } = {}): Promise<void> => {
    const current = phases.get(file) ?? { revision: 1, phase: "pending" };
    const next = await durable.updateOperationFile({ operationId: spec.id, workspaceId: spec.workspaceId, path: file, expectedRevision: current.revision, expectedPhase: current.phase, phase, ...extra });
    phases.set(file, { revision: Number(next.revision ?? current.revision + 1), phase });
  };
  for (const [file, state] of Object.entries(safety)) await transition(file, targetKinds[file] === "surface" ? "external-intent" : "apply-intent", { safety: state });
  const compensateKernel = async (): Promise<void> => {
    for (const { path: file, states } of orderForStates(Object.entries(spec.targets).map(([path, states]) => ({ path, states })), (entry) => safety[entry.path]!)) {
      try {
        const current = (await capture(context, file, false)).state;
        if (sameState(current, safety[file]!)) continue;
        if (!sameState(current, states.target)) { data.needsAttentionPaths.push(file); await transition(file, "needs-attention"); continue; }
        await transition(file, "compensate-intent");
        await context.fileStore.applyState(context.identity, context.root, file, safety[file]!);
        const restored = (await capture(context, file, false)).state;
        if (!sameState(restored, safety[file]!)) throw new Error(`Compensation did not restore ${file}`);
        data.compensatedPaths.push(file);
        await transition(file, "safety-observed", { safety: safety[file]! });
      } catch { data.needsAttentionPaths.push(file); await transition(file, "needs-attention").catch(() => undefined); }
    }
  };
  try {
    for (const { path: file, states } of orderForStates(Object.entries(spec.targets).map(([path, states]) => ({ path, states })), (entry) => entry.states.target)) {
      await runPathOperation(context, file, "subtree", async () => {
        const current = (await capture(context, file, false)).state;
        if (!sameState(current, safety[file]!)) throw new Error(`Parent workspace changed during integration: ${file}`);
        await context.fileStore.applyState(context.identity, context.root, file, states.target);
        const observed = (await capture(context, file, false)).state;
        if (!sameState(observed, states.target)) throw new Error(`Integrated path did not match target: ${file}`);
        await transition(file, "target-observed", { target: states.target });
        data.appliedPaths.push(file);
      });
    }
  } catch (error) {
    data.failure = error instanceof Error ? error.message : String(error);
    await compensateKernel();
    const status = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
    await durable.completeOperation({ operationId: spec.id, workspaceId: spec.workspaceId, expectedRevision: operationRevision, state: status, result: data, failure: { message: data.failure } });
    return { operationId: spec.id, status, appliedPaths: [], conflictPaths: spec.conflictPaths, compensatedPaths: data.compensatedPaths, needsAttentionPaths: data.needsAttentionPaths, diffStats: spec.diffStats, text: `Integration failed (${data.failure}); ${status}.` };
  }
  const persistTerminalOrCompensate = async (state: "awaiting-surface" | "conflict" | "complete"): Promise<DurableFileOperationResult | null> => {
    if (state !== "awaiting-surface" && spec.requireTurnBinding && spec.executionId) {
      const awaiting = await durable.completeOperation({
        operationId: spec.id,
        workspaceId: spec.workspaceId,
        expectedRevision: operationRevision,
        state: "awaiting-turn-binding",
        result: data,
      });
      operationRevision = Number(awaiting.revision ?? operationRevision + 1);
      const bound = await bindIntegrationTurn(durable, spec.workspaceId, data);
      if (!bound) {
        throw new Error(`Parent turn recovery binding cannot accept integration ${spec.id}`);
      }
      // Once the turn checkpoint contains this merge, a lost terminal response
      // is retried from awaiting-turn-binding. Compensating disk state here
      // would contradict the already durable checkpoint change.
      await durable.completeOperation({
        operationId: spec.id,
        workspaceId: spec.workspaceId,
        expectedRevision: operationRevision,
        state,
        result: data,
      });
      return null;
    }
    try {
      await durable.completeOperation({ operationId: spec.id, workspaceId: spec.workspaceId, expectedRevision: operationRevision, state, result: data });
      return null;
    } catch (error) {
      data.failure = `Durable integration terminal commit failed: ${error instanceof Error ? error.message : String(error)}`;
      await compensateKernel();
      const compensationState = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
      try {
        await durable.completeOperation({
          operationId: spec.id, workspaceId: spec.workspaceId, expectedRevision: operationRevision,
          state: compensationState, result: data, failure: { message: data.failure },
        });
      } catch (persistError) {
        throw new Error(`Integration compensation status could not be persisted: ${persistError instanceof Error ? persistError.message : String(persistError)}`, { cause: error });
      }
      return {
        operationId: spec.id, status: compensationState, appliedPaths: [], conflictPaths: spec.conflictPaths,
        compensatedPaths: [...data.compensatedPaths], needsAttentionPaths: [...data.needsAttentionPaths],
        diffStats: spec.diffStats, text: `Integration terminal commit failed; ${compensationState}.`,
      };
    }
  };
  if (Object.keys(externalTargets).length > 0) {
    const compensated = await persistTerminalOrCompensate("awaiting-surface");
    if (compensated) return compensated;
    return { operationId: spec.id, status: "pending", appliedPaths: data.appliedPaths, conflictPaths: spec.conflictPaths, diffStats: spec.diffStats, text: `Integrated ${data.appliedPaths.length} disk path(s); waiting for ${Object.keys(externalTargets).length} editor path(s).` };
  }
  const status = spec.conflictPaths.length > 0 ? "conflict" : "complete";
  const compensated = await persistTerminalOrCompensate(status);
  if (compensated) return compensated;
  return { operationId: spec.id, status: status === "complete" ? "applied" : "conflict", appliedPaths: data.appliedPaths, conflictPaths: spec.conflictPaths, diffStats: spec.diffStats, text: status === "complete" ? `Integrated ${data.appliedPaths.length} path(s).` : `Integrated ${data.appliedPaths.length} path(s) with ${spec.conflictPaths.length} conflict(s).` };
};

const pathDepth = (file: string): number => file.split(/[\\/]/).length;
const orderForStates = <T extends { path: string }>(
  values: T[],
  stateFor: (value: T) => RecoveryState,
): T[] => [...values].sort((left, right) => {
  const a = stateFor(left);
  const b = stateFor(right);
  const group = (state: RecoveryState) => state.kind === "missing" ? 0 : state.kind === "directory" ? 1 : 2;
  const groupDiff = group(a) - group(b);
  if (groupDiff !== 0) return groupDiff;
  const depthDiff = pathDepth(left.path) - pathDepth(right.path);
  return a.kind === "missing" ? -depthDiff : depthDiff;
});

export const applyDurableFileOperation = async (
  context: DurableFileOperationContext,
  spec: DurableFileOperationSpec,
): Promise<DurableFileOperationResult> => applyKernelDurableFileOperation(context, spec);

export interface DurableIntegrationInspection {
  operationId: string;
  state: string;
  threadId: string;
  resultRevision: number | string;
  targets: Record<string, DurableFileTarget>;
  targetKinds: Record<string, "disk" | "surface" | "branch">;
  externalBindings: Record<string, DurableExternalBinding>;
  applyCanonicalRoot?: string;
  applyExecutionWorkspaceId?: string;
  parentBranchId?: string;
  beforeWriteRevision?: number;
  afterWriteRevision?: number;
  retryBinding?: DurableFileRetryBinding;
  appliedPaths: string[];
  compensatedPaths: string[];
  needsAttentionPaths: string[];
  conflictPaths: string[];
  diffStats: DurableFileOperationSpec["diffStats"];
  safety: Record<string, RecoveryState>;
}

export const inspectDurableIntegrationOperation = async (
  context: DurableFileOperationContext,
  operationId: string,
): Promise<DurableIntegrationInspection> => {
    const operation = await context.durableRecoveryStore.getOperation(context.identity.workspaceId, operationId);
    if (!operation) throw new Error(`Integration operation not found: ${operationId}`);
    const data = kernelOperationData(operation);
    return {
      operationId,
      state: String(operation.state ?? "unknown"),
      threadId: String(data.threadId ?? operation.threadId ?? ""),
      resultRevision: data.resultRevision ?? 0,
      targets: structuredClone(data.targets ?? {}),
      targetKinds: structuredClone(data.targetKinds ?? {}),
      externalBindings: structuredClone(data.externalBindings ?? {}),
      appliedPaths: [...(data.appliedPaths ?? [])],
      compensatedPaths: [...(data.compensatedPaths ?? [])],
      needsAttentionPaths: [...(data.needsAttentionPaths ?? [])],
      conflictPaths: [...(data.conflictPaths ?? [])],
      diffStats: structuredClone(data.diffStats ?? { files: 0, insertions: 0, deletions: 0 }),
      safety: structuredClone(data.safety ?? {}),
      ...(data.applyCanonicalRoot ? { applyCanonicalRoot: data.applyCanonicalRoot } : {}),
      ...(data.applyExecutionWorkspaceId ? { applyExecutionWorkspaceId: data.applyExecutionWorkspaceId } : {}),
      ...(data.parentBranchId ? { parentBranchId: data.parentBranchId } : {}),
      ...(data.beforeWriteRevision === undefined ? {} : { beforeWriteRevision: data.beforeWriteRevision }),
      ...(data.afterWriteRevision === undefined ? {} : { afterWriteRevision: data.afterWriteRevision }),
      ...(data.retryBinding ? { retryBinding: structuredClone(data.retryBinding) } : {}),
    };
};

export const markDurableExternalDispatched = async (
  context: DurableFileOperationContext,
  operationId: string,
  paths: readonly string[],
): Promise<void> => {
    const operation = await kernelOperation(context, operationId);
    const data = kernelOperationData(operation);
    if (String(operation.state) !== "awaiting-surface") throw new Error(`Integration ${operationId} is not waiting for a surface`);
    const expected = Object.entries(data.targetKinds ?? {}).filter(([, kind]) => kind === "surface").map(([file]) => file).sort();
    const supplied = [...new Set(paths)].sort();
    if (expected.length !== supplied.length || expected.some((file, index) => file !== supplied[index])) throw new Error(`Integration ${operationId} surface path set changed before dispatch`);
    for (const file of supplied) await kernelTransition(context, operationId, file, "external-dispatched");
    return;
};

export const markDurableExternalUndoDispatched = async (
  context: DurableFileOperationContext,
  operationId: string,
  paths: readonly string[],
): Promise<void> => {
    const operation = await kernelOperation(context, operationId);
    const state = String(operation.state);
    if (state !== "complete" && state !== "conflict" && state !== "undoing") throw new Error(`Integration ${operationId} cannot begin undo from state ${state}`);
    const data = kernelOperationData(operation);
    const expected = Object.entries(data.targetKinds ?? {}).filter(([, kind]) => kind === "surface").map(([file]) => file).sort();
    const supplied = [...new Set(paths)].sort();
    if (expected.length !== supplied.length || expected.some((file, index) => file !== supplied[index])) throw new Error(`Integration ${operationId} surface undo path set changed`);
    for (const file of supplied) await kernelTransition(context, operationId, file, "external-compensate-intent");
    await kernelComplete(context, operationId, "undoing", data);
    return;
};

/**
 * Persist the undo intent before touching either a virtual branch or a
 * materialized directory.  The operation row is the recovery authority; a
 * file phase alone cannot make a pure-disk undo discoverable after restart.
 */
export const markDurableIntegrationUndoing = async (
  context: DurableFileOperationContext,
  operationId: string,
  apply?: { applyCanonicalRoot?: string; applyExecutionWorkspaceId?: string },
): Promise<void> => {
    const operation = await kernelOperation(context, operationId);
    const data = kernelOperationData(operation);
    const state = String(operation.state);
    if (state !== "complete" && state !== "conflict" && state !== "undoing") {
      throw new Error(`Integration ${operationId} cannot begin undo from state ${state}`);
    }
    if (apply?.applyCanonicalRoot && data.applyCanonicalRoot && apply.applyCanonicalRoot !== data.applyCanonicalRoot) {
      throw new Error(`Integration ${operationId} undo execution directory changed`);
    }
    if (apply?.applyExecutionWorkspaceId && data.applyExecutionWorkspaceId
      && apply.applyExecutionWorkspaceId !== data.applyExecutionWorkspaceId) {
      throw new Error(`Integration ${operationId} undo execution workspace changed`);
    }
    const nextData = {
      ...data,
      ...(apply?.applyCanonicalRoot ? { applyCanonicalRoot: apply.applyCanonicalRoot } : {}),
      ...(apply?.applyExecutionWorkspaceId ? { applyExecutionWorkspaceId: apply.applyExecutionWorkspaceId } : {}),
    };
    if (state !== "undoing" || apply?.applyCanonicalRoot !== data.applyCanonicalRoot || apply?.applyExecutionWorkspaceId !== data.applyExecutionWorkspaceId) {
      await kernelComplete(context, operationId, "undoing", nextData);
    }
    return;
};

export const finalizeDurableIntegrationUndone = async (
  context: DurableFileOperationContext,
  operationId: string,
  compensatedPaths?: readonly string[],
): Promise<DurableFileOperationResult> => {
    const operation = await kernelOperation(context, operationId);
    const data = kernelOperationData(operation);
    const state = String(operation.state);
    if (state !== "complete" && state !== "conflict" && state !== "undoing" && state !== "undone") {
      throw new Error(`Integration ${operationId} cannot finish undo from state ${state}`);
    }
    const paths = [...new Set([...(data.compensatedPaths ?? []), ...(compensatedPaths ?? data.appliedPaths ?? [])])].sort();
    const completed = { ...data, compensatedPaths: paths, needsAttentionPaths: [] };
    delete completed.failure;
    if (state !== "undone") await kernelComplete(context, operationId, "undone", completed);
    return {
      operationId,
      status: "compensated",
      appliedPaths: [],
      conflictPaths: [...(data.conflictPaths ?? [])],
      compensatedPaths: paths,
      diffStats: data.diffStats,
      text: "Integration was undone.",
    };
};

export const markDurableIntegrationNeedsAttention = async (
  context: DurableFileOperationContext,
  operationId: string,
  paths: readonly string[],
  failure: string,
): Promise<DurableFileOperationResult> => {
    const operation = await kernelOperation(context, operationId);
    const data = kernelOperationData(operation);
    data.failure = failure;
    for (const file of paths) {
      await kernelTransition(context, operationId, file, "needs-attention");
      if (!data.needsAttentionPaths.includes(file)) data.needsAttentionPaths.push(file);
    }
    await kernelComplete(context, operationId, "needs-attention", data, failure);
    return {
      operationId,
      status: "needs-attention",
      appliedPaths: [...data.appliedPaths],
      conflictPaths: [...data.conflictPaths],
      needsAttentionPaths: [...data.needsAttentionPaths],
      diffStats: data.diffStats,
      text: `Integration requires attention (${failure}).`,
    };
};

export const finalizeDurableExternalOperation = async (
  context: DurableFileOperationContext,
  input: {
    operationId: string;
    results: Record<string, "applied" | "unchanged" | "needs-attention">;
    receipts?: Record<string, { afterLocalEditRevision: number; afterHash: string }>;
    failure?: string;
  },
): Promise<DurableFileOperationResult> => {
    const operation = await kernelOperation(context, input.operationId);
    const data = kernelOperationData(operation);
    if (String(operation.state) !== "awaiting-surface") throw new Error(`Integration ${input.operationId} is not waiting for a surface`);
    const externalPaths = Object.entries(data.targetKinds ?? {}).filter(([, kind]) => kind === "surface").map(([file]) => file).sort();
    const resultPaths = Object.keys(input.results).sort();
    if (externalPaths.length !== resultPaths.length || externalPaths.some((file, index) => file !== resultPaths[index])) throw new Error(`Integration ${input.operationId} surface result path set is incomplete`);
    for (const file of externalPaths) {
      const result = input.results[file]!;
      await kernelTransition(context, input.operationId, file, result === "applied" ? "external-target-observed" : result === "unchanged" ? "external-safety-observed" : "needs-attention");
      if (result === "applied" && !data.appliedPaths.includes(file)) data.appliedPaths.push(file);
      if (result === "applied") {
        const receipt = input.receipts?.[file];
        const binding = data.externalBindings?.[file];
        if (!receipt || !binding) throw new Error(`Integration ${input.operationId} surface receipt is missing: ${file}`);
        binding.afterLocalEditRevision = receipt.afterLocalEditRevision;
        binding.afterHash = receipt.afterHash;
      }
      if (result === "needs-attention" && !data.needsAttentionPaths.includes(file)) data.needsAttentionPaths.push(file);
    }
    const values = Object.values(input.results);
    if (values.every((result) => result === "applied")) {
      const status = data.conflictPaths.length > 0 ? "conflict" : "complete";
      if (data.requireTurnBinding && data.executionId) {
        await kernelComplete(context, input.operationId, "awaiting-turn-binding", data);
        const bound = await bindIntegrationTurn(context.durableRecoveryStore, context.identity.workspaceId, data);
        if (!bound) throw new Error(`Parent turn recovery binding cannot accept integration ${input.operationId}`);
      }
      await kernelComplete(context, input.operationId, status, data);
      return { operationId: input.operationId, status: status === "complete" ? "applied" : "conflict", appliedPaths: [...data.appliedPaths], conflictPaths: [...data.conflictPaths], diffStats: data.diffStats, text: status === "complete" ? `Integrated ${data.appliedPaths.length} path(s).` : `Integrated ${data.appliedPaths.length} path(s) with ${data.conflictPaths.length} conflict(s).` };
    }
    if (values.every((result) => result === "unchanged")) {
      data.failure = input.failure ?? "The editor surface rejected the integration";
      await kernelCompensateDisk(context, input.operationId, data);
      const status = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated";
      await kernelComplete(context, input.operationId, status, data, data.failure);
      return { operationId: input.operationId, status, appliedPaths: [], conflictPaths: [...data.conflictPaths], compensatedPaths: [...data.compensatedPaths], needsAttentionPaths: [...data.needsAttentionPaths], diffStats: data.diffStats, text: `Integration failed (${data.failure}); ${status}.` };
    }
    data.failure = input.failure ?? "The editor surface result could not be determined atomically";
    await kernelComplete(context, input.operationId, "needs-attention", data, data.failure);
    return { operationId: input.operationId, status: "needs-attention", appliedPaths: [...data.appliedPaths], conflictPaths: [...data.conflictPaths], needsAttentionPaths: [...data.needsAttentionPaths], diffStats: data.diffStats, text: `Integration requires attention (${data.failure}).` };
};

export const undoDurableIntegrationOperation = async (
  context: DurableFileOperationContext,
  input: { operationId: string; surfaceUndonePaths: readonly string[] },
): Promise<DurableFileOperationResult> => {
    const operation = await kernelOperation(context, input.operationId);
    const data = kernelOperationData(operation);
    const state = String(operation.state);
    if (state !== "complete" && state !== "conflict" && state !== "undoing") throw new Error(`Integration ${input.operationId} cannot be undone from state ${state}`);
    const surfacePaths = Object.entries(data.targetKinds ?? {}).filter(([, kind]) => kind === "surface").map(([file]) => file).sort();
    const undone = [...new Set(input.surfaceUndonePaths)].sort();
    if (surfacePaths.length !== undone.length || surfacePaths.some((file, index) => file !== undone[index])) throw new Error(`Integration ${input.operationId} surface undo is incomplete`);
    if (state !== "undoing") await kernelComplete(context, input.operationId, "undoing", data);
    for (const file of surfacePaths) await kernelTransition(context, input.operationId, file, "external-safety-observed");
    await kernelCompensateDisk(context, input.operationId, data);
    const terminal = data.needsAttentionPaths.length > 0 ? "needs-attention" : "undone";
    await kernelComplete(context, input.operationId, terminal, data, data.failure);
    return { operationId: input.operationId, status: terminal === "undone" ? "compensated" : "needs-attention", appliedPaths: [], conflictPaths: [...(data.conflictPaths ?? [])], compensatedPaths: [...(data.compensatedPaths ?? [])], needsAttentionPaths: [...(data.needsAttentionPaths ?? [])], diffStats: data.diffStats, text: terminal === "undone" ? "Integration was undone." : "Integration undo requires attention." };
};

/**
 * Undo a branch integration after its parent has switched to a materialized
 * execution directory.  The branch remains the owning object store, but the
 * directory is the current authority and must be changed under its Documents
 * resource gate.
 */
export const undoBranchIntegrationOnDirectory = async (
  context: DurableFileOperationContext,
  input: { operationId: string; applyExecutionWorkspaceId?: string; deferFinalization?: boolean },
): Promise<DurableFileOperationResult> => {
  const durableOperation = await kernelOperation(context, input.operationId);
  const data = kernelOperationData(durableOperation);
  const state = String(durableOperation.state);
  if (!isBranchIntegration(data) || !data.parentBranchId) {
    throw new Error(`Integration ${input.operationId} is not a branch integration`);
  }
  if (state !== "complete" && state !== "conflict" && state !== "undoing") {
    throw new Error(`Integration ${input.operationId} cannot be undone from state ${state}`);
  }
  if (state === "undoing" && data.applyCanonicalRoot
    && data.applyCanonicalRoot !== context.identity.canonicalRoot) {
    return await markDurableIntegrationNeedsAttention(
      context,
      input.operationId,
      data.appliedPaths,
      "Execution directory identity changed during integration undo",
    );
  }
  if (state === "undoing" && data.applyExecutionWorkspaceId && input.applyExecutionWorkspaceId
    && data.applyExecutionWorkspaceId !== input.applyExecutionWorkspaceId) {
    return await markDurableIntegrationNeedsAttention(
      context,
      input.operationId,
      data.appliedPaths,
      "Execution workspace identity changed during integration undo",
    );
  }
  const before = data.retryBinding?.parentStates ?? data.safety;
  const after = data.retryBinding?.resultingParentStates ?? Object.fromEntries(
    Object.entries(data.targets).map(([file, states]) => [file, states.target]),
  );
  const paths = [...new Set(data.appliedPaths.length > 0 ? data.appliedPaths : Object.keys(after))].sort();
  const missingState = (file: string): RecoveryState => before[file] ?? { kind: "missing" };
  const targetState = (file: string): RecoveryState => after[file] ?? { kind: "missing" };
  const captureCurrent = async (file: string): Promise<RecoveryState> => (
    (await capture(context, file, false)).state
  );
  const writeAttention = async (attentionPaths: readonly string[], failure: string): Promise<DurableFileOperationResult> => {
    const unique = [...new Set(attentionPaths)].sort();
    const applyExecutionWorkspaceId = input.applyExecutionWorkspaceId ?? data.applyExecutionWorkspaceId;
    const next: PersistedIntegrationData = {
      ...data,
      applyCanonicalRoot: context.identity.canonicalRoot,
      ...(applyExecutionWorkspaceId ? { applyExecutionWorkspaceId } : {}),
      failure,
      needsAttentionPaths: [...new Set([...data.needsAttentionPaths, ...unique])],
    };
    await markDurableIntegrationNeedsAttention(context, input.operationId, unique, failure);
    return {
      operationId: input.operationId,
      status: "needs-attention",
      appliedPaths: [],
      conflictPaths: [...data.conflictPaths],
      needsAttentionPaths: next.needsAttentionPaths,
      diffStats: data.diffStats,
      text: `Integration undo requires attention (${failure}).`,
    };
  };

  const initial = await Promise.all(paths.map(async (file) => ({
    file,
    state: await captureCurrent(file),
  })));
  const drift = initial.filter(({ file, state }) => (
    !sameState(state, missingState(file)) && !sameState(state, targetState(file))
  )).map(({ file }) => file);
  if (drift.length > 0) {
    return writeAttention(drift, "The materialized parent changed before integration undo");
  }
  // Persist the execution identity before deciding that the disk side is
  // already restored. The branch cache still has to be synchronized, so an
  // online caller may deliberately leave this row in `undoing` until both
  // authorities agree.
  await markDurableIntegrationUndoing(context, input.operationId, {
    applyCanonicalRoot: context.identity.canonicalRoot,
    ...(input.applyExecutionWorkspaceId ? { applyExecutionWorkspaceId: input.applyExecutionWorkspaceId } : {}),
  });
  // A crash after a prior conditional apply leaves the row in undoing.  If all
  // paths already match before, the disk apply was durable; the caller still
  // owns branch-cache synchronization and finalization.
  if (initial.every(({ file, state }) => sameState(state, missingState(file)))) {
    for (const file of paths) await kernelTransition(context, input.operationId, file, "safety-observed");
    return input.deferFinalization
      ? {
          operationId: input.operationId,
          status: "compensated",
          appliedPaths: [],
          conflictPaths: [...data.conflictPaths],
          compensatedPaths: paths,
          diffStats: data.diffStats,
          text: "Integration disk state was restored; branch synchronization is pending.",
        }
      : await finalizeDurableIntegrationUndone(context, input.operationId, paths);
  }

  // Write ahead of every directory mutation.  Do not catch apply failures:
  // the persisted undoing state lets startup inspect the real after/before
  // state and decide whether to retry or surface attention.
  let driftPath: string | undefined;
  try {
    await context.resourceOperationGate.run(
    paths.map((file) => ({ resourceId: file, scope: "subtree" as const })),
    async () => {
      for (const file of paths) {
        const current = await captureCurrent(file);
        if (sameState(current, missingState(file))) continue;
        if (!sameState(current, targetState(file))) {
          driftPath = file;
          throw Object.assign(new Error(`The materialized parent changed before integration undo: ${file}`), {
            code: "INTEGRATION_UNDO_DRIFT",
          });
        }
        await kernelTransition(context, input.operationId, file, "compensate-intent");
        await context.fileStore.applyState(context.identity, context.root, file, missingState(file));
        const observed = await captureCurrent(file);
        if (!sameState(observed, missingState(file))) {
          driftPath = file;
          throw Object.assign(new Error(`Integration undo did not restore ${file}`), {
            code: "INTEGRATION_UNDO_DRIFT",
          });
        }
        await kernelTransition(context, input.operationId, file, "safety-observed");
      }
    },
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "INTEGRATION_UNDO_DRIFT") {
      return await writeAttention(
        driftPath ? [driftPath] : paths,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  return input.deferFinalization
    ? {
        operationId: input.operationId,
        status: "compensated",
        appliedPaths: [],
        conflictPaths: [...data.conflictPaths],
        compensatedPaths: paths,
        diffStats: data.diffStats,
        text: "Integration disk state was restored; branch synchronization is pending.",
      }
    : await finalizeDurableIntegrationUndone(context, input.operationId, paths);
};

export const reconcileInterruptedIntegrationOperations = async (
  context: DurableFileOperationContext,
  options?: { operationId?: string },
): Promise<{ compensated: string[]; needsAttention: string[]; aborted: string[]; completed: string[] }> => {
    const result = { compensated: [] as string[], needsAttention: [] as string[], aborted: [] as string[], completed: [] as string[] };
    for (const summary of await context.durableRecoveryStore.listOperations(context.identity.workspaceId, "integration")) {
      const operationId = typeof summary.operationId === "string" ? summary.operationId : "";
      if (options?.operationId && operationId !== options.operationId) continue;
      if (!operationId || ["complete", "aborted", "compensated", "needs-attention", "conflict", "undone"].includes(String(summary.state))) continue;
      const operation = await kernelOperation(context, operationId);
      const data = kernelOperationData(operation);
      if (isBranchIntegration(data)) continue;
      const applyContext = await resolvePersistedApplyContext(context, data);
      if (applyContext === "unresolved") {
        await kernelComplete(context, operationId, "needs-attention", data, "Execution directory could not be resolved for directory apply");
        result.needsAttention.push(operationId);
        continue;
      }
      let unknown = false;
      const files = Array.isArray(operation.files) ? operation.files.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
      for (const file of files) {
        const path = String(file.path ?? "");
        const phase = String(file.phase ?? "pending");
        if (data.targetKinds?.[path] === "surface") {
          const awaitingTurn = String(operation.state) === "awaiting-turn-binding";
          const proven = awaitingTurn ? phase === "external-target-observed" : phase === "external-safety-observed";
          if (!proven) { await kernelTransition(context, operationId, path, "needs-attention"); unknown = true; }
          continue;
        }
        const parse = (key: string): RecoveryState | undefined => typeof file[key] === "string" ? parseRecoveryState(JSON.parse(String(file[key]))) : undefined;
        const target = parse("targetJson") ?? data.targets?.[path]?.target;
        const safety = parse("safetyJson") ?? data.safety?.[path];
        if (!target || !safety) { await kernelTransition(context, operationId, path, "needs-attention"); unknown = true; continue; }
        const current = (await capture(applyContext, path, false)).state;
        if (phase === "apply-intent" && sameState(current, target)) await kernelTransition(context, operationId, path, "target-observed");
        else if ((phase === "apply-intent" || phase === "target-observed" || phase === "compensate-intent") && sameState(current, safety)) await kernelTransition(context, operationId, path, "safety-observed");
        else if (!sameState(current, safety) && !sameState(current, target)) { await kernelTransition(context, operationId, path, "needs-attention"); unknown = true; }
      }
      const latest = await kernelOperation(context, operationId);
      const latestFiles = Array.isArray(latest.files) ? latest.files : [];
      const appliedPhases = new Set(["target-observed", "external-target-observed"]);
      const provenAppliedPaths = latestFiles
        .filter((entry) => entry && typeof entry === "object" && appliedPhases.has(String((entry as Record<string, unknown>).phase)))
        .map((entry) => String((entry as Record<string, unknown>).path ?? ""))
        .filter(Boolean);
      // operation_files is the crash-proof evidence. A crash may occur after
      // target observation but before result_json/appliedPaths is refreshed.
      data.appliedPaths = [...new Set([...(data.appliedPaths ?? []), ...provenAppliedPaths])].sort();
      const hasApplied = provenAppliedPaths.length > 0;
      const allApplied = latestFiles.length > 0 && latestFiles.every((entry) => entry && typeof entry === "object" && appliedPhases.has(String((entry as Record<string, unknown>).phase)));
      if (!unknown && data.requireTurnBinding && data.executionId && String(operation.state) !== "awaiting-turn-binding") {
        const selection = context.durableRecoveryStore.listChanges
          ? await context.durableRecoveryStore.listChanges({ workspaceId: context.identity.workspaceId, executionId: data.executionId })
          : { changes: [], turns: [] };
        const turn = selection.turns.find((entry) => entry.executionId === data.executionId);
        if (!turn) {
          await kernelComplete(context, operationId, "needs-attention", data, "Parent turn recovery binding is unavailable for interrupted integration");
          result.needsAttention.push(operationId);
          continue;
        }
        if (allApplied && turn.status === "pending") {
          data.appliedPaths = latestFiles.map((entry) => String((entry as Record<string, unknown>).path ?? "")).filter(Boolean);
          await kernelComplete(context, operationId, "awaiting-turn-binding", data);
          const bound = await bindIntegrationTurn(context.durableRecoveryStore, context.identity.workspaceId, data);
          if (!bound) {
            await kernelComplete(context, operationId, "needs-attention", data, "Parent turn recovery binding rejected interrupted integration");
            result.needsAttention.push(operationId);
          } else {
            const state = data.conflictPaths.length > 0 ? "conflict" : "complete";
            await kernelComplete(context, operationId, state, data);
            result.completed.push(operationId);
          }
          continue;
        }
      }
      if (unknown) { await kernelComplete(context, operationId, "needs-attention", data, "Integration restart could not prove disk state"); result.needsAttention.push(operationId); }
      else if (String(operation.state) === "awaiting-turn-binding") {
        const bound = await bindIntegrationTurn(context.durableRecoveryStore, context.identity.workspaceId, data);
        if (!bound) {
          await kernelComplete(context, operationId, "needs-attention", data, "Parent turn settled without the integration checkpoint change");
          result.needsAttention.push(operationId);
        } else {
          const state = data.conflictPaths.length > 0 ? "conflict" : "complete";
          await kernelComplete(context, operationId, state, data);
          result.completed.push(operationId);
        }
      }
      else if (String(operation.state) === "undoing") { await kernelCompensateDisk(applyContext, operationId, data); const state = data.needsAttentionPaths.length > 0 ? "needs-attention" : "undone"; await kernelComplete(context, operationId, state, data); (state === "undone" ? result.compensated : result.needsAttention).push(operationId); }
      else if (hasApplied) { await kernelCompensateDisk(applyContext, operationId, data); const state = data.needsAttentionPaths.length > 0 ? "needs-attention" : "compensated"; await kernelComplete(context, operationId, state, data); (state === "compensated" ? result.compensated : result.needsAttention).push(operationId); }
      else { await kernelComplete(context, operationId, "aborted", data); result.aborted.push(operationId); }
    }
    return result;
};

export interface BranchIntegrationView {
  getBranch(branchId: string): { writeRevision?: number } | null;
  effectiveState(branchId: string): Record<string, RecoveryState> | null;
  commitVirtualWrites?: (
    branchId: string,
    expectedWriteRevision: number,
    files: Record<string, RecoveryState>,
  ) => Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }>;
}

/** Reconcile a kernel-owned branch CAS whose terminal response was lost. */
export const reconcileInterruptedKernelBranchIntegrations = async (
  context: DurableFileOperationContext,
  store: WorkingStateRootStore,
): Promise<{ aborted: string[]; completed: string[]; needsAttention: string[] }> => {
  const result = { aborted: [] as string[], completed: [] as string[], needsAttention: [] as string[] };
  const durable = context.durableRecoveryStore;
  if (!durable) return result;
  for (const summary of await durable.listOperations(context.identity.workspaceId, "integration")) {
    const operationId = typeof summary.operationId === "string" ? summary.operationId : "";
    if (!operationId || ["complete", "conflict", "compensated", "aborted", "undone", "needs-attention"].includes(String(summary.state))) continue;
    const operation = await durable.getOperation(context.identity.workspaceId, operationId);
    if (!operation) continue;
    const data = kernelOperationData(operation) as Record<string, unknown>;
    const parentBranchId = typeof data.parentBranchId === "string" ? data.parentBranchId : "";
    if (!parentBranchId) continue;
    const branch = await store.getBranchRoot(parentBranchId);
    const before = data.beforeStates && typeof data.beforeStates === "object" ? data.beforeStates as Record<string, RecoveryState> : {};
    const after = data.afterStates && typeof data.afterStates === "object" ? data.afterStates as Record<string, RecoveryState> : {};
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    if (!branch || paths.length === 0) {
      await durable.completeOperation({ operationId, workspaceId: context.identity.workspaceId, expectedRevision: Number(operation.revision ?? 1), state: "needs-attention", result: data, failure: { message: "Parent branch is unavailable during kernel restart reconciliation" } });
      result.needsAttention.push(operationId);
      continue;
    }
    const current = await store.readStateSlice(parentBranchId, paths) ?? {};
    const matches = (expected: Record<string, RecoveryState>): boolean => paths.every((file) => sameState(current[file] ?? { kind: "missing" }, expected[file] ?? { kind: "missing" }));
    const beforeRevision = Number(data.beforeWriteRevision ?? 0);
    const afterRevision = Number(data.afterWriteRevision ?? beforeRevision);
    if (String(operation.state) === "undoing") {
      if (typeof data.applyCanonicalRoot === "string" && data.applyCanonicalRoot) {
        const applyContext = await resolvePersistedApplyContext(context, data as PersistedIntegrationData);
        if (applyContext === "unresolved") {
          await markDurableIntegrationNeedsAttention(context, operationId, paths, "Execution directory could not be resolved for branch integration undo");
          result.needsAttention.push(operationId);
          continue;
        }
        const disk = await undoBranchIntegrationOnDirectory(applyContext, { operationId, deferFinalization: true });
        if (disk.status !== "compensated") {
          result.needsAttention.push(operationId);
          continue;
        }
      }
      const latestBranch = await store.getBranchRoot(parentBranchId);
      const latest = latestBranch ? await store.readStateSlice(parentBranchId, paths) ?? {} : {};
      const latestMatches = (expected: Record<string, RecoveryState>): boolean => paths.every((file) => sameState(latest[file] ?? { kind: "missing" }, expected[file] ?? { kind: "missing" }));
      if (!latestBranch || (!latestMatches(before) && !latestMatches(after))) {
        await markDurableIntegrationNeedsAttention(context, operationId, paths, "Parent branch matches neither the before nor after undo states");
        result.needsAttention.push(operationId);
        continue;
      }
      if (latestMatches(after) && !latestMatches(before)) {
        const committed = await store.commitVirtualWrites(parentBranchId, latestBranch.writeRevision ?? 0, before);
        if (committed.status === "conflict") {
          await markDurableIntegrationNeedsAttention(context, operationId, paths, "Parent branch changed during integration undo reconciliation");
          result.needsAttention.push(operationId);
          continue;
        }
      }
      await finalizeDurableIntegrationUndone(context, operationId, paths);
      result.completed.push(operationId);
      continue;
    }
    const state = branch.writeRevision === afterRevision && matches(after)
      ? "complete"
      : branch.writeRevision === beforeRevision && matches(before)
        ? "aborted"
        : "needs-attention";
    await durable.completeOperation({ operationId, workspaceId: context.identity.workspaceId, expectedRevision: Number(operation.revision ?? 1), state, result: data, ...(state === "needs-attention" ? { failure: { message: "Parent branch matches neither before nor after integration state" } } : {}) });
    (state === "complete" ? result.completed : state === "aborted" ? result.aborted : result.needsAttention).push(operationId);
  }
  return result;
};
