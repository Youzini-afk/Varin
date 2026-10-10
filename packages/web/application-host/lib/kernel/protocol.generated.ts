/**
 * Generated from `kernel/protocol/schema.json`.
 * Do not hand-edit the wire shapes; run `node scripts/generate-kernel-protocol.mjs`.
 */

export const KERNEL_PROTOCOL_VERSION = 1 as const;
export const KERNEL_REQUEST_WINDOW = 2 as const;
export const KERNEL_MAX_FRAME_BYTES = 16777216 as const;
export const KERNEL_CONTROL_METHODS = ["runtime.operation.status","runtime.child.cancel","runtime.child.capabilities","runtime.tree.cancel","runtime.goal.control","runtime.followup.control","runtime.policy.select","runtime.policy.cancel","runtime.policy.fail","runtime.policy.inspect","kernel.handshake","kernel.ping","kernel.shutdown","authority.grant.revoke","runtime.status","runtime.tools.select","runtime.run.inspect","runtime.run.scope","runtime.run.cancel","runtime.run.resume","runtime.operation.inspect","runtime.operation.cancel","runtime.process.access","process.interaction.inspect","runtime.input.cancel","runtime.input.inspect","runtime.admission.inspect","process.inspect","process.kill","process.resize","process.release","process.subscription.ack","process.subscription.unsubscribe"] as const;
export const KERNEL_CONTROL_RESPONSE_METHODS = ["runtime.operation.status","runtime.child.cancel","runtime.child.capabilities","runtime.tree.cancel","runtime.goal.control","runtime.followup.control","runtime.policy.select","runtime.policy.cancel","runtime.policy.fail","runtime.policy.inspect","kernel.handshake","kernel.ping","kernel.shutdown","authority.grant.revoke","runtime.status","runtime.tools.select","runtime.run.scope","runtime.run.cancel","runtime.run.resume","runtime.operation.cancel","runtime.process.access","process.interaction.inspect","process.kill","process.resize","process.release","process.subscription.ack","process.subscription.unsubscribe"] as const;
export const KERNEL_DEFERRED_RESPONSE_METHODS = ["process.write","process.resize"] as const;
export const KERNEL_INPUT_ORDER_PARAMS = {"runtime.thread.create":"branchId","runtime.branch.fork":"branchId","runtime.input.submit":"branchId","runtime.input.enqueue":"branchId","runtime.input.edit":"inputId"} as const;
export const KERNEL_RUNTIME_DATA_METHODS = ["runtime.history.body"] as const;
export const KERNEL_PROTOCOL_SCHEMA = "varin.kernel.v1" as const;

export type KernelMethod =
  | "runtime.goal.start"
  | "runtime.goal.update"
  | "runtime.goal.control"
  | "runtime.goal.list"
  | "runtime.resources.refresh"
  | "runtime.resources.snapshot"
  | "recovery.operation.conflicts"
  | "runtime.host_tool.reconcile"
  | "source.handoff.claim"
  | "runtime.branch.fork"
  | "runtime.plan.view"
  | "runtime.plan.contains"
  | "runtime.context_job.create"
  | "runtime.context_job.inspect"
  | "runtime.context_job.list"
  | "runtime.context_job.publish"
  | "runtime.context_job.resume"
  | "runtime.context.inspect"
  | "runtime.context.refresh"
  | "runtime.memory.reconcile"
  | "runtime.plan.reconcile"
  | "runtime.history.page"
  | "runtime.history.body"
  | "runtime.thread.operations.active"
  | "runtime.run.reconcile"
  | "runtime.launch.fail"
  | "runtime.thread.inspect"
  | "runtime.thread.list"
  | "runtime.launch.select"
  | "runtime.launch.mcp.prepare"
  | "runtime.launch.extensions.prepare"
  | "runtime.tools.select"
  | "runtime.tools.ready"
  | "runtime.launch.policy.prepare"
  | "runtime.policy.select"
  | "runtime.policy.ready"
  | "runtime.policy.cancel"
  | "runtime.policy.fail"
  | "runtime.policy.inspect"
  | "runtime.observer.read"
  | "runtime.observer.delivery"
  | "runtime.launch.inspect"
  | "runtime.launch.list"
  | "runtime.input.enqueue"
  | "runtime.input.enqueueReceipt"
  | "runtime.input.edit"
  | "runtime.input.cancel"
  | "runtime.input.inspect"
  | "runtime.input.list"
  | "runtime.run.start"
  | "runtime.model.select"
  | "runtime.model.inspect"
  | "runtime.status"
  | "runtime.followup.register"
  | "runtime.followup.list"
  | "runtime.followup.control"
  | "runtime.content.collect"
  | "runtime.admission.inspect"
  | "runtime.thread.create"
  | "runtime.input.submit"
  | "runtime.input.receipt"
  | "runtime.run.scope"
  | "runtime.run.inspect"
  | "runtime.run.cancel"
  | "runtime.run.resume"
  | "runtime.permission.open"
  | "runtime.permission.decide"
  | "runtime.permission.consume"
  | "runtime.question.answer"
  | "runtime.operation.inspect"
  | "runtime.operation.status"
  | "runtime.process.access"
  | "runtime.operation.cancel"
  | "runtime.events.read"
  | "process.subscribe"
  | "process.subscription.ack"
  | "process.subscription.unsubscribe"
  | "process.spawn"
  | "process.read"
  | "process.write"
  | "process.resize"
  | "process.interaction.inspect"
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
  | "file.read.check"
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
  | "working.result.prepare"
  | "working.result.publish"
  | "working.result.candidate.release"
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
  | "compute.grammar.register"
  | "runtime.child.sources.pending"
  | "runtime.child.sources.release"
  | "runtime.child.continuation.accept"
  | "runtime.child.execution.inspect"
  | "runtime.child.execution.for_run"
  | "runtime.child.execution.list"
  | "runtime.child.execution.report.read"
  | "runtime.child.list"
  | "runtime.child.inspect"
  | "runtime.child.report.read"
  | "runtime.child.for_thread"
  | "runtime.child.source.ready"
  | "runtime.child.settle"
  | "runtime.child.result.candidate"
  | "runtime.child.result.published"
  | "runtime.child.prepare"
  | "runtime.child.fail"
  | "runtime.child.cancel"
  | "runtime.tree.cancel"
  | "runtime.child.capabilities"
  | "runtime.child.release"
  | "runtime.process.wait.reconcile"
  | "runtime.child.reconcile"
  | "runtime.child.wait.cancel"
  | "runtime.family.list"
  | "runtime.family.runs"
  | "runtime.family.read"
  | "runtime.family.item"
  | "runtime.messages.send"
  | "runtime.messages.list"
  | "runtime.messages.get";

export type MessageKind = 'inform';

export interface MessageSendParams {
  key: string;
  senderThreadId: string;
  senderBranchId: string;
  targetThreadId?: string;
  targetBranchId?: string;
  replyTo?: string;
  kind: MessageKind;
  text: string;
}

export interface MessageListParams {
  threadId: string;
  branchId: string;
  direction: MessageDirection;
  cursor?: string;
  limit?: number;
}

export type MessageDirection = 'incoming' | 'outgoing';

export interface MessageGetParams {
  threadId: string;
  branchId: string;
  messageId: string;
}

export type MessageActor = {kind: 'user'} | {kind: 'agent'; runId: string; operationId: string; origin: ToolOrigin};

export interface MessageReceipt {
  messageId: string;
  senderThreadId: string;
  senderBranchId: string;
  targetThreadId: string;
  targetBranchId: string;
  actor: MessageActor;
  kind: MessageKind;
  replyTo: string | null;
  acceptedCursor: number;
}

export interface MessageSummary extends MessageReceipt {
  state: 'queued' | 'delivered';
  deliveredRunId: string | null;
  deliveredCursor: number | null;
}

export interface MessageView extends MessageSummary {
  text: string;
}

