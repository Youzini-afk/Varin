/**
 * Generated from `kernel/protocol/schema.json`.
 * Do not hand-edit the wire shapes; run `node scripts/generate-kernel-protocol.mjs`.
 */

export const KERNEL_PROTOCOL_VERSION = 1 as const;
export const KERNEL_REQUEST_WINDOW = 2 as const;
export const KERNEL_PROTOCOL_SCHEMA = "varin.kernel.v1" as const;

export type KernelMethod =
  | "runtime.launch.select"
  | "runtime.launch.inspect"
  | "runtime.launch.list"
  | "runtime.input.enqueue"
  | "runtime.input.edit"
  | "runtime.input.cancel"
  | "runtime.input.inspect"
  | "runtime.input.list"
  | "runtime.run.start"
  | "runtime.status"
  | "runtime.thread.create"
  | "runtime.input.submit"
  | "runtime.run.inspect"
  | "runtime.run.cancel"
  | "runtime.operation.inspect"
  | "runtime.operation.cancel"
  | "runtime.history.read"
  | "runtime.events.read"
  | "process.subscribe"
  | "process.subscription.ack"
  | "process.subscription.unsubscribe"
  | "process.spawn"
  | "process.read"
  | "process.write"
  | "process.resize"
  | "process.kill"
  | "process.inspect"
  | "process.list"
  | "process.release"
  | "kernel.handshake"
  | "kernel.ping"
  | "kernel.shutdown"
  | "storage.health"
  | "authority.grant.issue"
  | "authority.grant.revoke"
  | "storage.snapshot"
  | "storage.putBlob.begin"
  | "storage.putBlob.chunk"
  | "storage.putBlob.finish"
  | "storage.putBlob.abort"
  | "storage.blob.release"
  | "storage.getBlob"
  | "storage.object.rebindOwner"
  | "file.root.register"
  | "file.operation.list"
  | "file.operation.reconcile"
  | "file.lease.acquire"
  | "file.lease.check"
  | "file.lease.release"
  | "file.capture"
  | "file.captureBatch"
  | "file.apply"
  | "file.mkdir"
  | "file.remove"
  | "file.rename"
  | "file.scan"
  | "file.measure"
  | "file.materialize"
  | "storage.record.put"
  | "storage.record.get"
  | "storage.record.list"
  | "storage.record.workspaces"
  | "storage.record.release"
  | "working.result.put"
  | "working.result.get"
  | "working.result.list"
  | "working.result.release"
  | "working.draft.put"
  | "working.draft.get"
  | "working.draft.list"
  | "working.draft.release"
  | "working.verification.put"
  | "working.verification.list"
  | "working.verification.release"
  | "working.review.put"
  | "working.review.list"
  | "working.review.release"
  | "branch.create.begin"
  | "branch.create.append"
  | "branch.create.finish"
  | "branch.create.abort"
  | "branch.read"
  | "branch.write.begin"
  | "branch.write.append"
  | "branch.write.finish"
  | "branch.write.abort"
  | "branch.publish"
  | "branch.pin"
  | "branch.unpin"
  | "branch.diff"
  | "branch.objects"
  | "branch.delete"
  | "pin.read"
  | "recovery.operation.get"
  | "recovery.turn.start"
  | "recovery.turn.get"
  | "recovery.turn.settle"
  | "recovery.checkpoint.create"
  | "recovery.checkpoint.list"
  | "recovery.entry.resolve"
  | "recovery.change.before"
  | "recovery.change.get"
  | "recovery.change.list"
  | "recovery.change.after"
  | "recovery.operation.create"
  | "recovery.operation.file.cas"
  | "recovery.operation.complete"
  | "recovery.operation.list"
  | "recovery.operation.release"
  | "operation.get"
  | "operation.release"
  | "storage.gc"
  | "compute.start"
  | "compute.read"
  | "compute.cancel"
  | "compute.release"
  | "compute.grammar.register";

export interface NativeLaunchSourceParams {
  materialized: boolean;
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string | null;
  revision: number | null;
}

export interface NativeLaunchSelectParams {
  runId: string;
  source: NativeLaunchSourceParams;
  enabledTools: string[];
  credentialScope?: NativeCredentialScope;
}

export interface NativeLaunchSource {
  materialized: boolean;
  workspace_id: string;
  execution_workspace_id: string;
  branch_id: string | null;
  revision: number | null;
}

export interface NativeLaunchTool {
  name: string;
  version: string;
  schema: unknown;
}

export interface NativeLaunchPolicy {
  name: string;
  version: string;
}

export interface NativeLaunchSelection {
  connection_identity: string;
  provider_family: string;
  model: string;
  configuration_generation: number;
  tool_schema_generation: number;
  tools: NativeLaunchTool[];
  policy: NativeLaunchPolicy;
  source: NativeLaunchSource | null;
}

export interface NativeLaunchIntent {
  run_id: string;
  revision: number;
  selection: NativeLaunchSelection;
  bound_epoch: number | null;
  requires_rebind: boolean;
}

export interface KernelProcessSubscribeParams {
  workspaceId: string;
  processId: string;
  subscriptionId: string;
  cursor: number;
}

export interface KernelProcessSubscriptionParams {
  subscriptionId: string;
}

export interface KernelProcessSubscriptionAckParams {
  subscriptionId: string;
  stream: string;
  sequence: number;
}

export interface KernelProcessSubscribeResult {
  subscriptionId: string;
  processId: string;
  kernelEpoch: string;
}

