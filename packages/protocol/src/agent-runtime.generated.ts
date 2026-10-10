// Generated from kernel/protocol/schema.json. Do not hand-edit.

export type CalendarRule =
  | { kind: 'once'; date: string; time: string }
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; times: string[]; weekdays: number[] }
  | { kind: 'cron'; expression: string };

export type CalendarMissedPolicy = 'skip' | 'coalesce_once';

export interface CalendarModel { providerId: string; modelId: string; thinkingLevel?: string; temperature?: number }

export type CalendarTarget =
  | { kind: 'new_work'; model: CalendarModel; sourceMode: SourceMode; goal: { budget: GoalBudget | null } | null }
  | { kind: 'existing_work'; threadId: string; branchId: string };

export type CalendarOnceAcceptanceOwner = 'pi' | 'agent';

export interface CalendarOnceAcceptance { owner: CalendarOnceAcceptanceOwner; acceptanceId: string; scheduledAtMs: number; acceptedAtMs: number; }

export interface CalendarDefinitionInput {
  taskId: string;
  assetRevision: string;
  assetKind: 'gui' | 'loop';
  name: string;
  enabled: boolean;
  onceAcceptance: CalendarOnceAcceptance | null;
  activationHold: 'previous_runtime_active' | 'asset_invalid' | null;
  timezone: string;
  rule: CalendarRule;
  missedPolicy: CalendarMissedPolicy;
  target: CalendarTarget;
  instruction: string;
}

export interface CalendarDefinition {
  id: string;
  project_id: string;
  task_id: string;
  asset_revision: string;
  asset_kind: 'gui' | 'loop';
  revision: number;
  generation: number;
  name: string;
  enabled: boolean;
  deleted: boolean;
  timezone: string;
  rule: CalendarRule;
  missed_policy: CalendarMissedPolicy;
  target: CalendarTarget;
  synchronized: boolean;
  once_acceptance: CalendarOnceAcceptance | null;
  activation_hold: 'previous_runtime_active' | 'asset_invalid' | null;
  next_at_ms: number | null;
  calculation_pending: boolean;
  calculation_failure: string | null;
}

export type CalendarOccurrenceReason = { kind: 'scheduled'; at_ms: number } | { kind: 'manual'; key: string };

export type CalendarOccurrenceState = 'observed' | 'preparing' | 'held' | 'queued' | 'delivered' | 'completed' | 'failed' | 'cancelled';

export interface CalendarOccurrence {
  id: string;
  definition_id: string;
  generation: number;
  revision: number;
  reason: CalendarOccurrenceReason;
  observed_at_ms: number;
  thread_id: string;
  branch_id: string;
  input_id: string | null;
  run_id: string | null;
  execution_id: string | null;
  goal_id: string | null;
  state: CalendarOccurrenceState;
  hold_reason: string | null;
  failure_code: string | null;
}

export interface CalendarProject {
  project_id: string;
  revision: number;
  definitions: CalendarDefinition[];
}

export interface CalendarCalculation {
  definition_id: string;
  generation: number;
  revision: number; // exact cursor calculation revision
  owner_epoch: number;
  rule: CalendarRule;
  timezone: string;
  after_ms: number;
  now_ms: number;
}

export interface CalendarSlot { at_ms: number; following_at_ms: number | null }

export interface CalendarCalculationResult {
  next: CalendarSlot | null; // first strictly after request.after_ms; once fixed instant is special
  latest_due: CalendarSlot | null; // latest real slot <= request.now_ms and > after_ms; never synthetic now
  next_future: CalendarSlot | null; // first real slot strictly > request.now_ms and >= after_ms
}

export interface CalendarPending {
  calculations: CalendarCalculation[];
  preparations: CalendarOccurrence[];
}

export interface CalendarPreparation {
  occurrence: CalendarOccurrence;
  definition: CalendarDefinition;
  instruction: string;
  owner_epoch: number;
}

export interface CalendarSyncParams {
  projectId: string;
  expectedRevision: number | null;
  definitions: CalendarDefinitionInput[];
}

export interface CalendarProjectParams {
  projectId: string;
}

export interface CalendarDefinitionParams {
  definitionId: string;
}

export interface CalendarRunParams {
  definitionId: string;
  expectedRevision: number;
  key: string;
}

export interface CalendarOccurrenceParams {
  occurrenceId: string;
}

export interface CalendarOccurrenceControlParams {
  occurrenceId: string;
  expectedRevision: number;
  action: CalendarOccurrenceControlAction;
}

export interface CalendarCalculatedParams {
  calculation: CalendarCalculation;
  result: CalendarCalculationResult | null;
  failureCode: string | null;
}

export interface CalendarAdmitParams {
  occurrenceId: string;
  expectedRevision: number;
  ownerEpoch: number;
  configuration: unknown;
  launch: SubmitLaunch;
  initialContext: InitialContext;
  inputPreparation?: InputResourcePreparation;
}

export interface CalendarPreparationFailedParams {
  occurrenceId: string;
  expectedRevision: number;
  ownerEpoch: number;
  failureCode: string;
}

export type CalendarOccurrenceControlAction = 'cancel' | 'retry';

export interface CalendarCalculationRetryParams {
  definitionId: string;
  expectedRevision: number;
}