export interface MessagePage {
  messages: MessageSummary[];
  nextCursor: string | null;
}

export type FollowupTrigger = { kind: 'process_stopped'; operation_id: string } | { kind: 'run_completed'; cursor: number } | { kind: 'goal_requested'; cursor: number };

export type FollowupEvidence = { kind: 'process_stopped'; receipt_identity: string; receipt_epoch: string } | { kind: 'run_completed'; run_revision: number } | { kind: 'goal_requested'; run_revision: number };

export type GoalState = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete' | 'cancelled';

export type GoalControl = 'active' | 'paused' | 'complete' | 'cancelled';

export type GoalControlAction = 'pause' | 'resume' | 'complete' | 'cancel';

export interface GoalBudget {
  maxOutputTokens: number;
}

export interface GoalTokenAmount {
  known: number;
  unknown_receipts: number;
}

export interface GoalMeasuredUsage {
  inferences: number;
  input_tokens: GoalTokenAmount;
  output_tokens: GoalTokenAmount;
  cached_input_tokens: GoalTokenAmount;
  cache_write_tokens: GoalTokenAmount;
  reasoning_tokens: GoalTokenAmount;
}

export interface GoalUsage {
  actual: GoalMeasuredUsage;
  estimated: GoalMeasuredUsage;
  missing_inferences: number;
  pending_inferences: number;
}

export type GoalBlockReason = 'reported' | 'dependency' | 'run_failed' | 'waiting' | 'unsettled' | 'context_changed' | 'preparation_failed' | 'usage_unknown';

export interface Goal {
  id: string;
  revision: number;
  generation: number;
  thread_id: string;
  branch_id: string;
  source_run_id: string;
  objective: string;
  control: GoalControl;
  state: GoalState;
  budget: GoalBudget | null;
  usage: GoalUsage;
  blocked_reason: GoalBlockReason | null;
  reason: string | null;
  dependency_operation_id: string | null;
}

export interface GoalControlReceipt {
  id: string;
  revision: number;
  generation: number;
  thread_id: string;
  branch_id: string;
  control: GoalControl;
}

export interface GoalStartParams {
  key: string;
  threadId: string;
  branchId: string;
  runId: string;
  objective: string;
  budget: GoalBudget | null;
}

export interface GoalUpdateParams {
  goalId: string;
  threadId: string;
  branchId: string;
  expectedRevision: number;
  objective: string;
  budget: GoalBudget | null;
}

export interface GoalControlParams {
  goalId: string;
  threadId: string;
  branchId: string;
  expectedRevision: number;
  action: GoalControlAction;
}

export interface SourceResourceLink {
  path: string;
  target: SourceResourceTarget;
}

export interface AgentResourceFailure {
  domainId: string;
  viewId: string;
  path: string;
  status: 'missing' | 'invalid' | 'denied' | 'unavailable' | 'stale' | 'cancelled';
  reason: string;
}

export interface AgentResourceDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'unsupported';
}

export interface SourceResourceDirectory {
  path: string;
  entries: AgentResourceDirectoryEntry[];
  version: string;
  canonicalId?: string;
}

export interface SourceResourceCapsule {
  domainId: string;
  viewId: string;
  displayRoot: string;
  files: AgentResourceCapture[];
  directories: SourceResourceDirectory[];
  missing: string[];
  failures: AgentResourceFailure[];
}

export type SourceResourceCoverage = { kind: 'complete' } | { kind: 'selected'; paths: string[]; subtrees: string[] };

export type SourceResourceTarget = { kind: 'source'; directory: string } | { kind: 'capsule'; capsule: SourceResourceCapsule; directory: string };

export interface SourceResourceAncestor {
  capsule: SourceResourceCapsule;
  appliesTo: string;
  includeSkills: boolean;
}

export interface SourceResourceConfiguredPath {
  configuredPath: string;
  target: SourceResourceTarget;
}

export interface SourceResourcePackage {
  identity: string;
  source: string;
  target: SourceResourceTarget;
}

export interface SourceResourceCapture {
  root: string;
  cwd: string;
  skillAncestorBoundary: string;
  coverage: SourceResourceCoverage;
  ancestors: SourceResourceAncestor[];
  configuredPaths: SourceResourceConfiguredPath[];
  installedPackages: SourceResourcePackage[];
  shadowedContextCanonicalIds: string[];
  sourceLinks: SourceResourceLink[];
}

export interface AgentResourceLocation {
  domainId: string;
  viewId: string;
  path: string;
}

export interface AgentResourceReference {
  domainId: string;
  viewId: string;
  path: string;
  canonicalId: string;
  version: string;
}

export interface AgentResourceCapture {
  reference: AgentResourceReference;
  content: string;
}

export interface AgentResourceScope {
  threadId: string;
  branchId: string;
  mode: 'agent' | 'bot';
  threadRole: string;
  projectId: string | null;
  sourceIdentity: string | null;
  cwd: string;
  projectTrusted: boolean;
  projectRoot: string | null;
}

export interface AgentResourceReader {
  domainId: string;
  viewId: string;
  consistency: 'immutable' | 'capture-only';
}

export interface AgentResourceProject {
  domainId: string;
  viewId: string;
  cwd: string;
}

export interface AgentResourceInstruction {
  origin: 'user' | 'project' | 'ancestor';
  kind: 'user-config' | 'project-instruction';
  appliesTo: string | null;
  reference: AgentResourceReference;
}

export interface AgentResourceInstructionScope {
  directory: string;
  instructions: AgentResourceInstruction[];
}

export interface AgentResourceSkill {
  id: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  requiresProjectTrust: boolean;
  origin: 'user' | 'project' | 'package';
  reference: AgentResourceReference;
  basePath: string;
  baseCanonicalId: string;
  priority: number;
  packageIdentity?: string;
}

export interface AgentResourceDiagnostic {
  kind: 'read' | 'invalid' | 'warning' | 'disabled' | 'collision' | 'duplicate';
  message: string;
  location: AgentResourceLocation;
  status?: 'missing' | 'invalid' | 'denied' | 'unavailable' | 'stale' | 'cancelled';
  winner?: AgentResourceReference;
}

export interface AgentResourceObservation {
  domainId: string;
  viewId: string;
  path: string;
  status: 'ready' | 'missing' | 'invalid' | 'denied' | 'unavailable' | 'stale' | 'cancelled';
  version?: string;
}

export interface AgentResourceSnapshot {
  id: string;
  scope: AgentResourceScope;
  readers: AgentResourceReader[];
  project: AgentResourceProject | null;
  configurationDigest: string;
  shadowedContextCanonicalIds: string[];
  system: AgentResourceInstruction | null;
  appendSystem: AgentResourceInstruction | null;
  instructions: AgentResourceInstruction[];
  instructionScopes: AgentResourceInstructionScope[];
  skills: AgentResourceSkill[];
  diagnostics: AgentResourceDiagnostic[];
  capturedFiles: AgentResourceCapture[];
  observations: AgentResourceObservation[];
}

export interface ContextResources {
  source: LaunchSource | null;
  snapshot: AgentResourceSnapshot;
}

export interface ResourceActivation {
  activationId: string;
  inputId: string;
  inputRevision: number;
  ordinal: number;
  resourceCheckpointId: string;
  snapshotId: string;
  resourceId: string;
  reference: AgentResourceReference;
}

export interface PreparedExplicitSkill {
  snapshotId: string;
  resourceId: string;
  reference: AgentResourceReference;
  name: string;
  arguments: string;
  body: string;
}

export interface InputResourcePreparation {
  expectedContextCheckpoint: string | null;
  skill: PreparedExplicitSkill | null;
}

export type AgentResourceRequest = { kind: 'skill'; resourceId: string; activationId?: string } | { kind: 'skill-resource'; resourceId: string; relativePath: string; activationId?: string } | { kind: 'instruction-scope'; targetPath: string; targetType?: 'file' | 'directory' };