export interface KernelProcessStreamEvent {
  v: typeof KERNEL_PROTOCOL_VERSION;
  kind: "process-event";
  kernelEpoch: string;
  subscriptionId: string;
  grantId: string;
  processId: string;
  stream: "control" | "data" | "closed";
  sequence: number;
  result: KernelProcessReadResult | null;
  error: string | null;
}

export type NativeInputMode = "boundary" | "interrupt" | "next_run";

export type NativeInputState = "queued" | "delivered" | "cancelled";

export interface NativeInputEnqueueParams {
  key: string;
  threadId: string;
  branchId: string;
  mode: NativeInputMode;
  input: unknown;
  configuration?: unknown;
}

export interface NativeInputEditParams {
  inputId: string;
  expectedRevision: number;
  content: unknown;
}

export interface NativeInputCancelParams {
  inputId: string;
  expectedRevision: number;
}

export interface NativeInputHandleParams {
  inputId: string;
}

export interface NativeInputReceipt {
  input_id: string;
  run_id: string;
  mode: NativeInputMode;
  cursor: number;
}

export interface NativeQueuedInput {
  id: string;
  thread_id: string;
  branch_id: string;
  run_id: string;
  mode: NativeInputMode;
  state: NativeInputState;
  revision: number;
  content: unknown;
  cursor: number;
}

export interface NativeExternalReceipt {
  executor: string;
  identity: string;
  epoch: string;
  outcome: NativeOutcome;
  effect: NativeEffect;
  result: unknown;
}

export interface NativeRunStartParams {
  runId: string;
  toolBinding?: unknown;
  credentialScope?: NativeCredentialScope;
}

export interface NativeCredentialScope {
  reference: string;
  authority: string;
  account: string;
  generation: number;
}

export interface NativeModelSessionConfiguration {
  providerFamily: string;
  model: string;
  endpoint: string;
  credentialEnvironment: string | null;
  allowAnonymous: boolean;
  configurationGeneration: number;
  maxOutputTokens: number;
  azureDeployment?: string | null;
  azureApiVersion?: string | null;
  legacyMaxTokens?: boolean;
  includeStreamUsage?: boolean;
  reasoningEffort?: string | null;
}

export interface NativeRunStartReceipt {
  runId: string;
  epoch: number;
}

export type NativeRunState = "accepted" | "preparing" | "runnable" | "generating" | "executing" | "waiting" | "completed" | "failed" | "cancelled";

export type NativeOperationPhase = "accepted" | "preparing" | "queued" | "running" | "waiting" | "settling" | "terminal";

export type NativeOutcome = "succeeded" | "failed" | "cancelled" | "indeterminate";

export type NativeEffect = "none" | "dispatched" | "partial" | "confirmed" | "unknown";

export type NativeLifetime = "call" | "run" | "thread" | "environment";

export type NativeHistorySource = "user" | "assistant" | "tool" | "agent" | "environment" | "compaction";

export type NativeModelStepState = "prepared" | "dispatched" | "completed" | "interrupted" | "failed" | "cancelled";

export type NativeDeliveryState = "selected" | "sent" | "committed";

export interface NativeThreadCreateParams {
  threadId: string;
  branchId: string;
}

export interface NativeInputSubmitParams {
  key: string;
  threadId: string;
  branchId: string;
  expectedHead: string | null;
  input: unknown;
  configuration: unknown;
}

export interface NativeRunParams {
  runId: string;
}

export interface NativeOperationParams {
  operationId: string;
}

export interface NativeHistoryParams {
  branchId: string;
}

export interface NativeEventsParams {
  cursor: number;
  limit: number;
}

export interface NativeStatus {
  epoch: number;
}

export interface NativeReceipt {
  thread_id: string;
  branch_id: string;
  run_id: string;
  input_id: string;
  cursor: number;
}

export interface NativeRun {
  waiting_on: string | null;
  id: string;
  thread_id: string;
  branch_id: string;
  state: NativeRunState;
  revision: number;
  epoch: number;
  configuration: unknown;
  cancel_requested: boolean;
}

export interface NativeOperation {
  external_receipt: NativeExternalReceipt | null;
  id: string;
  run_id: string;
  epoch: number;
  revision: number;
  phase: NativeOperationPhase;
  outcome: NativeOutcome | null;
  effect: NativeEffect;
  cancel_requested: boolean;
  lifetime: NativeLifetime;
  handed_off: boolean;
  executor: string | null;
  waiting_on: string | null;
  intent: unknown;
  result: unknown;
}

export interface NativeProviderOriginal {
  connection_identity: string;
  adapter: string;
  version: string;
  item: unknown;
}

export interface NativeHistoryItem {
  id: string;
  thread_id: string;
  parent: string | null;
  source: NativeHistorySource;
  content: unknown;
  provider: NativeProviderOriginal | null;
}

export interface NativeEvent {
  cursor: number;
  subject: string;
  revision: number;
  kind: string;
  data: unknown;
}

export interface KernelProcessEnvironmentEntry {
  name: string;
  value: string;
}

export interface KernelProcessSpawnParams {
  workspaceId: string;
  processId: string;
  rootId: string;
  cwd: string;
  command: string;
  args: string[];
  windowsRawArguments?: string;
  env: KernelProcessEnvironmentEntry[];
  mode: string;
  cols?: number;
  rows?: number;
}

export interface KernelProcessReadParams {
  workspaceId: string;
  processId: string;
  cursor: number;
  maxBytes?: number;
}

export interface KernelProcessWriteParams {
  workspaceId: string;
  processId: string;
  sequence: number;
  bytesBase64: string;
  eof?: boolean;
}

