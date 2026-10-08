import { NativeCredentialBridge, type PrivateCredentialResponse } from "./native-credential-bridge.js";
import type { ExistingHostCredentialOwner, NativeCredentialScope } from "./native-credential-owner.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { KernelRequestWindow } from "./request-window.js";
import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  KERNEL_PROTOCOL_VERSION,
  KERNEL_REQUEST_WINDOW,
  type KernelBranchReadResult,
  type KernelBranchChange,
  type KernelCreateEntry,
  type KernelError,
  type KernelHandshakeResult,
  type KernelGrantIssueParams,
  type KernelHealthResult,
  type KernelGetBlobParams,
  type KernelMethod,
  type KernelMethodParams,
  type KernelObjectSlice,
  type KernelPutBlobResult,
  type KernelRecordListResult,
  type KernelRecordResult,
  type KernelRequest,
  type KernelResponse,
  type KernelWriteResult,
  type KernelProcessSnapshot,
  type KernelComputeReadResult,
  type KernelProcessListResult,
  type KernelProcessReadResult,
  type KernelProcessWriteResult,
  type KernelProcessStreamEvent,
  type NativeRuntimeStreamEvent,
  type KernelProcessSubscribeResult,
} from "./protocol.generated.js";

export interface KernelClientOptions {
  hostId: string;
  storageRoot: string;
  buildVersion: string;
  kernelPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Used by focused tests; production always uses a real child process. */
  spawnProcess?: typeof spawn;
  allowCargoDevRunner?: boolean;
  hostGeneration?: string;
  kernelBuildIdentity?: string;
  targetTriple?: string;
  targetArch?: string;
  requireKernelManifest?: boolean;
  onExit?: (error: Error) => void;
}

export type KernelGrantIssueInput = Pick<KernelGrantIssueParams, "grantId" | "capabilities" | "pathScopes"> & {
  [K in Exclude<keyof KernelGrantIssueParams, "grantId" | "capabilities" | "pathScopes">]?: KernelGrantIssueParams[K] | undefined;
};

export type KernelBlobReadSource =
  | { branchId: string; path: string; revision?: number }
  | { pinId: string; path: string }
  | { recordId: string; slot: string }
  | { ownerId: string };

export interface KernelCreateBranchInput {
  operationId: string;
  branchId: string;
  workspaceId: string;
  entries: KernelCreateEntry[];
  baseRef?: string;
  /** Product-level immutable parent identity. This is metadata, not the root used by the kernel builder. */
  parentRef?: string;
  draftBasePaths: string[];
  captureScopes: string[];
}

export interface KernelGrantHandle {
  readonly grantId: string;
  readonly kernelEpoch: string;
  readonly hostGeneration: string;
  readonly authorityInstanceId: string | null;
  readonly workerId: string | null;
  readonly workerGeneration: number | null;
  readonly sessionId: string | null;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly owningWorkspace: string | null;
  readonly executionWorkspace: string | null;
  readonly capabilities: readonly string[];
  readonly pathScopes: readonly string[];
  readonly storageIdentity: string;
}

export interface KernelProcessSubscription {
  readonly closed: Promise<void>;
  acknowledge(stream: "data" | "control", sequence: number): Promise<void>;
  close(): Promise<void>;
}
export type KernelProcessObserver = (event: KernelProcessStreamEvent, acknowledge: () => Promise<void>) => void;
interface ProcessSubscriptionEntry {
  id: string; processId: string; grant: KernelGrantHandle; listener(event: KernelProcessStreamEvent): void;
  dataSequence: number; controlSequence: number; closed: boolean;
  resolve(): void; reject(error: Error): void;
}

interface InternalGrantHandle extends KernelGrantHandle {
  readonly clientToken: symbol;
}

export class KernelClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: KernelError | { code: string; message: string; retryable?: boolean }) {
    super(error.message);
    this.name = "KernelClientError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

export class KernelScopedClient {
  private readonly grant: KernelGrantHandle;

  constructor(private readonly owner: KernelClient, grant: KernelGrantHandle) {
    this.grant = owner.assertGrantForScope(grant);
  }

  computeStart(params: KernelMethodParams["compute.start"], signal?: AbortSignal): Promise<KernelComputeReadResult> {
    return this.owner.computeStart(params, this.grant, signal);
  }

  computeRead(params: KernelMethodParams["compute.read"], signal?: AbortSignal): Promise<KernelComputeReadResult> {
    return this.owner.computeRead(params, this.grant, signal);
  }