export interface ResourceRefreshParams {
  branchId: string;
  expectedRevision: number;
  context: InitialContext;
}

export interface ResourceSnapshotParams {
  activationId?: string;
  runId: string;
  origin: ToolOrigin;
  callId: string;
  resourceCheckpointId: string;
}

export interface KernelRecoveryOperationConflictsParams {
  workspaceId: string;
  rootId: string;
  paths: string[];
  exceptOperationId?: string;
}

export interface KernelRecoveryOperationConflict {
  operationId: string;
  workspaceId: string;
  state: string;
  revision: number;
  canonicalRoot: string;
  paths: string[];
}

export interface KernelRecoveryOperationConflictsResult {
  operations: KernelRecoveryOperationConflict[];
}

export type RetrievalInvocation = { kind: 'model_step'; requestId: string; toolCallId: string } | { kind: 'policy_action'; actionId: string; nodeId: string; toolCallId: string };

export interface RetrievalQuery {
  invocation: RetrievalInvocation;
  runId: string;
  threadId: string;
  workspaceId: string;
  executionWorkspaceId: string;
  liveRoot: LiveRoot;
  grantId: string;
  projectId: string | null;
  question: string;
  paths?: string[];
  limit?: number;
}

export interface KernelFileReadCheckParams {
  workspaceId: string;
  rootId: string;
  path: string;
}

export interface KernelFileReadCheckResult {
  resourceKey: string;
}

export interface LanguageQuery {
  runId: string;
  threadId: string;
  workspaceId: string;
  executionWorkspaceId: string;
  liveRoot: LiveRoot;
  method: string;
  path: string;
  line?: number;
  character?: number;
}

export interface HistoryPageParams {
  branchId: string;
  headId?: string;
  beforeId?: string;
  limit: number;
}

export interface HistoryBodyParams {
  itemId: string;
  chunkIndex: number;
}

export interface HistoryReference {
  id: string;
  thread_id: string;
  parent: string | null;
  source: HistorySource;
  content_ref: string;
  run_id: string;
}

export interface HistoryPage {
  head: string | null;
  items: HistoryReference[];
  previous: string | null;
}

export interface HistoryBodyChunk {
  itemId: string;
  contentRef: string;
  chunkIndex: number;
  chunkCount: number;
  totalBytes: number;
  bytesBase64: string;
}

export interface HostToolReconcileParams {
  operationId: string;
  executionOwner: ExecutorOwner;
}

export interface RunReconcileParams {
  runId: string;
  toolBinding: unknown;
}

export interface RunReconcileResult {
  reconciled: string[];
  unresolved: string[];
}

export interface SubmitLaunch {
  inheritSource?: boolean;
  source: LaunchSourceParams | null;
  enabledTools: string[];
  credentialScope?: CredentialScope;
  childDispatch?: ChildDispatchCatalog;
}

export interface LaunchFailedParams {
  runId: string;
  code: string;
}

export interface ThreadParams {
  threadId: string;
}

export interface ThreadOperationsParams {
  threadId: string;
  branchId?: string;
}

export interface ThreadBranch {
  branch_id: string;
  head: string | null;
  active_run_id: string | null;
  latest_run: Run | null;
}

export interface ThreadSummary {
  thread_id: string;
  branches: ThreadBranch[];
  observer_project_ids: Array<string | null>;
}

export type AgentRuntimeStreamEvent = {v: 1; kind: 'runtime-event'; kernelEpoch: string} & ({stream: 'durable'; cursor: number} | {stream: 'progress'; runId: string; streamId: string; sequence: number; event: unknown});

export type SourceMode = 'fixed_branch' | 'materialized' | 'live_root';

export interface LiveRoot {
  hostId: string;
  canonicalRoot: string;
  rootId: string;
}

export interface LaunchSourceParams {
  environmentRunId?: string;
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string | null;
  revision: number | null;
  mode: SourceMode;
  liveRoot?: LiveRoot | null;
}

export interface LaunchSelectParams {
  runId: string;
  source: LaunchSourceParams | null;
  enabledTools: string[];
  credentialScope?: CredentialScope;
  childDispatch?: ChildDispatchCatalog;
}

export interface LaunchSource {
  environment_run_id?: string | null;
  workspace_id: string;
  execution_workspace_id: string;
  branch_id: string | null;
  revision: number | null;
  mode: SourceMode;
  live_root: LiveRoot | null;
}

export interface ToolMetadata { service_id: string; service_version: number; completion: 'result'; operation: 'read' | 'effect'; examples?: unknown[]; source?: {path: string; line?: number}; }

export interface HostToolCall {
  runId: string;
  operationId: string;
  origin: ToolOrigin;
  callId: string;
  name: string;
  schemaVersion: string;
  arguments: unknown;
}

export interface ExtensionToolBinding {
  providerKey: string;
  extensionId: string;
  extensionVersion: string;
  serviceId: string;
  serviceVersion: number;
  artifactIntegrity: string;
  declarationHash: string;
  configurationIdentity: string | null;
  tool: LaunchTool;
}

export interface LiveExtensionToolBinding {
  ownerId: string;
  generation: number;
  binding: ExtensionToolBinding;
}

export interface ExtensionPrepareParams {
  runId: string;
  bindings: ExtensionToolBinding[];
}

export interface LaunchTool {
  name: string;
  version: string;
  description: string;
  schema: unknown;
  output_schema: unknown;
  metadata: ToolMetadata | null;
}

export interface LaunchPolicy {
  name: string;
  version: string;
}

export interface AgentPolicyArtifactBinding {
  providerKey: string;
  extensionId: string;
  extensionVersion: string;
  serviceId: 'varin.agent.policy';
  serviceVersion: 3;
  artifactIntegrity: string;
  configurationIdentity: string;
  declaredIdentity: LaunchPolicy;
  identity: LaunchPolicy;
  modelRoles: 'agentPlanning'[];
  stateTransition: 'unsupported' | 'explicit';
}

export type PolicyTarget = {kind: 'default'} | {kind: 'extension'; artifact: AgentPolicyArtifactBinding};

export type PolicyStateMode = 'preserve' | 'restart_state';

export type PolicySelectionStatus = 'preparing' | 'ready' | 'active' | 'failed' | 'superseded' | 'cancelled';

export interface PolicySelection {
  expected_selection_id: string | null;
  selection_id: string;
  run_id: string;
  generation: number;
  expected_generation: number;
  target: PolicyTarget;
  state_mode: PolicyStateMode;
  status: PolicySelectionStatus;
  failure: string | null;
  activation_cursor: number | null;
}

export interface ActivePolicySelection {
  generation: number;
  target: PolicyTarget;
  identity: LaunchPolicy;
  activation_cursor: number | null;
}

export interface PolicySelections {
  active: ActivePolicySelection;
  desired: PolicySelection | null;
}

export interface PolicySelectParams {
  expectedSelectionId: string | null;
  runId: string;
  selectionId: string;
  expectedGeneration: number;
  target: PolicyTarget;
  stateMode: PolicyStateMode;
}

export interface PolicyReadyParams {
  runId: string;
  selectionId: string;
  generation: number;
  binding: AgentPolicyBinding | null;
  policyModels: PolicyModelCapability[];
}

export interface PolicyCancelParams {
  runId: string;
  selectionId: string;
}

export type PolicyPreparationFailure = 'policy_preparation_failed' | 'policy_preparation_cancelled' | 'policy_binding_revoked';

export interface PolicyFailParams {
  runId: string;
  selectionId: string;
  code: PolicyPreparationFailure;
}

export interface AgentPolicyBinding {
  reference: string;
  generation: number;
  artifact: AgentPolicyArtifactBinding;
}

