// Generated from kernel/protocol/schema.json. Do not hand-edit.

export interface NativeHistoryPageParams {
  branchId: string;
  headId?: string;
  beforeId?: string;
  limit: number;
}

export interface NativeHistoryBodyParams {
  itemId: string;
  chunkIndex: number;
}

export interface NativeHistoryReference {
  id: string;
  thread_id: string;
  parent: string | null;
  source: NativeHistorySource;
  content_ref: string;
}

export interface NativeHistoryPage {
  head: string | null;
  items: NativeHistoryReference[];
  previous: string | null;
}

export interface NativeHistoryBodyChunk {
  itemId: string;
  contentRef: string;
  chunkIndex: number;
  chunkCount: number;
  totalBytes: number;
  bytesBase64: string;
}

export interface NativeRunReconcileParams {
  runId: string;
  toolBinding: unknown;
}

export interface NativeRunReconcileResult {
  reconciled: string[];
  unresolved: string[];
}

export interface NativeSubmitLaunch {
  inheritSource?: boolean;
  source: NativeLaunchSourceParams | null;
  enabledTools: string[];
  credentialScope?: NativeCredentialScope;
}

export interface NativeLaunchFailedParams {
  runId: string;
  code: string;
}

export interface NativeThreadParams {
  threadId: string;
}

export interface NativeThreadBranch {
  branch_id: string;
  head: string | null;
  active_run_id: string | null;
  latest_run: NativeRun | null;
}

export interface NativeThreadSummary {
  thread_id: string;
  branches: NativeThreadBranch[];
  observer_project_ids: Array<string | null>;
}

export type NativeRuntimeStreamEvent = {v: 1; kind: 'runtime-event'; kernelEpoch: string} & ({stream: 'durable'; cursor: number} | {stream: 'progress'; runId: string; streamId: string; sequence: number; event: unknown});

export interface NativeLaunchSourceParams {
  environmentRunId?: string;
  materialized: boolean;
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string | null;
  revision: number | null;
}

export interface NativeLaunchSelectParams {
  runId: string;
  source: NativeLaunchSourceParams | null;
  enabledTools: string[];
  credentialScope?: NativeCredentialScope;
}

export interface NativeLaunchSource {
  environment_run_id?: string | null;
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

export interface NativeAgentPolicyBinding {
  reference: string;
  identity: NativeLaunchPolicy;
}

export interface NativePolicyModelCapability {
  capability_id: string;
  purpose: string;
  status: NativePolicyModelStatus;
  binding_id: string | null;
  configuration_identity: string | null;
  supported_operation: string;
  binding: unknown;
  configuration: NativeModelSessionConfiguration | null;
  credential_scope: NativeCredentialScope | null;
}

export type NativePolicyModelStatus = 'available' | 'disabled' | 'unconfigured' | 'invalid' | 'unavailable';

export interface NativePolicyPrepareParams {
  runId: string;
  identity: NativeLaunchPolicy;
  policyModels?: unknown;
}

export interface NativeMcpBinding {
  resources: Record<string, string>;
  reference: string;
  generation: number;
  tools: NativeLaunchTool[];
}

export interface NativeMcpPrepareParams {
  runId: string;
  binding: NativeMcpBinding;
}

export interface NativeLaunchSelection {
  policy_models: NativePolicyModelCapability[];
  mcp_binding: NativeMcpBinding | null;
  credential_scope: NativeCredentialScope | null;
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
  preparation_failure: string | null;
  run_id: string;
  revision: number;
  selection: NativeLaunchSelection;
  bound_epoch: number | null;
  requires_rebind: boolean;
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

export interface NativeBranchForkParams {
  sourceBranchId: string;
  branchId: string;
  headId: string | null;
}

export interface NativeBranchForkResult {
  threadId: string;
  branchId: string;
}

export interface NativeContextJobCreateParams {
  key: string;
  branchId: string;
  throughId: string;
  expectedRevision: number;
  effectiveSystemPrompt: string;
  instructionSources: string[];
  memoryCheckpoint: string | null;
  configuration: unknown;
  credentialScope?: NativeCredentialScope;
}

export interface NativeRunStartParams {
  policyBinding?: NativeAgentPolicyBinding;
  mcpBinding?: NativeMcpBinding;
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

export interface NativeSystemSection {
  name: string;
  content: string;
}

export interface NativeContextFragment {
  name: string;
  kind: string;
  content: string;
}

export interface NativeContextComposition {
  providerId: string;
  contentVersion: string;
  scopeId: string;
  selectionRevision: number;
  sections: NativeContextFragment[];
}

export interface NativeContextPersonalization {
  contextComposition?: NativeContextComposition;
  revision: number;
  sessionId: string;
  projectId: string | null;
  originalSections: NativeSystemSection[];
  instructionSources: string[];
}

export interface NativeContextRefreshParams {
  branchId: string;
  expectedRevision: number;
  context: NativeInitialContext;
}

export interface NativeInitialContext {
  personalization?: NativeContextPersonalization;
  effectiveSystemPrompt: string;
  instructionSources: string[];
  memoryCheckpoint: string | null;
}

export interface NativeInputSubmitParams {
  initialContext?: NativeInitialContext;
  launch?: NativeSubmitLaunch;
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

export interface NativePermissionOpenParams {
  operationId: string;
  permissionId: string;
  call: unknown;
  scope: unknown;
}

export interface NativePermissionDecideParams {
  operationId: string;
  permissionId: string;
  decision: string;
}

export interface NativeQuestionAnswerParams {
  operationId: string;
  answer: string;
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

export interface NativeObserverReadParams {
  observerId: string;
  threadId: string;
  limit: number;
  throughCursor: number;
}

export interface NativeObserverDeliveryParams {
  observerId: string;
  threadId: string;
  cursor: number;
  state: NativeDeliveryState;
}

export interface NativeStatus {
  epoch: number;
  eventCursor: number;
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