export interface KernelProcessResizeParams {
  workspaceId: string;
  processId: string;
  cols: number;
  rows: number;
}

export interface KernelProcessKillParams {
  workspaceId: string;
  processId: string;
  force?: boolean;
}

export interface KernelProcessHandleParams {
  workspaceId: string;
  processId: string;
}

export interface KernelProcessListParams {
  workspaceId: string;
  rootId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelProcessListResult {
  processes: KernelProcessSnapshot[];
  nextCursor: number | null;
}

export interface KernelProcessSnapshot {
  processId: string;
  kernelEpoch: string;
  workspaceId: string;
  cwd: string;
  mode: string;
  status: "starting" | "running" | "exited" | "failed" | "unknown" | "released";
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  writerActive: boolean;
  outputAvailable: boolean;
  outputComplete?: boolean;
  outputError?: string | null;
}

export interface KernelProcessOutputChunk {
  channel: "stdout" | "stderr";
  offset: number;
  bytesBase64: string;
}

export interface KernelProcessReadResult {
  process: KernelProcessSnapshot;
  chunks: KernelProcessOutputChunk[];
  nextCursor: number;
  endCursor: number;
  inputSequence: number;
  inputError: string | null;
  outputComplete: boolean;
  outputError: string | null;
}

export interface KernelProcessWriteResult {
  sequence: number;
  queued: boolean;
}

export type KernelEmptyParams = Record<string, never>;

export interface KernelHandshakeParams {
  protocolVersion: number;
  buildVersion: string;
  hostId: string;
  hostGeneration: string;
  storageRoot: string;
  capabilities: string[];
}

export interface KernelHealthParams {
  deep?: boolean;
}

export interface KernelGrantIssueParams {
  grantId: string;
  hostGeneration: string;
  authorityInstanceId?: string | null;
  workerId?: string | null;
  workerGeneration?: number | null;
  sessionId: string | null;
  threadId: string | null;
  runId: string | null;
  owningWorkspace: string | null;
  executionWorkspace: string | null;
  storageIdentity: string;
  capabilities: string[];
  pathScopes: string[];
}

export interface KernelGrantRevokeParams {
  grantId: string;
}

export interface KernelSnapshotParams {
  workspaceId: string;
}

export interface KernelPutBlobBeginParams {
  operationId: string;
  streamId: string;
  byteLength: number;
  expectedHash?: string;
  workspaceId?: string;
}

export interface KernelPutBlobChunkParams {
  streamId: string;
  sequence: number;
  bytesBase64: string;
}

export interface KernelPutBlobFinishParams {
  operationId: string;
  streamId: string;
  expectedHash?: string;
  workspaceId?: string;
}

export interface KernelPutBlobAbortParams {
  operationId: string;
  streamId: string;
  workspaceId?: string;
}

export interface KernelBlobReleaseParams {
  ownerId: string;
  workspaceId?: string;
}

export interface KernelObjectOwnerRebindParams {
  workspaceId: string;
  ownerId: string;
}

export interface KernelGetBlobParams {
  hash: string;
  branchId?: string;
  revision?: number;
  pinId?: string;
  ownerId?: string;
  recordId?: string;
  slot?: string;
  path?: string;
  offset?: number;
  length?: number;
}

export interface KernelFileRootRegisterParams {
  workspaceId: string;
  executionWorkspaceId: string;
  canonicalRoot: string;
}

export interface KernelFileOperationListParams {
  workspaceId: string;
  rootId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelFileOperationReconcileParams {
  workspaceId: string;
  rootId: string;
  operationId: string;
}

export interface KernelFileLeaseResource {
  path: string;
  scope: string;
}

export interface KernelFileLeaseAcquireParams {
  workspaceId: string;
  rootId: string;
  leaseId: string;
  resources: KernelFileLeaseResource[];
}

export interface KernelFileLeaseReleaseParams {
  workspaceId: string;
  rootId: string;
  leaseId: string;
}

export interface KernelFileCaptureParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  path: string;
  store: boolean;
  leaseId?: string;
}

export interface KernelFileCaptureBatchParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  paths: string[];
  store: boolean;
  leaseId: string;
}

export interface KernelFileApplyParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  path: string;
  targetJson: string;
  expectedJson?: string;
  ownerId?: string;
  leaseId?: string;
}

export interface KernelFileMkdirParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  path: string;
  recursive: boolean;
  leaseId?: string;
}

export interface KernelFileRemoveParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  path: string;
  recursive: boolean;
  force: boolean;
  leaseId?: string;
}

export interface KernelFileRenameParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  fromPath: string;
  toPath: string;
  targetMustBeMissing?: boolean;
  expectedFromJson?: string;
  expectedToJson?: string;
  leaseId?: string;
}

export interface KernelFileScanParams {
  workspaceId: string;
  rootId: string;
  path: string;
  scopes?: string[];
  cursor?: number;
  pageSize?: number;
  expectedFingerprint?: string;
}

export interface KernelFileMeasureParams {
  workspaceId: string;
  rootId: string;
  path: string;
}

export interface KernelFileMaterializeParams {
  operationId: string;
  workspaceId: string;
  rootId: string;
  path: string;
  sourceRoot: string;
  leaseId?: string;
}

export interface KernelRecordReference {
  slot: string;
  objectHash: string;
}