export interface PolicyModelCapability {
  capability_id: string;
  purpose: string;
  status: PolicyModelStatus;
  binding_id: string | null;
  configuration_identity: string | null;
  supported_operation: string;
  binding: unknown;
  configuration: ModelSessionConfiguration | null;
  credential_scope: CredentialScope | null;
}

export type PolicyModelStatus = 'available' | 'disabled' | 'unconfigured' | 'invalid' | 'unavailable';

export interface PolicyPrepareParams {
  runId: string;
  identity: LaunchPolicy;
  target: PolicyTarget;
  policyModels: PolicyModelCapability[];
}

export interface McpConfiguration {
  agent_dir: string;
  config_cwd: string;
  project_trusted: boolean;
}

export interface McpServerSelection {
  definition_version: string;
  resource_key: string;
}

export type McpExecutionScope = 'global' | 'workspace';

export interface McpProvenance {
  execution_scope: McpExecutionScope;
  configuration: McpConfiguration;
  servers: Record<string, McpServerSelection>;
}

export interface McpBinding {
  provenance: McpProvenance;
  resources: Record<string, string>;
  reference: string;
  generation: number;
  tools: LaunchTool[];
}

export interface LiveMcpBinding {
  ownerId: string;
  binding: McpBinding;
}

export interface McpPrepareParams {
  runId: string;
  binding: McpBinding;
}

export interface ToolSelectParams {
  runId: string;
  selectionId: string;
}

export interface ToolReadyParams {
  extensionBindings?: LiveExtensionToolBinding[];
  runId: string;
  selectionId: string;
  binding?: LiveMcpBinding;
}

export interface LaunchSelection {
  extension_bindings: ExtensionToolBinding[];
  policy_models: PolicyModelCapability[];
  mcp_binding: McpBinding | null;
  credential_scope: CredentialScope | null;
  connection_identity: string;
  provider_family: string;
  model: string;
  configuration_generation: number;
  tool_schema_generation: number;
  tools: LaunchTool[];
  policy: LaunchPolicy;
  source: LaunchSource | null;
  child_dispatch: ChildDispatchCatalog | null;
}

export interface LaunchIntent {
  policy_preparable: boolean;
  policy_generation: number;
  policy_target: PolicyTarget;
  preparation_failure: string | null;
  run_id: string;
  revision: number;
  selection: LaunchSelection;
  bound_epoch: number | null;
  requires_rebind: boolean;
  startable: boolean;
  pause: PolicyPauseInfo | null;
}

