import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  IntegrationApplyPhase,
  ThreadConflictResolution,
  ThreadIntegrationPreview,
} from "@varin/protocol";
import type {
  DocumentSurfaceOperationRequest,
  DocumentSurfaceOperationResult,
} from "../../documents/authority.js";
import type { IntegrationApplyResult, RecoveryState, ThreeWayMergePlan, ThreeWayPathPlan, WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./types.js";
import { buildThreeWayMergePlan } from "./three-way-merge.js";
import {
  classifyIntegrationTarget,
  dirtyResourceMap,
  parentRevisionOf,
  selectDirtyResource,
  type DirtyBufferInspectResource,
  type DirtyBufferInspectPublication,
} from "./integration-parents.js";
import {
  applyDurableFileOperation,
  cancelUndispatchedDurableExternalOperation,
  finalizeDurableIntegrationUndone,
  finalizeDurableExternalOperation,
  inspectDurableIntegrationOperation,
  markDurableExternalUndoDispatched,
  markDurableIntegrationNeedsAttention,
  markDurableIntegrationUndoing,
  markDurableExternalDispatched,
  reconcileInterruptedKernelBranchIntegrations,
  reconcileInterruptedIntegrationOperations,
  undoDurableIntegrationOperation,
  undoBranchIntegrationOnDirectory,
  type DurableExternalBinding,
  type DurableFileOperationContext,
  type DurableFileTarget,
  type HostResourceOperationGate,
  type IntegrationOperationBinding,
  type DurableIntegrationInspection,
} from "../../recovery/durable-file-operation.js";
import { sameState } from "../../recovery/journal-files.js";
import { inspectDocumentBytes } from "../../documents/inspect.js";

export class DirectoryApplyUnresolvedError extends Error {
  readonly directory: string;

  constructor(directory: string, options?: { cause?: unknown }) {
    super(`Execution workspace could not be resolved for directory apply: ${directory}`, options);
    this.name = "DirectoryApplyUnresolvedError";
    this.directory = directory;
  }
}

interface PlannedSurfaceTextEdit {
  resourceId: string;
  expectedLocalEditRevision: number;
  expectedBaseRevision: string | null;
  newText: string;
}

export interface IntegrationCoordinatorOptions {
  resolveDocumentWorkspaceId?: (owningScopeId: string) => Promise<string>;
  workingStates: WorkspaceWorkingStateRootAccess;
  inspectDirtyBuffers?: (workspaceId: string) => Promise<DirtyBufferInspectPublication[]>;
  beginDirtyStateBarrier?: (workspaceId: string, paths: string[]) => Promise<{
    release(): Promise<void>;
  }>;
  requestSurfaceOperation?: (
    request: DocumentSurfaceOperationRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<DocumentSurfaceOperationResult[]>;
  commitParentVirtualWrites?: (input: {
    workspaceId: string;
    branchId: string;
    files: Record<string, RecoveryState>;
    expectedWriteRevision: number;
    store: WorkingStateRootStore;
    sessionId?: string;
  }) => Promise<{ status: "committed"; writeRevision: number } | { status: "conflict"; writeRevision: number }>;
  holdParentVirtualWrite?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<{ status: "disk" } | { status: "virtual"; release(): void }>;
  resolveParentSessionId?: (workspaceId: string, branchId: string) => string | undefined;
  resolveDirectoryApplyContext?: (directory: string, owningWorkspaceId?: string) => Promise<{
    workspaceId: string;
    resourceOperationGate: HostResourceOperationGate;
  }>;
}

export interface IntegrationPlanInput {
  /** Stable selected-code receipt identity; retries must not replay against later recipient edits. */
  operationId?: string;
  baseStatesOverride?: Record<string, RecoveryState>;
  resolveBaseStates?: (store: WorkingStateRootStore) => Promise<Record<string, RecoveryState>>;
  /** Trusted Host has already acquired the receiving virtual-write ticket. */
  parentWriteHeld?: boolean;
  workspaceId: string;
  threadId: string;
  branchId: string;
  resultRevision: number;
  executionId?: string;
  requireTurnBinding?: boolean;
  operationBinding?: IntegrationOperationBinding;
  /** Trusted admitted source access; never a model-supplied authority. */
  scopedWorkingStates?: WorkspaceWorkingStateRootAccess;
  sourceOwner?: { ownerId: string; generation: number };
  expectedBindingFingerprint?: string;
  signal?: AbortSignal;
  resolutions?: ThreadConflictResolution[];
  /** Where the parent writable view lives when this Thread is nested. */
  parentAuthority?:
    | { kind: "workspace" }
    | { kind: "branch"; branchId: string; sessionId?: string }
    | { kind: "directory"; directory: string; workspaceId?: string };
}

export type IntegrationOperationReceipt = IntegrationApplyResult & {
  changedFiles: string[];
  receipt?: { kind: "integration"; workspaceId: string; operationId: string; revision: number; state: string };
  effect?: "none" | "confirmed" | "partial" | "unknown";
  executorStopped?: boolean;
  /** File contents include governed Documents buffers; Pi conversation checkpoints are excluded. */
  recoveryCoverage?: "files-only";
};

const terminalIntegrationStates = new Set(["complete", "conflict", "compensated", "aborted", "undone"]);

// The request promise is tied by Documents authority to its original owner,
// generation, registration and operation. A complete matching ACK proves stop
// independently of whether its hashes/revisions prove the intended effect.
const completeSurfaceAcknowledgement = (request: DocumentSurfaceOperationRequest, results: DocumentSurfaceOperationResult[]): boolean => {
  if (results.length !== request.targets.length) return false;
  const expected = new Map(request.targets.map(target => [target.resource.resourceId, target.documentInstanceId]));
  for (const result of results) {
    const document = expected.get(result.resource.resourceId);
    if (result.resource.workspaceId !== request.workspaceId || document === undefined || result.documentInstanceId !== document
      || (request.action === "apply" ? result.status !== "applied" && result.status !== "failed" : result.status !== "undone" && result.status !== "failed")) return false;
    expected.delete(result.resource.resourceId);
  }
  return expected.size === 0;
};

const mergeTarget = async (
  store: WorkingStateRootStore,
  pathPlan: ThreeWayPathPlan,
): Promise<RecoveryState | null> => {
  if (pathPlan.decision === "apply-child") {
    const child = pathPlan.childState;
    if (
      child.kind === "regular-file"
      && child.mode === undefined
      && pathPlan.parentState.kind === "regular-file"
      && pathPlan.parentState.mode !== undefined
    ) {
      return { ...child, mode: pathPlan.parentState.mode };
    }
    return child;
  }
  if (pathPlan.decision === "merge-clean" && pathPlan.mergedText !== undefined) {
    const bytes = Buffer.from(pathPlan.mergedText, "utf8");
    const object = await store.putObject(bytes);
    return {
      kind: "regular-file",
      objectHash: object.hash,
      byteLength: object.byteLength,
      ...(pathPlan.mergedMode !== undefined ? { mode: pathPlan.mergedMode } : {}),
    };
  }
  if (pathPlan.decision === "conflict" && pathPlan.conflictMarkers !== undefined) {
    const bytes = Buffer.from(pathPlan.conflictMarkers, "utf8");
    const object = await store.putObject(bytes);
    return {
      kind: "regular-file",
      objectHash: object.hash,
      byteLength: object.byteLength,
      ...(pathPlan.parentState.kind === "regular-file" && pathPlan.parentState.mode !== undefined
        ? { mode: pathPlan.parentState.mode }
        : {}),
    };
  }
  return null;
};

const previewFingerprint = (binding: ThreadIntegrationPreview["binding"], resultRevision: number): string => {
  const material = JSON.stringify({ resultRevision, binding });
  return createHash("sha256").update(material).digest("hex");
};

const decodeUtf8 = (bytes: Buffer | null): string | undefined => {
  if (bytes === null) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const contentHash = (content: string): string => `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`;
const normalizeEditorText = (content: string): string => content.replace(/\r\n|\r/gu, "\n");

const editorStateFrom = async (
  store: WorkingStateRootStore,
  state: RecoveryState,
): Promise<RecoveryState> => {
  if (state.kind !== "regular-file") return state;
  const bytes = await store.getObject(state.objectHash);
  if (bytes === null) return state;
  const inspected = inspectDocumentBytes(bytes);
  if (inspected.kind !== "text") return state;
  const object = await store.putObject(Buffer.from(normalizeEditorText(inspected.content), "utf8"));
  return {
    kind: "regular-file",
    objectHash: object.hash,
    byteLength: object.byteLength,
    ...(state.mode === undefined ? {} : { mode: state.mode }),
  };
};

const readableText = async (store: WorkingStateRootStore, state: RecoveryState): Promise<string | undefined> => {
  if (state.kind !== "regular-file") return undefined;
  const bytes = await store.getObject(state.objectHash);
  if (bytes === null) return undefined;
  const inspected = inspectDocumentBytes(bytes);
  return inspected.kind === "text" ? inspected.content : undefined;
};

const surfaceBinding = (resource: DirtyBufferInspectResource): ThreadIntegrationPreview["binding"][string] => ({
  target: "surface",
  revision: parentRevisionOf({ kind: "missing" }, resource),
  localEditRevision: resource.localEditRevision,
  baseRevision: resource.baseRevision,
  ownerId: resource.ownerId,
  ownerGeneration: resource.generation,
  ownerRegistrationId: resource.registrationId,
  documentInstanceId: resource.documentInstanceId,
  bufferHash: resource.bufferHash,
  encoding: resource.encoding,
  bom: resource.bom,
  lineEnding: resource.lineEnding,
});

const applyResolutions = (
  plan: ThreeWayMergePlan,
  resolutions: readonly ThreadConflictResolution[] | undefined,
  bindings: ThreadIntegrationPreview["binding"],
  expectedBindingFingerprint: string | undefined,
): ThreeWayMergePlan => {
  if (!resolutions?.length) return plan;
  const actualFingerprint = previewFingerprint(bindings, Number(plan.resultRevision));
  if (!expectedBindingFingerprint || expectedBindingFingerprint !== actualFingerprint) {
    throw new Error("Integration conflict resolutions are stale because the parent binding changed");
  }
  const byPath = new Map(resolutions.map((resolution) => [resolution.path, resolution]));
  const paths = plan.paths.map((pathPlan) => {
    const resolution = byPath.get(pathPlan.path);
    if (!resolution || pathPlan.decision !== "conflict") return pathPlan;
    const binding = bindings[pathPlan.path];
    if (!binding || resolution.expectedParentRevision !== binding.revision
      || (binding.target === "surface" && resolution.expectedLocalEditRevision !== binding.localEditRevision)) {
      throw new Error(`Integration resolution for ${pathPlan.path} is stale`);
    }
    if (resolution.choice === "parent") return { ...pathPlan, decision: "keep-parent" as const };
    if (resolution.choice === "child") return { ...pathPlan, decision: "apply-child" as const };
    if (resolution.choice === "base") return { ...pathPlan, decision: "apply-child" as const, childState: pathPlan.baseState };
    if (resolution.choice === "text" && resolution.text !== undefined) {
      const { conflictMarkers: _conflictMarkers, ...rest } = pathPlan;
      return { ...rest, decision: "merge-clean" as const, mergedText: resolution.text };
    }
    return pathPlan;
  });
  const conflictPaths = paths.filter((pathPlan) => pathPlan.decision === "conflict").map((pathPlan) => pathPlan.path);
  const appliedPaths = paths
    .filter((pathPlan) => pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean")
    .map((pathPlan) => pathPlan.path);
  return { ...plan, paths, conflictPaths, appliedPaths, clean: conflictPaths.length === 0 };
};

const projectPreview = (
  plan: ThreeWayMergePlan,
  targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>,
  bindings: ThreadIntegrationPreview["binding"],
  phases: Record<string, IntegrationApplyPhase>,
  readTexts: Record<string, { parent?: string; child?: string; baseline?: string }>,
): ThreadIntegrationPreview => {
  const unavailablePaths = plan.paths
    .filter((pathPlan) => targets[pathPlan.path] === "unavailable")
    .map((pathPlan) => pathPlan.path);
  const surfaceTargetPaths = plan.paths
    .filter((pathPlan) => targets[pathPlan.path] === "surface")
    .map((pathPlan) => pathPlan.path);
  const incompleteSurface = plan.paths.some((pathPlan) => (
    targets[pathPlan.path] === "surface" && readTexts[pathPlan.path]?.parent === undefined
  ));
  const valid = unavailablePaths.length === 0;
  return {
    operationId: plan.operationId,
    threadId: plan.threadId,
    resultRevision: Number(plan.resultRevision),
    bindingFingerprint: previewFingerprint(bindings, Number(plan.resultRevision)),
    valid,
    mergeReady: valid && plan.clean && !incompleteSurface && unavailablePaths.length === 0,
    binding: bindings,
    paths: plan.paths.map((pathPlan) => {
      const texts = readTexts[pathPlan.path];
      return {
        path: pathPlan.path,
        target: targets[pathPlan.path] ?? "disk",
        decision: targets[pathPlan.path] === "unavailable" ? "unavailable" : pathPlan.decision,
        phase: phases[pathPlan.path]
          ?? (pathPlan.decision === "identical" || pathPlan.decision === "keep-parent" ? "skipped-identical" : "pending"),
        isText: pathPlan.isText,
        ...(pathPlan.conflictReason ? { conflictReason: pathPlan.conflictReason } : {}),
        ...(texts?.parent !== undefined ? { parentText: texts.parent } : {}),
        ...(texts?.child !== undefined ? { childText: texts.child } : {}),
        ...(texts?.baseline !== undefined ? { baselineText: texts.baseline } : {}),
      };
    }),
    conflictPaths: plan.conflictPaths,
    surfaceTargetPaths,
    unavailablePaths,
    appliedPaths: plan.appliedPaths,
    ...(valid ? {} : { invalidReason: "Parent buffer or child result binding is incomplete" }),
  };
};

export class IntegrationCoordinator {
  private readonly workingStates: WorkspaceWorkingStateRootAccess;
  private readonly resolveDocumentWorkspaceId?: IntegrationCoordinatorOptions["resolveDocumentWorkspaceId"];
  private readonly inspectDirtyBuffers?: IntegrationCoordinatorOptions["inspectDirtyBuffers"];
  private readonly beginDirtyStateBarrier?: IntegrationCoordinatorOptions["beginDirtyStateBarrier"];
  private readonly requestSurfaceOperation?: IntegrationCoordinatorOptions["requestSurfaceOperation"];
  private readonly commitParentVirtualWrites?: IntegrationCoordinatorOptions["commitParentVirtualWrites"];
  private readonly holdParentVirtualWrite?: IntegrationCoordinatorOptions["holdParentVirtualWrite"];
  private readonly resolveParentSessionId?: IntegrationCoordinatorOptions["resolveParentSessionId"];
  private readonly resolveDirectoryApplyContext?: IntegrationCoordinatorOptions["resolveDirectoryApplyContext"];
  private readonly previewByThread = new Map<string, { workspaceId: string; preview: ThreadIntegrationPreview }>();
  private readonly merging = new Map<string, { identity: string; result: Promise<IntegrationOperationReceipt> }>();

  constructor(options: IntegrationCoordinatorOptions) {
    this.workingStates = options.workingStates;
    this.resolveDocumentWorkspaceId = options.resolveDocumentWorkspaceId;
    this.inspectDirtyBuffers = options.inspectDirtyBuffers;
    this.beginDirtyStateBarrier = options.beginDirtyStateBarrier;
    this.requestSurfaceOperation = options.requestSurfaceOperation;
    this.commitParentVirtualWrites = options.commitParentVirtualWrites;
    this.holdParentVirtualWrite = options.holdParentVirtualWrite;
    this.resolveParentSessionId = options.resolveParentSessionId;
    this.resolveDirectoryApplyContext = options.resolveDirectoryApplyContext;
  }

  private withWorkingStore<T>(
    workspaceId: string,
    purpose: string,
    operation: (store: WorkingStateRootStore, context: WorkingStateRootContext & { durableRecoveryStore: NonNullable<WorkingStateRootContext["durableRecoveryStore"]> }) => Promise<T> | T,
    mode: "exclusive" | "shared" = "shared",
    access: WorkspaceWorkingStateRootAccess = this.workingStates,
  ): Promise<T> {
    return access.withBranchStore(workspaceId, purpose, (store, context) => {
      if (!context?.durableRecoveryStore) throw new Error("Rust recovery operation port is unavailable");
      return operation(store, context as WorkingStateRootContext & { durableRecoveryStore: NonNullable<WorkingStateRootContext["durableRecoveryStore"]> });
    }, mode);
  }

  private validateOperationInput(input: IntegrationPlanInput): void {
    const binding = input.operationBinding;
    if (!binding) return;
    if (!input.scopedWorkingStates || input.executionId || input.requireTurnBinding
      || input.operationId !== `integration:${binding.operationId}`
      || input.workspaceId !== binding.result.workspaceId || input.branchId !== binding.result.branchId
      || input.threadId !== binding.childThreadId || input.resultRevision !== binding.result.resultRevision) {
      throw new Error("Integration does not match its admitted runtime Operation");
    }
    if (binding.target.mode === "fixed_branch" || input.parentAuthority?.kind !== "directory"
      || !input.parentAuthority.workspaceId
      || binding.target.workspace_id !== input.workspaceId) {
      throw new Error("Runtime Integration requires its explicit writable source target");
    }
    if (binding.target.mode === "live_root"
      && (binding.target.live_root?.canonicalRoot !== input.parentAuthority.directory
        || input.parentAuthority.workspaceId !== binding.target.execution_workspace_id)) {
      throw new Error("Integration target differs from its admitted live root");
    }
  }

  private admittedApplyContext(input: IntegrationPlanInput, context: DurableFileOperationContext): DurableFileOperationContext {
    if (!input.operationBinding) return context;
    const target = input.parentAuthority;
    if (target?.kind !== "directory" || context.identity.canonicalRoot !== target.directory || !target.workspaceId) {
      throw new Error("Integration recovery context differs from its admitted target");
    }
    return { ...context, resolveDirectoryApplyContext: async directory => {
      if (directory !== target.directory) throw new Error("Integration cannot resolve another target directory");
      return { workspaceId: target.workspaceId!, resourceOperationGate: context.resourceOperationGate };
    } };
  }

  private validateReceipt(input: IntegrationPlanInput, operation: DurableIntegrationInspection): void {
    if (operation.threadId !== input.threadId || Number(operation.resultRevision) !== input.resultRevision
      || operation.retryBinding?.branchId !== input.branchId
      || !isDeepStrictEqual(operation.operationBinding, input.operationBinding)) {
      throw new Error("Integration receipt belongs to another fixed source or invocation");
    }
    if (input.parentAuthority?.kind === "directory" && operation.applyCanonicalRoot !== input.parentAuthority.directory) {
      throw new Error("Integration receipt belongs to another target directory");
    }
    if (input.parentAuthority?.kind === "branch" && operation.parentBranchId !== input.parentAuthority.branchId) {
      throw new Error("Integration receipt belongs to another target branch");
    }
  }

  private receiptResult(workspaceId: string, operation: DurableIntegrationInspection): IntegrationOperationReceipt {
    const state = operation.state;
    const status = state === "complete" ? "applied" : state === "conflict" ? "conflict"
      : state === "compensated" || state === "undone" ? "compensated" : "needs-attention";
    const remaining = operation.appliedPaths.filter(file => !operation.compensatedPaths.includes(file));
    const effect = !terminalIntegrationStates.has(state) ? "unknown"
      : remaining.length === 0 ? operation.compensatedPaths.length > 0 ? "confirmed" : "none"
        : state === "complete" ? "confirmed" : "partial";
    return { operationId: operation.operationId, status, appliedPaths: operation.appliedPaths,
      conflictPaths: operation.conflictPaths, compensatedPaths: operation.compensatedPaths,
      needsAttentionPaths: operation.needsAttentionPaths, diffStats: operation.diffStats,
      changedFiles: Object.keys(operation.retryBinding?.childStates ?? {}).sort(),
      text: `Recorded integration ${operation.operationId}: ${state}`,
      ...(operation.operationBinding ? { receipt: { kind: "integration" as const, workspaceId,
        operationId: operation.operationId, revision: operation.revision, state }, effect,
        executorStopped: operation.executorStopped, recoveryCoverage: "files-only" as const } : {}) };
  }

  async inspectIntegration(input: IntegrationPlanInput & { operationId: string }): Promise<IntegrationOperationReceipt | null> {
    this.validateOperationInput(input);
    return this.withWorkingStore(input.workspaceId, "integration-receipt", async (_store, context) => {
      if (!await context.durableRecoveryStore.getOperation(input.workspaceId, input.operationId)) return null;
      const operation = await inspectDurableIntegrationOperation(context, input.operationId);
      this.validateReceipt(input, operation);
      return this.receiptResult(input.workspaceId, operation);
    }, "shared", input.scopedWorkingStates);
  }

  /** Only the original execution owner may establish this stop fact. */
  async recoverIntegration(input: IntegrationPlanInput & { operationId: string; executorStopped: true }): Promise<IntegrationOperationReceipt | null> {
    this.validateOperationInput(input);
    if (this.merging.has(`${input.workspaceId}\0${input.operationId}`)) throw new Error("Integration still has an active executor");
    return this.withWorkingStore(input.workspaceId, "integration-recover", async (store, context) => {
      if (!await context.durableRecoveryStore.getOperation(input.workspaceId, input.operationId)) return null;
      const original = await inspectDurableIntegrationOperation(context, input.operationId);
      this.validateReceipt(input, original);
      await reconcileInterruptedIntegrationOperations(this.admittedApplyContext(input, context), { operationId: input.operationId, executorStopped: true });
      await reconcileInterruptedKernelBranchIntegrations(context, store, { operationId: input.operationId });
      return this.receiptResult(input.workspaceId, await inspectDurableIntegrationOperation(context, input.operationId));
    }, "shared", input.scopedWorkingStates);
  }

  private async assertUnresolvedDisjoint(context: DurableFileOperationContext, canonicalRoot: string, paths: string[], exceptOperationId?: string): Promise<void> {
    const conflicts = await context.durableRecoveryStore.listOperationConflicts({ workspaceId: context.identity.workspaceId,
      canonicalRoot, paths, ...(exceptOperationId ? { exceptOperationId } : {}) });
    if (conflicts.length) {
      const pending = conflicts[0]!;
      throw new Error(`Integration ${pending.operationId} has unresolved effects on the requested resources (${pending.state})`);
    }
  }

  private reserveIntegration(input: IntegrationPlanInput, operationId: string): Promise<{ operation: DurableIntegrationInspection; created: boolean }> {
    // Resolve and acquire the physical path lease before entering the short
    // workspace metadata section. A busy alias must not block disjoint work.
    return this.withWorkingStore(input.workspaceId, "integration-reservation-target", async (store, context) => {
      const result = await store.getResult(input.branchId, input.resultRevision);
      if (!result || (input.operationBinding && result.root !== input.operationBinding.result.root)) {
        throw new Error("Integration fixed result is unavailable or changed");
      }
      const canonicalRoot = input.parentAuthority?.kind === "directory" ? input.parentAuthority.directory : context.identity.canonicalRoot;
      if (input.operationBinding && context.identity.canonicalRoot !== canonicalRoot) {
        throw new Error("Integration file context is not bound to its admitted target");
      }
      const applyContext = input.operationBinding ? this.admittedApplyContext(input, context)
        : input.parentAuthority?.kind === "directory" ? (await this.directoryApplyContext(context, input.parentAuthority)).context : context;
      return applyContext.resourceOperationGate.run(result.changedPaths.map(resourceId => ({ resourceId, scope: "subtree" as const })),
        () => this.withWorkingStore(input.workspaceId, "integration-reserve", async (_store, reservationContext) => {
          const existing = await reservationContext.durableRecoveryStore.getOperation(input.workspaceId, operationId);
          if (existing) {
            const receipt = await inspectDurableIntegrationOperation(reservationContext, operationId);
            this.validateReceipt(input, receipt);
            return { operation: receipt, created: false };
          }
          await this.assertUnresolvedDisjoint(reservationContext, canonicalRoot, result.changedPaths);
          const data = { operationId, threadId: input.threadId, resultRevision: input.resultRevision,
            executorStopped: false, effect: "none",
            targets: {}, targetKinds: {}, externalBindings: {}, safety: {}, appliedPaths: [], conflictPaths: [], compensatedPaths: [], needsAttentionPaths: [],
            diffStats: result.diffStats, reservedResources: { canonicalRoot, paths: result.changedPaths },
            retryBinding: { branchId: input.branchId, parentStates: {}, childStates: result.pathStates, resultingParentStates: {} },
            ...(input.parentAuthority?.kind === "directory" ? { applyCanonicalRoot: canonicalRoot,
              applyExecutionWorkspaceId: input.parentAuthority.workspaceId } : {}),
            ...(input.operationBinding ? { operationBinding: input.operationBinding } : {}) };
          await reservationContext.durableRecoveryStore.createOperation({ operationId, workspaceId: input.workspaceId, kind: "integration", state: "planned", data,
            targets: Object.fromEntries(result.changedPaths.map(file => [file, {}])),
            ...(input.operationBinding ? { threadId: input.operationBinding.parentThreadId, runId: input.operationBinding.parentRunId } : {}) });
          return { operation: await inspectDurableIntegrationOperation(reservationContext, operationId), created: true };
        }, "exclusive", input.scopedWorkingStates), input.signal ? { signal: input.signal } : {});
    }, "shared", input.scopedWorkingStates);
  }

  private documentWorkspace(input: { workspaceId: string; parentAuthority?: IntegrationPlanInput["parentAuthority"] }): Promise<string> {
    return input.parentAuthority?.kind === "directory" && input.parentAuthority.workspaceId
      ? Promise.resolve(input.parentAuthority.workspaceId)
      : this.resolveDocumentWorkspaceId?.(input.workspaceId) ?? Promise.resolve(input.workspaceId);
  }

  invalidateThread(workspaceId: string, threadId: string): void {
    this.previewByThread.delete(this.previewKey(workspaceId, threadId));
  }

  private async directoryApplyContext(
    context: DurableFileOperationContext,
    parentAuthority: { kind: "directory"; directory: string; workspaceId?: string },
  ): Promise<{ context: DurableFileOperationContext; executionWorkspaceId: string }> {
    if (!this.resolveDirectoryApplyContext) {
      throw new DirectoryApplyUnresolvedError(parentAuthority.directory);
    }
    try {
      const resolved = await this.resolveDirectoryApplyContext(
        parentAuthority.directory,
        context.identity.workspaceId,
      );
      return {
        executionWorkspaceId: resolved.workspaceId,
        context: {
          ...context,
          identity: {
            ...context.identity,
            canonicalRoot: parentAuthority.directory,
          },
          resourceOperationGate: resolved.resourceOperationGate,
        },
      };
    } catch (error) {
      if (error instanceof DirectoryApplyUnresolvedError) throw error;
      throw new DirectoryApplyUnresolvedError(parentAuthority.directory, { cause: error });
    }
  }

  private sameParentSlice(
    current: Record<string, RecoveryState>,
    expected: Record<string, RecoveryState>,
  ): boolean {
    return Object.keys(expected).every((file) => sameState(current[file] ?? { kind: "missing" }, expected[file]!));
  }

  private async reusableTerminalIntegration(
    store: WorkingStateRootStore,
    context: WorkingStateRootContext & { durableRecoveryStore: NonNullable<WorkingStateRootContext["durableRecoveryStore"]> },
    input: IntegrationPlanInput,
  ): Promise<(IntegrationApplyResult & { changedFiles: string[] }) | null> {
    if (input.requireTurnBinding) return null;
    const parentAuthority = input.parentAuthority ?? { kind: "workspace" as const };
    const summaries = await context.durableRecoveryStore.listOperations(input.workspaceId, "integration");
    for (const summary of [...summaries].reverse()) {
      const state = String(summary.state ?? "");
      if (state !== "complete" && state !== "conflict") continue;
      const operationId = typeof summary.operationId === "string" ? summary.operationId : "";
      if (!operationId) continue;
      const operation = await inspectDurableIntegrationOperation(context as DurableFileOperationContext, operationId);
      const binding = operation.retryBinding;
      if (!binding
        || operation.threadId !== input.threadId
        || Number(operation.resultRevision) !== input.resultRevision
        || binding.branchId !== input.branchId
        || Object.values(operation.targetKinds).some((kind) => kind === "surface")) continue;
      const expected = binding.resultingParentStates;
      const paths = Object.keys(expected).sort();
      let current: Record<string, RecoveryState>;
      if (parentAuthority.kind === "branch") {
        if (operation.parentBranchId !== parentAuthority.branchId) continue;
        current = await store.readStateSlice(parentAuthority.branchId, paths) ?? {};
      } else {
        if (operation.parentBranchId) continue;
        let applyContext: DurableFileOperationContext = context as DurableFileOperationContext;
        if (parentAuthority.kind === "directory") {
          if (operation.applyCanonicalRoot !== parentAuthority.directory) continue;
          try {
            applyContext = (await this.directoryApplyContext(context as DurableFileOperationContext, parentAuthority)).context;
          } catch {
            continue;
          }
        } else if (operation.applyCanonicalRoot) {
          continue;
        }
        current = {};
        for (const file of paths) {
          current[file] = (await applyContext.fileStore.captureState(
            applyContext.identity, applyContext.root, file, { store: false },
          )).state;
        }
      }
      if (!this.sameParentSlice(current, expected)) continue;
      return {
        operationId,
        status: state === "complete" ? "applied" : "conflict",
        appliedPaths: [],
        conflictPaths: [...operation.conflictPaths],
        compensatedPaths: [...operation.compensatedPaths],
        needsAttentionPaths: [...operation.needsAttentionPaths],
        diffStats: operation.diffStats,
        changedFiles: Object.keys(binding.childStates).sort(),
        text: `Reused durable ${state} integration ${operationId}; parent state already matches its recorded result.`,
      };
    }
    return null;
  }

  private previewKey(workspaceId: string, threadId: string): string {
    return `${workspaceId}\0${threadId}`;
  }

  latestPreview(workspaceId: string, threadId: string): ThreadIntegrationPreview | undefined {
    return this.previewByThread.get(this.previewKey(workspaceId, threadId))?.preview;
  }

  invalidateWorkspace(workspaceId: string, resourceIds?: readonly string[]): ThreadIntegrationPreview[] {
    const resources = resourceIds ? new Set(resourceIds) : null;
    const invalidated: ThreadIntegrationPreview[] = [];
    for (const [key, entry] of this.previewByThread) {
      if (!entry.preview.valid
        || entry.workspaceId !== workspaceId
        || (resources && !Object.keys(entry.preview.binding).some((path) => resources.has(path)))) continue;
      const preview = {
        ...entry.preview,
        valid: false,
        mergeReady: false,
        invalidReason: "Parent document state changed after this preview",
      };
      this.previewByThread.set(key, { workspaceId, preview });
      invalidated.push(preview);
    }
    return invalidated;
  }

  previewMatches(workspaceId: string, threadId: string, resultRevision: number, binding: ThreadIntegrationPreview["binding"]): boolean {
    const current = this.previewByThread.get(this.previewKey(workspaceId, threadId))?.preview;
    if (!current) return false;
    return current.valid
      && current.resultRevision === resultRevision
      && previewFingerprint(current.binding, current.resultRevision) === previewFingerprint(binding, resultRevision);
  }

  async previewResult(input: IntegrationPlanInput): Promise<ThreadIntegrationPreview> {
    const planned = await this.plan(input);
    this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview: planned.preview });
    return planned.preview;
  }

  private async holdParentBranchWrite(
    parentAuthority: IntegrationPlanInput["parentAuthority"],
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (parentAuthority?.kind !== "branch" || !parentAuthority.sessionId || !this.holdParentVirtualWrite) {
      return () => undefined;
    }
    const held = await this.holdParentVirtualWrite(parentAuthority.sessionId, signal);
    if (held.status === "disk") {
      throw new Error("Parent working branch is no longer virtual");
    }
    return () => held.release();
  }

  mergeResult(input: IntegrationPlanInput): Promise<IntegrationOperationReceipt> {
    this.validateOperationInput(input);
    const identity = JSON.stringify({ workspaceId: input.workspaceId, threadId: input.threadId, branchId: input.branchId,
      revision: input.resultRevision, parent: input.parentAuthority, binding: input.operationBinding,
      resolutions: input.resolutions, fingerprint: input.expectedBindingFingerprint });
    const key = input.operationId ? `${input.workspaceId}\0${input.operationId}` : undefined;
    const existing = key ? this.merging.get(key) : undefined;
    if (existing) {
      if (existing.identity !== identity) return Promise.reject(new Error("Integration Operation was retried with different inputs"));
      return existing.result;
    }
    const result = this.mergeResultOnce(input);
    if (key) {
      this.merging.set(key, { identity, result });
      void result.finally(() => { if (this.merging.get(key)?.result === result) this.merging.delete(key); }).catch(() => undefined);
    }
    return result;
  }

  private async mergeResultOnce(input: IntegrationPlanInput): Promise<IntegrationOperationReceipt> {
    const releaseParentWrite = input.parentWriteHeld ? () => undefined : await this.holdParentBranchWrite(input.parentAuthority, input.signal);
    let reservedId: string | undefined;
    try {
    const result = await this.withWorkingStore<IntegrationOperationReceipt>(input.workspaceId, "thread-result-integration", async (store, context) => {
      if (input.requireTurnBinding && !input.executionId) {
        throw new Error("Parent turn recovery binding is required for integration");
      }
      if (input.requireTurnBinding && input.executionId) {
        const changes = await context.durableRecoveryStore.listChanges?.({ workspaceId: input.workspaceId, executionId: input.executionId });
        if (!changes?.turns.some(turn => turn.executionId === input.executionId && turn.status === "pending")) {
          throw new Error("Parent turn recovery binding is unavailable for integration");
        }
      }
      if (input.operationId) {
        const receipt = await context.durableRecoveryStore.getOperation(input.workspaceId, input.operationId);
        if (receipt) {
          const operation = await inspectDurableIntegrationOperation(context, input.operationId);
          this.validateReceipt(input, operation);
          return this.receiptResult(input.workspaceId, operation);
        }
      }
      const reusable = input.operationBinding ? null : await this.reusableTerminalIntegration(store, context, input);
      if (reusable) return reusable;
      const operationId = input.operationId ?? `integration-${randomUUID()}`;
      if (input.parentAuthority?.kind !== "branch") {
        const reservation = await this.reserveIntegration(input, operationId);
        if (!reservation.created) return this.receiptResult(input.workspaceId, reservation.operation);
        reservedId = operationId;
      }
      const planned = await this.planFrom(store, context, input);
      if (input.expectedBindingFingerprint
        && input.expectedBindingFingerprint !== planned.preview.bindingFingerprint) {
        throw new Error("Integration preview is stale because the parent binding changed");
      }
      planned.plan = { ...planned.plan, operationId };
      planned.preview = { ...planned.preview, operationId };
      this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview: planned.preview });
      const pendingSurface = planned.preview.surfaceTargetPaths.filter((path) => (
        planned.plan.paths.some((pathPlan) => (
          pathPlan.path === path
          && (pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean")
        ))
        && !planned.surfaceEdits.some((edit) => edit.resourceId === path)
      ));
      const conflictPaths = [...new Set([
        ...planned.plan.conflictPaths,
        ...pendingSurface,
        ...planned.preview.unavailablePaths,
      ])].sort();
      const externalTargets: Record<string, DurableFileTarget> = {};
      const externalBindings: Record<string, DurableExternalBinding> = {};
      for (const edit of planned.surfaceEdits) {
        const pathPlan = planned.plan.paths.find((entry) => entry.path === edit.resourceId);
        if (!pathPlan) continue;
        const target = await mergeTarget(store, pathPlan);
        if (target) {
          externalTargets[edit.resourceId] = { expected: pathPlan.parentState, target };
          const binding = planned.preview.binding[edit.resourceId]!;
          externalBindings[edit.resourceId] = {
            ownerId: binding.ownerId!,
            ownerGeneration: binding.ownerGeneration!,
            ownerRegistrationId: binding.ownerRegistrationId!,
            documentInstanceId: binding.documentInstanceId!,
            baseRevision: binding.baseRevision!,
            beforeLocalEditRevision: binding.localEditRevision!,
            beforeHash: binding.bufferHash!,
            encoding: binding.encoding!,
            bom: binding.bom!,
            lineEnding: binding.lineEnding!,
          };
        }
      }
      input.signal?.throwIfAborted();
      const parentAuthority = input.parentAuthority ?? { kind: "workspace" as const };
      if (parentAuthority.kind === "branch") {
        const writes: Record<string, RecoveryState> = {};
        for (const pathPlan of planned.plan.paths) {
          if (pathPlan.decision === "keep-parent" || pathPlan.decision === "identical") continue;
          const target = await mergeTarget(store, pathPlan);
          if (target) writes[pathPlan.path] = target;
          else if (pathPlan.decision === "apply-child" && pathPlan.childState.kind === "missing") {
            writes[pathPlan.path] = { kind: "missing" };
          }
        }
        const parentBranch = await store.getBranchRoot(parentAuthority.branchId);
        if (!parentBranch) throw new Error(`Parent working branch not found: ${parentAuthority.branchId}`);
        const expectedWriteRevision = parentBranch.writeRevision ?? 0;
        const failed = planned.plan.conflictPaths.length > 0 || planned.preview.unavailablePaths.length > 0;
        const appliedPaths = failed ? [] : Object.keys(writes).sort();
        const afterStates = { ...planned.diskParentStates, ...(failed ? {} : writes) };
        const createdAt = new Date().toISOString();
        let afterWriteRevision = expectedWriteRevision;
        const branchTargets = Object.fromEntries(Object.entries(writes).map(([path, target]) => [path, {
          ...(planned.diskParentStates[path] ? { expected: planned.diskParentStates[path] } : {}),
          target,
          ...(planned.diskParentStates[path] ? { safety: planned.diskParentStates[path] } : {}),
        }]));
        const branchData = {
          operationId: planned.plan.operationId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          branchId: input.branchId,
          resultRevision: input.resultRevision,
          parentBranchId: parentAuthority.branchId,
          beforeWriteRevision: expectedWriteRevision,
          afterWriteRevision: expectedWriteRevision + (failed ? 0 : 1),
          beforeStates: planned.diskParentStates,
          afterStates,
          childStates: planned.childStates,
          targets: Object.fromEntries(Object.entries(writes).map(([path, target]) => [path, {
            expected: planned.diskParentStates[path] ?? { kind: "missing" as const },
            target,
          }])),
          targetKinds: Object.fromEntries(Object.keys(writes).map((path) => [path, "branch" as const])),
          externalBindings: {},
          safety: structuredClone(planned.diskParentStates),
          appliedPaths,
          compensatedPaths: [] as string[],
          needsAttentionPaths: [] as string[],
          conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
          diffStats: planned.plan.diffStats,
          retryBinding: {
            branchId: input.branchId,
            parentStates: structuredClone(planned.diskParentStates),
            childStates: structuredClone(planned.childStates),
            resultingParentStates: structuredClone(afterStates),
          },
          createdAt,
        };
        const created = await context.durableRecoveryStore.createOperation({
          operationId: planned.plan.operationId,
          workspaceId: input.workspaceId,
          kind: "integration",
          state: "applying",
          data: branchData,
          targets: branchTargets,
        });
        if (!failed) {
          afterWriteRevision = expectedWriteRevision + 1;
          const committed = this.commitParentVirtualWrites
            ? await this.commitParentVirtualWrites({
              workspaceId: input.workspaceId,
              branchId: parentAuthority.branchId,
              files: writes,
              expectedWriteRevision,
              store,
              ...(parentAuthority.sessionId ? { sessionId: parentAuthority.sessionId } : {}),
            })
            : await store.commitVirtualWrites(parentAuthority.branchId, expectedWriteRevision, writes);
          if (committed.status === "conflict") {
            throw new Error("Parent branch revision changed during nested merge");
          }
          afterWriteRevision = committed.writeRevision;
        }
        const terminalState: "conflict" | "complete" = failed ? "conflict" : "complete";
        await context.durableRecoveryStore.completeOperation({
          operationId: planned.plan.operationId,
          workspaceId: input.workspaceId,
          expectedRevision: Number(created.revision ?? 1),
          state: terminalState,
          result: { ...branchData, afterWriteRevision, state: terminalState },
        });
        const preview = { ...planned.preview, operationId: planned.plan.operationId };
        this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview });
        return {
          status: failed ? "conflict" : "applied",
          appliedPaths,
          conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
          changedFiles: planned.changedPaths,
          diffStats: planned.plan.diffStats,
          operationId: planned.plan.operationId,
          text: failed
            ? "Nested merge could not apply cleanly to the parent branch"
            : `Merged ${appliedPaths.length} files into the parent branch`,
          preview,
        };
      }
      let applyContext: DurableFileOperationContext = context as DurableFileOperationContext;
      let applyExecutionWorkspaceId: string | undefined;
      if (parentAuthority.kind === "directory") {
        try {
          const resolved = input.operationBinding
            ? { context: this.admittedApplyContext(input, context), executionWorkspaceId: parentAuthority.workspaceId! }
            : await this.directoryApplyContext(context, parentAuthority);
          applyContext = resolved.context;
          applyExecutionWorkspaceId = resolved.executionWorkspaceId;
        } catch (error) {
          if (!(error instanceof DirectoryApplyUnresolvedError)) throw error;
          return {
            operationId: planned.plan.operationId,
            status: "needs-attention",
            appliedPaths: [],
            conflictPaths: [...planned.plan.conflictPaths, ...planned.preview.unavailablePaths].sort(),
            changedFiles: planned.changedPaths,
            needsAttentionPaths: planned.changedPaths,
            diffStats: planned.plan.diffStats,
            text: error.message,
            preview: planned.preview,
          };
        }
      }
      for (const states of Object.values({ ...planned.diskTargets, ...externalTargets })) {
        for (const state of [states.expected, states.target]) {
          if (state.kind !== "regular-file") continue;
          const ownerId = store.ownerIdForObject?.(state.objectHash);
          if (ownerId) {
            if (input.operationBinding && !applyContext.durableRecoveryStore.registerObjectOwner) {
              throw new Error("Runtime Integration candidate object transfer is unavailable");
            }
            applyContext.durableRecoveryStore.registerObjectOwner?.(input.workspaceId, state.objectHash, ownerId);
          }
        }
      }
      let applied = await applyDurableFileOperation(applyContext, {
        id: planned.plan.operationId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        targets: planned.diskTargets,
        ...(Object.keys(externalTargets).length > 0 ? { externalTargets } : {}),
        ...(Object.keys(externalBindings).length > 0 ? { externalBindings } : {}),
        conflictPaths,
        diffStats: planned.plan.diffStats,
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.requireTurnBinding ? { requireTurnBinding: true } : {}),
        ...(input.operationBinding ? { operationBinding: input.operationBinding } : {}),
        ...(reservedId ? { reserved: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        retryBinding: {
          branchId: input.branchId,
          parentStates: planned.diskParentStates,
          childStates: planned.childStates,
          resultingParentStates: Object.fromEntries(planned.changedPaths.map((file) => [
            file,
            planned.diskTargets[file]?.target ?? planned.diskParentStates[file]!,
          ])),
        },
        ...(parentAuthority.kind === "directory" ? { applyCanonicalRoot: parentAuthority.directory } : {}),
        ...(applyExecutionWorkspaceId ? { applyExecutionWorkspaceId } : {}),
      });
      if (applied.status === "pending" && input.operationBinding && input.signal?.aborted) {
        applied = await cancelUndispatchedDurableExternalOperation(applyContext, applied.operationId);
      }
      const phases: Record<string, IntegrationApplyPhase> = {};
      for (const path of applied.appliedPaths) phases[path] = "disk-applied";
      if (applied.status === "pending") {
        const editsByPath = new Map(planned.surfaceEdits.map((edit) => [edit.resourceId, edit]));
        const grouped = new Map<string, {
          binding: ThreadIntegrationPreview["binding"][string];
          paths: string[];
        }>();
        for (const path of Object.keys(externalTargets)) {
          const binding = planned.preview.binding[path]!;
          const key = `${binding.ownerId}\0${binding.ownerGeneration}\0${binding.ownerRegistrationId}`;
          const group = grouped.get(key) ?? { binding, paths: [] };
          group.paths.push(path);
          grouped.set(key, group);
          phases[path] = "surface-intent";
        }
        const observed = new Map<string, DocumentSurfaceOperationResult>();
        const uncertain = new Set<string>();
        const stoppedSurfacePaths = new Set<string>();
        const cancelledSurfacePaths = new Set<string>();
        const markUndispatched = (paths: string[]) => {
          for (const file of paths) { cancelledSurfacePaths.add(file); stoppedSurfacePaths.add(file); }
        };
        for (const group of grouped.values()) {
          if (input.operationBinding && input.signal?.aborted) { markUndispatched(group.paths); continue; }
          const binding = group.binding;
          if (!this.requestSurfaceOperation || !binding.ownerId || binding.ownerGeneration === undefined
            || !binding.ownerRegistrationId || !binding.documentInstanceId || !binding.bufferHash
            || !binding.encoding || binding.bom === undefined || !binding.lineEnding
            || binding.localEditRevision === undefined || binding.baseRevision === undefined) {
            for (const file of group.paths) uncertain.add(file);
            continue;
          }
          try {
            await markDurableExternalDispatched(context, applied.operationId, group.paths);
            if (input.operationBinding && input.signal?.aborted) { markUndispatched(group.paths); continue; }
            for (const file of group.paths) phases[file] = "surface-dispatched";
            const request: DocumentSurfaceOperationRequest = {
              action: "apply",
              generation: binding.ownerGeneration,
              operationId: applied.operationId,
              ownerId: binding.ownerId,
              registrationId: binding.ownerRegistrationId,
              targets: group.paths.map((file) => {
                const current = planned.preview.binding[file]!;
                return {
                  baseRevision: current.baseRevision!,
                  bufferHash: current.bufferHash!,
                  documentInstanceId: current.documentInstanceId!,
                  encoding: current.encoding!,
                  bom: current.bom!,
                  lineEnding: current.lineEnding!,
                  localEditRevision: current.localEditRevision!,
                  resource: { workspaceId: planned.documentWorkspaceId, resourceId: file },
                  newText: editsByPath.get(file)!.newText,
                };
              }),
              workspaceId: planned.documentWorkspaceId,
            };
            // Native cancellation cannot discard an already dispatched writer's
            // only exact ACK. The original Tool domain promise drains this wait.
            const results = await this.requestSurfaceOperation(request, !input.operationBinding && input.signal ? { signal: input.signal } : {});
            if (completeSurfaceAcknowledgement(request, results)) {
              for (const file of group.paths) stoppedSurfacePaths.add(file);
            } else {
              for (const file of group.paths) uncertain.add(file);
            }
            for (const result of results) observed.set(result.resource.resourceId, result);
          } catch {
            for (const file of group.paths) uncertain.add(file);
          }
        }
        const durableResults: Record<string, "applied" | "unchanged" | "needs-attention"> = {};
        const appliedSurface = new Set<string>();
        const compensatedSurface = new Set<string>();
        for (const file of Object.keys(externalTargets)) {
          const result = observed.get(file);
          const binding = planned.preview.binding[file]!;
          const edit = editsByPath.get(file)!;
          if (cancelledSurfacePaths.has(file)) {
            durableResults[file] = "unchanged";
          } else if (uncertain.has(file)) {
            durableResults[file] = "needs-attention";
          } else if (result?.status === "applied"
            && result.documentInstanceId === binding.documentInstanceId
            && result.beforeLocalEditRevision === binding.localEditRevision
            && result.beforeHash === binding.bufferHash
            && result.afterLocalEditRevision === binding.localEditRevision! + 1
            && result.afterHash === contentHash(edit.newText)) {
            durableResults[file] = "applied";
            appliedSurface.add(file);
          } else if (result?.status === "failed"
            && result.documentInstanceId === binding.documentInstanceId
            && result.afterLocalEditRevision === binding.localEditRevision
            && result.afterHash === binding.bufferHash) {
            durableResults[file] = "unchanged";
          } else {
            durableResults[file] = "needs-attention";
          }
        }
        const allApplied = Object.values(durableResults).every((status) => status === "applied");
        if (!allApplied && appliedSurface.size > 0) {
          for (const group of grouped.values()) {
            const paths = group.paths.filter((file) => appliedSurface.has(file));
            if (paths.length === 0) continue;
            const binding = group.binding;
            try {
              for (const file of paths) stoppedSurfacePaths.delete(file);
              const request: DocumentSurfaceOperationRequest = {
                action: "undo",
                generation: binding.ownerGeneration!,
                operationId: applied.operationId,
                ownerId: binding.ownerId!,
                registrationId: binding.ownerRegistrationId!,
                targets: paths.map((file) => {
                  const current = planned.preview.binding[file]!;
                  const edit = editsByPath.get(file)!;
                  return {
                    baseRevision: current.baseRevision!,
                    bufferHash: current.bufferHash!,
                    documentInstanceId: current.documentInstanceId!,
                    encoding: current.encoding!,
                    bom: current.bom!,
                    lineEnding: current.lineEnding!,
                    localEditRevision: current.localEditRevision!,
                    resource: { workspaceId: planned.documentWorkspaceId, resourceId: file },
                    newText: edit.newText,
                    expectedAppliedRevision: current.localEditRevision! + 1,
                    expectedAppliedHash: contentHash(edit.newText),
                  };
                }),
                workspaceId: planned.documentWorkspaceId,
              };
              const undone = await this.requestSurfaceOperation!(request);
              const acknowledged = completeSurfaceAcknowledgement(request, undone);
              if (acknowledged) for (const file of paths) stoppedSurfacePaths.add(file);
              const undoneByPath = new Map(undone.map((entry) => [entry.resource.resourceId, entry]));
              for (const file of paths) {
                const restored = acknowledged && undoneByPath.get(file)?.status === "undone"
                  && undoneByPath.get(file)?.afterHash === planned.preview.binding[file]!.bufferHash;
                durableResults[file] = restored ? "unchanged" : "needs-attention";
                if (restored) compensatedSurface.add(file);
              }
            } catch {
              for (const file of paths) durableResults[file] = "needs-attention";
            }
          }
        }
        applied = await finalizeDurableExternalOperation(context, {
          operationId: applied.operationId,
          results: durableResults,
          undispatchedSurfacePaths: [...cancelledSurfacePaths],
          appliedSurfacePaths: [...appliedSurface],
          compensatedSurfacePaths: [...compensatedSurface],
          ...(input.operationBinding ? { executorStopped: Object.keys(externalTargets).every(file => stoppedSurfacePaths.has(file)) } : {}),
          receipts: Object.fromEntries([...observed].flatMap(([file, result]) => (
            result.status === "applied" && result.afterLocalEditRevision !== undefined && result.afterHash
              ? [[file, { afterLocalEditRevision: result.afterLocalEditRevision, afterHash: result.afterHash }]]
              : []
          ))),
          ...(!allApplied ? { failure: "One or more editor buffers could not be applied atomically" } : {}),
        });
        for (const [file, status] of Object.entries(durableResults)) {
          phases[file] = status === "applied" ? "surface-applied"
            : status === "unchanged" ? "compensated" : "unavailable";
        }
      }
      if (applied.status === "pending") throw new Error(`Integration ${applied.operationId} did not finish its surface operation`);
      for (const path of applied.conflictPaths) {
        phases[path] = planned.targets[path] === "unavailable" ? "unavailable" : "conflict";
      }
      for (const path of applied.compensatedPaths ?? []) phases[path] = "compensated";
      for (const path of applied.needsAttentionPaths ?? []) phases[path] = "unavailable";
      const preview = projectPreview(planned.plan, planned.targets, planned.preview.binding, phases, planned.texts);
      this.previewByThread.set(this.previewKey(input.workspaceId, input.threadId), { workspaceId: input.workspaceId, preview });
      const status: IntegrationApplyResult["status"] = preview.unavailablePaths.length > 0 && applied.status === "applied"
        ? "needs-attention" as const
        : applied.status as IntegrationApplyResult["status"];
      return {
        ...applied,
        status,
        changedFiles: planned.changedPaths,
        ...(planned.preview.surfaceTargetPaths.length > 0 ? { surfaceTargetPaths: planned.preview.surfaceTargetPaths } : {}),
        preview,
      };
    }, input.parentAuthority?.kind === "branch" ? "exclusive" : "shared", input.scopedWorkingStates);
    if (input.operationBinding) {
      const recorded = await this.inspectIntegration({ ...input, operationId: result.operationId });
      if (!recorded?.receipt || !recorded.effect || recorded.executorStopped === undefined || !recorded.recoveryCoverage) {
        throw new Error("Integration returned without its original durable receipt");
      }
      return recorded;
    }
    return result;
    } catch (error) {
      if (reservedId) {
        await this.withWorkingStore(input.workspaceId, "integration-abort-preparation", async (_store, context) => {
          const operation = await context.durableRecoveryStore.getOperation(input.workspaceId, reservedId!);
          if (operation?.state === "planned") await context.durableRecoveryStore.completeOperation({
            operationId: reservedId!, workspaceId: input.workspaceId, expectedRevision: Number(operation.revision),
            state: "aborted", result: { ...operation.data as Record<string, unknown>, executorStopped: true },
          });
        }, "exclusive", input.scopedWorkingStates).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseParentWrite();
    }
  }

  async undoIntegration(input: {
    workspaceId: string;
    threadId: string;
    operationId: string;
    sourceOwner?: { ownerId: string; generation: number };
    signal?: AbortSignal;
    parentAuthority?: IntegrationPlanInput["parentAuthority"];
    /** The caller already holds the parent VirtualWriteGate across this undo. */
    parentWriteHeld?: boolean;
  }): Promise<IntegrationApplyResult> {
    const inspection = await this.withWorkingStore(
      input.workspaceId,
      "thread-result-integration-undo-inspect",
      (_store, context) => inspectDurableIntegrationOperation(context, input.operationId),
      "shared",
    );
    if (inspection.threadId !== input.threadId) throw new Error(`Integration operation does not belong to thread ${input.threadId}`);
    let releaseParentWrite = (): void => undefined;
    let heldParentIsDisk = false;
    if (inspection.parentBranchId && !input.parentWriteHeld) {
      const sessionId = this.resolveParentSessionId?.(input.workspaceId, inspection.parentBranchId);
      if (sessionId && this.holdParentVirtualWrite) {
        const held = await this.holdParentVirtualWrite(sessionId, input.signal);
        if (held.status === "virtual") releaseParentWrite = () => held.release();
        else heldParentIsDisk = true;
      }
    }
    try {
    return await this.withWorkingStore(input.workspaceId, "thread-result-integration-undo", async (store, context) => {
      const operation = await inspectDurableIntegrationOperation(context, input.operationId);
      if (operation.threadId !== input.threadId) throw new Error(`Integration operation does not belong to thread ${input.threadId}`);
      if (operation.state === "undone") {
        const finalized = await finalizeDurableIntegrationUndone(context, input.operationId, operation.appliedPaths);
        this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
        return { ...finalized, status: finalized.status as IntegrationApplyResult["status"] };
      }
      const reserveUndo = () => this.withWorkingStore(input.workspaceId, "integration-undo-reserve", async (_store, reservationContext) => {
        const current = await inspectDurableIntegrationOperation(reservationContext, input.operationId);
        if (current.state !== "complete" && current.state !== "conflict") {
          throw new Error(`Integration ${input.operationId} requires recovery before undo (${current.state})`);
        }
        if (!current.parentBranchId) await this.assertUnresolvedDisjoint(reservationContext,
          current.applyCanonicalRoot ?? reservationContext.identity.canonicalRoot,
          current.reservedResources?.paths ?? Object.keys(current.targets), input.operationId);
        await markDurableIntegrationUndoing(reservationContext, input.operationId);
      }, "exclusive");
      if (operation.parentBranchId) await reserveUndo();
      else {
        const targetContext = operation.applyCanonicalRoot
          ? (await this.directoryApplyContext(context, { kind: "directory", directory: operation.applyCanonicalRoot,
            ...(operation.applyExecutionWorkspaceId ? { workspaceId: operation.applyExecutionWorkspaceId } : {}) })).context
          : context;
        await targetContext.resourceOperationGate.run((operation.reservedResources?.paths ?? Object.keys(operation.targets))
          .map(resourceId => ({ resourceId, scope: "subtree" as const })), reserveUndo, input.signal ? { signal: input.signal } : {});
      }
      if (operation.parentBranchId) {
        const authority = input.parentAuthority;
        if (heldParentIsDisk || authority?.kind === "directory") {
          if (heldParentIsDisk && authority?.kind !== "directory") {
            return {
              ...await markDurableIntegrationNeedsAttention(
                context,
                input.operationId,
                operation.appliedPaths,
                "Parent working branch materialized without a resolvable execution directory",
              ),
              status: "needs-attention" as const,
            };
          }
          if (authority?.kind !== "directory") {
            return {
              ...await markDurableIntegrationNeedsAttention(
                context,
                input.operationId,
                operation.appliedPaths,
                "Parent working branch authority is unavailable for materialized undo",
              ),
              status: "needs-attention" as const,
            };
          }
          let applyContext: DurableFileOperationContext;
          let applyExecutionWorkspaceId: string | undefined;
          try {
            const resolved = await this.directoryApplyContext(context, authority);
            applyContext = resolved.context;
            applyExecutionWorkspaceId = resolved.executionWorkspaceId;
          } catch (error) {
            if (!(error instanceof DirectoryApplyUnresolvedError)) throw error;
            return {
              ...await markDurableIntegrationNeedsAttention(context, input.operationId, operation.appliedPaths, error.message),
              status: "needs-attention" as const,
            };
          }
          const undoneDirectory = await undoBranchIntegrationOnDirectory(applyContext, {
            operationId: input.operationId,
            ...(applyExecutionWorkspaceId ? { applyExecutionWorkspaceId } : {}),
            deferFinalization: true,
          });
          if (undoneDirectory.status === "compensated") {
            // The materialized directory is authoritative while the parent is
            // on disk.  Bring the non-authoritative branch cache back to the
            // same before slice so a later rematerialization cannot resurrect
            // the undone child result.
            const parentBranch = await store.getBranchRoot(operation.parentBranchId);
            if (!parentBranch) {
              return {
                ...await markDurableIntegrationNeedsAttention(
                  context,
                  input.operationId,
                  operation.appliedPaths,
                  "Parent working branch disappeared while synchronizing materialized undo",
                ),
                status: "needs-attention" as const,
              };
            }
            const before = operation.retryBinding?.parentStates ?? operation.safety;
            const current = await store.readStateSlice(operation.parentBranchId, Object.keys(operation.retryBinding?.parentStates ?? operation.safety)) ?? {};
            const currentAfter = operation.retryBinding?.resultingParentStates ?? Object.fromEntries(
              Object.entries(operation.targets).map(([file, states]) => [file, states.target]),
            );
            const branchPaths = operation.appliedPaths.length > 0
              ? operation.appliedPaths
              : Object.keys(currentAfter);
            const branchDrift = branchPaths.filter((file) => (
              !sameState(current[file] ?? { kind: "missing" }, currentAfter[file] ?? { kind: "missing" })
              && !sameState(current[file] ?? { kind: "missing" }, before[file] ?? { kind: "missing" })
            ));
            if (branchDrift.length > 0) {
              return {
                ...await markDurableIntegrationNeedsAttention(
                  context,
                  input.operationId,
                  branchDrift,
                  "Parent working branch changed while synchronizing materialized undo",
                ),
                status: "needs-attention" as const,
              };
            }
            if (branchPaths.some((file) => !sameState(
              current[file] ?? { kind: "missing" },
              before[file] ?? { kind: "missing" },
            ))) {
              const synced = await store.commitVirtualWrites(
                operation.parentBranchId,
                parentBranch.writeRevision ?? 0,
                Object.fromEntries(branchPaths.map((file) => [file, before[file] ?? { kind: "missing" }])),
              );
              if (synced.status === "conflict") {
                return {
                  ...await markDurableIntegrationNeedsAttention(
                    context,
                    input.operationId,
                    branchPaths,
                    "Parent working branch changed while synchronizing materialized undo",
                  ),
                  status: "needs-attention" as const,
                };
              }
            }
            const finalized = await finalizeDurableIntegrationUndone(
              context,
              input.operationId,
              branchPaths,
            );
            this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
            return { ...finalized, status: finalized.status as IntegrationApplyResult["status"] };
          }
          this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
          return { ...undoneDirectory, status: undoneDirectory.status as IntegrationApplyResult["status"] };
        }
        const parentBranch = await store.getBranchRoot(operation.parentBranchId);
        if (!parentBranch) throw new Error(`Parent working branch not found: ${operation.parentBranchId}`);
        const before = operation.retryBinding?.parentStates ?? operation.safety;
        const after = operation.retryBinding?.resultingParentStates ?? Object.fromEntries(
          Object.entries(operation.targets).map(([file, states]) => [file, states.target]),
        );
        const currentView = await store.readStateSlice(operation.parentBranchId, Object.keys(operation.retryBinding?.parentStates ?? operation.safety)) ?? {};
        if (this.sameParentSlice(currentView, before)) {
          this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
          const finalized = await finalizeDurableIntegrationUndone(context, input.operationId, operation.appliedPaths);
          return { ...finalized, status: finalized.status as IntegrationApplyResult["status"] };
        }
        if (!this.sameParentSlice(currentView, after)) {
          return {
            ...await markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              Object.keys(after),
              "Parent branch changed before the nested integration could be undone",
            ),
            status: "needs-attention" as const,
          };
        }
        await markDurableIntegrationUndoing(context, input.operationId);
        const parentSessionId = this.resolveParentSessionId?.(input.workspaceId, operation.parentBranchId);
        const committed = this.commitParentVirtualWrites
          ? await this.commitParentVirtualWrites({
            workspaceId: input.workspaceId,
            branchId: operation.parentBranchId,
            files: before,
            expectedWriteRevision: parentBranch.writeRevision ?? 0,
            store,
            ...(parentSessionId ? { sessionId: parentSessionId } : {}),
          })
          : await store.commitVirtualWrites(operation.parentBranchId, parentBranch.writeRevision ?? 0, before);
        if (committed.status === "conflict") {
          return {
            ...await markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              Object.keys(after),
              "Parent branch revision changed during nested undo",
            ),
            status: "needs-attention" as const,
          };
        }
        const observed = await store.readStateSlice(operation.parentBranchId, Object.keys(before)) ?? {};
        if (!this.sameParentSlice(observed, before)) {
          return {
            ...await markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              Object.keys(before),
              "Parent branch undo did not produce the expected before state",
            ),
            status: "needs-attention" as const,
          };
        }
        const finalized = await finalizeDurableIntegrationUndone(context, input.operationId, operation.appliedPaths);
        this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
        return { ...finalized, status: finalized.status as IntegrationApplyResult["status"] };
      }
      let applyContext: DurableFileOperationContext = context as DurableFileOperationContext;
      if (operation.applyCanonicalRoot) {
        try {
          applyContext = (await this.directoryApplyContext(context, {
            kind: "directory",
            directory: operation.applyCanonicalRoot,
          })).context;
        } catch (error) {
          if (!(error instanceof DirectoryApplyUnresolvedError)) throw error;
          return {
            ...await markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              operation.appliedPaths,
              error.message,
            ),
            status: "needs-attention" as const,
          };
        }
      }
      const surfacePaths = Object.entries(operation.targetKinds)
        .filter(([, kind]) => kind === "surface")
        .map(([file]) => file)
        .sort();
      const documentWorkspaceId = operation.applyExecutionWorkspaceId ?? await this.documentWorkspace(input);
      const barrier = surfacePaths.length > 0 && this.beginDirtyStateBarrier
        ? await this.beginDirtyStateBarrier(documentWorkspaceId, surfacePaths)
        : null;
      // The barrier forces every connected owner to publish a fresh revision.
      // Release it before asking the registry to undo: registry edits are
      // deliberately fenced while a recovery barrier is held. The subsequent
      // owner/registration/instance/revision/hash checks provide the CAS.
      await barrier?.release();
      const undonePaths: string[] = [];
        if (surfacePaths.length > 0) {
          if (!this.requestSurfaceOperation) throw new Error("Document surface operation channel is unavailable");
          const grouped = new Map<string, { binding: DurableExternalBinding; paths: string[] }>();
          for (const file of surfacePaths) {
            const binding = operation.externalBindings[file];
            if (!binding || binding.afterLocalEditRevision === undefined || !binding.afterHash) {
              throw new Error(`Integration surface receipt is unavailable: ${file}`);
            }
            if (input.sourceOwner && (binding.ownerId !== input.sourceOwner.ownerId
              || binding.ownerGeneration !== input.sourceOwner.generation)) {
              throw new Error(`Integration was applied by another document surface: ${file}`);
            }
            const key = `${binding.ownerId}\0${binding.ownerGeneration}\0${binding.ownerRegistrationId}`;
            const group = grouped.get(key) ?? { binding, paths: [] };
            group.paths.push(file);
            grouped.set(key, group);
          }
          await markDurableExternalUndoDispatched(context, input.operationId, surfacePaths);
          const failed: string[] = [];
          for (const group of grouped.values()) {
            try {
              const results = await this.requestSurfaceOperation({
                action: "undo",
                generation: group.binding.ownerGeneration,
                operationId: input.operationId,
                ownerId: group.binding.ownerId,
                registrationId: group.binding.ownerRegistrationId,
                targets: group.paths.map((file) => {
                  const binding = operation.externalBindings[file]!;
                  return {
                    baseRevision: binding.baseRevision,
                    bufferHash: binding.beforeHash,
                    documentInstanceId: binding.documentInstanceId,
                    encoding: binding.encoding,
                    bom: binding.bom,
                    lineEnding: binding.lineEnding,
                    localEditRevision: binding.beforeLocalEditRevision,
                    expectedAppliedRevision: binding.afterLocalEditRevision!,
                    expectedAppliedHash: binding.afterHash!,
                    resource: { workspaceId: documentWorkspaceId, resourceId: file },
                  };
                }),
                workspaceId: documentWorkspaceId,
              }, input.signal ? { signal: input.signal } : {});
              const byPath = new Map(results.map((result) => [result.resource.resourceId, result]));
              for (const file of group.paths) {
                const result = byPath.get(file);
                const binding = operation.externalBindings[file]!;
                if (result?.status === "undone" && result.documentInstanceId === binding.documentInstanceId
                  && result.afterHash === binding.beforeHash) undonePaths.push(file);
                else failed.push(file);
              }
            } catch {
              failed.push(...group.paths);
            }
          }
          if (failed.length > 0) {
            const attention = await markDurableIntegrationNeedsAttention(
              context,
              input.operationId,
              failed,
              "One or more editor buffers changed before the integration could be undone",
            );
            return { ...attention, status: "needs-attention" as const };
          }
        }
        const undone = await undoDurableIntegrationOperation(applyContext, {
          operationId: input.operationId,
          surfaceUndonePaths: undonePaths,
        });
        this.previewByThread.delete(this.previewKey(input.workspaceId, input.threadId));
        if (undone.status === "pending") throw new Error(`Integration ${input.operationId} undo did not settle`);
      return { ...undone, status: undone.status as IntegrationApplyResult["status"] };
    });
    } finally {
      releaseParentWrite();
    }
  }

  private async plan(input: IntegrationPlanInput): Promise<{
    documentWorkspaceId: string;
    plan: ThreeWayMergePlan;
    preview: ThreadIntegrationPreview;
    targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>;
    diskTargets: Record<string, DurableFileTarget>;
    diskParentStates: Record<string, RecoveryState>;
    childStates: Record<string, RecoveryState>;
    changedPaths: string[];
    surfaceEdits: PlannedSurfaceTextEdit[];
    texts: Record<string, { parent?: string; child?: string; baseline?: string }>;
  }> {
    this.validateOperationInput(input);
    return this.withWorkingStore(input.workspaceId, "thread-result-preview", (store, context) => this.planFrom(store, context, input), "shared", input.scopedWorkingStates);
  }

  private async planFrom(
    store: WorkingStateRootStore,
    context: WorkingStateRootContext,
    input: IntegrationPlanInput,
  ): Promise<{
    documentWorkspaceId: string;
    plan: ThreeWayMergePlan;
    preview: ThreadIntegrationPreview;
    targets: Record<string, ReturnType<typeof classifyIntegrationTarget>>;
    diskTargets: Record<string, DurableFileTarget>;
    diskParentStates: Record<string, RecoveryState>;
    childStates: Record<string, RecoveryState>;
    changedPaths: string[];
    surfaceEdits: PlannedSurfaceTextEdit[];
    texts: Record<string, { parent?: string; child?: string; baseline?: string }>;
  }> {
    const storedResult = await store.getResult(input.branchId, input.resultRevision);
    const overrides = input.baseStatesOverride ?? await input.resolveBaseStates?.(store);
    const result = storedResult && { ...storedResult, baseStates: { ...storedResult.baseStates, ...overrides },
      pathStates: { ...storedResult.pathStates }, changedPaths: [...storedResult.changedPaths] };
    if (!result) throw new Error(`Working result not found: ${input.branchId}@${input.resultRevision}`);
    if (overrides && Object.keys(overrides).length) {
      const paths = [...new Set([...result.changedPaths, ...Object.keys(overrides)])];
      const fixed = await store.readStateSlice(input.branchId, paths, { revision: input.resultRevision });
      if (!fixed) throw new Error("The fixed source for acknowledged paths is unavailable");
      result.pathStates = Object.fromEntries(paths.map(path => [path, fixed[path] ?? { kind: "missing" as const }]));
      result.changedPaths = paths.filter(path => !sameState(result.baseStates[path] ?? { kind: "missing" }, result.pathStates[path]!));
    }
    const branch = await store.getBranchRoot(input.branchId);
    if (!branch) throw new Error(`Working branch not found: ${input.branchId}`);
    const parentAuthority = input.parentAuthority ?? { kind: "workspace" as const };
    const documentWorkspaceId = await this.documentWorkspace(input);
    const barrier = parentAuthority.kind !== "branch" && this.beginDirtyStateBarrier
      ? await this.beginDirtyStateBarrier(documentWorkspaceId, result.changedPaths)
      : null;
    try {
      const publications = parentAuthority.kind !== "branch" && this.inspectDirtyBuffers
        ? await this.inspectDirtyBuffers(documentWorkspaceId)
        : [];
      const dirty = dirtyResourceMap(publications);
      const sourceOwner = input.sourceOwner;
      const sourceOwnerConnected = !sourceOwner || publications.some((publication) => (
        publication.ownerId === sourceOwner.ownerId
        && publication.generation === sourceOwner.generation
        && Boolean(publication.registrationId)
      ));
      const diskParentStates: Record<string, RecoveryState> = {};
      const parentState: Record<string, RecoveryState> = {};
      const targets: Record<string, ReturnType<typeof classifyIntegrationTarget>> = {};
      const bindings: ThreadIntegrationPreview["binding"] = {};
      const selectedSurfaces = new Map<string, DirtyBufferInspectResource>();
      const texts: Record<string, { parent?: string; child?: string; baseline?: string }> = {};
      const parentIdentity = parentAuthority.kind === "directory"
        ? { ...context.identity, canonicalRoot: parentAuthority.directory }
        : context.identity;
      const parentBranchView = parentAuthority.kind === "branch"
        ? await store.readStateSlice(parentAuthority.branchId, result.changedPaths) ?? {}
        : null;

      for (const file of result.changedPaths) {
        const disk = parentBranchView
          ? parentBranchView[file] ?? { kind: "missing" as const }
          : (await context.fileStore.captureState(parentIdentity, context.root, file, { store: true })).state;
        diskParentStates[file] = disk;
        if (parentAuthority.kind === "branch") {
          targets[file] = "disk";
          parentState[file] = disk;
          bindings[file] = { target: "disk", revision: parentRevisionOf(disk) };
          continue;
        }
        const selected = selectDirtyResource(dirty.get(file), input.sourceOwner);
        if (selected.status === "ambiguous"
          || (input.sourceOwner && !sourceOwnerConnected && branch.draftBasePaths.includes(file))) {
          targets[file] = "unavailable";
          parentState[file] = disk;
          bindings[file] = { target: "unavailable", revision: `ambiguous:${parentRevisionOf(disk)}` };
        } else {
          const live = selected.status === "selected" ? selected.resource : undefined;
          const target = classifyIntegrationTarget({
            draftBasePath: branch.draftBasePaths.includes(file),
            ...(live ? { dirty: live } : {}),
            inspectDirtyBuffers: Boolean(this.inspectDirtyBuffers),
            parentState: disk,
            baseState: result.baseStates[file]!,
            childState: result.pathStates[file]!,
          });
          targets[file] = target;
          if (target === "surface" && live) {
            selectedSurfaces.set(file, live);
            bindings[file] = surfaceBinding(live);
          } else {
            parentState[file] = disk;
            bindings[file] = {
              target,
              revision: target === "unavailable" ? `unavailable:${parentRevisionOf(disk)}` : parentRevisionOf(disk),
            };
          }
        }
      }

      const groups = new Map<string, { owner: DirtyBufferInspectResource; paths: string[] }>();
      for (const [file, owner] of selectedSurfaces) {
        const key = `${owner.ownerId}\0${owner.generation}\0${owner.registrationId}`;
        const group = groups.get(key) ?? { owner, paths: [] };
        group.paths.push(file);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (!this.requestSurfaceOperation) {
          for (const file of group.paths) {
            targets[file] = "unavailable";
            parentState[file] = diskParentStates[file]!;
            bindings[file] = { ...bindings[file]!, target: "unavailable" };
          }
          continue;
        }
        let captured: DocumentSurfaceOperationResult[];
        try {
          captured = await this.requestSurfaceOperation({
            action: "capture",
            generation: group.owner.generation,
            operationId: `preview-capture-${randomUUID()}`,
            ownerId: group.owner.ownerId,
            registrationId: group.owner.registrationId,
            targets: group.paths.map((file) => ({
              ...group.owner,
              ...selectedSurfaces.get(file)!,
              resource: { workspaceId: documentWorkspaceId, resourceId: file },
            })),
            workspaceId: documentWorkspaceId,
          }, input.signal ? { signal: input.signal } : {});
        } catch {
          input.signal?.throwIfAborted();
          captured = [];
        }
        const byPath = new Map(captured.map((entry) => [entry.resource.resourceId, entry]));
        for (const file of group.paths) {
          const live = selectedSurfaces.get(file)!;
          const entry = byPath.get(file);
          if (entry?.status !== "captured" || typeof entry.content !== "string"
            || entry.documentInstanceId !== live.documentInstanceId
            || entry.beforeLocalEditRevision !== live.localEditRevision
            || entry.beforeHash !== live.bufferHash
            || contentHash(entry.content) !== live.bufferHash) {
            targets[file] = "unavailable";
            parentState[file] = diskParentStates[file]!;
            bindings[file] = { ...bindings[file]!, target: "unavailable" };
            continue;
          }
          const object = await store.putObject(Buffer.from(entry.content, "utf8"));
          const disk = diskParentStates[file]!;
          const base = result.baseStates[file]!;
          const mode = disk.kind === "regular-file" ? disk.mode : base.kind === "regular-file" ? base.mode : undefined;
          parentState[file] = {
            kind: "regular-file",
            objectHash: object.hash,
            byteLength: object.byteLength,
            ...(mode === undefined ? {} : { mode }),
          };
          texts[file] = { ...texts[file], parent: entry.content };
        }
      }

      const mergeBaseStates = { ...result.baseStates };
      const mergeChildStates = { ...result.pathStates };
      for (const file of result.changedPaths) {
        mergeBaseStates[file] ??= { kind: "missing" };
        mergeChildStates[file] ??= { kind: "missing" };
        if (targets[file] === "surface") {
          mergeBaseStates[file] = await editorStateFrom(store, result.baseStates[file]!);
          mergeChildStates[file] = await editorStateFrom(store, result.pathStates[file]!);
        }
        const childText = await readableText(store, mergeChildStates[file]!);
        const baselineText = await readableText(store, mergeBaseStates[file]!);
        if (childText !== undefined) texts[file] = { ...texts[file], child: childText };
        if (baselineText !== undefined) texts[file] = { ...texts[file], baseline: baselineText };
      }

      const preliminary = await buildThreeWayMergePlan({
        operationId: "preview-pending-binding",
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        resultRevision: input.resultRevision,
        allPaths: result.changedPaths,
        baseState: mergeBaseStates,
        parentState,
        childState: mergeChildStates,
        readContent: async (state) => state.kind === "regular-file" ? store.getObject(state.objectHash) : null,
      });
      const bindingFingerprint = previewFingerprint(bindings, input.resultRevision);
      let plan = applyResolutions(
        { ...preliminary, operationId: `preview-${bindingFingerprint.slice(0, 24)}` },
        input.resolutions,
        bindings,
        input.expectedBindingFingerprint,
      );
      const unrepresentable = new Set<string>();
      plan = {
        ...plan,
        paths: plan.paths.map((pathPlan) => {
          if (targets[pathPlan.path] !== "surface"
            || pathPlan.decision === "identical" || pathPlan.decision === "keep-parent" || pathPlan.decision === "conflict") return pathPlan;
          const target = pathPlan.decision === "apply-child" ? pathPlan.childState : null;
          const targetText = target?.kind === "regular-file"
            ? texts[pathPlan.path]?.child
            : pathPlan.mergedText;
          const parentMode = pathPlan.parentState.kind === "regular-file" ? pathPlan.parentState.mode : undefined;
          const targetMode = target?.kind === "regular-file" ? target.mode : pathPlan.mergedMode;
          if (targetText !== undefined && targetMode === parentMode) return pathPlan;
          unrepresentable.add(pathPlan.path);
          return {
            ...pathPlan,
            decision: "conflict" as const,
            conflictReason: "The editor buffer cannot represent this deletion, binary/type change, or file-mode change",
            isText: false,
          };
        }),
      };
      if (unrepresentable.size > 0) {
        plan.conflictPaths = [...new Set([...plan.conflictPaths, ...unrepresentable])].sort();
        plan.appliedPaths = plan.appliedPaths.filter((file) => !unrepresentable.has(file));
        plan.clean = false;
      }
      const diskTargets: Record<string, DurableFileTarget> = {};
      const surfaceEdits: PlannedSurfaceTextEdit[] = [];
      for (const pathPlan of plan.paths) {
        const target = await mergeTarget(store, pathPlan);
        if (targets[pathPlan.path] === "disk") {
          if (target) diskTargets[pathPlan.path] = { expected: pathPlan.parentState, target };
          continue;
        }
        if (targets[pathPlan.path] !== "surface" || !target || target.kind !== "regular-file") continue;
        const newText = decodeUtf8(await store.getObject(target.objectHash));
        const live = selectedSurfaces.get(pathPlan.path);
        if (newText === undefined || !live) continue;
        surfaceEdits.push({
          resourceId: pathPlan.path,
          expectedLocalEditRevision: live.localEditRevision,
          expectedBaseRevision: live.baseRevision,
          newText,
        });
      }
      const preview = projectPreview(plan, targets, bindings, {}, texts);
      return {
        documentWorkspaceId,
        plan,
        preview,
        targets,
        diskTargets,
        diskParentStates,
        childStates: result.pathStates,
        changedPaths: result.changedPaths,
        surfaceEdits,
        texts,
      };
    } finally {
      await barrier?.release();
    }
  }
}