export interface KernelRecordPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  revision?: number;
  resultRevision?: number;
  expectedRecordRevision?: number;
  payloadJson: string;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelRecordGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelRecordListParams {
  workspaceId: string;
  recordType?: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecordReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelRecordWorkspacesParams {
  recordType: string;
}

export interface KernelWorkingDiffStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface KernelWorkingResultDocument {
  resultRevision: number;
  branchId: string;
  parentRef?: string;
  changedPaths: string[];
  diffStats: KernelWorkingDiffStats;
  createdAt: string;
  root: string;
  baseRoot: string;
  baseStates: unknown;
  pathStates: unknown;
}

export interface KernelDraftProvenance {
  path: string;
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  localEditRevision: number;
  revision: string;
}

export interface KernelWorkingDraftDocument {
  id: string;
  workspaceId: string;
  branchId: string;
  revision: number;
  createdAt: string;
  root: string;
  provenance: KernelDraftProvenance[];
}

export interface KernelVerificationEnvSummary {
  PATH?: boolean;
  VIRTUAL_ENV?: string;
}

export interface KernelVerificationActor {
  authorityInstanceId: string;
  sessionId: string;
  workerId: string;
  workerGeneration: number;
  runId?: string;
}

export interface KernelVerificationInputIdentity {
  kind: string;
  branchId?: string;
  root?: string;
  startTreeHash?: string;
  endTreeHash?: string;
  reason?: string;
}

export interface KernelCommandVerificationRecord {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  envSummary?: KernelVerificationEnvSummary;
  commandRunId?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
  actor: KernelVerificationActor;
  bindingGeneration: number;
  inputIdentity: KernelVerificationInputIdentity;
  inputChangedDuringRun: boolean | null;
  relationToPublished: string;
}

export interface KernelWorkingVerificationDocument {
  resultRevision?: number;
  mergedResultRevision?: number;
  mergeOperationId?: string;
  branchId?: string;
  resultTreeHash?: string;
  parentTreeHash?: string;
  recordedAt: number;
  windowOpenedAt?: number;
  draftUnsaved?: boolean;
  note?: string;
  binding: string;
  bindingReason?: string;
  checks: KernelCommandVerificationRecord[];
}

export interface KernelReviewFinding {
  severity: string;
  file?: string;
  line?: number;
  message: string;
}

export interface KernelWorkingReviewDocument {
  resultRevision: number;
  status: string;
  recordedAt: number;
  reviewThreadId?: string;
  reviewRunId?: string;
  gate?: boolean;
  conclusion?: string;
  findings?: KernelReviewFinding[];
  error?: string;
}

export interface KernelWorkingResultPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  branchId: string;
  resultRevision: number;
  root: string;
  parentRef?: string;
  changedPaths: string[];
  diffStats: KernelWorkingDiffStats;
  createdAt: string;
  document: KernelWorkingResultDocument;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingResultGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingResultListParams {
  workspaceId: string;
  branchId?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelWorkingResultReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingDraftPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  document: KernelWorkingDraftDocument;
  branchId: string;
  revision: number;
  root: string;
  createdAt: string;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingDraftGetParams {
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingDraftListParams {
  workspaceId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelWorkingDraftReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingVerificationPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  kind: string;
  threadId: string;
  runId?: string;
  branchId: string;
  resultRevision: number;
  root: string;
  document: KernelWorkingVerificationDocument;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingVerificationListParams {
  workspaceId: string;
  threadId: string;
  kind: string;
}

export interface KernelWorkingVerificationReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelWorkingReviewPutParams {
  operationId: string;
  recordId: string;
  workspaceId: string;
  threadId: string;
  runId?: string;
  branchId: string;
  resultRevision: number;
  root: string;
  document: KernelWorkingReviewDocument;
  expectedRecordRevision?: number;
  ownerIds: string[];
  references: KernelRecordReference[];
}

export interface KernelWorkingReviewListParams {
  workspaceId: string;
  threadId: string;
}

export interface KernelWorkingReviewReleaseParams {
  operationId: string;
  workspaceId: string;
  recordId: string;
}

export interface KernelCreateBranchBeginParams {
  operationId: string;
  builderId: string;
  branchId: string;
  workspaceId: string;
  baseRef?: string;
  parentRef?: string;
  draftBasePaths: string[];
  captureScopes: string[];
}

export interface KernelCreateBranchAppendParams {
  builderId: string;
  sequence: number;
  entries: KernelCreateEntry[];
}

export interface KernelCreateBranchFinishParams {
  operationId: string;
  builderId: string;
}

export interface KernelCreateBranchAbortParams {
  builderId: string;
}

export interface KernelCreateEntry {
  path: string;
  state: KernelBranchState;
  ownerId?: string;
  sourcePath?: string;
  sourceRecordId?: string;
  sourceSlot?: string;
}

export interface KernelBranchReadParams {
  branchId: string;
  revision?: number;
  paths?: string[];
  roots?: string[];
  includeEntries?: boolean;
  cursor?: number;
  pageSize?: number;
}

export interface KernelBranchWriteBeginParams {
  operationId: string;
  builderId: string;
  branchId: string;
  expectedWriteRevision: number;
}

export interface KernelBranchWriteAppendParams {
  builderId: string;
  sequence: number;
  changes: KernelBranchChange[];
}

export interface KernelBranchWriteFinishParams {
  operationId: string;
  builderId: string;
  baseRef?: string;
  parentRef?: string;
}

export interface KernelBranchWriteAbortParams {
  builderId: string;
}

export interface KernelBranchChange {
  path: string;
  state: KernelBranchState;
  ownerId?: string;
  sourcePath?: string;
  sourceRecordId?: string;
  sourceSlot?: string;
}

export interface KernelBranchPublishParams {
  operationId: string;
  branchId: string;
  expectedWriteRevision: number;
  expectedRoot: string;
}

export interface KernelBranchPinParams {
  operationId: string;
  branchId: string;
  revision?: number;
  expectedWriteRevision?: number;
  expectedRoot?: string;
  pinId?: string;
  persistent?: boolean;
}

export interface KernelBranchUnpinParams {
  operationId: string;
  branchId: string;
  pinId: string;
}

export interface KernelBranchDiffParams {
  leftRoot: string;
  rightRoot: string;
}

export interface KernelBranchObjectsParams {
  branchId: string;
  includeRevisions?: boolean;
  cursor?: number;
  pageSize?: number;
}

export interface KernelBranchDeleteParams {
  operationId: string;
  branchId: string;
}

export interface KernelPinReadParams {
  pinId: string;
  paths?: string[];
  roots?: string[];
  includeEntries?: boolean;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryReference {
  slot: string;
  objectHash: string;
  ownerId?: string;
}

export interface KernelRecoveryTurnStartParams {
  operationId: string;
  workspaceId: string;
  executionId: string;
  sessionId: string;
  userEntryId: string;
  workerId: string;
  runtimeGeneration: number;
  activeWriterScopes: string[];
  provenance: string;
  failure?: boolean;
}

export interface KernelRecoveryTurnGetParams {
  workspaceId: string;
  executionId: string;
  sessionId?: string;
}

export interface KernelRecoveryTurnSettleParams {
  operationId: string;
  workspaceId: string;
  executionId: string;
  expectedRevision: number;
  status: string;
  observedResourceIds: string[];
  unrecordedResourceIds: string[];
  observationComplete: boolean;
  activeWriterScopes: string[];
  provenance: string;
  assistantEntryId?: string;
  failureJson?: string;
}

export interface KernelRecoveryCheckpointCreateParams {
  operationId: string;
  workspaceId: string;
  label: string;
}

export interface KernelRecoveryCheckpointListParams {
  workspaceId: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryEntryResolveParams {
  workspaceId: string;
  sessionId: string;
  entryId: string;
}

export interface KernelRecoveryChangeBeforeParams {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  checkpointId: string;
  path: string;
  toolName: string;
  mutationId: string;
  beforeJson: string;
  references: KernelRecoveryReference[];
}

export interface KernelRecoveryChangeGetParams {
  workspaceId: string;
  checkpointId: string;
  path: string;
}

export interface KernelRecoveryChangeListParams {
  workspaceId: string;
  sessionId?: string;
  executionId?: string;
  entryIds?: string[];
}

export interface KernelRecoveryChangeAfterParams {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  executionId: string;
  checkpointId: string;
  path: string;
  afterJson: string;
  succeeded: boolean;
  expectedRevision: number;
  references: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationFile {
  path: string;
  expectedJson?: string;
  targetJson?: string;
  safetyJson?: string;
  phase?: string;
  references?: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationCreateParams {
  operationId: string;
  workspaceId: string;
  kind: string;
  state: string;
  dataJson: string;
  files: KernelRecoveryOperationFile[];
  sessionId?: string;
  threadId?: string;
  runId?: string;
}

export interface KernelRecoveryOperationFileCasParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
  path: string;
  expectedRevision: number;
  expectedPhase: string;
  phase: string;
  observedFingerprint?: string;
  expectedJson?: string;
  targetJson?: string;
  safetyJson?: string;
  references?: KernelRecoveryReference[];
}

export interface KernelRecoveryOperationCompleteParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
  expectedRevision: number;
  state: string;
  resultJson?: string;
  failureJson?: string;
}

export interface KernelRecoveryOperationGetParams {
  operationId: string;
  workspaceId: string;
}

export interface KernelRecoveryOperationListParams {
  workspaceId: string;
  kind?: string;
  cursor?: number;
  pageSize?: number;
}

export interface KernelRecoveryOperationReleaseParams {
  transitionId: string;
  operationId: string;
  workspaceId: string;
}

export interface KernelOperationGetParams {
  operationId: string;
}

export interface KernelOperationReleaseParams {
  operationId: string;
  workspaceId?: string;
}

export interface KernelGcParams {
  operationId: string;
}

export interface KernelError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface KernelResponse<T = unknown> {
  v: typeof KERNEL_PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: boolean;
  result?: T;
  error?: KernelError;
}

export interface KernelHandshakeResult {
  protocolVersion: typeof KERNEL_PROTOCOL_VERSION;
  buildVersion: string;
  applicationBuildVersion: string;
  kernelVersion: string;
  kernelBuildIdentity: string;
  targetTriple: string;
  arch: string;
  kernelEpoch: string;
  requestWindow: number;
  hostId: string;
  hostGeneration: string;
  storageRoot: string;
  capabilities: string[];
}

export type KernelBranchState =
  | { kind: "regular-file"; objectHash: string; byteLength: number; mode: number }
  | { kind: "directory"; mode?: number }
  | { kind: "symlink"; symlinkTarget: string; mode?: number }
  | { kind: "missing" }
  | { kind: "unsupported" };

export interface KernelEntry {
  path: string;
  state: KernelBranchState;
}

export interface KernelBranchReadResult {
  branchId: string;
  workspaceId: string;
  root: string;
  revision: number;
  view: "current" | "revision";
  currentRoot: string;
  headRevision: number;
  writeRevision: number;
  parentRef?: string;
  draftBasePaths: string[];
  captureScopes: string[];
  createdAt: number;
  updatedAt: number;
  entries: KernelEntry[];
  nextCursor?: number | null;
}

export interface KernelWriteResult {
  status: "committed" | "conflict";
  writeRevision: number;
  root: string;
}

export interface KernelBlobResult {
  hash: string;
  byteLength: number;
}

export interface KernelPutBlobResult extends KernelBlobResult {
  ownerId: string;
}

export interface KernelRecordResult {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  branchId?: string;
  revision?: number;
  resultRevision?: number;
  recordRevision: number;
  payloadJson: string;
  references: KernelRecordReference[];
  createdAt: number;
  updatedAt: number;
}

export interface KernelRecordListResult {
  records: KernelRecordResult[];
  nextCursor: number | null;
}

export interface KernelObjectSlice extends KernelBlobResult {
  offset: number;
  nextOffset: number;
  eof: boolean;
  bytesBase64: string;
}

export interface KernelHealthResult {
  integrity: string;
  branches: number;
  nodes: number;
  nodeJsonBytes?: number;
  catalogBytes?: number;
  walBytes?: number;
  operations?: number;
  temporaryObjectOwners?: number;
  blobs: number;
  storageRoot: string;
  pendingCleanup?: number;
  cleanupFailures?: string[];
  deep?: boolean;
  missingNodes?: string[];
  missingObjects?: string[];
  corruptObjects?: string[];
  relationshipErrors?: string[];
}

export interface KernelComputeObject {
  path: string;
  revision: string;
  objectHash?: string;
  ownerId?: string;
  missing?: boolean;
}

export interface KernelComputeFile {
  path: string;
  recipeId?: string;
  revision?: string;
  unchangedRevision?: string;
  lines?: number[];
}

export interface KernelComputeStartParams {
  workspaceId: string;
  jobId: string;
  lane: string;
  operation: string;
  pinId?: string;
  rootId?: string;
  objects?: KernelComputeObject[];
  paths?: string[];
  globs?: string[];
  excludePaths?: string[];
  excludeDirectories?: string[];
  respectGitignore?: boolean;
  includeHidden?: boolean;
  query?: string;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  maxResults?: number;
  before?: number;
  after?: number;
  startLine?: number;
  endLine?: number;
  byteOffset?: number;
  byteLength?: number;
  immediate?: boolean;
  files?: KernelComputeFile[];
  parseBudgetMs?: number;
  chunkLines?: number;
  includeText?: boolean;
  includeTracked?: boolean;
  includeRevisions?: boolean;
}

export interface KernelComputeReadParams {
  workspaceId: string;
  jobId: string;
  cursor: number;
  maxBytes?: number;
}

export interface KernelComputeHandleParams {
  workspaceId: string;
  jobId: string;
}

export interface KernelComputeGrammarParams {
  recipeId: string;
  grammarPath: string;
  grammarName: string;
  style: string;
  definitionQuery: string;
  importQuery?: string;
  literalCallQuery?: string;
  maxDepth?: number;
  maxSymbols?: number;
  grammarHash?: string;
}

export interface KernelComputeRecord {
  kind: string;
  path: string;
  revision: string;
  data: unknown;
}

export interface KernelComputeReadResult {
  jobId: string;
  kernelEpoch: string;
  workspaceId: string;
  status: "queued" | "running" | "ready" | "empty" | "partial" | "failed" | "cancelled";
  root: string | null;
  records: KernelComputeRecord[];
  nextCursor: number;
  endCursor: number;
  scannedFiles: number;
  message: string | null;
}

export type KernelMethodParams = {
  "runtime.input.enqueue": NativeInputEnqueueParams;
  "runtime.input.edit": NativeInputEditParams;
  "runtime.input.cancel": NativeInputCancelParams;
  "runtime.input.inspect": NativeInputHandleParams;
  "runtime.input.list": NativeHistoryParams;
  "runtime.launch.select": NativeLaunchSelectParams;
  "runtime.launch.inspect": NativeRunParams;
  "runtime.launch.list": KernelEmptyParams;
  "runtime.run.start": NativeRunStartParams;
  "runtime.status": KernelEmptyParams;
  "runtime.thread.create": NativeThreadCreateParams;
  "runtime.input.submit": NativeInputSubmitParams;
  "runtime.run.inspect": NativeRunParams;
  "runtime.run.cancel": NativeRunParams;
  "runtime.operation.inspect": NativeOperationParams;
  "runtime.operation.cancel": NativeOperationParams;
  "runtime.history.read": NativeHistoryParams;
  "runtime.events.read": NativeEventsParams;
  "process.subscribe": KernelProcessSubscribeParams;
  "process.subscription.ack": KernelProcessSubscriptionAckParams;
  "process.subscription.unsubscribe": KernelProcessSubscriptionParams;
  "process.spawn": KernelProcessSpawnParams;
  "process.read": KernelProcessReadParams;
  "process.write": KernelProcessWriteParams;
  "process.resize": KernelProcessResizeParams;
  "process.kill": KernelProcessKillParams;
  "process.inspect": KernelProcessHandleParams;
  "process.list": KernelProcessListParams;
  "process.release": KernelProcessHandleParams;
  "kernel.handshake": KernelHandshakeParams;
  "kernel.ping": KernelEmptyParams;
  "kernel.shutdown": KernelEmptyParams;
  "storage.health": KernelHealthParams;
  "authority.grant.issue": KernelGrantIssueParams;
  "authority.grant.revoke": KernelGrantRevokeParams;
  "storage.snapshot": KernelSnapshotParams;
  "storage.putBlob.begin": KernelPutBlobBeginParams;
  "storage.putBlob.chunk": KernelPutBlobChunkParams;
  "storage.putBlob.finish": KernelPutBlobFinishParams;
  "storage.putBlob.abort": KernelPutBlobAbortParams;
  "storage.blob.release": KernelBlobReleaseParams;
  "storage.getBlob": KernelGetBlobParams;
  "storage.object.rebindOwner": KernelObjectOwnerRebindParams;
  "file.root.register": KernelFileRootRegisterParams;
  "file.operation.list": KernelFileOperationListParams;
  "file.operation.reconcile": KernelFileOperationReconcileParams;
  "file.lease.acquire": KernelFileLeaseAcquireParams;
  "file.lease.check": KernelFileLeaseAcquireParams;
  "file.lease.release": KernelFileLeaseReleaseParams;
  "file.capture": KernelFileCaptureParams;
  "file.captureBatch": KernelFileCaptureBatchParams;
  "file.apply": KernelFileApplyParams;
  "file.mkdir": KernelFileMkdirParams;
  "file.remove": KernelFileRemoveParams;
  "file.rename": KernelFileRenameParams;
  "file.scan": KernelFileScanParams;
  "file.measure": KernelFileMeasureParams;
  "file.materialize": KernelFileMaterializeParams;
  "storage.record.put": KernelRecordPutParams;
  "storage.record.get": KernelRecordGetParams;
  "storage.record.list": KernelRecordListParams;
  "storage.record.workspaces": KernelRecordWorkspacesParams;
  "storage.record.release": KernelRecordReleaseParams;
  "working.result.put": KernelWorkingResultPutParams;
  "working.result.get": KernelWorkingResultGetParams;
  "working.result.list": KernelWorkingResultListParams;
  "working.result.release": KernelWorkingResultReleaseParams;
  "working.draft.put": KernelWorkingDraftPutParams;
  "working.draft.get": KernelWorkingDraftGetParams;
  "working.draft.list": KernelWorkingDraftListParams;
  "working.draft.release": KernelWorkingDraftReleaseParams;
  "working.verification.put": KernelWorkingVerificationPutParams;
  "working.verification.list": KernelWorkingVerificationListParams;
  "working.verification.release": KernelWorkingVerificationReleaseParams;
  "working.review.put": KernelWorkingReviewPutParams;
  "working.review.list": KernelWorkingReviewListParams;
  "working.review.release": KernelWorkingReviewReleaseParams;
  "branch.create.begin": KernelCreateBranchBeginParams;
  "branch.create.append": KernelCreateBranchAppendParams;
  "branch.create.finish": KernelCreateBranchFinishParams;
  "branch.create.abort": KernelCreateBranchAbortParams;
  "branch.read": KernelBranchReadParams;
  "branch.write.begin": KernelBranchWriteBeginParams;
  "branch.write.append": KernelBranchWriteAppendParams;
  "branch.write.finish": KernelBranchWriteFinishParams;
  "branch.write.abort": KernelBranchWriteAbortParams;
  "branch.publish": KernelBranchPublishParams;
  "branch.pin": KernelBranchPinParams;
  "branch.unpin": KernelBranchUnpinParams;
  "branch.diff": KernelBranchDiffParams;
  "branch.objects": KernelBranchObjectsParams;
  "branch.delete": KernelBranchDeleteParams;
  "pin.read": KernelPinReadParams;
  "recovery.operation.get": KernelRecoveryOperationGetParams;
  "recovery.turn.start": KernelRecoveryTurnStartParams;
  "recovery.turn.get": KernelRecoveryTurnGetParams;
  "recovery.turn.settle": KernelRecoveryTurnSettleParams;
  "recovery.checkpoint.create": KernelRecoveryCheckpointCreateParams;
  "recovery.checkpoint.list": KernelRecoveryCheckpointListParams;
  "recovery.entry.resolve": KernelRecoveryEntryResolveParams;
  "recovery.change.before": KernelRecoveryChangeBeforeParams;
  "recovery.change.get": KernelRecoveryChangeGetParams;
  "recovery.change.list": KernelRecoveryChangeListParams;
  "recovery.change.after": KernelRecoveryChangeAfterParams;
  "recovery.operation.create": KernelRecoveryOperationCreateParams;
  "recovery.operation.file.cas": KernelRecoveryOperationFileCasParams;
  "recovery.operation.complete": KernelRecoveryOperationCompleteParams;
  "recovery.operation.list": KernelRecoveryOperationListParams;
  "recovery.operation.release": KernelRecoveryOperationReleaseParams;
  "operation.get": KernelOperationGetParams;
  "operation.release": KernelOperationReleaseParams;
  "storage.gc": KernelGcParams;
  "compute.start": KernelComputeStartParams;
  "compute.read": KernelComputeReadParams;
  "compute.cancel": KernelComputeHandleParams;
  "compute.release": KernelComputeHandleParams;
  "compute.grammar.register": KernelComputeGrammarParams;
};

export type KernelRequest =
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.enqueue";
      params: NativeInputEnqueueParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.edit";
      params: NativeInputEditParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.cancel";
      params: NativeInputCancelParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.inspect";
      params: NativeInputHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.list";
      params: NativeHistoryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.select";
      params: NativeLaunchSelectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.inspect";
      params: NativeRunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.list";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.start";
      params: NativeRunStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.status";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.thread.create";
      params: NativeThreadCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.submit";
      params: NativeInputSubmitParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.inspect";
      params: NativeRunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.cancel";
      params: NativeRunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.operation.inspect";
      params: NativeOperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.operation.cancel";
      params: NativeOperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.history.read";
      params: NativeHistoryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.events.read";
      params: NativeEventsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.subscribe";
      params: KernelProcessSubscribeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.subscription.ack";
      params: KernelProcessSubscriptionAckParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.subscription.unsubscribe";
      params: KernelProcessSubscriptionParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.spawn";
      params: KernelProcessSpawnParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.read";
      params: KernelProcessReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.write";
      params: KernelProcessWriteParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.resize";
      params: KernelProcessResizeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.kill";
      params: KernelProcessKillParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.inspect";
      params: KernelProcessHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.list";
      params: KernelProcessListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "process.release";
      params: KernelProcessHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.handshake";
      params: KernelHandshakeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.ping";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "kernel.shutdown";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.health";
      params: KernelHealthParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "authority.grant.issue";
      params: KernelGrantIssueParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "authority.grant.revoke";
      params: KernelGrantRevokeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.snapshot";
      params: KernelSnapshotParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.begin";
      params: KernelPutBlobBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.chunk";
      params: KernelPutBlobChunkParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.finish";
      params: KernelPutBlobFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.putBlob.abort";
      params: KernelPutBlobAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.blob.release";
      params: KernelBlobReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.getBlob";
      params: KernelGetBlobParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.object.rebindOwner";
      params: KernelObjectOwnerRebindParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.root.register";
      params: KernelFileRootRegisterParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.operation.list";
      params: KernelFileOperationListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.operation.reconcile";
      params: KernelFileOperationReconcileParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.lease.acquire";
      params: KernelFileLeaseAcquireParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.lease.check";
      params: KernelFileLeaseAcquireParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.lease.release";
      params: KernelFileLeaseReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.capture";
      params: KernelFileCaptureParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.captureBatch";
      params: KernelFileCaptureBatchParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.apply";
      params: KernelFileApplyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.mkdir";
      params: KernelFileMkdirParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.remove";
      params: KernelFileRemoveParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.rename";
      params: KernelFileRenameParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.scan";
      params: KernelFileScanParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.measure";
      params: KernelFileMeasureParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "file.materialize";
      params: KernelFileMaterializeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.put";
      params: KernelRecordPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.get";
      params: KernelRecordGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.list";
      params: KernelRecordListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.workspaces";
      params: KernelRecordWorkspacesParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.record.release";
      params: KernelRecordReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.put";
      params: KernelWorkingResultPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.get";
      params: KernelWorkingResultGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.list";
      params: KernelWorkingResultListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.release";
      params: KernelWorkingResultReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.put";
      params: KernelWorkingDraftPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.get";
      params: KernelWorkingDraftGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.list";
      params: KernelWorkingDraftListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.draft.release";
      params: KernelWorkingDraftReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.put";
      params: KernelWorkingVerificationPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.list";
      params: KernelWorkingVerificationListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.verification.release";
      params: KernelWorkingVerificationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.put";
      params: KernelWorkingReviewPutParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.list";
      params: KernelWorkingReviewListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.review.release";
      params: KernelWorkingReviewReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.begin";
      params: KernelCreateBranchBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.append";
      params: KernelCreateBranchAppendParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.finish";
      params: KernelCreateBranchFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.create.abort";
      params: KernelCreateBranchAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.read";
      params: KernelBranchReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.begin";
      params: KernelBranchWriteBeginParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.append";
      params: KernelBranchWriteAppendParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.finish";
      params: KernelBranchWriteFinishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.write.abort";
      params: KernelBranchWriteAbortParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.publish";
      params: KernelBranchPublishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.pin";
      params: KernelBranchPinParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.unpin";
      params: KernelBranchUnpinParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.diff";
      params: KernelBranchDiffParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.objects";
      params: KernelBranchObjectsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "branch.delete";
      params: KernelBranchDeleteParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "pin.read";
      params: KernelPinReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.get";
      params: KernelRecoveryOperationGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.start";
      params: KernelRecoveryTurnStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.get";
      params: KernelRecoveryTurnGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.turn.settle";
      params: KernelRecoveryTurnSettleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.checkpoint.create";
      params: KernelRecoveryCheckpointCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.checkpoint.list";
      params: KernelRecoveryCheckpointListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.entry.resolve";
      params: KernelRecoveryEntryResolveParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.before";
      params: KernelRecoveryChangeBeforeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.get";
      params: KernelRecoveryChangeGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.list";
      params: KernelRecoveryChangeListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.change.after";
      params: KernelRecoveryChangeAfterParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.create";
      params: KernelRecoveryOperationCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.file.cas";
      params: KernelRecoveryOperationFileCasParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.complete";
      params: KernelRecoveryOperationCompleteParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.list";
      params: KernelRecoveryOperationListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "recovery.operation.release";
      params: KernelRecoveryOperationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "operation.get";
      params: KernelOperationGetParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "operation.release";
      params: KernelOperationReleaseParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "storage.gc";
      params: KernelGcParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "compute.start";
      params: KernelComputeStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "compute.read";
      params: KernelComputeReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "compute.cancel";
      params: KernelComputeHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "compute.release";
      params: KernelComputeHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "compute.grammar.register";
      params: KernelComputeGrammarParams;
      epoch?: string;
      grantId?: string;
    }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; };
