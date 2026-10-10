// Generated from kernel/protocol/schema.json. Do not hand-edit.

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

export type AgentResourceRequest = { kind: 'skill'; resourceId: string } | { kind: 'skill-resource'; resourceId: string; relativePath: string } | { kind: 'instruction-scope'; targetPath: string; targetType?: 'file' | 'directory' };

export interface ResourceRefreshParams {
  branchId: string;
  expectedRevision: number;
  context: InitialContext;
}

export interface ResourceSnapshotParams {
  runId: string;
  origin: ToolOrigin;
  callId: string;
  resourceCheckpointId: string;
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

export interface McpBinding {
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

export type InputMode = "boundary" | "interrupt" | "next_run";

export type InputState = "queued" | "delivered" | "cancelled";

export interface InputEnqueueParams {
  key: string;
  threadId: string;
  branchId: string;
  mode: InputMode;
  input: unknown;
  configuration?: unknown;
}

export interface InputEditParams {
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

export type ModelStepState = "prepared" | "dispatched" | "completed" | "interrupted" | "failed" | "cancelled";

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
  kind: 'process_stopped';
  after_cursor: number;
  trigger_cursor: number | null;
  state: 'waiting' | 'observed' | 'consumed' | 'cancelled';
}

export interface FollowupOccurrence {
  id: string;
  generation: number;
  trigger_cursor: number;
  receipt_identity: string;
  receipt_epoch: string;
  state: 'observed' | 'held' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  hold_reason: 'control_paused' | 'source_run_active' | 'source_unsettled' | 'branch_active' | 'context_scope_changed' | 'preparation_failed' | null;
  receipt: InputSubmitReceipt | null;
}

export interface Followup {
  id: string;
  revision: number;
  generation: number;
  thread_id: string;
  branch_id: string;
  source_run_id: string;
  operation_id: string;
  state: 'active' | 'paused' | 'cancelled';
  wait: FollowupWait;
  occurrence: FollowupOccurrence | null;
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
}

export interface RuntimeEvent {
  cursor: number;
  subject: string;
  revision: number;
  kind: string;
  data: unknown;
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

export type ChildSource = { kind: 'pending'; handoff: ChildSourceHandoff } | { kind: 'ready'; handoff: ChildSourceHandoff; pin: ChildSourcePin; selection: LaunchSource; provenance: ChildSourceProvenance };

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
  operationId: string;
  pin: ChildSourcePin;
  source: LaunchSourceParams;
  provenance: ChildSourceProvenance;
}

export interface ChildSettleParams {
  operationId: string;
  toolBinding: unknown;
}

export interface ChildResultCandidateParams {
  operationId: string;
  toolBinding: unknown;
  candidateOperationId: string;
}

export interface ChildResultPublishedParams {
  operationId: string;
  toolBinding: unknown;
  publicationId: string;
}

export interface ChildPrepareParams {
  operationId: string;
  source: LaunchSourceParams;
  context: InitialContext;
}

export interface ChildFailParams {
  operationId: string;
  code: string;
}

export interface ChildWaitParams {
  waitId: string;
}

export interface ChildInput {
  task: string;
  model: string;
  profile: string;
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