export type MessageKind = 'inform' | 'request';

export type MessageActivationHold = 'manual_pause' | 'question' | 'goal_blocked' | 'dependency_wait' | 'preparing' | 'source_unsettled';

export type MessageActivation = { state: 'passive' } | { state: 'pending'; executionId: string | null; holdReason: MessageActivationHold | null } | { state: 'bound'; runId: string; executionId: string | null; holdReason: MessageActivationHold | null } | { state: 'cancelled'; runId: string | null; executionId: string | null } | { state: 'failed'; executionId: string | null; code: string };

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
  acceptedAtMs: number;
}

export interface ReplyWaitView { waitId: string; operationId: string; runId: string; deadlineAtMs: number | null; state: 'waiting' | 'replied' | 'expired' | 'cancelled'; replyMessageId: string | null; delivered: boolean }

export interface MessageSummary extends MessageReceipt {
  state: 'queued' | 'delivered' | 'cancelled';
  activation: MessageActivation;
  replyWait: ReplyWaitView | null;
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

export type FollowupSource = { kind: 'at'; at_ms: number } | { kind: 'process_stopped'; operation_id: string };

export type FollowupLeafEvidence = { kind: 'at'; at_ms: number; observed_at_ms: number } | { kind: 'process_stopped'; receipt_identity: string; receipt_epoch: string };

export interface FollowupSourceObservation {
  trigger_cursor: number;
  evidence: FollowupLeafEvidence;
}

export interface FollowupSourceState {
  source_index: number;
  after_cursor: number;
  observed: FollowupSourceObservation | null;
}

export interface FollowupSourceEvidence {
  source_index: number;
  trigger_cursor: number;
  evidence: FollowupLeafEvidence;
}

export type FollowupTrigger = FollowupSource | { kind: 'any' | 'all'; sources: FollowupSource[] } | { kind: 'run_completed'; cursor: number } | { kind: 'goal_requested'; cursor: number };

export type FollowupEvidence = FollowupLeafEvidence | { kind: 'any' | 'all'; sources: FollowupSourceEvidence[] } | { kind: 'run_completed'; run_revision: number } | { kind: 'goal_requested'; run_revision: number };

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

export type FollowupRegistrationSource = { kind: 'at'; atMs: number } | { kind: 'process_stopped'; operationId: string };

export type FollowupRegistrationTrigger = FollowupRegistrationSource | { kind: 'any' | 'all'; sources: FollowupRegistrationSource[] };

export type FollowupActor = { kind: 'user' } | { kind: 'agent'; run_id: string; operation_id: string; origin: ToolOrigin } | { kind: 'goal'; goal_id: string };

export interface FollowupGetParams {
  followupId: string;
}

export interface FollowupView {
  followup: Followup;
  instruction: string | null;
}

export interface FollowupObservation {
  wait_id: string;
  operation_id: string;
  run_id: string;
  state: 'waiting' | 'triggered' | 'cancelled';
  delivered: boolean;
}

export interface FollowupDelivery {
  input_id: string;
  state: InputState;
  activation_state: 'pending' | 'bound' | 'cancelled' | 'failed';
  run_id: string | null;
  execution_id: string | null;
  delivered_cursor: number | null;
  failure_code: string | null;
}

export interface FollowupRegisterParams {
  key: string;
  runId: string;
  trigger: FollowupRegistrationTrigger;
  instruction: string;
}

export interface FollowupControlParams {
  followupId: string;
  expectedRevision: number;
  action: FollowupControlAction;
}

export interface FollowupWait {
  id: string;
  kind: 'process_stopped' | 'run_completed' | 'goal_requested' | 'at' | 'any' | 'all';
  after_cursor: number;
  trigger_cursor: number | null;
  state: 'waiting' | 'observed' | 'consumed' | 'cancelled';
}

export interface FollowupOccurrence {
  id: string;
  generation: number;
  trigger_cursor: number;
  state: 'observed' | 'held' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  hold_reason: 'control_paused' | 'source_run_active' | 'source_unsettled' | 'branch_active' | 'context_scope_changed' | 'preparation_failed' | 'goal_paused' | 'goal_budget' | 'goal_blocked' | 'goal_ended' | 'goal_superseded' | null | 'manual_pause' | 'question' | 'preparing';
  evidence: FollowupEvidence;
  delivery: FollowupDelivery | null;
}

export interface Followup {
  id: string;
  revision: number;
  generation: number;
  thread_id: string;
  branch_id: string;
  source_run_id: string;
  sources: FollowupSourceState[];
  state: 'active' | 'paused' | 'cancelled';
  wait: FollowupWait;
  occurrence: FollowupOccurrence | null;
  goal_id: string | null;
  trigger: FollowupTrigger;
  actor: FollowupActor;
  has_instruction: boolean;
  registered_at_ms: number;
  observation: FollowupObservation | null;
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

export type DelegatedExecutionTrigger = { kind: 'dispatch' } | { kind: 'user_continuation'; key: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'message_request'; message_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'followup'; followup_id: string; occurrence_id: string; input_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'calendar'; definition_id: string; occurrence_id: string; input_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null };

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
  deadline_at_ms: number | null;
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