  computeCancel(params: KernelMethodParams["compute.cancel"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.computeCancel(params, this.grant, signal);
  }

  computeRelease(params: KernelMethodParams["compute.release"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.computeRelease(params, this.grant, signal);
  }

  computeGrammarRegister(params: KernelMethodParams["compute.grammar.register"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.computeGrammarRegister(params, this.grant, signal);
  }

  processSpawn(params: KernelMethodParams["process.spawn"], signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.owner.processSpawn(params, this.grant, signal);
  }

  processRead(params: KernelMethodParams["process.read"], signal?: AbortSignal): Promise<KernelProcessReadResult> {
    return this.owner.processRead(params, this.grant, signal);
  }

  processSubscribe(params: Omit<KernelMethodParams["process.subscribe"], "subscriptionId">, observer: KernelProcessObserver): Promise<KernelProcessSubscription> {
    return this.owner.processSubscribe(params, this.grant, observer);
  }

  processWrite(params: KernelMethodParams["process.write"], signal?: AbortSignal): Promise<KernelProcessWriteResult> {
    return this.owner.processWrite(params, this.grant, signal);
  }

  processResize(params: KernelMethodParams["process.resize"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.processResize(params, this.grant, signal);
  }

  processKill(params: KernelMethodParams["process.kill"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.processKill(params, this.grant, signal);
  }

  processInspect(params: KernelMethodParams["process.inspect"], signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.owner.processInspect(params, this.grant, signal);
  }

  processList(params: KernelMethodParams["process.list"], signal?: AbortSignal): Promise<KernelProcessListResult> {
    return this.owner.processList(params, this.grant, signal);
  }

  processRelease(params: KernelMethodParams["process.release"], signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.owner.processRelease(params, this.grant, signal);
  }

  health(options: { deep?: boolean; signal?: AbortSignal | undefined } = {}): Promise<KernelHealthResult> {
    return this.owner.health(options);
  }

  snapshot(workspaceId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.snapshot(workspaceId, this.grant, signal);
  }

  putBlob(bytes: Uint8Array, operationId: string, signal?: AbortSignal): Promise<KernelPutBlobResult> {
    return this.owner.putBlob(bytes, operationId, this.grant, signal);
  }

  putBlobStream(
    chunks: AsyncIterable<Uint8Array>,
    input: { operationId: string; byteLength: number; expectedHash: string },
    signal?: AbortSignal,
  ): Promise<KernelPutBlobResult> {
    return this.owner.putBlobStream(chunks, input, this.grant, signal);
  }

  getBlob(hash: string, source: KernelBlobReadSource, options: { offset?: number; length?: number; signal?: AbortSignal | undefined } = {}): Promise<KernelObjectSlice> {
    return this.owner.getBlob(hash, source, this.grant, options);
  }

  fileRootRegister(params: KernelMethodParams["file.root.register"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileRootRegister(params, this.grant, signal);
  }

  fileOperationList(params: KernelMethodParams["file.operation.list"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileOperationList(params, this.grant, signal);
  }

  fileOperationReconcile(params: KernelMethodParams["file.operation.reconcile"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileOperationReconcile(params, this.grant, signal);
  }

  fileLeaseAcquire(params: KernelMethodParams["file.lease.acquire"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileLeaseAcquire(params, this.grant, signal);
  }

  fileLeaseCheck(params: KernelMethodParams["file.lease.check"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileLeaseCheck(params, this.grant, signal);
  }

  fileLeaseRelease(params: KernelMethodParams["file.lease.release"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileLeaseRelease(params, this.grant, signal);
  }

  fileCapture(params: KernelMethodParams["file.capture"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileCapture(params, this.grant, signal);
  }

  fileCaptureBatch(params: KernelMethodParams["file.captureBatch"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileCaptureBatch(params, this.grant, signal);
  }

  fileApply(params: KernelMethodParams["file.apply"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileApply(params, this.grant, signal);
  }

  fileMkdir(params: KernelMethodParams["file.mkdir"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileMkdir(params, this.grant, signal);
  }

  fileRemove(params: KernelMethodParams["file.remove"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileRemove(params, this.grant, signal);
  }

  fileRename(params: KernelMethodParams["file.rename"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileRename(params, this.grant, signal);
  }

  fileScan(params: KernelMethodParams["file.scan"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileScan(params, this.grant, signal);
  }

  fileMeasure(params: KernelMethodParams["file.measure"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileMeasure(params, this.grant, signal);
  }

  fileMaterialize(params: KernelMethodParams["file.materialize"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.fileMaterialize(params, this.grant, signal);
  }

  createBranch(params: KernelCreateBranchInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.createBranch(params, this.grant, signal);
  }

  readBranch(params: { branchId: string; revision?: number; paths?: string[]; roots?: string[]; includeEntries?: boolean; cursor?: number; pageSize?: number }, signal?: AbortSignal): Promise<KernelBranchReadResult> {
    return this.owner.readBranch(params, this.grant, signal);
  }

  writeBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; changes: KernelBranchChange[]; baseRef?: string; parentRef?: string }, signal?: AbortSignal): Promise<KernelWriteResult> {
    return this.owner.writeBranch(params, this.grant, signal);
  }

  publishBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; expectedRoot: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.publishBranch(params, this.grant, signal);
  }

  pinBranch(params: KernelMethodParams["branch.pin"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.pinBranch(params, this.grant, signal);
  }

  unpinBranch(params: { operationId: string; branchId: string; pinId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.unpinBranch(params, this.grant, signal);
  }

  diffRoots(params: { leftRoot: string; rightRoot: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.diffRoots(params, this.grant, signal);
  }

  branchObjects(params: { branchId: string; includeRevisions?: boolean; cursor?: number; pageSize?: number }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.branchObjects(params, this.grant, signal);
  }

  deleteBranch(params: { operationId: string; branchId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.deleteBranch(params, this.grant, signal);
  }

  readPin(params: KernelMethodParams["pin.read"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.readPin(params, this.grant, signal);
  }

  gc(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.gc(operationId, this.grant, signal);
  }

  getOperation(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.getOperation(operationId, this.grant, signal);
  }

  recoveryOperationGet(params: KernelMethodParams["recovery.operation.get"], signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.recoveryOperationGet(params, this.grant, signal);
  }

  recoveryTurnStart(params: KernelMethodParams["recovery.turn.start"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryTurnStart(params, this.grant, signal);
  }

  recoveryTurnGet(params: KernelMethodParams["recovery.turn.get"], signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.recoveryTurnGet(params, this.grant, signal);
  }

  recoveryTurnSettle(params: KernelMethodParams["recovery.turn.settle"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryTurnSettle(params, this.grant, signal);
  }

  recoveryCheckpointCreate(params: KernelMethodParams["recovery.checkpoint.create"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryCheckpointCreate(params, this.grant, signal);
  }

  recoveryCheckpointList(params: KernelMethodParams["recovery.checkpoint.list"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryCheckpointList(params, this.grant, signal);
  }

  recoveryEntryResolve(params: KernelMethodParams["recovery.entry.resolve"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryEntryResolve(params, this.grant, signal);
  }

  recoveryChangeBefore(params: KernelMethodParams["recovery.change.before"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryChangeBefore(params, this.grant, signal);
  }

  recoveryChangeGet(params: KernelMethodParams["recovery.change.get"], signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.owner.recoveryChangeGet(params, this.grant, signal);
  }

  recoveryChangeList(params: KernelMethodParams["recovery.change.list"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryChangeList(params, this.grant, signal);
  }

  recoveryChangeAfter(params: KernelMethodParams["recovery.change.after"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryChangeAfter(params, this.grant, signal);
  }

  recoveryOperationCreate(params: KernelMethodParams["recovery.operation.create"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryOperationCreate(params, this.grant, signal);
  }

  recoveryOperationFileCas(params: KernelMethodParams["recovery.operation.file.cas"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryOperationFileCas(params, this.grant, signal);
  }

  recoveryOperationComplete(params: KernelMethodParams["recovery.operation.complete"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryOperationComplete(params, this.grant, signal);
  }

  recoveryOperationList(params: KernelMethodParams["recovery.operation.list"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryOperationList(params, this.grant, signal);
  }

  recoveryOperationRelease(params: KernelMethodParams["recovery.operation.release"], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.recoveryOperationRelease(params, this.grant, signal);
  }

  releaseBlob(ownerId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseBlob(ownerId, this.grant, signal);
  }

  rebindObjectOwner(workspaceId: string, ownerId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.rebindObjectOwner(workspaceId, ownerId, this.grant, signal);
  }

  releaseOperation(operationId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseOperation(operationId, this.grant, signal);
  }

  putRecord(params: KernelMethodParams["storage.record.put"], signal?: AbortSignal): Promise<KernelRecordResult> {
    return this.owner.putRecord(params, this.grant, signal);
  }

  workingResultPut(params: KernelMethodParams["working.result.put"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingResultPut(params, this.grant, signal); }
  workingResultGet(params: KernelMethodParams["working.result.get"], signal?: AbortSignal): Promise<Record<string, unknown> | null> { return this.owner.workingResultGet(params, this.grant, signal); }
  workingResultList(params: KernelMethodParams["working.result.list"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingResultList(params, this.grant, signal); }
  workingResultRelease(params: KernelMethodParams["working.result.release"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingResultRelease(params, this.grant, signal); }
  workingDraftPut(params: KernelMethodParams["working.draft.put"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingDraftPut(params, this.grant, signal); }
  workingDraftGet(params: KernelMethodParams["working.draft.get"], signal?: AbortSignal): Promise<Record<string, unknown> | null> { return this.owner.workingDraftGet(params, this.grant, signal); }
  workingDraftList(params: KernelMethodParams["working.draft.list"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingDraftList(params, this.grant, signal); }
  workingDraftRelease(params: KernelMethodParams["working.draft.release"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingDraftRelease(params, this.grant, signal); }
  workingVerificationPut(params: KernelMethodParams["working.verification.put"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingVerificationPut(params, this.grant, signal); }
  workingVerificationList(params: KernelMethodParams["working.verification.list"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingVerificationList(params, this.grant, signal); }
  workingVerificationRelease(params: KernelMethodParams["working.verification.release"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingVerificationRelease(params, this.grant, signal); }
  workingReviewPut(params: KernelMethodParams["working.review.put"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingReviewPut(params, this.grant, signal); }
  workingReviewList(params: KernelMethodParams["working.review.list"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingReviewList(params, this.grant, signal); }
  workingReviewRelease(params: KernelMethodParams["working.review.release"], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.owner.workingReviewRelease(params, this.grant, signal); }

  getRecord(workspaceId: string, recordId: string, signal?: AbortSignal): Promise<KernelRecordResult | null> {
    return this.owner.getRecord({ workspaceId, recordId }, this.grant, signal);
  }

  listRecords(params: KernelMethodParams["storage.record.list"], signal?: AbortSignal): Promise<KernelRecordListResult> {
    return this.owner.listRecords(params, this.grant, signal);
  }

  releaseRecord(operationId: string, workspaceId: string, recordId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.owner.releaseRecord({ operationId, workspaceId, recordId }, this.grant, signal);
  }

  close(): Promise<void> { return this.owner.close(); }
}

interface PendingRequest {
  release(): void;
  cancel(): void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  grantId?: string | undefined;
}

const frame = (payload: string): Buffer => {
  const body = Buffer.from(payload, "utf8");
  if (body.byteLength > 16 * 1024 * 1024) throw new KernelClientError({ code: "kernel-frame-too-large", message: "Rust kernel frame exceeds transport limit", retryable: false });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

const KERNEL_BATCH_TARGET_BYTES = 512 * 1024;

const batchForKernelTransport = <T>(values: readonly T[]): T[][] => {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const value of values) {
    const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (batch.length > 0 && batchBytes + valueBytes > KERNEL_BATCH_TARGET_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(value);
    batchBytes += valueBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
};

const normalizeStorageIdentity = (value: string): string => {
  const withoutDevicePrefix = process.platform === "win32" && value.startsWith("\\\\?\\") ? value.slice(4) : value;
  const normalized = path.normalize(withoutDevicePrefix);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const canonicalStoragePath = (value: string): string => {
  try { return fs.realpathSync.native(value); } catch { /* the kernel creates a missing leaf */ }
  try {
    return path.join(fs.realpathSync.native(path.dirname(value)), path.basename(value));
  } catch {
    return path.resolve(value);
  }
};

interface KernelManifest {
  schema: number;
  executable: string;
  targetTriple: string;
  platform: string;
  arch: string;
  binaryFormat: "pe" | "elf" | "macho";
  buildIdentity: string;
  protocolVersion: number;
  kernelVersion: string;
  sha256: string;
}

const defaultKernelCandidates = (): string[] => {
  const extension = process.platform === "win32" ? ".exe" : "";
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.VARIN_KERNEL_PATH?.trim() || "",
    path.resolve(moduleDirectory, "../../../../../kernel", `varin-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../../kernel", `varin-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../kernel", "target", "release", `varin-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../../kernel", "target", "debug", `varin-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../../kernel", `varin-kernel${extension}`),
    path.resolve(moduleDirectory, "../../../kernel", `varin-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", `varin-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "release", `varin-kernel${extension}`),
    path.resolve(process.cwd(), "kernel", "target", "debug", `varin-kernel${extension}`),
  ].filter(Boolean);
};

const resolveKernelCommand = (options: KernelClientOptions): { command: string; args: string[]; manifestPath?: string } => {
  const explicit = options.kernelPath?.trim() || defaultKernelCandidates().find((candidate) => fs.existsSync(candidate));
  if (explicit) {
    const manifestPath = path.join(path.dirname(explicit), "manifest.json");
    return { command: explicit, args: [], ...(fs.existsSync(manifestPath) ? { manifestPath } : {}) };
  }
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const manifest = [
    path.resolve(moduleDirectory, "../../../../../kernel/Cargo.toml"),
    path.resolve(process.cwd(), "kernel", "Cargo.toml"),
  ].find((candidate) => fs.existsSync(candidate));
  const allowCargo = options.allowCargoDevRunner ?? process.env.NODE_ENV !== "production";
  if (allowCargo && manifest) {
    return { command: process.platform === "win32" ? "cargo.exe" : "cargo", args: ["run", "--quiet", "--manifest-path", manifest, "--bin", "varin-kernel"] };
  }
  throw new KernelClientError({
    code: "kernel-entry-unavailable",
    message: "Varin Rust kernel executable is unavailable; build the kernel or set VARIN_KERNEL_PATH",
    retryable: false,
  });
};

export class KernelClient {
  private readonly options: KernelClientOptions;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly processSubscriptions = new Map<string, ProcessSubscriptionEntry>();
  private readonly nativeRuntimeListeners = new Set<(event: NativeRuntimeStreamEvent) => void>();
  onNativeRuntimeEvent(listener: (event: NativeRuntimeStreamEvent) => void): () => void {
    this.nativeRuntimeListeners.add(listener);
    return () => this.nativeRuntimeListeners.delete(listener);
  }
  private readonly credentialBridge: NativeCredentialBridge;
  private window = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
  private nativeWindow = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
  private closePromise: Promise<void> | undefined;
  private readonly revokedGrants = new Set<string>();
  private started = false;
  private transportFailed = false;
  private readonly exitListeners = new Set<(error: Error) => void>();
  private closed = false;
  private epoch: string | null = null;
  private readonly clientToken = Symbol("varin-kernel-client");
  private managementGrant: InternalGrantHandle | null = null;
  private handshakeResult: KernelHandshakeResult | null = null;
  private startPromise: Promise<KernelHandshakeResult> | null = null;

  constructor(options: KernelClientOptions) {
    this.options = options;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.credentialBridge = new NativeCredentialBridge(() => this.epoch,
      response => this.write(response),
      () => this.failAll(new KernelClientError({ code: "credential-channel-failed", message: "Private credential channel failed", retryable: false }), true));
  }

  get isReady(): boolean { return this.started && !this.closed; }
  subscribeExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }


  /** Host-only owner registration. This is not exposed through tool grants or renderer APIs. */
  async registerNativeCredentialOwner(runId: string, owner: ExistingHostCredentialOwner): Promise<NativeCredentialScope> {
    if (!this.handshakeResult) await this.start();
    return this.credentialBridge.register(runId, owner);
  }
  unregisterNativeCredentialOwner(runId: string): void { this.credentialBridge.unregister(runId); }

  get kernelEpoch(): string | null { return this.epoch; }
  get handshake(): KernelHandshakeResult | null { return this.handshakeResult; }

  private assertGrant(grant: KernelGrantHandle | undefined): InternalGrantHandle {
    if (!grant || (grant as InternalGrantHandle).clientToken !== this.clientToken) {
      throw new KernelClientError({ code: "kernel-grant-required", message: "A scoped kernel grant handle is required", retryable: false });
    }
    const internal = grant as InternalGrantHandle;
    if (!this.epoch || internal.kernelEpoch !== this.epoch || internal.grantId.length === 0) {
      throw new KernelClientError({ code: "kernel-grant-stale", message: "The kernel grant handle belongs to an old epoch", retryable: true });
    }
    return internal;
  }

  /** Create a client whose every domain call carries this explicit actor grant. */
  scoped(grant: KernelGrantHandle): KernelScopedClient {
    return new KernelScopedClient(this, grant);
  }

  /** @internal used by KernelScopedClient; callers should use scoped(). */
  assertGrantForScope(grant: KernelGrantHandle): KernelGrantHandle {
    return this.assertGrant(grant);
  }

  private grantFromResponse(value: Record<string, unknown>): InternalGrantHandle {
    const grantId = typeof value.grant_id === "string" ? value.grant_id : "";
    const epoch = typeof value.kernel_epoch === "string" ? value.kernel_epoch : "";
    if (!grantId || !epoch) throw new KernelClientError({ code: "kernel-grant-invalid", message: "Rust kernel returned an incomplete grant handle", retryable: false });
    return Object.freeze({
      clientToken: this.clientToken,
      grantId,
      kernelEpoch: epoch,
      hostGeneration: String(value.host_generation ?? ""),
      authorityInstanceId: typeof value.authority_instance_id === "string" ? value.authority_instance_id : null,
      workerId: typeof value.worker_id === "string" ? value.worker_id : null,
      workerGeneration: typeof value.worker_generation === "number" ? value.worker_generation : null,
      sessionId: typeof value.session_id === "string" ? value.session_id : null,
      threadId: typeof value.thread_id === "string" ? value.thread_id : null,
      runId: typeof value.run_id === "string" ? value.run_id : null,
      owningWorkspace: typeof value.owning_workspace === "string" ? value.owning_workspace : null,
      executionWorkspace: typeof value.execution_workspace === "string" ? value.execution_workspace : null,
      capabilities: Object.freeze(Array.isArray(value.capabilities) ? value.capabilities.filter((entry): entry is string => typeof entry === "string") : []),
      pathScopes: Object.freeze(Array.isArray(value.path_scopes) ? value.path_scopes.filter((entry): entry is string => typeof entry === "string") : []),
      storageIdentity: String(value.storage_identity ?? ""),
    });
  }

  private isManagementMethod(method: KernelMethod): boolean {
    return method === "kernel.ping" || method === "kernel.shutdown" || method === "storage.health";
  }

  async start(): Promise<KernelHandshakeResult> {
    if (this.handshakeResult) return this.handshakeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { return await this.startPromise; } finally { this.startPromise = null; }
  }

  private async startInternal(): Promise<KernelHandshakeResult> {
    if (this.closed) throw new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closed" });
    const command = resolveKernelCommand(this.options);
    let manifest: KernelManifest | null = null;
    if (command.manifestPath) {
      try {
        manifest = JSON.parse(await fs.promises.readFile(command.manifestPath, "utf8")) as KernelManifest;
        const bytes = await fs.promises.readFile(command.command);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (manifest.schema !== 3 || manifest.sha256 !== digest || manifest.protocolVersion !== KERNEL_PROTOCOL_VERSION
          || manifest.platform !== process.platform || manifest.arch !== (this.options.targetArch ?? process.arch)
          || (this.options.targetTriple !== undefined && manifest.targetTriple !== this.options.targetTriple)
          || (this.options.kernelBuildIdentity !== undefined && manifest.buildIdentity !== this.options.kernelBuildIdentity)) {
          throw new KernelClientError({ code: "kernel-manifest-mismatch", message: "Rust kernel manifest does not match this Host", retryable: false });
        }
      } catch (error) {
        if (error instanceof KernelClientError) throw error;
        throw new KernelClientError({ code: "kernel-manifest-invalid", message: `Rust kernel manifest is invalid: ${String(error)}`, retryable: false });
      }
    } else if (this.options.requireKernelManifest ?? process.env.NODE_ENV === "production") {
      throw new KernelClientError({ code: "kernel-manifest-missing", message: "Rust kernel manifest is required for this Host", retryable: false });
    }
    this.window = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
    this.nativeWindow = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
    this.transportFailed = false;
    this.revokedGrants.clear();
    const child = this.spawnProcess(command.command, [...command.args, "--stdio"], {
      cwd: this.options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        VARIN_KERNEL_BUILD_IDENTITY: this.options.kernelBuildIdentity ?? this.options.buildVersion,
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on("error", (error) => {
      if (this.child !== child) return;
      this.failAll(new KernelClientError({
        code: "kernel-disconnected",
        message: `Rust kernel stdin failed: ${error.message}`,
        retryable: true,
      }));
    });
    child.stdout.on("data", (chunk: Buffer | string) => { if (this.child === child) this.consume(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => {
      // stderr is intentionally separate from the protocol. Keep it out of
      // request responses; the Host can attach a logger at the process layer.
      if (process.env.VARIN_KERNEL_DEBUG === "1") process.stderr.write(chunk);
    });
    child.once("error", (error) => this.failAll(new KernelClientError({ code: "kernel-spawn-failed", message: error.message, retryable: true })));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const error = new KernelClientError({
        code: "kernel-exited",
        message: `Rust kernel exited (${signal ?? code ?? "unknown"})`,
        retryable: true,
      });
      this.failAll(error);
      if (!this.closed) this.options.onExit?.(error);
    });
    let result: KernelHandshakeResult;
    try {
    result = await this.requestRaw<KernelHandshakeResult>("kernel.handshake", {
        protocolVersion: KERNEL_PROTOCOL_VERSION,
        buildVersion: this.options.buildVersion,
        hostId: this.options.hostId,
        hostGeneration: this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`,
        storageRoot: this.options.storageRoot,
        capabilities: ["storage", "workingState", "recovery", "branchCas", "pins", "gc"],
      }, { allowBootstrap: true });
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    const requiredCapabilities = ["storage", "workingState", "recovery", "branchCas", "pins", "gc"];
    const expectedHostGeneration = this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`;
    if (result.protocolVersion !== KERNEL_PROTOCOL_VERSION || result.requestWindow !== KERNEL_REQUEST_WINDOW || !result.kernelEpoch || result.applicationBuildVersion !== this.options.buildVersion
      || result.buildVersion !== result.kernelBuildIdentity
      || (manifest && (result.kernelBuildIdentity !== manifest.buildIdentity || result.targetTriple !== manifest.targetTriple || result.arch !== manifest.arch))
      || (this.options.kernelBuildIdentity !== undefined && result.kernelBuildIdentity !== this.options.kernelBuildIdentity)
      || result.hostId !== this.options.hostId || result.hostGeneration !== expectedHostGeneration
      || normalizeStorageIdentity(result.storageRoot) !== normalizeStorageIdentity(canonicalStoragePath(this.options.storageRoot))
      || !requiredCapabilities.every((capability) => result.capabilities.includes(capability))) {
      await this.close().catch(() => undefined);
      throw new KernelClientError({ code: "kernel-protocol-mismatch", message: "Rust kernel handshake returned an incompatible protocol", retryable: false });
    }
    this.epoch = result.kernelEpoch;
    this.handshakeResult = result;
    this.started = true;
    const managementGrant = await this.requestRaw<Record<string, unknown>>("authority.grant.issue", {
      grantId: `host-management:${this.options.hostId}:${process.pid}`,
      hostGeneration: expectedHostGeneration,
      sessionId: null,
      threadId: null,
      runId: null,
      owningWorkspace: null,
      executionWorkspace: null,
      storageIdentity: result.storageRoot,
      capabilities: ["storage.read", "storage.gc"],
      pathScopes: [""],
    }, { allowBootstrap: true });
    this.managementGrant = this.grantFromResponse(managementGrant);
    return result;
  }

  private consume(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > 16 * 1024 * 1024) {
        this.failAll(new KernelClientError({ code: "kernel-frame-too-large", message: "Rust kernel response exceeds transport limit", retryable: false }), true);
        return;
      }
      if (this.buffer.byteLength < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let response: KernelResponse | KernelProcessStreamEvent | NativeRuntimeStreamEvent;
      try { response = JSON.parse(body.toString("utf8")) as KernelResponse | KernelProcessStreamEvent | NativeRuntimeStreamEvent; }
      catch (error) { this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: `Invalid Rust kernel response: ${String(error)}`, retryable: false }), true); return; }
      if (this.credentialBridge.consume(response)) continue;
      if (response.kind === "runtime-event") {
        if (response.v !== KERNEL_PROTOCOL_VERSION || response.kernelEpoch !== this.epoch
          || !["durable", "progress"].includes(response.stream)
          || (response.stream === "durable" && (!Number.isSafeInteger(response.cursor) || response.cursor < 0))
          || (response.stream === "progress" && (typeof response.runId !== "string" || typeof response.streamId !== "string"
            || !Number.isSafeInteger(response.sequence) || response.sequence < 0))) {
          this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: "Malformed native runtime event", retryable: false }), true);
          return;
        }
        for (const listener of this.nativeRuntimeListeners) {
          // Presentation consumers cannot take down the authority transport.
          try { listener(response); } catch { this.nativeRuntimeListeners.delete(listener); }
        }
        continue;
      }
      if (response.kind === "process-event") {
        this.consumeProcessEvent(response);
        if (this.transportFailed) return;
        continue;
      }
      if (response.v !== KERNEL_PROTOCOL_VERSION || response.kind !== "response" || typeof response.id !== "string" || typeof response.ok !== "boolean") {
        this.failAll(new KernelClientError({ code: "kernel-protocol-error", message: "Rust kernel response envelope is malformed", retryable: false }), true);
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      pending.release();
      if (response.ok) pending.resolve(response.result);
      else {
        pending.reject(new KernelClientError(response.error ?? { code: "kernel-error", message: "Rust kernel request failed" }));
      }
    }
  }

  private consumeProcessEvent(event: KernelProcessStreamEvent): void {
    const invalid = (message: string) => this.failAll(new KernelClientError({ code: "kernel-protocol-error", message, retryable: false }), true);
    if (event.v !== KERNEL_PROTOCOL_VERSION || typeof event.subscriptionId !== "string" || typeof event.kernelEpoch !== "string"
      || typeof event.grantId !== "string" || typeof event.processId !== "string" || !Number.isSafeInteger(event.sequence)
      || !["control", "data", "closed"].includes(event.stream)) { invalid("Malformed process stream envelope"); return; }
    const entry = this.processSubscriptions.get(event.subscriptionId);
    if (!entry || entry.closed || this.revokedGrants.has(entry.grant.grantId)) return;
    if (event.kernelEpoch !== this.epoch || event.kernelEpoch !== entry.grant.kernelEpoch || event.grantId !== entry.grant.grantId || event.processId !== entry.processId) {
      invalid("Process stream actor or epoch mismatch"); return;
    }
    if (event.stream === "closed") {
      if (typeof event.error !== "string") { invalid("Closed process stream omitted its reason"); return; }
      entry.closed = true; this.processSubscriptions.delete(entry.id); entry.reject(new Error(event.error));
    } else {
      if (event.result === null || typeof event.result !== "object" || event.error !== null) { invalid("Process stream omitted its typed result"); return; }
      const key = event.stream === "data" ? "dataSequence" : "controlSequence";
      if (event.sequence !== entry[key] + 1) { invalid("Process stream sequence is not contiguous"); return; }
      entry[key] = event.sequence;
    }
    try { entry.listener(event); }
    catch (error) {
      entry.closed = true; this.processSubscriptions.delete(entry.id);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      void this.requestRaw("process.subscription.unsubscribe", { subscriptionId: entry.id }, { grant: entry.grant }).catch(() => undefined);
    }
  }

  private failAll(error: Error, terminate = false): void {
    if (this.transportFailed) {
      if (terminate && this.child && !this.child.killed) this.child.kill();
      return;
    }
    this.transportFailed = true;
    this.credentialBridge.close();
    this.window.close(error);
    this.nativeWindow.close(error);
    for (const pending of this.pending.values()) { pending.reject(error); pending.release(); }
    this.pending.clear();
    for (const entry of this.processSubscriptions.values()) { entry.closed = true; entry.reject(error); }
    this.processSubscriptions.clear();
    for (const listener of this.exitListeners) {
      try { listener(error); } catch { /* A projection cannot prevent other handle invalidations. */ }
    }
    this.started = false;
    this.epoch = null;
    this.managementGrant = null;
    this.handshakeResult = null;
    this.buffer = Buffer.alloc(0);
    if (terminate && this.child && !this.child.killed) this.child.kill();
  }

  private async write(request: KernelRequest | PrivateCredentialResponse): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new KernelClientError({ code: "kernel-disconnected", message: "Rust kernel stdin is unavailable", retryable: true });
    const writable = stdin as Writable;
    // The callback settles on delivery or stream failure, including destruction
    // while backpressured. Waiting only for 'drain' can hang after disconnect.
    await new Promise<void>((resolve, reject) => writable.write(frame(JSON.stringify(request)), error => error ? reject(error) : resolve()));
  }

  private async requestRaw<T, M extends KernelMethod = KernelMethod>(method: M, params: KernelMethodParams[M], options: { signal?: AbortSignal | undefined; grant?: KernelGrantHandle | undefined; allowBootstrap?: boolean | undefined; settleCancellation?: boolean | undefined } = {}): Promise<T> {
    const cancelled = () => new KernelClientError({ code: "cancelled", message: "Kernel request cancelled", retryable: true });
    const release = this.closed && method === "kernel.shutdown" ? () => undefined : await (method.startsWith("runtime.") || method.startsWith("process.subscription.") ? this.nativeWindow : this.window).acquire(options.signal, cancelled);
    let admitted = false;
    try {
      if (this.closed && method !== "kernel.shutdown") throw new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closed" });
      if (options.signal?.aborted) throw cancelled();
      const id = randomUUID();
      const grant = options.grant ? this.assertGrant(options.grant) : this.isManagementMethod(method) ? this.managementGrant : null;
      if (grant && this.revokedGrants.has(grant.grantId)) throw new KernelClientError({ code: "forbidden", message: "Kernel grant was revoked" });
      if (this.epoch && !grant && !options.allowBootstrap && method !== "kernel.handshake" && method !== "authority.grant.issue" && method !== "authority.grant.revoke") {
        throw new KernelClientError({ code: "kernel-grant-required", message: "A scoped grant is required for " + method, retryable: false });
      }
      const identity = { ...(this.epoch ? { epoch: this.epoch } : {}), ...(grant ? { grantId: grant.grantId } : {}) };
      const request = { v: KERNEL_PROTOCOL_VERSION, kind: "request", id, method, params, ...identity } as KernelRequest;
      let rejectPending!: (error: unknown) => void;
      let cancelSent = false;
      const abort = () => {
        if (!this.pending.has(id) || cancelSent) return;
        cancelSent = true;
        if (!options.settleCancellation) rejectPending(cancelled());
        // Keep the ledger entry/credit until Rust acknowledges the actual stop.
        // Control frames bypass the ordinary request window.
        void this.write({ v: KERNEL_PROTOCOL_VERSION, kind: "cancel", id, ...identity }).catch(error => this.failAll(error instanceof Error ? error : new Error(String(error)), true));
      };
      const promise = new Promise<T>((resolve, reject) => {
        rejectPending = reject;
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, release, cancel: abort, grantId: grant?.grantId });
      });
      admitted = true;
      void promise.catch(() => undefined);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        await this.write(request);
        return await promise;
      } catch (error) {
        if (!cancelSent && this.pending.has(id)) this.failAll(error instanceof Error ? error : new Error(String(error)), true);
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", abort);
      }
    } finally {
      if (!admitted) release();
    }
  }

  /** Native authority management. Never expose this Host-owned channel to tool grants. */
  async nativeRuntimeRequest<T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal): Promise<T> {
    if (!this.handshakeResult) await this.start();
    return this.requestRaw<T, M>(method, params, { signal, allowBootstrap: true });
  }

  async health(options: { deep?: boolean; signal?: AbortSignal | undefined } = {}): Promise<KernelHealthResult> {
    if (!this.handshakeResult) await this.start();
    return this.requestRaw<KernelHealthResult>("storage.health", options.deep === undefined ? {} : { deep: options.deep }, { signal: options.signal });
  }

  async snapshot(workspaceId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.snapshot", { workspaceId }, { signal, grant });
  }

  async putBlob(bytes: Uint8Array, operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelPutBlobResult> {
    const scoped = this.assertGrant(grant);
    const source = Buffer.from(bytes);
    const expectedHash = `sha256-${createHash("sha256").update(source).digest("hex")}`;
    const existing = await this.getOperation(operationId, scoped, signal).catch(() => null);
    if (existing?.state === "committed" && existing.result && typeof existing.result === "object") {
      const result = existing.result as Partial<KernelPutBlobResult>;
      if (result.hash === expectedHash && result.byteLength === source.byteLength && typeof result.ownerId === "string") return result as KernelPutBlobResult;
    }
    const streamId = `blob-${randomUUID()}`;
    try {
      const begin = await this.requestRaw<Record<string, unknown>>("storage.putBlob.begin", {
        operationId,
        streamId,
        byteLength: source.byteLength,
        expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
      if (begin.streamId !== streamId) throw new KernelClientError({ code: "kernel-stream-invalid", message: "Rust kernel returned a different upload stream identity", retryable: false });
      const chunkSize = 64 * 1024;
      let sequence = 0;
      for (let offset = 0; offset < source.byteLength; offset += chunkSize) {
        signal?.throwIfAborted();
        const chunk = source.subarray(offset, Math.min(offset + chunkSize, source.byteLength));
        const receipt = await this.requestRaw<{ sequence: number }>("storage.putBlob.chunk", {
          streamId, sequence, bytesBase64: chunk.toString("base64"),
        }, { signal, grant: scoped });
        if (receipt.sequence !== sequence) throw new Error("Kernel acknowledged a different upload sequence");
        sequence += 1;
      }
      return await this.requestRaw<KernelPutBlobResult>("storage.putBlob.finish", {
        operationId,
        streamId,
        expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("storage.putBlob.abort", {
        operationId,
        streamId,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async putBlobStream(
    chunks: AsyncIterable<Uint8Array>,
    input: { operationId: string; byteLength: number; expectedHash: string },
    grant: KernelGrantHandle,
    signal?: AbortSignal,
  ): Promise<KernelPutBlobResult> {
    const scoped = this.assertGrant(grant);
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
      throw new Error("Blob stream byteLength must be a non-negative safe integer");
    }
    if (!/^sha256-[0-9a-f]{64}$/.test(input.expectedHash)) {
      throw new Error("Blob stream expectedHash must be a sha256 object identity");
    }
    const existing = await this.getOperation(input.operationId, scoped, signal).catch(() => null);
    if (existing?.state === "committed" && existing.result && typeof existing.result === "object") {
      const result = existing.result as Partial<KernelPutBlobResult>;
      if (result.hash === input.expectedHash && result.byteLength === input.byteLength && typeof result.ownerId === "string") {
        return result as KernelPutBlobResult;
      }
    }
    const streamId = `blob-${randomUUID()}`;
    const digest = createHash("sha256");
    let received = 0;
    let sequence = 0;
    try {
      const begin = await this.requestRaw<Record<string, unknown>>("storage.putBlob.begin", {
        operationId: input.operationId,
        streamId,
        byteLength: input.byteLength,
        expectedHash: input.expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
      if (begin.streamId !== streamId) throw new KernelClientError({ code: "kernel-stream-invalid", message: "Rust kernel returned a different upload stream identity", retryable: false });
      for await (const value of chunks) {
        signal?.throwIfAborted();
        const source = Buffer.from(value);
        digest.update(source);
        received += source.byteLength;
        if (received > input.byteLength) throw new Error("Blob stream exceeded its declared byteLength");
        for (let offset = 0; offset < source.byteLength; offset += 64 * 1024) {
          const chunk = source.subarray(offset, Math.min(offset + 64 * 1024, source.byteLength));
          const receipt = await this.requestRaw<{ sequence: number }>("storage.putBlob.chunk", {
            streamId, sequence, bytesBase64: chunk.toString("base64"),
          }, { signal, grant: scoped });
          if (receipt.sequence !== sequence) throw new Error("Kernel acknowledged a different upload sequence");
          sequence += 1;
        }
      }
      const actualHash = `sha256-${digest.digest("hex")}`;
      if (received !== input.byteLength || actualHash !== input.expectedHash) {
        throw new Error("Blob stream content did not match its declared identity");
      }
      return await this.requestRaw<KernelPutBlobResult>("storage.putBlob.finish", {
        operationId: input.operationId,
        streamId,
        expectedHash: input.expectedHash,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("storage.putBlob.abort", {
        operationId: input.operationId,
        streamId,
        ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
      }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async getBlob(hash: string, source: KernelBlobReadSource, grant: KernelGrantHandle, options: { offset?: number; length?: number; signal?: AbortSignal | undefined } = {}): Promise<KernelObjectSlice> {
    const params: KernelGetBlobParams = { hash, ...source, ...(options.offset === undefined ? {} : { offset: options.offset }), ...(options.length === undefined ? {} : { length: options.length }) };
    return this.requestRaw<KernelObjectSlice>("storage.getBlob", params, { signal: options.signal, grant });
  }

  async fileRootRegister(params: KernelMethodParams["file.root.register"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.root.register", params, { signal, grant });
  }

  async fileOperationList(params: KernelMethodParams["file.operation.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.operation.list", params, { signal, grant });
  }

  async fileOperationReconcile(params: KernelMethodParams["file.operation.reconcile"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.operation.reconcile", params, { signal, grant });
  }

  async fileLeaseAcquire(params: KernelMethodParams["file.lease.acquire"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.lease.acquire", params, { signal, grant });
  }

  async fileLeaseCheck(params: KernelMethodParams["file.lease.check"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.lease.check", params, { signal, grant });
  }

  async fileLeaseRelease(params: KernelMethodParams["file.lease.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.lease.release", params, { signal, grant });
  }

  async fileCapture(params: KernelMethodParams["file.capture"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.capture", params, { signal, grant });
  }

  async fileCaptureBatch(params: KernelMethodParams["file.captureBatch"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.captureBatch", params, { signal, grant, settleCancellation: true });
  }

  async fileApply(params: KernelMethodParams["file.apply"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.apply", params, { signal, grant });
  }

  async fileMkdir(params: KernelMethodParams["file.mkdir"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.mkdir", params, { signal, grant });
  }

  async fileRemove(params: KernelMethodParams["file.remove"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.remove", params, { signal, grant });
  }

  async fileRename(params: KernelMethodParams["file.rename"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.rename", params, { signal, grant });
  }

  async fileScan(params: KernelMethodParams["file.scan"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.scan", params, { signal, grant });
  }

  async fileMeasure(params: KernelMethodParams["file.measure"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.measure", params, { signal, grant });
  }

  computeStart(params: KernelMethodParams["compute.start"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelComputeReadResult> {
    return this.requestRaw<KernelComputeReadResult>("compute.start", params, { signal, grant });
  }

  computeRead(params: KernelMethodParams["compute.read"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelComputeReadResult> {
    return this.requestRaw<KernelComputeReadResult>("compute.read", params, { signal, grant });
  }

  computeCancel(params: KernelMethodParams["compute.cancel"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("compute.cancel", params, { signal, grant });
  }

  computeRelease(params: KernelMethodParams["compute.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("compute.release", params, { signal, grant });
  }

  computeGrammarRegister(params: KernelMethodParams["compute.grammar.register"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("compute.grammar.register", params, { signal, grant });
  }

  async processSubscribe(params: Omit<KernelMethodParams["process.subscribe"], "subscriptionId">, grantValue: KernelGrantHandle,
    observer: KernelProcessObserver): Promise<KernelProcessSubscription> {
    const grant = this.assertGrant(grantValue);
    const subscriptionId = randomUUID();
    let resolve!: () => void; let reject!: (error: Error) => void;
    const closed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closed.catch(() => undefined);
    const entry: ProcessSubscriptionEntry = { id: subscriptionId, processId: params.processId, grant, listener: () => undefined,
      dataSequence: 0, controlSequence: 0, closed: false, resolve, reject };
    let closing: Promise<void> | undefined;
    const handle: KernelProcessSubscription = {
      closed,
      acknowledge: async (stream, sequence) => {
        if (entry.closed) return;
        await this.requestRaw("process.subscription.ack", { subscriptionId, stream, sequence }, { grant });
      },
      close: () => {
        if (closing) return closing;
        if (entry.closed) return Promise.resolve();
        entry.closed = true; this.processSubscriptions.delete(subscriptionId);
        closing = this.requestRaw("process.subscription.unsubscribe", { subscriptionId }, { grant }).then(() => { resolve(); }, (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error)); reject(failure); throw failure;
        });
        return closing;
      },
    };
    entry.listener = event => observer(event, () => event.stream === "closed" ? Promise.resolve() : handle.acknowledge(event.stream, event.sequence));
    // Register before sending: the initial control/data frame may precede the subscribe reply.
    this.processSubscriptions.set(subscriptionId, entry);
    try {
      const result = await this.requestRaw<KernelProcessSubscribeResult>("process.subscribe", { ...params, subscriptionId }, { grant });
      if (result.subscriptionId !== subscriptionId || result.processId !== params.processId || result.kernelEpoch !== grant.kernelEpoch) {
        throw new KernelClientError({ code: "kernel-protocol-error", message: "Process subscription identity mismatch" });
      }
      return handle;
    } catch (error) {
      entry.closed = true; this.processSubscriptions.delete(subscriptionId);
      reject(error instanceof Error ? error : new Error(String(error))); throw error;
    }
  }

  async processSpawn(params: KernelMethodParams["process.spawn"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.requestRaw<KernelProcessSnapshot>("process.spawn", params, { signal, grant });
  }

  async processRead(params: KernelMethodParams["process.read"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessReadResult> {
    return this.requestRaw<KernelProcessReadResult>("process.read", params, { signal, grant });
  }

  async processWrite(params: KernelMethodParams["process.write"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessWriteResult> {
    return this.requestRaw<KernelProcessWriteResult>("process.write", params, { signal, grant });
  }

  async processResize(params: KernelMethodParams["process.resize"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("process.resize", params, { signal, grant });
  }

  async processKill(params: KernelMethodParams["process.kill"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("process.kill", params, { signal, grant });
  }

  async processInspect(params: KernelMethodParams["process.inspect"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.requestRaw<KernelProcessSnapshot>("process.inspect", params, { signal, grant });
  }

  async processList(params: KernelMethodParams["process.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessListResult> {
    return this.requestRaw<KernelProcessListResult>("process.list", params, { signal, grant });
  }

  async processRelease(params: KernelMethodParams["process.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelProcessSnapshot> {
    return this.requestRaw<KernelProcessSnapshot>("process.release", params, { signal, grant });
  }

  async fileMaterialize(params: KernelMethodParams["file.materialize"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("file.materialize", params, { signal, grant });
  }

  async createBranch(params: KernelCreateBranchInput, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scoped = this.assertGrant(grant);
    const builderId = `branch-builder-${randomUUID()}`;
    try {
      await this.requestRaw<Record<string, unknown>>("branch.create.begin", {
        operationId: params.operationId,
        builderId,
        branchId: params.branchId,
        workspaceId: params.workspaceId,
        ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
        ...(params.parentRef === undefined ? {} : { parentRef: params.parentRef }),
        draftBasePaths: params.draftBasePaths,
        captureScopes: params.captureScopes,
      }, { signal, grant: scoped });
      let sequence = 0;
      for (const batch of batchForKernelTransport(params.entries)) {
        await this.requestRaw<Record<string, unknown>>("branch.create.append", { builderId, sequence, entries: batch }, { signal, grant: scoped });
        sequence += 1;
      }
      return await this.requestRaw<Record<string, unknown>>("branch.create.finish", { operationId: params.operationId, builderId }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("branch.create.abort", { builderId }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async readBranch(params: { branchId: string; revision?: number; paths?: string[]; roots?: string[]; includeEntries?: boolean; cursor?: number; pageSize?: number }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelBranchReadResult> {
    return this.requestRaw<KernelBranchReadResult>("branch.read", params, { signal, grant });
  }

  async writeBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; changes: KernelBranchChange[]; baseRef?: string; parentRef?: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelWriteResult> {
    const scoped = this.assertGrant(grant);
    const builderId = `branch-write-${randomUUID()}`;
    try {
      await this.requestRaw<Record<string, unknown>>("branch.write.begin", {
        operationId: params.operationId,
        builderId,
        branchId: params.branchId,
        expectedWriteRevision: params.expectedWriteRevision,
      }, { signal, grant: scoped });
      let sequence = 0;
      for (const batch of batchForKernelTransport(params.changes)) {
        await this.requestRaw<Record<string, unknown>>("branch.write.append", { builderId, sequence, changes: batch }, { signal, grant: scoped });
        sequence += 1;
      }
      return await this.requestRaw<KernelWriteResult>("branch.write.finish", {
        operationId: params.operationId,
        builderId,
        ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
        ...(params.parentRef === undefined ? {} : { parentRef: params.parentRef }),
      }, { signal, grant: scoped });
    } catch (error) {
      await this.requestRaw<Record<string, unknown>>("branch.write.abort", { builderId }, { grant: scoped }).catch(() => undefined);
      throw error;
    }
  }

  async publishBranch(params: { operationId: string; branchId: string; expectedWriteRevision: number; expectedRoot: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.publish", params, { signal, grant });
  }

  async pinBranch(params: KernelMethodParams["branch.pin"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.pin", params, { signal, grant });
  }

  async unpinBranch(params: { operationId: string; branchId: string; pinId: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.unpin", params, { signal, grant });
  }

  async diffRoots(params: { leftRoot: string; rightRoot: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.diff", params, { signal, grant });
  }

  async branchObjects(params: { branchId: string; includeRevisions?: boolean; cursor?: number; pageSize?: number }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.objects", params, { signal, grant });
  }

  async deleteBranch(params: { operationId: string; branchId: string }, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("branch.delete", params, { signal, grant });
  }

  async readPin(params: KernelMethodParams["pin.read"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("pin.read", params, { signal, grant });
  }

  async gc(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.gc", { operationId }, { signal, grant });
  }

  async getOperation(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("operation.get", { operationId }, { signal, grant });
  }

  async recoveryOperationGet(params: KernelMethodParams["recovery.operation.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("recovery.operation.get", params, { signal, grant });
  }

  async recoveryTurnStart(params: KernelMethodParams["recovery.turn.start"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.turn.start", params, { signal, grant });
  }

  async recoveryTurnGet(params: KernelMethodParams["recovery.turn.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("recovery.turn.get", params, { signal, grant });
  }

  async recoveryTurnSettle(params: KernelMethodParams["recovery.turn.settle"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.turn.settle", params, { signal, grant });
  }

  async recoveryCheckpointCreate(params: KernelMethodParams["recovery.checkpoint.create"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.checkpoint.create", params, { signal, grant });
  }

  async recoveryCheckpointList(params: KernelMethodParams["recovery.checkpoint.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.checkpoint.list", params, { signal, grant });
  }

  async recoveryEntryResolve(params: KernelMethodParams["recovery.entry.resolve"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.entry.resolve", params, { signal, grant });
  }

  async recoveryChangeBefore(params: KernelMethodParams["recovery.change.before"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.change.before", params, { signal, grant });
  }

  async recoveryChangeGet(params: KernelMethodParams["recovery.change.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return this.requestRaw<Record<string, unknown> | null>("recovery.change.get", params, { signal, grant });
  }

  async recoveryChangeList(params: KernelMethodParams["recovery.change.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.change.list", params, { signal, grant });
  }

  async recoveryChangeAfter(params: KernelMethodParams["recovery.change.after"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.change.after", params, { signal, grant });
  }

  async recoveryOperationCreate(params: KernelMethodParams["recovery.operation.create"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.create", params, { signal, grant });
  }

  async recoveryOperationFileCas(params: KernelMethodParams["recovery.operation.file.cas"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.file.cas", params, { signal, grant });
  }

  async recoveryOperationComplete(params: KernelMethodParams["recovery.operation.complete"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.complete", params, { signal, grant });
  }

  async recoveryOperationList(params: KernelMethodParams["recovery.operation.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.list", params, { signal, grant });
  }

  async recoveryOperationRelease(params: KernelMethodParams["recovery.operation.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("recovery.operation.release", params, { signal, grant });
  }

  async issueGrant(params: KernelGrantIssueInput, signal?: AbortSignal): Promise<KernelGrantHandle> {
    if (!this.handshakeResult) await this.start();
    const grant = await this.requestRaw<Record<string, unknown>>("authority.grant.issue", {
      grantId: params.grantId,
      capabilities: params.capabilities,
      pathScopes: params.pathScopes,
      sessionId: params.sessionId ?? null,
      threadId: params.threadId ?? null,
      runId: params.runId ?? null,
      owningWorkspace: params.owningWorkspace ?? null,
      executionWorkspace: params.executionWorkspace ?? null,
      storageIdentity: params.storageIdentity ?? this.handshakeResult!.storageRoot,
      hostGeneration: params.hostGeneration ?? this.options.hostGeneration ?? `${this.options.hostId}:${process.pid}`,
      ...(params.authorityInstanceId === undefined ? {} : { authorityInstanceId: params.authorityInstanceId }),
      ...(params.workerId === undefined ? {} : { workerId: params.workerId }),
      ...(params.workerGeneration === undefined ? {} : { workerGeneration: params.workerGeneration }),
    }, { signal });
    this.revokedGrants.delete(String(grant.grant_id));
    return this.grantFromResponse(grant);
  }

  async revokeGrant(grantId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.handshakeResult) await this.start();
    this.revokedGrants.add(grantId);
    for (const [id, entry] of this.processSubscriptions) {
      if (entry.grant.grantId !== grantId) continue;
      entry.closed = true; this.processSubscriptions.delete(id);
      entry.reject(new KernelClientError({ code: "forbidden", message: "Process subscription grant was revoked" }));
    }
    for (const pending of this.pending.values()) if (pending.grantId === grantId) pending.cancel();
    return this.requestRaw<Record<string, unknown>>("authority.grant.revoke", { grantId }, { signal });
  }

  async releaseBlob(ownerId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.blob.release", { ownerId }, { signal, grant });
  }

  async rebindObjectOwner(workspaceId: string, ownerId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.object.rebindOwner", { workspaceId, ownerId }, { signal, grant });
  }

  async releaseOperation(operationId: string, grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scoped = this.assertGrant(grant);
    return this.requestRaw<Record<string, unknown>>("operation.release", {
      operationId,
      ...(scoped.owningWorkspace ? { workspaceId: scoped.owningWorkspace } : {}),
    }, { signal, grant: scoped });
  }

  async putRecord(params: KernelMethodParams["storage.record.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordResult> {
    return this.requestRaw<KernelRecordResult>("storage.record.put", params, { signal, grant });
  }

  async workingResultPut(params: KernelMethodParams["working.result.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.result.put", params, { signal, grant }); }
  async workingResultGet(params: KernelMethodParams["working.result.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> { return this.requestRaw("working.result.get", params, { signal, grant }); }
  async workingResultList(params: KernelMethodParams["working.result.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.result.list", params, { signal, grant }); }
  async workingResultRelease(params: KernelMethodParams["working.result.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.result.release", params, { signal, grant }); }
  async workingDraftPut(params: KernelMethodParams["working.draft.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.draft.put", params, { signal, grant }); }
  async workingDraftGet(params: KernelMethodParams["working.draft.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown> | null> { return this.requestRaw("working.draft.get", params, { signal, grant }); }
  async workingDraftList(params: KernelMethodParams["working.draft.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.draft.list", params, { signal, grant }); }
  async workingDraftRelease(params: KernelMethodParams["working.draft.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.draft.release", params, { signal, grant }); }
  async workingVerificationPut(params: KernelMethodParams["working.verification.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.verification.put", params, { signal, grant }); }
  async workingVerificationList(params: KernelMethodParams["working.verification.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.verification.list", params, { signal, grant }); }
  async workingVerificationRelease(params: KernelMethodParams["working.verification.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.verification.release", params, { signal, grant }); }
  async workingReviewPut(params: KernelMethodParams["working.review.put"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.review.put", params, { signal, grant }); }
  async workingReviewList(params: KernelMethodParams["working.review.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.review.list", params, { signal, grant }); }
  async workingReviewRelease(params: KernelMethodParams["working.review.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.requestRaw("working.review.release", params, { signal, grant }); }

  async getRecord(params: KernelMethodParams["storage.record.get"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordResult | null> {
    return this.requestRaw<KernelRecordResult | null>("storage.record.get", params, { signal, grant });
  }

  async listRecords(params: KernelMethodParams["storage.record.list"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<KernelRecordListResult> {
    return this.requestRaw<KernelRecordListResult>("storage.record.list", params, { signal, grant });
  }

  /**
   * Owning workspaces of a record type (cross-workspace enumeration for Host
   * recovery). Requires a maintenance-capable grant without an owning
   * workspace binding.
   */
  async recordWorkspaces(params: KernelMethodParams["storage.record.workspaces"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<{ workspaceIds: string[] }> {
    const result = await this.requestRaw<{ workspaceIds?: unknown }>("storage.record.workspaces", params, { signal, grant });
    const ids = result && Array.isArray(result.workspaceIds)
      ? result.workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return { workspaceIds: ids };
  }

  async releaseRecord(params: KernelMethodParams["storage.record.release"], grant: KernelGrantHandle, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestRaw<Record<string, unknown>>("storage.record.release", params, { signal, grant });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal().catch(error => { this.closePromise = undefined; throw error; });
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.credentialBridge.close();
    this.window.close(new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closing" }));
    this.nativeWindow.close(new KernelClientError({ code: "kernel-client-closed", message: "Kernel client is closing" }));
    for (const pending of this.pending.values()) pending.cancel();
    const child = this.child;
    if (!child) return;
    const bounded = async (work: Promise<unknown>): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    if (await bounded(Promise.all([this.window.whenIdle(), this.nativeWindow.whenIdle()])) && this.handshakeResult && !child.killed) {
      await bounded(this.requestRaw("kernel.shutdown", {}, { grant: this.managementGrant ?? undefined }));
    }
    const waitForExit = (): Promise<boolean> => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(false); }, 5_000);
      child.once("exit", onExit);
    });
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (!await waitForExit()) {
        child.kill();
        if (!await waitForExit()) throw new KernelClientError({ code: "kernel-stop-failed", message: "Rust kernel did not exit after termination", retryable: true });
      }
    }
    if (this.child === child) this.child = null;
  }
}

export const createKernelClient = (options: KernelClientOptions): KernelClient => new KernelClient(options);