export interface KernelProcessSubscribeParams {
  workspaceId: string;
  processId: string;
  rootId?: string;
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

export type InputMode = "boundary" | "interrupt" | "next_run";

export type InputState = "queued" | "delivered" | "cancelled";

export interface InputEnqueueParams {
  inputPreparation?: InputResourcePreparation;
  key: string;
  threadId: string;
  branchId: string;
  mode: InputMode;
  input: unknown;
  configuration?: unknown;
}

export interface InputEditParams {
  inputPreparation?: InputResourcePreparation;
  inputId: string;
  expectedRevision: number;
  content: unknown;
}

export interface InputCancelParams {
  inputId: string;
  expectedRevision: number;
}

export interface InputHandleParams {
  inputId: string;
}

export interface InputReceipt {
  input_id: string;
  run_id: string;
  mode: InputMode;
  cursor: number;
}

export interface QueuedInput {
  id: string;
  thread_id: string;
  branch_id: string;
  run_id: string;
  mode: InputMode;
  state: InputState;
  revision: number;
  content: unknown;
  cursor: number;
}

export type ToolOrigin = {kind: 'model_step'; request_id: string} | {kind: 'policy_action'; action_id: string; node_id: string};

export type ExecutorOwner = {kind: 'kernel'} | {kind: 'external'; identity: string; epoch: string};

export interface ExternalReceipt {
  executor: string;
  identity: string;
  epoch: string;
  outcome: Outcome;
  effect: Effect;
  result: unknown;
}

export interface BranchForkParams {
  sourceBranchId: string;
  branchId: string;
  headId: string | null;
  planCapture?: PlanForkCaptureParams;
}

export interface PlanForkCaptureParams {
  sourceThreadId: string;
  sourceBranchId: string;
  targetBranchId: string;
  headId: string | null;
  inheritedRef: string | null;
  capturedRef: string | null;
}

export interface PlanContainsParams {
  branchId: string;
  headId: string | null;
  candidateHeadId: string | null;
  cursor?: string;
}

export interface PlanViewParams {
  branchId: string;
  headId: string | null;
  current: boolean;
}

export interface BranchForkResult {
  threadId: string;
  branchId: string;
}

export interface ContextJobCreateParams {
  ownerRunId?: string;
  personalization?: ContextPersonalization;
  key: string;
  branchId: string;
  throughId: string;
  expectedRevision: number;
  effectiveSystemPrompt: string;
  instructionSources: string[];
  memoryCheckpoint: string | null;
  configuration: unknown;
  credentialScope?: CredentialScope;
}

export interface ModelSelectParams {
  runId: string;
  key: string;
  configuration: unknown;
  credentialScope?: CredentialScope;
  childDispatch?: ChildDispatchCatalog;
}

export interface RunModelSelection {
  id: string;
  run_id: string;
  revision: number;
  binding_id: string;
  configuration: ModelSessionConfiguration;
  credential_scope: CredentialScope | null;
  status: 'preparing' | 'ready' | 'active' | 'failed' | 'superseded';
  failure: string | null;
}

export interface RunModelSelections {
  desired: RunModelSelection | null;
  active: RunModelSelection | null;
}

export interface RunStartParams {
  extensionBindings?: LiveExtensionToolBinding[];
  policyBinding?: AgentPolicyBinding;
  mcpBinding?: LiveMcpBinding;
  runId: string;
  toolBinding?: unknown;
  credentialScope?: CredentialScope;
}

export interface CredentialScope {
  reference: string;
  authority: string;
  account: string;
  generation: number;
}

export type RunCancellationReceipt = Omit<Run, 'configuration'>;

export type OperationCancellationReceipt = Omit<Operation, 'intent' | 'result' | 'external_receipt'>;

export interface ModelSessionConfiguration {
  providerId?: string;
  providerFamily: string;
  model: string;
  endpoint: string;
  credentialEnvironment: string | null;
  allowAnonymous: boolean;
  acceptsImages?: boolean;
  configurationGeneration: number;
  maxOutputTokens: number | null;
  azureDeployment?: string | null;
  azureApiVersion?: string | null;
  legacyMaxTokens?: boolean;
  includeStreamUsage?: boolean;
  reasoningEffort?: string | null;
  anthropicOauth?: boolean;
  adapterId?: string;
  adapterVersion?: string;
  contextWindowTokens?: number;
  thinkingLevel?: string;
  modelOptions?: unknown;
}

export interface RunStartReceipt {
  runId: string;
  epoch: number;
}

export type RunState = "accepted" | "preparing" | "runnable" | "generating" | "executing" | "waiting" | "completed" | "failed" | "cancelled";

export type OperationPhase = "accepted" | "preparing" | "queued" | "running" | "waiting" | "settling" | "terminal";

export type Outcome = "succeeded" | "failed" | "cancelled" | "indeterminate";

export type Effect = "none" | "dispatched" | "partial" | "confirmed" | "unknown";

export type Lifetime = "call" | "run" | "thread" | "environment";

export type HistorySource = "user" | "assistant" | "tool" | "agent" | "environment" | "compaction";

export type ModelStepState = "prepared" | "not_dispatched" | "dispatched" | "completed" | "interrupted" | "failed" | "cancelled";

export type DeliveryState = "selected" | "sent" | "committed";

export interface ThreadCreateParams {
  threadId: string;
  branchId: string;
}

export interface SystemSection {
  name: string;
  content: string;
}

export interface ContextFragment {
  name: string;
  kind: string;
  content: string;
}

export interface ContextComposition {
  providerId: string;
  contentVersion: string;
  scopeId: string;
  selectionRevision: number;
  sections: ContextFragment[];
}

export interface MemorySnapshot {
  revision: number;
  memories: unknown[];
}

export interface ContextPersonalization {
  memorySnapshot: MemorySnapshot;
  configurationDigest: string;
  mode: string;
  threadRole: string;
  contextComposition?: ContextComposition;
  revision: number;
  sessionId: string;
  projectId: string | null;
  originalSections: SystemSection[];
  instructionSources: string[];
}

export interface ContextRefreshParams {
  branchId: string;
  expectedRevision: number;
  context: InitialContext;
}

export interface InitialContext {
  resources?: ContextResources;
  personalization?: ContextPersonalization;
  effectiveSystemPrompt: string;
  instructionSources: string[];
  memoryCheckpoint: string | null;
}

export interface InputSubmitParams {
  inputPreparation?: InputResourcePreparation;
  expectedContextCheckpoint?: string;
  initialContext?: InitialContext;
  launch?: SubmitLaunch;
  key: string;
  threadId: string;
  branchId: string;
  expectedHead: string | null;
  input: unknown;
  configuration: unknown;
}

export interface RunContextScope {
  mode: string;
  threadRole: string;
  sessionId: string;
  projectId: string | null;
}

export type FollowupControlAction = 'pause' | 'resume' | 'cancel';

export interface FollowupRegisterParams {
  key: string;
  runId: string;
  operationId: string;
}

export interface FollowupControlParams {
  followupId: string;
  expectedRevision: number;
  action: FollowupControlAction;
}

export interface FollowupWait {
  id: string;
  kind: 'process_stopped' | 'run_completed' | 'goal_requested';
  after_cursor: number;
  trigger_cursor: number | null;
  state: 'waiting' | 'observed' | 'consumed' | 'cancelled';
}

export interface FollowupOccurrence {
  id: string;
  generation: number;
  trigger_cursor: number;
  state: 'observed' | 'held' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  hold_reason: 'control_paused' | 'source_run_active' | 'source_unsettled' | 'branch_active' | 'context_scope_changed' | 'preparation_failed' | 'goal_paused' | 'goal_budget' | 'goal_blocked' | 'goal_ended' | 'goal_superseded' | null;
  receipt: InputSubmitReceipt | null;
  evidence: FollowupEvidence;
}

export interface Followup {
  id: string;
  revision: number;
  generation: number;
  thread_id: string;
  branch_id: string;
  source_run_id: string;
  operation_id: string | null;
  state: 'active' | 'paused' | 'cancelled';
  wait: FollowupWait;
  occurrence: FollowupOccurrence | null;
  goal_id: string | null;
  trigger: FollowupTrigger;
}

export interface RunParams {
  runId: string;
}

export interface RunResumeParams {
  runId: string;
  waitId: string;
}

export interface PolicyResumeReceipt {
  run_id: string;
  action_id: string;
  wait_id: string;
  cursor: number;
}

export interface PolicyPauseInfo {
  action_id: string;
  wait_id: string;
  reason: string;
}

export interface PermissionOpenParams {
  operationId: string;
  permissionId: string;
  call: HostToolCall;
  scope: unknown;
}

export interface PermissionDecideParams {
  operationId: string;
  permissionId: string;
  decision: string;
}

export interface QuestionAnswerParams {
  operationId: string;
  answer: string;
}

export interface OperationParams {
  operationId: string;
}

export interface HistoryParams {
  branchId: string;
}

export interface EventsParams {
  cursor: number;
  limit: number;
}

export interface ObserverReadParams {
  observerId: string;
  threadId: string;
  limit: number;
  throughCursor: number;
}

export interface ObserverDeliveryParams {
  observerId: string;
  threadId: string;
  cursor: number;
  state: DeliveryState;
}

export interface AdmissionInspectParams {
  runId: string;
  ownerGeneration: number;
  callId: string;
  requestId?: string;
  actionId?: string;
  nodeId?: string;
}

export interface AdmissionSummary {
  localComputeCapacity: number;
  localComputeActive: number;
  queued: number;
}

export interface AdmissionStatus {
  admissionId: string;
  familyId: string;
  class: 'unmetered' | 'local_compute';
  runId: string | null;
  ownerGeneration: number | null;
  origin: unknown;
  state: 'queued' | 'active';
  reason: string | null;
}

export interface AdmissionInspection {
  admissionId: string;
  state: 'queued' | 'active' | 'settled' | 'not_active';
  queue: AdmissionStatus | null;
}

export type ContentCollectionStatus = "completed" | "deferred" | "cancelled" | "failed";

export type ContentCollectionPhase = "admission" | "roots" | "verify" | "sweep" | "staging";

export interface ContentCollectionReport {
  status: ContentCollectionStatus;
  phase: ContentCollectionPhase;
  removedObjects: number;
  removedBytes: number;
  removedStagingFiles: number;
  reason: string | null;
}

export interface RuntimeStatus {
  epoch: number;
  eventCursor: number;
  admission: AdmissionSummary;
}

export interface InputSubmitReceipt {
  thread_id: string;
  branch_id: string;
  run_id: string;
  input_id: string;
  cursor: number;
}

export interface Run {
  waiting_on: string | null;
  id: string;
  thread_id: string;
  branch_id: string;
  state: RunState;
  revision: number;
  epoch: number;
  configuration: unknown;
  cancel_requested: boolean;
}

export type OperationCallCompletion =
  | { kind: 'not_dispatched'; reason: string }
  | { kind: 'result'; outcome: Outcome; effect: Effect; content: unknown }
  | { kind: 'job_accepted'; operation_id: string; phase: string; effect: Effect; lifetime: Lifetime };

export interface Operation {
  execution_owner: ExecutorOwner | null;
  external_receipt: ExternalReceipt | null;
  call_completion: OperationCallCompletion | null;
  id: string;
  run_id: string;
  epoch: number;
  revision: number;
  phase: OperationPhase;
  outcome: Outcome | null;
  effect: Effect;
  cancel_requested: boolean;
  lifetime: Lifetime;
  handed_off: boolean;
  executor: string | null;
  waiting_on: string | null;
  intent: unknown;
  result: unknown;
}

export interface ProviderOriginal {
  connection_identity: string;
  adapter: string;
  version: string;
  item: unknown;
}

export interface HistoryItem {
  id: string;
  thread_id: string;
  parent: string | null;
  source: HistorySource;
  content: unknown;
  provider: ProviderOriginal | null;
  run_id: string;
}

export interface RuntimeEvent {
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
  rootId?: string;
  cursor: number;
  maxBytes?: number;
}

export interface KernelProcessWriteParams {
  workspaceId: string;
  processId: string;
  rootId?: string;
  operationId: string;
  bytesBase64: string;
  eof?: boolean;
}

export interface KernelProcessResizeParams {
  workspaceId: string;
  processId: string;
  rootId?: string;
  operationId: string;
  cols: number;
  rows: number;
}

export interface KernelProcessKillParams {
  workspaceId: string;
  processId: string;
  rootId?: string;
  force?: boolean;
}

export interface KernelProcessHandleParams {
  workspaceId: string;
  processId: string;
  rootId?: string;
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

export interface KernelProcessInteractionBase {
  processId: string;
  operationId: string;
  kernelEpoch: string;
  sequence: number;
  state: "applied" | "partial" | "not_applied" | "unknown";
  reason: string | null;
  cancelled: boolean;
}

export type KernelProcessInteractionReceipt = KernelProcessInteractionBase & (
  | { kind: "write"; requestedBytes: number; confirmedBytes: number; eofRequested: boolean; eofApplied: boolean }
  | { kind: "resize"; cols: number; rows: number }
);

export interface KernelProcessInteractionInspectParams {
  workspaceId: string;
  processId: string;
  operationId: string;
  rootId?: string;
}

export interface RuntimeProcessAccessParams {
  threadId: string;
  branchId: string;
  operationId: string;
  toolBinding: unknown;
}

export interface RuntimeProcessAccess {
  operationId: string;
  runId: string;
  threadId: string;
  branchId: string;
  workspaceId: string;
  rootId: string;
  process: KernelProcessSnapshot;
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

export interface KernelSourceHandoffClaimParams {
  handoffOperationId: string;
  grantId: string;
  childThreadId: string;
  childBranchId: string;
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

export interface KernelWorkingResultPrepareParams {
  operationId: string;
  publicationId: string;
  builderId: string;
  expectedRoot: string;
}

export interface KernelWorkingResultPublishParams {
  operationId: string;
  workspaceId: string;
  branchId: string;
  candidateOperationId: string;
}

export interface KernelWorkingResultCandidateReleaseParams {
  operationId: string;
  workspaceId: string;
  branchId: string;
  candidateOperationId: string;
}

export interface KernelWorkingResultCandidate {
  publicationId: string;
  candidateOperationId: string;
  workspaceId: string;
  branchId: string;
  root: string;
  baseRoot: string;
  writeRevision: number;
  pinId: string;
  basePinId: string;
}

export interface KernelWorkingResultPublication {
  publicationId: string;
  workspaceId: string;
  branchId: string;
  resultRevision: number;
  root: string;
  baseRoot: string;
  recordId: string;
  createdAt: string;
}

export interface KernelWorkingResultCandidateReleased {
  released: boolean;
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

export interface KernelSourceProvenanceReference {
  objectHash: string;
  ownerId: string;
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
  sourceProvenance?: KernelSourceProvenanceReference;
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

export interface KernelRequestCreditReleased {
  v: typeof KERNEL_PROTOCOL_VERSION;
  kind: "request-credit-released";
  id: string;
  kernelEpoch: string;
  method: KernelMethod;
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
  branchId?: string;
  revision?: number;
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

export interface UnacceptedChildSource {
  operation_id: string;
  parent_thread_id: string;
  source: LaunchSource;
  pin_id: string;
}

export interface ChildSourceHandoff {
  operation_id: string;
  source: LaunchSource;
  root: ChildSourceRoot;
}

export type ChildSourceRoot = { kind: 'fixed'; pin: ChildSourcePin } | { kind: 'physical'; root: LiveRoot };

export type ChildSourceProvenance = { consistency: 'fixed-root'; root: string; resources?: SourceResourceCapture } | { consistency: 'stable-capture' | 'git-base-with-overlay'; contentMode: 'saved-files' | 'fixed-draft-baseline'; captureScopes: string[]; omittedDraftPaths: string[]; resources?: SourceResourceCapture };

export type ChildSource = { kind: 'pending'; handoff: ChildSourceHandoff } | { kind: 'ready'; handoff: ChildSourceHandoff | null; pin: ChildSourcePin; selection: LaunchSource; provenance: ChildSourceProvenance };

export interface ChildWorkingResultRef {
  publication_id: string;
  workspace_id: string;
  branch_id: string;
  result_revision: number;
  root: string;
  base_root: string;
  record_id: string;
}

export type ChildCodeResult = { kind: 'pending' } | { kind: 'settling'; publication_id: string } | { kind: 'candidate'; candidate: KernelWorkingResultCandidate } | { kind: 'published'; result: ChildWorkingResultRef; effect: Effect } | { kind: 'no_changes' } | { kind: 'unavailable'; code: string; effect: Effect };

export interface ChildSourceReadyParams {
  executionId: string;
  pin: ChildSourcePin;
  source: LaunchSourceParams;
  provenance: ChildSourceProvenance;
}

export interface ChildSettleParams {
  executionId: string;
  toolBinding: unknown;
}

export interface ChildResultCandidateParams {
  executionId: string;
  toolBinding: unknown;
  candidateOperationId: string;
}

export interface ChildResultPublishedParams {
  executionId: string;
  toolBinding: unknown;
  publicationId: string;
}

export interface ChildPrepareParams {
  executionId: string;
  source: LaunchSourceParams;
  context: InitialContext;
  expectedContextCheckpoint: string | null;
  inputPreparation?: InputResourcePreparation;
}

export interface ChildFailParams {
  executionId: string;
  code: string;
}

export interface ChildWaitParams {
  waitId: string;
}

export interface ChildCapabilityDescriptor {
  name: string;
  version: string;
  source_requirement: 'none' | 'source' | 'physical';
}

export type ChildWorkMode = 'read_only' | 'isolated_write';

export interface ChildModelBinding {
  configuration: ModelSessionConfiguration;
  credential_scope: CredentialScope | null;
}

export interface ChildCapabilityFailure {
  code: string;
  capabilities: string[];
}

export interface ChildPreset {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
  work_mode: ChildWorkMode;
  model: ChildModelBinding | null;
  unavailable: ChildCapabilityFailure | null;
  model_source: 'inherit' | 'selected';
  inherit_base: ChildModelBinding | null;
}

export interface ChildDispatchCatalog {
  native_capabilities: ChildCapabilityDescriptor[];
  identity: string;
  presets: ChildPreset[];
  normal_unavailable: ChildCapabilityFailure | null;
}

export interface ChildSelectedProfile {
  preset_id: string | null;
  catalog_identity: string | null;
  work_mode: ChildWorkMode;
  tools: string[];
  instructions: string;
}

export type TreeCancelTarget = { kind: 'thread'; thread_id: string } | { kind: 'child'; operation_id: string };

export interface TreeCancelParams {
  target: TreeCancelTarget;
  expectedParentThreadId?: string;
}

export interface TreeCancellationReceipt {
  target: TreeCancelTarget;
  cursor: number;
  run_count: number;
  child_count: number;
  process_count: number;
}

export interface ChildInput {
  task: string;
  preset?: string;
  workMode?: ChildWorkMode;
  tools?: string[];
}

export interface ChildSourcePin {
  pin_id: string;
  root: string;
  source: LaunchSource;
}

export interface ChildReportReadParams {
  operationId: string;
  itemId: string;
  offset?: number;
  maxBytes?: number;
}

export interface ChildTextPage {
  operation_id: string;
  item_id: string;
  offset: number;
  next_offset: number | null;
  total_bytes: number;
  text: string;
  execution_id: string;
}

export interface ChildReport {
  outcome: Outcome;
  sender_thread_id: string;
  run_id: string | null;
  history_ids: string[];
  detail: string | null;
}

export interface ChildTask {
  operation_id: string;
  parent_run_id: string;
  parent_thread_id: string;
  parent_branch_id: string;
  origin: unknown;
  call_id: string;
  child_thread_id: string;
  child_branch_id: string;
  project_id: string | null;
  input: ChildInput;
  configuration: unknown;
  launch: LaunchSelection;
  state: string;
  revision: number;
  cursor: number;
  receipt: InputSubmitReceipt | null;
  report: ChildReport | null;
  resources_released: boolean;
  source: ChildSource;
  code_result: ChildCodeResult;
  selected_profile: ChildSelectedProfile;
}

export interface ChildContinuationAcceptParams {
  key: string;
  childOperationId: string;
  previousRunId: string;
  expectedHead: string | null;
  input: unknown;
}

export interface ChildExecutionParams {
  executionId: string;
}

export interface ChildExecutionListParams {
  childOperationId?: string;
}

export interface ChildExecutionReportReadParams {
  executionId: string;
  itemId: string;
  offset?: number;
  maxBytes?: number;
}

export type DelegatedExecutionTrigger = { kind: 'dispatch' } | { kind: 'user_continuation'; key: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null };

export type ChildSourceBasis = { kind: 'working_result'; source: LaunchSource; root: string; provenance: ChildSourceProvenance; result: ChildWorkingResultRef } | { kind: 'immutable_source'; source: LaunchSource; root: string; provenance: ChildSourceProvenance; pin: ChildSourcePin };

export interface DelegatedExecution {
  execution_id: string;
  child_operation_id: string;
  parent_run_id: string;
  parent_thread_id: string;
  parent_branch_id: string;
  origin: ToolOrigin;
  call_id: string;
  child_thread_id: string;
  child_branch_id: string;
  project_id: string | null;
  trigger: DelegatedExecutionTrigger;
  input: unknown;
  configuration: unknown;
  selected_profile: ChildSelectedProfile;
  launch: LaunchSelection;
  policy_target: PolicyTarget;
  source_basis: ChildSourceBasis | null;
  source: ChildSource | null;
  code_result: ChildCodeResult;
  state: string;
  revision: number;
  cursor: number;
  receipt: InputSubmitReceipt | null;
  report: ChildReport | null;
  terminal_head: string | null;
  resources_released: boolean;
  cancel_requested: boolean;
}

export interface ChildWait {
  id: string;
  run_id: string;
  subject: string;
  kind: string;
  after_cursor: number;
  trigger_cursor: number | null;
  cancelled: boolean;
}

export interface FamilyListParams {
  callerThreadId: string;
  includeSelf?: boolean;
}

export interface FamilyRunsParams {
  callerThreadId: string;
  threadId: string;
  branchId: string;
  cursor?: string;
  limit?: number;
}

export interface FamilyReadParams {
  callerThreadId: string;
  threadId: string;
  branchId: string;
  runId?: string;
  anchor?: string;
  cursor?: string;
  query: FamilyReadQuery;
}

export interface FamilyItemParams {
  callerThreadId: string;
  threadId: string;
  branchId: string;
  runId?: string;
  anchor: string;
  itemId: string;
  offset?: number;
  maxBytes?: number;
}

export type FamilyReadQuery =
  | { kind: 'recent'; limit?: number; maxItemBytes?: number }
  | { kind: 'range'; afterId?: string; beforeId?: string; direction: 'older' | 'newer'; limit?: number; maxItemBytes?: number }
  | { kind: 'search'; text: string; direction: 'older' | 'newer'; limit?: number; maxItemBytes?: number; scanLimit?: number };

export interface FamilyRun {
  runId: string;
  branchId: string;
  state: string;
}

export interface FamilyLatestRun {
  runId: string;
  state: string;
}

export interface FamilyBranch {
  branchId: string;
  headId: string | null;
  activeRunId: string | null;
  latestRun: FamilyLatestRun | null;
}

export interface FamilyMember {
  threadId: string;
  parentThreadId: string | null;
  task: string | null;
  state: string;
  branches: FamilyBranch[];
}

export interface FamilyList {
  rootThreadId: string;
  members: FamilyMember[];
}

export interface FamilyRuns {
  threadId: string;
  branchId: string;
  runs: FamilyRun[];
  nextCursor: string | null;
}

export interface FamilyToolAssociation { requestId: string; callId: string; role: 'call' | 'result' }

export interface FamilyHistoryEntry {
  id: string;
  parentId: string | null;
  sequence: number;
  runId: string;
  source: string;
  kind: string;
  body: unknown | null;
  preview: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  tool: FamilyToolAssociation | null;
}

export interface FamilyRead {
  threadId: string;
  branchId: string;
  runId: string | null;
  headId: string | null;
  anchor: string;
  items: FamilyHistoryEntry[];
  nextCursor: string | null;
  scanned: number;
  scanComplete: boolean;
  hasEarlier: boolean;
  hasLater: boolean;
}

export interface FamilyItem { threadId: string; branchId: string; runId: string | null; headId: string | null; itemId: string; format: 'conversation_json'; text: string; offset: number; nextOffset: number | null; totalBytes: number }

export type KernelMethodParams = {
  "runtime.goal.start": GoalStartParams;
  "runtime.goal.update": GoalUpdateParams;
  "runtime.goal.control": GoalControlParams;
  "runtime.goal.list": ThreadParams;
  "runtime.resources.refresh": ResourceRefreshParams;
  "runtime.resources.snapshot": ResourceSnapshotParams;
  "runtime.followup.register": FollowupRegisterParams;
  "runtime.followup.list": ThreadParams;
  "runtime.followup.control": FollowupControlParams;
  "runtime.branch.fork": BranchForkParams;
  "runtime.plan.view": PlanViewParams;
  "runtime.plan.contains": PlanContainsParams;
  "runtime.context_job.create": ContextJobCreateParams;
  "runtime.context_job.inspect": RunParams;
  "runtime.context_job.list": HistoryParams;
  "runtime.context_job.publish": RunParams;
  "runtime.context_job.resume": RunParams;
  "runtime.context.inspect": HistoryParams;
  "runtime.context.refresh": ContextRefreshParams;
  "runtime.memory.reconcile": RunParams;
  "runtime.plan.reconcile": RunParams;
  "runtime.history.page": HistoryPageParams;
  "runtime.history.body": HistoryBodyParams;
  "runtime.thread.operations.active": ThreadOperationsParams;
  "runtime.host_tool.reconcile": HostToolReconcileParams;
  "runtime.run.reconcile": RunReconcileParams;
  "runtime.launch.fail": LaunchFailedParams;
  "runtime.thread.inspect": ThreadParams;
  "runtime.thread.list": KernelEmptyParams;
  "runtime.input.enqueue": InputEnqueueParams;
  "runtime.input.enqueueReceipt": InputEnqueueParams;
  "runtime.input.edit": InputEditParams;
  "runtime.input.cancel": InputCancelParams;
  "runtime.input.inspect": InputHandleParams;
  "runtime.input.list": HistoryParams;
  "runtime.launch.select": LaunchSelectParams;
  "runtime.launch.mcp.prepare": McpPrepareParams;
  "runtime.launch.extensions.prepare": ExtensionPrepareParams;
  "runtime.tools.select": ToolSelectParams;
  "runtime.tools.ready": ToolReadyParams;
  "runtime.launch.policy.prepare": PolicyPrepareParams;
  "runtime.policy.select": PolicySelectParams;
  "runtime.policy.ready": PolicyReadyParams;
  "runtime.policy.cancel": PolicyCancelParams;
  "runtime.policy.fail": PolicyFailParams;
  "runtime.policy.inspect": RunParams;
  "runtime.launch.inspect": RunParams;
  "runtime.launch.list": KernelEmptyParams;
  "runtime.run.start": RunStartParams;
  "runtime.model.select": ModelSelectParams;
  "runtime.model.inspect": RunParams;
  "runtime.status": KernelEmptyParams;
  "runtime.content.collect": KernelEmptyParams;
  "runtime.admission.inspect": AdmissionInspectParams;
  "runtime.thread.create": ThreadCreateParams;
  "runtime.input.submit": InputSubmitParams;
  "runtime.input.receipt": InputSubmitParams;
  "runtime.run.scope": RunParams;
  "runtime.run.inspect": RunParams;
  "runtime.run.cancel": RunParams;
  "runtime.run.resume": RunResumeParams;
  "runtime.permission.open": PermissionOpenParams;
  "runtime.permission.decide": PermissionDecideParams;
  "runtime.permission.consume": PermissionOpenParams;
  "runtime.question.answer": QuestionAnswerParams;
  "runtime.operation.inspect": OperationParams;
  "runtime.operation.status": OperationParams;
  "runtime.operation.cancel": OperationParams;
  "runtime.process.access": RuntimeProcessAccessParams;
  "runtime.events.read": EventsParams;
  "runtime.observer.read": ObserverReadParams;
  "runtime.observer.delivery": ObserverDeliveryParams;
  "process.subscribe": KernelProcessSubscribeParams;
  "process.subscription.ack": KernelProcessSubscriptionAckParams;
  "process.subscription.unsubscribe": KernelProcessSubscriptionParams;
  "process.spawn": KernelProcessSpawnParams;
  "process.read": KernelProcessReadParams;
  "process.write": KernelProcessWriteParams;
  "process.resize": KernelProcessResizeParams;
  "process.interaction.inspect": KernelProcessInteractionInspectParams;
  "process.kill": KernelProcessKillParams;
  "process.inspect": KernelProcessHandleParams;
  "process.list": KernelProcessListParams;
  "process.release": KernelProcessHandleParams;
  "kernel.handshake": KernelHandshakeParams;
  "kernel.ping": KernelEmptyParams;
  "kernel.shutdown": KernelEmptyParams;
  "storage.health": KernelHealthParams;
  "source.handoff.claim": KernelSourceHandoffClaimParams;
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
  "file.read.check": KernelFileReadCheckParams;
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
  "working.result.prepare": KernelWorkingResultPrepareParams;
  "working.result.publish": KernelWorkingResultPublishParams;
  "working.result.candidate.release": KernelWorkingResultCandidateReleaseParams;
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
  "recovery.operation.conflicts": KernelRecoveryOperationConflictsParams;
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
  "runtime.child.sources.pending": KernelEmptyParams;
  "runtime.child.sources.release": OperationParams;
  "runtime.child.continuation.accept": ChildContinuationAcceptParams;
  "runtime.child.execution.inspect": ChildExecutionParams;
  "runtime.child.execution.for_run": RunParams;
  "runtime.child.execution.list": ChildExecutionListParams;
  "runtime.child.execution.report.read": ChildExecutionReportReadParams;
  "runtime.child.list": KernelEmptyParams;
  "runtime.child.inspect": OperationParams;
  "runtime.child.report.read": ChildReportReadParams;
  "runtime.child.for_thread": ThreadParams;
  "runtime.child.source.ready": ChildSourceReadyParams;
  "runtime.child.settle": ChildSettleParams;
  "runtime.child.result.candidate": ChildResultCandidateParams;
  "runtime.child.result.published": ChildResultPublishedParams;
  "runtime.child.prepare": ChildPrepareParams;
  "runtime.child.fail": ChildFailParams;
  "runtime.child.cancel": OperationParams;
  "runtime.tree.cancel": TreeCancelParams;
  "runtime.child.capabilities": KernelEmptyParams;
  "runtime.child.release": ChildExecutionParams;
  "runtime.process.wait.reconcile": KernelEmptyParams;
  "runtime.child.reconcile": KernelEmptyParams;
  "runtime.child.wait.cancel": ChildWaitParams;
  "runtime.family.list": FamilyListParams;
  "runtime.family.runs": FamilyRunsParams;
  "runtime.family.read": FamilyReadParams;
  "runtime.family.item": FamilyItemParams;
  "runtime.messages.send": MessageSendParams;
  "runtime.messages.list": MessageListParams;
  "runtime.messages.get": MessageGetParams;
};

export type KernelRequest =
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.goal.start";
      params: GoalStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.goal.update";
      params: GoalUpdateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.goal.control";
      params: GoalControlParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.goal.list";
      params: ThreadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.resources.refresh";
      params: ResourceRefreshParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.resources.snapshot";
      params: ResourceSnapshotParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.followup.register";
      params: FollowupRegisterParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.followup.list";
      params: ThreadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.followup.control";
      params: FollowupControlParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.branch.fork";
      params: BranchForkParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.plan.view";
      params: PlanViewParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.plan.contains";
      params: PlanContainsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context_job.create";
      params: ContextJobCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context_job.inspect";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context_job.list";
      params: HistoryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context_job.publish";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context_job.resume";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context.inspect";
      params: HistoryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.context.refresh";
      params: ContextRefreshParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.memory.reconcile";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.plan.reconcile";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.history.page";
      params: HistoryPageParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.history.body";
      params: HistoryBodyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.thread.operations.active";
      params: ThreadOperationsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.host_tool.reconcile";
      params: HostToolReconcileParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.reconcile";
      params: RunReconcileParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.fail";
      params: LaunchFailedParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.thread.inspect";
      params: ThreadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.thread.list";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.enqueue";
      params: InputEnqueueParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.enqueueReceipt";
      params: InputEnqueueParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.edit";
      params: InputEditParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.cancel";
      params: InputCancelParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.inspect";
      params: InputHandleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.list";
      params: HistoryParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.select";
      params: LaunchSelectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.mcp.prepare";
      params: McpPrepareParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.extensions.prepare";
      params: ExtensionPrepareParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.tools.select";
      params: ToolSelectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.tools.ready";
      params: ToolReadyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.policy.prepare";
      params: PolicyPrepareParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.policy.select";
      params: PolicySelectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.policy.ready";
      params: PolicyReadyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.policy.cancel";
      params: PolicyCancelParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.policy.fail";
      params: PolicyFailParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.policy.inspect";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.launch.inspect";
      params: RunParams;
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
      params: RunStartParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.model.select";
      params: ModelSelectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.model.inspect";
      params: RunParams;
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
      method: "runtime.content.collect";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.admission.inspect";
      params: AdmissionInspectParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.thread.create";
      params: ThreadCreateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.submit";
      params: InputSubmitParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.input.receipt";
      params: InputSubmitParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.scope";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.inspect";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.cancel";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.run.resume";
      params: RunResumeParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.permission.open";
      params: PermissionOpenParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.permission.decide";
      params: PermissionDecideParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.permission.consume";
      params: PermissionOpenParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.question.answer";
      params: QuestionAnswerParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.operation.inspect";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.operation.status";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.operation.cancel";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.process.access";
      params: RuntimeProcessAccessParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.events.read";
      params: EventsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.observer.read";
      params: ObserverReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.observer.delivery";
      params: ObserverDeliveryParams;
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
      method: "process.interaction.inspect";
      params: KernelProcessInteractionInspectParams;
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
      method: "source.handoff.claim";
      params: KernelSourceHandoffClaimParams;
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
      method: "file.read.check";
      params: KernelFileReadCheckParams;
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
      method: "working.result.prepare";
      params: KernelWorkingResultPrepareParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.publish";
      params: KernelWorkingResultPublishParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "working.result.candidate.release";
      params: KernelWorkingResultCandidateReleaseParams;
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
      method: "recovery.operation.conflicts";
      params: KernelRecoveryOperationConflictsParams;
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
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.sources.pending";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.sources.release";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.continuation.accept";
      params: ChildContinuationAcceptParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.execution.inspect";
      params: ChildExecutionParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.execution.for_run";
      params: RunParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.execution.list";
      params: ChildExecutionListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.execution.report.read";
      params: ChildExecutionReportReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.list";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.inspect";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.report.read";
      params: ChildReportReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.for_thread";
      params: ThreadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.source.ready";
      params: ChildSourceReadyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.settle";
      params: ChildSettleParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.result.candidate";
      params: ChildResultCandidateParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.result.published";
      params: ChildResultPublishedParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.prepare";
      params: ChildPrepareParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.fail";
      params: ChildFailParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.cancel";
      params: OperationParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.tree.cancel";
      params: TreeCancelParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.capabilities";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.release";
      params: ChildExecutionParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.process.wait.reconcile";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.reconcile";
      params: KernelEmptyParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.child.wait.cancel";
      params: ChildWaitParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.family.list";
      params: FamilyListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.family.runs";
      params: FamilyRunsParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.family.read";
      params: FamilyReadParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.family.item";
      params: FamilyItemParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.messages.send";
      params: MessageSendParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.messages.list";
      params: MessageListParams;
      epoch?: string;
      grantId?: string;
    }
  | {
      v: typeof KERNEL_PROTOCOL_VERSION;
      kind: "request";
      id: string;
      method: "runtime.messages.get";
      params: MessageGetParams;
      epoch?: string;
      grantId?: string;
    }
  | { v: typeof KERNEL_PROTOCOL_VERSION; kind: "cancel"; id: string; epoch?: string; grantId?: string; };
