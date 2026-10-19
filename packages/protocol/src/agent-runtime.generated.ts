// Generated from kernel/protocol/schema.json. Do not hand-edit.

export interface ModelHttpConfiguration { headers?:Record<string,string>; proxy?:{mode:"direct"}|{mode:"proxy";url:string} }

export interface FileObservationAuthority {coordinatorHostId:string;authorityId:string;resourceEpoch:string;}

export interface InferenceReceiptPendingParams {
  operationId: string;
  executionOwner: ExecutorOwner;
  requestStarted: boolean | null;
}

export type InferenceRequestKind = 'preparation' | 'model_compute';

export type InferenceExecutor = { kind: "http"; api: string; endpoint: string; credentialScope: CredentialScope } | { kind: "local_component"; componentId: string; componentVersion: string; manifestDigest: string; modelRevision: string; workerProtocol: number };

export interface InferenceBinding {
  requestKind: InferenceRequestKind;
  purpose: string;
  providerId: string;
  modelId: string;
  configurationId: string;
  executor: InferenceExecutor;
}

export interface InferenceUsage {
  measurement: "missing" | "estimated" | "actual";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  pricingVersion?: string | null;
}

export interface InferenceReceipt {
  requestStarted: boolean | null;
  providerCompleted: boolean;
  localExecutorStopped: boolean;
  usage: InferenceUsage;
  httpStatus: number | null;
  problem: InferenceProblem | null;
}

export interface InferenceSessionParams {
  parentOperationId: string;
  executionOwner: ExecutorOwner;
}

export interface InferenceSessionStatus {
  hasRequests: boolean;
}

export interface ModelPresentationParams {
  requestIds: string[];
}

export interface ModelPresentation { requestId: string; providerFamily: string; modelId: string; contextTokens?: number | null; usage: InferenceUsage; }

export interface ThreadUsageParams {
  threadId: string;
  branchId: string;
}

export interface UsageTokenCount { known: string | null; missing: number; }

export interface ThreadUsageRow { kind: 'conversation' | 'context' | 'planning' | 'mcp_sampling' | 'auxiliary'; providerId: string | null; providerFamily: string | null; modelId: string; measurement: 'missing' | 'estimated' | 'actual'; requests: number; pendingRequests: number; inputTokens: UsageTokenCount; outputTokens: UsageTokenCount; cachedInputTokens: UsageTokenCount; cacheWriteTokens: UsageTokenCount; reasoningTokens: UsageTokenCount; }

export interface ThreadUsage { threadId: string; branchId: string; throughCursor: number; notDispatchedRequests: number; rows: ThreadUsageRow[]; }

export interface InferenceGenerateParams {
  parentOperationId: string;
  callerOwner: ExecutorOwner;
  ordinal: number;
  configuration: ModelSessionConfiguration;
  credentialScope: CredentialScope;
  purpose: string;
  systemPrompt: string;
  user: string;
}

export interface InferenceAdmitParams {
  parentOperationId: string;
  executionOwner: ExecutorOwner;
  ordinal: number;
  binding: InferenceBinding;
  request: unknown;
}

export interface InferenceOwnerParams {
  operationId: string;
  executionOwner: ExecutorOwner;
}

export interface InferenceSettleParams {
  operationId: string;
  executionOwner: ExecutorOwner;
  receipt: InferenceReceipt;
  response: unknown;
}

export interface InferenceStatus {
  requestKind: InferenceRequestKind;
  operationId: string;
  phase: OperationPhase;
  outcome: Outcome | null;
  live: boolean;
  cancelRequested: boolean;
  dispatched: boolean;
  recovered: boolean;
  receiptPending: boolean;
  receipt: InferenceReceipt | null;
}

export type InferenceProblem = 'cancelled' | 'transport_failed' | 'executor_failed' | 'http_rejected' | 'invalid_response' | 'owner_interrupted' | 'not_dispatched' | 'receipt_pending';

export interface McpInteractionPending extends McpInteractionRecord {
  generation?: McpSamplingGeneration;
}

export type McpInteractionPresentation = McpElicitationPresentation | { mode: 'sampling'; message: string };

export interface McpSamplingGenerateParams {
  operationId: string;
  interactionId: string;
  expectedRevision: number;
  editedRequest: Record<string, unknown>;
  configuration: ModelSessionConfiguration;
  credentialScope?: CredentialScope;
}

export interface McpSamplingOutputReviewParams {
  operationId: string;
  interactionId: string;
  expectedRevision: number;
  action: McpSamplingOutputAction;
}

export interface McpSamplingRequestReviewParams {
  operationId: string;
  interactionId: string;
  expectedRevision: number;
  action: McpSamplingRequestAction;
  editedRequest?: Record<string, unknown>;
}

export type McpSamplingOutputAction = 'accept' | 'decline' | 'cancel';

export type McpSamplingRequestAction = 'generate' | 'decline' | 'cancel';

export interface McpSamplingBodies { editedRequest: Record<string, unknown> | null; output: McpSamplingResult | null; providerOutput: unknown | null; receipt: unknown | null; snapshot: unknown | null; }

export interface McpSamplingResult { role: 'assistant'; model: string; content: { type: 'text'; text: string } | { type: 'text'; text: string }[]; stopReason?: string; }

export interface McpSamplingGeneration { operationId: string; phase: OperationPhase; outcome: Outcome | null; cancelRequested: boolean; dispatch: 'not_started' | 'started' | 'completed' | 'interrupted'; model: { providerId: string | null; providerFamily: string; model: string; maxTokens: number } | null; usage: { measurement: 'missing' | 'estimated' | 'actual'; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null; pricingVersion: string | null }; problem: string | null; }

export interface McpSamplingState { generationOperationId: string | null; review: 'request' | 'output' | 'closed'; }

export type McpRequestId = string | number;

export type McpInteractionRelation = { kind: 'rpc_response_stream'; outgoingRequestId: McpRequestId } | { kind: 'task'; taskId: string };

export type McpInteractionSource = { kind: 'server_request'; requestId: McpRequestId; relation: McpInteractionRelation } | { kind: 'rpc_error'; outgoingRequestId: McpRequestId; method: string; elicitationId: string; taskId?: string };

export type McpElicitationResponse = { action: 'accept'; content?: Record<string, string | number | boolean | string[]> } | { action: 'decline' | 'cancel' };

export interface McpElicitationField { name: string; title: string; description?: string; required: boolean; kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi_enum'; options?: { value: string; title: string }[]; default?: string | number | boolean | string[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; pattern?: string; format?: 'email' | 'uri' | 'date' | 'date-time'; }

export type McpElicitationPresentation = { mode: 'form'; message: string; fields: McpElicitationField[] } | { mode: 'url'; message: string; url: string; elicitationId: string };

export type McpInteractionMode = 'form' | 'url' | 'sampling';

export type McpInteractionChoice = 'accept' | 'decline' | 'cancel';

export type McpInteractionAvailability = 'live' | 'cancelled' | 'connection_lost' | 'owner_unavailable' | 'rpc_closed';

export type McpInteractionDelivery = 'not_started' | 'sending' | 'sent' | 'unknown' | 'not_sent';

export interface McpInteractionBinding {
  operationId: string;
  executionOwner: ExecutorOwner;
  endpoint: McpEndpoint;
  connectionId: string;
  source: McpInteractionSource;
}

export interface McpInteractionRecord {
  id: string;
  revision: number;
  binding: McpInteractionBinding;
  runId: string;
  threadId: string;
  branchId: string;
  mode: McpInteractionMode;
  availability: McpInteractionAvailability;
  choice: McpInteractionChoice | null;
  delivery: McpInteractionDelivery | null;
  completionReported: boolean;
  deliveryReleased: boolean;
  problem: string | null;
  sampling?: McpSamplingState;
}

export interface McpInteractionItem {
  record: McpInteractionRecord;
  presentation: McpInteractionPresentation;
  response: McpElicitationResponse | null;
  generation?: McpSamplingGeneration;
}

export interface McpInteractionView extends McpInteractionItem {
  request: Record<string, unknown>;
  sampling?: McpSamplingBodies;
}

export interface McpInteractionPage {
  items: McpInteractionItem[];
  nextCursor: string | null;
}

export interface McpInteractionOpenParams {
  id: string;
  binding: McpInteractionBinding;
  mode: McpInteractionMode;
  request: Record<string, unknown>;
  presentation: McpInteractionPresentation;
}

export interface McpInteractionErrorItem {
  id: string;
  binding: McpInteractionBinding;
  presentation: McpElicitationPresentation;
}

export interface McpInteractionErrorOpenParams {
  items: McpInteractionErrorItem[];
  request: Record<string, unknown>;
}

export interface McpInteractionListParams {
  threadId: string;
  branchId: string;
  cursor?: string;
  limit?: number;
}

export interface McpInteractionContext {
  record: McpInteractionRecord;
  owner: McpServerOwner;
}

export interface McpInteractionReadParams {
  operationId: string;
  interactionId: string;
}

export interface McpInteractionRespondParams {
  operationId: string;
  interactionId: string;
  expectedRevision: number;
  response: McpElicitationResponse;
}

export interface McpInteractionControlParams {
  binding: McpInteractionBinding;
  interactionId: string;
}

export interface McpInteractionSettleParams {
  binding: McpInteractionBinding;
  interactionId: string;
  delivery: McpInteractionDelivery;
}

export interface McpInteractionCloseParams {
  binding: McpInteractionBinding;
  interactionId: string;
  availability: McpInteractionAvailability;
  problem?: string;
}

export interface MediaReadChunk { media:StoredMedia;partIndex:number;chunkIndex:number;chunkCount:number;totalBytes:number;bytesBase64:string }

export interface MediaReadParams { threadId:string;branchId:string;holder:OutputMediaHolder;partIndex:number;chunkIndex:number;expectedContentRef:string }

export type OutputMediaHolder = {kind:'history';itemId:string} | {kind:'input';inputId:string;expectedRevision:number} | {kind:'operation';operationId:string;output:'completion'|'result'|'external_receipt' | 'mcp_task_result'} | {kind:'event';cursor:number;output:'completion'|'result'|'external_receipt' | 'mcp_task_result'} | {kind:'policy_evidence';reference:OutputEvidenceRef} | {kind:'child_report';operationId:string;executionId?:string;itemId:string} | {kind:'family';threadId:string;branchId:string;runId?:string;anchor:string;itemId:string};

export type OperationResult = {kind:'control';value:unknown} | {kind:'output';output:OutputBody};

export interface OutputBody<M = StoredMedia> { data: unknown; parts: OutputPart<M>[] }

export type OutputPart<M = StoredMedia> = {kind:'text';text:string} | {kind:'media';media:M};

export interface ResolvedMedia { media_type: string; source: OutputSource; data_base64: string }

export interface StoredMedia { media_type: string; source: OutputSource; content_ref: ContentRef }

export interface IncomingMedia { media_type: string; data_base64: string }

export interface ContentRef { content_object: string }

export type OutputSource = {kind:'conversation';provenance:ContentProvenance} | {kind:'tool';context:{run_id:string;origin:ToolOrigin;operation_id:string}} | {kind:'operation';operation_id:string};

export type ContentProvenance = {kind:'system_instruction';source:string} | {kind:'goal_instruction';goal_id:string;generation:number} | {kind:'user_instruction';input_id:string} | {kind:'sampling';interaction_id:string;role:'system'|'user'|'assistant'} | {kind:'assistant'} | {kind:'policy_output';action_id:string;identity:{name:string;version:string}} | {kind:'tool_data';call_id:string} | {kind:'policy_tool_data';reference:OutputEvidenceRef} | {kind:'external_data';source:string} | {kind:'agent_message';thread_id:string} | {kind:'environment_fact';event_id:string};

export interface OutputEvidenceRef { action_id: string; node_id: string; content_ref: string }

export interface ManagedProcess { purpose: ManagedProcessKind; kernel_epoch: string | null; }

export type ManagedProcessKind = {kind:'process_job'} | {kind:'script_environment';node:NodeBinding};

export interface NodeBinding { executable: string; worker_path: string; worker_identity: string; configuration_identity: string; }

export interface ToolRequirements { source: 'source' | 'physical' | 'live'; process: boolean; }

export type ComputerEventKind = 'takeover' | 'cancel' | 'handback';

export interface ComputerEventFact {
  id: string;
  kind: ComputerEventKind;
  desktopId: string;
  execution: ComputerRequestExecution;
  at: string;
  releaseConfirmed: boolean;
}

export interface ComputerEventCommand {
  fact: ComputerEventFact;
  label: string;
}

export interface ComputerEventCancellation {
  id: string;
  execution: ComputerRequestExecution;
  desktopId: string;
  pendingEventIds: string[];
}

export interface ComputerEventReceipt {
  eventId: string;
  inputIds: string[];
  cursor: number;
}

export interface ComputerRequestExecution {
  threadId: string;
  branchId: string;
  runId: string;
}

export type ComputerRequestAccess = 'observe' | 'control';

export type ComputerRequestStatus = 'pending' | 'granting' | 'granted' | 'denied' | 'cancelled' | 'indeterminate';

export type ComputerDecisionActor = {kind:'tool';operationId:string} | {kind:'user';threadId:string;branchId:string;key:string};

export interface ComputerDecisionClaim {
  actor: ComputerDecisionActor;
  manager: ComputerRequestExecution | null;
  hostEpoch: string;
  assignmentId: string;
  approved: boolean;
  reasonRef: unknown | null;
}

export interface ComputerRequestRecord {
  id: string;
  operationId: string;
  rootThreadId: string;
  rootBranchId: string;
  desktopId: string;
  executionOwner: ExecutorOwner;
  requester: ComputerRequestExecution;
  access: ComputerRequestAccess;
  revision: number;
  status: ComputerRequestStatus;
  createdAtMs: number;
  requestRef: unknown;
  detailRef: unknown | null;
  claim: ComputerDecisionClaim | null;
}

export interface ComputerRequestView {
  request: ComputerRequestRecord;
  reason: string;
  detail: string | null;
}

export interface ComputerRequestCreateParams {
  operationId: string;
  desktopId: string;
  access: ComputerRequestAccess;
  reason: string;
}

export interface ComputerRequestListParams {
  rootThreadId?: string;
  rootBranchId?: string;
}

export interface ComputerDecisionBeginParams {
  requestId: string;
  expectedRevision: number;
  actor: ComputerDecisionActor;
  approved: boolean;
  hostEpoch: string;
  assignmentId: string;
  reason?: string;
}

export interface ComputerDecisionSettleParams {
  requestId: string;
  claim: ComputerDecisionClaim;
  status: ComputerRequestStatus;
  reason?: string;
}

export type ComputerRequestCancelTarget = {kind:'requests';requestIds:string[]} | {kind:'execution';execution:ComputerRequestExecution;family:boolean;desktopId:string | null};

export interface ComputerRequestCancelParams {
  target: ComputerRequestCancelTarget;
}

export interface ComputerRequestReconcileParams {
  hostEpoch?: string;
}

export interface ComputerRequestWaitParams {
  operationId: string;
  requestId: string;
}

export interface HostJobBinding {
  operationId: string;
  executionOwner: ExecutorOwner;
  domain: string;
  domainVersion: number;
  subject: HostJobSubject;
}

export interface ResearchScope {
  canSubmit: boolean;
  rootThreadId: string;
  threadId: string;
  branchId: string;
  sourceRunId: string;
  source: LaunchSource;
  readThreadIds: string[];
  controlThreadIds: string[];
}

export interface ResearchScopeParams {
  threadId: string;
  branchId: string;
  sourceRunId?: string;
  operationId?: string;
}

export interface HostJobUserParams {
  subjectId: string;
  threadId: string;
  branchId: string;
  sourceRunId: string;
  key: string;
  domain: string;
  domainVersion: number;
  request: unknown;
}

export type HostJobOrigin = {kind:'tool';origin:ToolOrigin;call_id:string;tool_name:string;schema_version:string} | {kind:'user';key:string};

export interface HostJobPending {
  mcpHolderReleased: boolean;
  executorStopped: boolean;
  binding: HostJobBinding;
  runId: string;
  accepted: boolean;
  cancelRequested: boolean;
  phase: OperationPhase;
  origin: HostJobOrigin;
  mcpTask?: McpTaskLink;
}

export interface HostJobSource {
  observationKinds: ('job_stopped' | 'job_result' | 'artifact' | 'collection' | 'log_literal' | 'log_end')[];
  binding: HostJobBinding;
  sourceRunId: string;
  threadId: string;
  branchId: string;
  cancelRequested: boolean;
  phase: OperationPhase;
  executorStopped: boolean;
  origin: HostJobOrigin;
  mcpTask?: McpTaskLink;
}

export interface HostJobLink {
  mcpHolderReleased: boolean;
  binding: HostJobBinding;
  acceptanceRef: unknown | null;
  mcpTask?: McpTaskLink;
}

export interface HostJobBeginParams {
  binding: HostJobBinding;
}

export interface HostJobAcceptParams {
  binding: HostJobBinding;
  content: OutputBody<IncomingMedia>;
  task?: McpTaskState;
}

export interface HostJobTerminalParams {
  binding: HostJobBinding;
  outcome: Outcome;
  effect: Effect;
  content: OutputBody<IncomingMedia>;
  executorStopped: boolean;
}

export interface HostJobObserveParams {
  operationId: string;
  targetOperationId: string;
  mode?: HostJobWaitMode;
}

export type CalendarRule =
  | { kind: 'once'; date: string; time: string }
  | { kind: 'daily'; times: string[] }
  | { kind: 'weekly'; times: string[]; weekdays: number[] }
  | { kind: 'cron'; expression: string };

export type CalendarMissedPolicy = 'skip' | 'coalesce_once';

export interface CalendarModel { providerId: string; modelId: string; thinkingLevel?: string; temperature?: number }

export type CalendarSource =
  | { kind: 'project' }
  | { kind: 'workspace'; resourceOwner: SourceResourceOwner; workspaceId: string };

export type CalendarTarget =
  | { kind: 'new_work'; model: CalendarModel; source: CalendarSource; sourceMode: SourceMode; goal: { budget: GoalBudget | null } | null }
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
  sourceAgent?: string;
  name?: string;
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

export type LogStream = 'stdout' | 'stderr';

export interface FollowupLogState {
  offset: number;
  matched_prefix: number;
  ended: boolean;
  failure_code: string | null;
}

export type FollowupLogEvidence = { kind: 'log_literal'; binding: HostJobBinding; stream: LogStream; start_offset: number; end_offset: number; published_bytes: number; job_revision: number } | { kind: 'log_end'; binding: HostJobBinding; stream: LogStream; published_bytes: number; job_revision: number | null; attempt_revision: number };

export type MetricKind = 'cpu_percent' | 'memory_mb' | 'gpu_percent' | 'gpu_memory_mb';

export type MetricPredicate = 'above' | 'below';

export type MetricAvailability = 'available' | 'missing' | 'stale' | 'unavailable';

export interface MetricMachineIdentity {
  host_id: string;
  machine_id: string;
  kind: string;
  backend: string | null;
  target_host_id: string | null;
}

export interface FollowupMetricState {
  identity: MetricMachineIdentity | null;
  sample_revision: number | null;
  observed_at_ms: number | null;
  status: MetricAvailability;
  failure_code: string | null;
  holding: boolean | null;
  value: number | null;
  gap: boolean;
}

export interface FollowupMetricEvidence {
  identity: MetricMachineIdentity;
  machine_revision: number;
  sample_revision: number;
  observed_at_ms: number;
  metric: MetricKind;
  gpu_uuid: string | null;
  predicate: MetricPredicate;
  threshold: number;
  value: number;
  gap: boolean;
}

export type ResearchCollectionOutcome = 'done' | 'failed' | 'not_started';

export interface ResearchArtifactCounts {
  available: number;
  failed: number;
  expired: number;
  pending: number;
}

export type FollowupArtifactFact = { kind: 'artifact_available' | 'artifact_failed' | 'artifact_expired'; artifact_id: string; record_revision: number } | { kind: 'artifact_missing' | 'artifact_absent'; completion_revision: number; outcome: ResearchCollectionOutcome };

export interface FollowupArtifactEvidence {
  kind: 'artifact';
  binding: HostJobBinding;
  fact: FollowupArtifactFact;
  gap: boolean;
}

export interface FollowupCollectionEvidence {
  kind: 'collection';
  binding: HostJobBinding;
  completion_revision: number;
  outcome: ResearchCollectionOutcome;
  counts: ResearchArtifactCounts;
  gap: boolean;
}

export type FileCondition = 'exists' | 'changed' | 'ready';

export type FileState = { kind: 'regular-file'; objectHash: string; byteLength: number; mode: number | null } | { kind: 'directory'; mode: number | null } | { kind: 'symlink'; symlinkTarget: string; mode: number | null } | { kind: 'missing' } | { kind: 'unsupported' };

export interface FileWatchPosition {
  sourceId: string;
  generation: number;
  sequence: number;
}

export type FileProof = 'exists' | 'snapshot_difference' | 'targeted_invalidation' | 'managed_ready';

export interface FollowupFileEvidence {
  kind: 'file';
  receipt_id: string;
  condition: FileCondition;
  path: string;
  state: FileState;
  proof: FileProof;
  position: FileWatchPosition | null;
  gap: boolean;
  observed_at_ms: number;
}

export interface FollowupFileSourceState {
  resource_authority: FileObservationAuthority | null;
  receipt_id: string;
  revision: number;
  baseline: FileState | null;
  current: FileState | null;
  ready: boolean;
  immutable: boolean;
  watch_id: string | null;
  position: FileWatchPosition | null;
  gap: boolean;
  failure_code: string | null;
  released: boolean;
}

export interface FollowupPendingRegistration {
  id: string;
  sourceRunId: string;
  threadId: string;
  branchId: string;
  paths: string[];
}

export interface FollowupPendingParams {
  threadId: string;
  branchId: string;
  after?: string;
}

export interface FollowupPendingResult {
  registrations: FollowupPendingRegistration[];
  nextCursor: string | null;
}

export interface FollowupRegistrationCancelParams {
  key: string;
  runId: string;
}

export interface FollowupRegistrationCancelResult {
  followup: Followup | null;
}

export type FollowupSource = { kind: 'at'; at_ms: number } | { kind: 'process_stopped'; operation_id: string } | { kind: 'job_stopped'; operation_id: string } | { kind: 'file'; path: string; condition: FileCondition } | { kind: 'artifact'; operation_id: string; artifact_id?: string; name?: string } | { kind: 'collection'; operation_id: string } | { kind: 'log_literal'; operation_id: string; stream: LogStream; from_offset: number; literal_bytes: number } | { kind: 'log_end'; operation_id: string; stream: LogStream } | { kind: 'metric'; machine_id: string; metric: MetricKind; gpu_uuid?: string; predicate: MetricPredicate; threshold: number };

export type FollowupLeafEvidence = { kind: 'at'; at_ms: number; observed_at_ms: number } | { kind: 'process_stopped'; receipt_identity: string; receipt_epoch: string } | { kind: 'job_stopped'; binding: HostJobBinding; outcome: Outcome; effect: Effect; receipt_identity: string; receipt_epoch: string } | FollowupFileEvidence | FollowupArtifactEvidence | FollowupCollectionEvidence | FollowupLogEvidence | { kind: 'metric'; fact: FollowupMetricEvidence };

export interface FollowupSourceObservation {
  accepted_cursor: number;
  trigger_cursor: number;
  evidence: FollowupLeafEvidence;
}

export interface FollowupSourceState {
  consumed_cursor: number;
  source_index: number;
  after_cursor: number;
  observed: FollowupSourceObservation | null;
  file: FollowupFileSourceState | null;
  log: FollowupLogState | null;
  metric: FollowupMetricState | null;
}

export interface FollowupSourceEvidence {
  accepted_cursor: number;
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

export type AgentResourceRequest = { kind: 'skill'; resourceId: string; activationId?: string } | { kind: 'skill-resource'; resourceId: string; relativePath: string; activationId?: string } | { kind: 'instruction-scope'; targetPath: string; targetType?: 'file' | 'directory' } | { kind: 'ui'; ref: string; view?: 'summary' | 'source' | 'state' | 'screen' | 'structure'; file?: string; startLine?: number; endLine?: number; offset?: number; limit?: number };

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

export type RetrievalInvocation = { kind: 'model_step'; requestId: string; toolCallId: string } | { kind: 'policy_action'; actionId: string; nodeId: string; toolCallId: string } | { kind: 'nested_call'; parentOperationId: string; toolCallId: string };

export interface RetrievalQuery {
  inferenceOwner: ExecutorOwner;
  invocation: RetrievalInvocation;
  runId: string;
  threadId: string;
  source: LaunchSource;
  physicalRoot: LiveRoot | null;
  grantId: string;
  projectId: string | null;
  question: string;
  paths?: string[];
  limit?: number;
}

export interface LanguageQuery {
  runId: string;
  threadId: string;
  grantId: string;
  source: LaunchSource;
  physicalRoot: LiveRoot | null;
  method: "definition" | "references" | "diagnostics" | "hover" | "workspace_symbols" | "document_symbols" | "call_hierarchy";
  path: string;
  line?: number;
  character?: number;
  query?: string;
  direction?: "incoming" | "outgoing";
}

export interface RecoveryAnchor {
  executionId: string;
  threadId: string;
  branchId: string;
  runId: string;
  entryId: string;
  epoch: number;
}

export interface RecoveryRangeTurn {
  anchor: RecoveryAnchor;
  entryIds: string[];
  source: LaunchSource | null;
  uncovered: boolean;
  settled: boolean;
}

export interface NavigationSelectParams {
  threadId: string;
  branchId: string;
  entryId: string;
}

export interface NavigationParams {
  threadId: string;
  branchId: string;
  key: string;
  expectedHeadId: string | null;
  targetHeadId: string | null;
  undoOf?: string;
}

export interface NavigationReceiptParams {
  threadId: string;
  branchId: string;
  key?: string;
}

export interface NavigationSelection {
  expectedHeadId: string | null;
  targetHeadId: string | null;
  removedEntryIds: string[];
  editorText?: string;
}

export interface NavigationReceipt {
  threadId: string;
  branchId: string;
  key: string;
  previousHeadId: string | null;
  headId: string | null;
  alreadyApplied: boolean;
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

export interface AgentSelection {
  profileId: string | null;
  name: string | null;
  workFocus: "code" | "research";
  tools: string[] | null;
}

export interface SubmitLaunch {
  agent?: AgentSelection;
  inheritSource?: boolean;
  source: LaunchSourceParams | null;
  enabledTools: string[];
  credentialScope?: CredentialScope;
  childDispatch?: ChildDispatchCatalog;
}

export type SourceFailureCode = 'source_unavailable' | 'source_registration_missing' | 'source_authority_denied' | 'source_environment_unavailable' | 'source_changed';

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

export interface ThreadCatalogQuery { query?: string; archived?: 'exclude' | 'include' | 'only'; }

export interface ThreadMetadataUpdateParams { threadId: string; key: string; expectedRevision: number; title?: string; pinned?: boolean; archived?: boolean; }

export interface ThreadDeleteParams { threadId: string; key: string; expectedRevision: number; }

export interface ThreadReadPositionParams { threadId: string; key: string; throughCursor: number; }

export interface ThreadSummary {
  agent_code?: string;
  parent_thread_id: string | null;
  main_branch_id: string;
  title: string;
  revision: number;
  created_at_ms: number;
  updated_at_ms: number;
  pinned: boolean;
  archived: boolean;
  deleted_at_ms: number | null;
  activity_cursor: number;
  read_cursor: number;
  unread: boolean;
  bot_id: string | null;
  thread_id: string;
  branches: ThreadBranch[];
  observer_project_ids: Array<string | null>;
}

export type AgentRuntimeStreamEvent = {v: 51; kind: 'runtime-event'; kernelEpoch: string} & ({stream: 'durable'; cursor: number} | {stream: 'progress'; runId: string; threadId: string; branchId: string; requestId: string; streamId: string; sequence: number; event: unknown});

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
  resourceOwner: SourceResourceOwner;
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
  resource_owner: SourceResourceOwner;
}

export interface ToolMetadata { always_declared?: boolean; service_id: string; service_version: number; completion: 'result' | 'job'; lifetime?: 'thread' | 'environment'; operation: 'read' | 'effect'; examples?: unknown[]; source?: {path: string; line?: number}; }

export interface NestedToolSummary {
  name: string;
  version: string;
  description: string;
}

export type NestedToolInspection = {
  origin: 'accepted_run'; permission: 'checked_on_invocation'; runId: string; generation: number;
} & ({ action: 'list'; tools: NestedToolSummary[] } | { action: 'describe'; tool: LaunchTool | null });

export interface NestedToolInput {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface NestedToolReceipt {
  operationId: string;
  completion: OperationCallCompletion<ResolvedMedia>;
}

export interface HostToolCall {
  runId: string;
  operationId: string;
  origin: ToolOrigin;
  callId: string;
  name: string;
  schemaVersion: string;
  arguments: unknown;
}

export interface HostCompositionProvider {
  nodeId: string;
  providerKey: string;
}

export interface HostCompositionDependency {
  id: string;
  version: number;
  binding: 'single' | 'selected' | 'all';
  optional: boolean;
  providers: HostCompositionProvider[];
}

export interface HostCompositionGrant {
  capability: string;
  granted: boolean;
}

export interface HostCompositionNode {
  id: string;
  extensionId: string;
  entrypointId: 'host';
  extensionVersion: string;
  artifactIntegrity: string;
  activationConfiguration: null;
  grants: HostCompositionGrant[];
  dependencies: HostCompositionDependency[];
}

export interface HostServiceComposition {
  schemaVersion: 1;
  root: string;
  nodes: HostCompositionNode[];
}

export interface ExtensionToolBinding {
  providerKey: string;
  extensionId: string;
  extensionVersion: string;
  serviceId: string;
  serviceVersion: number;
  artifactIntegrity: string;
  composition: HostServiceComposition;
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
  requirements?: ToolRequirements;
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
  serviceVersion: 4;
  artifactIntegrity: string;
  composition: HostServiceComposition;
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

export interface McpSourceAuthority {
  coordinator_host_id: string;
  authority_id: string;
  resource_epoch: string;
}

export interface McpServerOwner {
  resource_owner: SourceResourceOwner;
  configuration: McpConfiguration;
  execution_scope: McpExecutionScope;
  source_authority: McpSourceAuthority | null;
}

export interface McpServerSelection {
  owner: McpServerOwner;
  definition_version: string;
  resource_key: string;
}

export type McpExecutionScope = 'global' | 'workspace';

export interface McpProvenance {
  servers: Record<string, McpServerSelection>;
}

export type McpRoute = {kind:"direct"} | {kind:"server_argument";argument:string} | {kind:"discovery";argument:string} | {kind:"direct_task"} | {kind:"server_task_argument";argument:string} | {kind:"task_control";argument:string;action:McpTaskAction} | {kind:"resource_subscribe";argument:string} | {kind:"resource_unsubscribe";argument:string};

export interface McpBinding {
  routes: Record<string, McpRoute>;
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
  derivations?: McpChildDerivationReceipt[];
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
  agent?: AgentSelection;
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

export type ToolOrigin = {kind: 'model_step'; request_id: string} | {kind: 'policy_action'; action_id: string; node_id: string} | {kind: 'nested_call'; parent_operation_id: string};
/** Canonical invocation identity shared by all public/Host consumers. */
export function toolOperationId(origin: ToolOrigin, callId: string): string {
  switch (origin.kind) {
    case 'model_step': return `${origin.request_id}:tool:${callId}`;
    case 'policy_action': return `${origin.action_id}:node:${origin.node_id}`;
    case 'nested_call': return `nested:${new TextEncoder().encode(origin.parent_operation_id).length}:${origin.parent_operation_id}:${callId}`;
  }
}
export function validToolOrigin(value: unknown): value is ToolOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const text = (key: string) => typeof v[key] === 'string' && (v[key] as string).length > 0;
  const keys = v.kind === 'model_step' ? ['kind', 'request_id'] : v.kind === 'policy_action' ? ['kind', 'action_id', 'node_id'] : v.kind === 'nested_call' ? ['kind', 'parent_operation_id'] : [];
  return keys.length > 0 && Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key)) && keys.every(key => key === 'kind' || text(key));
}

export type ExecutorOwner = {kind: 'kernel'} | {kind: 'external'; identity: string; epoch: string};

export interface ExternalReceipt {
  executor: string;
  identity: string;
  epoch: string;
  outcome: Outcome;
  effect: Effect;
  result: OutputBody;
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

export type ContextBudgetStrategy = { kind: 'builtin'; name: string; version: string } | { kind: 'extension'; providerKey: string; extensionId: string; extensionVersion: string; artifactIntegrity: string; serviceVersion: number; configurationIdentity: string; name: string; version: string };

export interface ContextSummaryRecipe {
  strategy: ContextBudgetStrategy;
  mode: 'manual' | 'background' | 'blocking';
  configurationIdentity: string | null;
  additionalInstructions: string | null;
  continuationBudgetTokens?: number;
}

export type ContextCompactionProducer = {kind:'builtin';name:'fold';version:'1'} | {kind:'extension';providerKey:string;providerId:string;extensionId:string;extensionVersion:string;serviceId:'varin.context.compaction';serviceVersion:1;artifactIntegrity:string;composition:HostServiceComposition;configurationIdentity:string;declaredIdentity:LaunchPolicy};

export interface ContextCompactionRange {start:number;end:number}

export type ContextCompactionInput = {kind:'source';sourceId:string;range:ContextCompactionRange|null} | {kind:'node_output';nodeId:string};

export interface ContextCompactionNode {id:string;instructions:string|null;inputs:ContextCompactionInput[]}

export type ContextCompactionPlan = {kind:'text';sourceCutHash:string;text:string} | {kind:'model_plan';sourceCutHash:string;nodes:ContextCompactionNode[];finalNodeId:string};

export interface ContextCompactionCandidate {producer:ContextCompactionProducer;plan:ContextCompactionPlan}

export interface ContextCompactionSource {sourceId:string;item:{id:string;provenance:{kind:'external_data';source:string};content:{kind:'text';text:string}|{kind:'media';media:ResolvedMedia};opaque:null}}

export type TokenizerBinding = {kind: 'encoding'; name: string} | {kind: 'file'; path: string; sha256: string}

export interface ContextCompactionModelBudget {contextWindowTokens:number|null;maxOutputTokens:number|null;sourceBudgetTokens:number|null}

export interface ContextCompactionPreview {sourceCutHash:string;sources:ContextCompactionSource[];modelBudget:ContextCompactionModelBudget}

export interface ContextCompactionMetadata {producer:ContextCompactionProducer;kind:'text'|'model_plan';sourceCutHash:string;planHash:string}

export interface ContextJobPreviewParams {
  summaryRecipe: ContextSummaryRecipe;
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

export interface ContextJobCreateParams {
  compaction: ContextCompactionCandidate | null;
  summaryRecipe: ContextSummaryRecipe;
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
  tokenizer?: TokenizerBinding;
  catalogModelId?: string;
  providerId?: string;
  providerFamily: string;
  model: string;
  endpoint: string;
  credentialEnvironment: string | null;
  allowAnonymous: boolean;
  acceptsImages?: boolean;
  toolOutputVisibleBytes?: number;
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
  awsRegion?: string;
  adapterIdentity?: string;
  adapterBindingId?: string;
  connection?: ModelHttpConfiguration;
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

export interface ContextTransform {
  providerId: string;
  contentVersion: string;
  sections: ContextFragment[];
}

export interface ContextComposition {
  scopeId: string;
  selectionRevision: number;
  transforms: ContextTransform[];
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
  threadId: string;
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
  threadId: string;
  projectId: string | null;
}

export type FollowupRepeat = 'once' | 'each';

export interface FollowupOccurrenceGetParams {
  followupId: string;
  occurrenceId: string;
}

export interface FollowupOccurrenceFact {
  source_index: number;
  accepted_cursor: number;
  content: unknown;
}

export interface FollowupOccurrenceView {
  occurrence: FollowupOccurrence;
  facts: FollowupOccurrenceFact[];
}

export interface FollowupOccurrencesParams {
  followupId: string;
  after?: number;
}

export interface FollowupOccurrencesResult {
  occurrences: FollowupOccurrence[];
  nextCursor: number | null;
}

export type FollowupControlAction = 'pause' | 'resume' | 'cancel';

export type FollowupRegistrationSource = { kind: 'at'; atMs: number } | { kind: 'process_stopped'; operationId: string } | { kind: 'job_stopped'; operationId: string } | { kind: 'file'; path: string; condition: FileCondition } | { kind: 'artifact'; operationId: string; artifactId?: string; name?: string } | { kind: 'collection'; operationId: string } | { kind: 'log_literal'; operationId: string; stream: LogStream; literal: string; fromOffset?: number } | { kind: 'log_end'; operationId: string; stream: LogStream } | { kind: 'metric'; machineId: string; metric: MetricKind; gpuUuid?: string; predicate: MetricPredicate; threshold: number };

export type FollowupRegistrationTrigger = FollowupRegistrationSource | { kind: 'any' | 'all'; sources: FollowupRegistrationSource[] };

export type FollowupActor = { kind: 'user' } | { kind: 'agent'; run_id: string; operation_id: string; origin: ToolOrigin } | { kind: 'goal'; goal_id: string };

export interface FollowupGetParams {
  followupId: string;
}

export interface FollowupView {
  followup: Followup;
  instruction: string | null;
  registration_trigger: FollowupRegistrationTrigger | null;
}

export interface FollowupObservation {
  wait_id: string;
  operation_id: string;
  run_id: string;
  state: 'waiting' | 'triggered' | 'exhausted' | 'cancelled';
  delivered: boolean;
  delivery_pending: boolean;
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
  repeat?: FollowupRepeat;
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
  kind: FollowupTrigger['kind'];
  after_cursor: number;
  trigger_cursor: number | null;
  state: 'waiting' | 'observed' | 'consumed' | 'cancelled';
}

export interface FollowupOccurrence {
  accepted_cursor: number;
  id: string;
  generation: number;
  trigger_cursor: number;
  state: 'observed' | 'held' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  hold_reason: 'control_paused' | 'source_run_active' | 'source_unsettled' | 'branch_active' | 'context_scope_changed' | 'preparation_failed' | 'goal_paused' | 'goal_budget' | 'goal_blocked' | 'goal_ended' | 'goal_superseded' | null | 'manual_pause' | 'question' | 'preparing';
  evidence: FollowupEvidence;
  delivery: FollowupDelivery | null;
}

export interface Followup {
  repeat: FollowupRepeat;
  pending_occurrences: number;
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
  exhausted: boolean;
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
  parentOperationId?: string;
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

export interface RunFailure {
  runId: string;
  cursor: number;
  code: string;
  message: string;
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

export type OperationCallCompletion<M = StoredMedia> =
  | { kind: 'not_dispatched'; reason: string }
  | { kind: 'result'; outcome: Outcome; effect: Effect; content: OutputBody<M> }
  | { kind: 'job_accepted'; operation_id: string; phase: string; effect: Effect; lifetime: Lifetime; content?: OutputBody<M> };

export interface Operation {
  host_job?: HostJobView;
  execution_owner: ExecutorOwner | null;
  external_receipt: ExternalReceiptView | null;
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
  result: OperationResult | null;
  managed_process?: ManagedProcess;
  mcp_resource_subscription?: McpResourceSubscription;
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

export interface UnacceptedChildSourcePin {
  source: LaunchSource;
  pin_id: string;
}

export interface UnacceptedChildDependencies {
  operation_id: string;
  parent_thread_id: string;
  parent_run_id: string;
  execution_owner: ExecutorOwner;
  execution_epoch: number;
  source_pin: UnacceptedChildSourcePin | null;
  mcp_binding: McpBinding | null;
}

export interface AgentSourceSelection {
  run_id: string;
  source: LaunchSource;
}

export interface ChildSourceHandoff {
  refresh?: AgentSourceSelection;
  source_run_id?: string;
  operation_id: string;
  source: LaunchSource;
  root: ChildSourceRoot;
  resource_authority: ChildSourceAuthority | null;
}

export type ChildSourceRoot = { kind: 'fixed'; pin: ChildSourcePin } | { kind: 'physical'; root: LiveRoot };

export interface SourceDraftResource { workspaceId: string; resourceId: string; baseRevision: string | null; localEditRevision: number; revision: string; encoding: string; bom: boolean; coordinationId?: string; documentInstanceId?: string; bufferHash?: string; lineEnding?: 'lf' | 'crlf' | 'cr'; }

export interface SourceDraftProvenance { threadId: string; branchId: string; snapshotRef: string; ownerId: string; ownerGeneration: number; resources: SourceDraftResource[]; }

export type ChildSourceProvenance = { consistency: 'refreshed-root'; root: string; previousRoot: string; incoming: { run_id: string; source: LaunchSource }; incomingRoot: string; conflicts: string[]; resources?: SourceResourceCapture } | { consistency: 'fixed-root'; root: string; resources?: SourceResourceCapture } | { consistency: 'stable-capture' | 'git-base-with-overlay'; contentMode: 'saved-files' | 'fixed-draft-baseline'; captureScopes: string[]; omittedDraftPaths: string[]; captureIdentity?: string; drafts?: SourceDraftProvenance; resources?: SourceResourceCapture };

export type ChildSource = { kind: 'absent' } | { kind: 'pending'; handoff: ChildSourceHandoff } | { kind: 'shared'; handoff: ChildSourceHandoff | null; selection: LaunchSource } | { kind: 'ready'; handoff: ChildSourceHandoff | null; pin: ChildSourcePin; selection: LaunchSource; provenance: ChildSourceProvenance };

export interface ChildWorkingResultRef {
  publication_id: string;
  workspace_id: string;
  branch_id: string;
  result_revision: number;
  root: string;
  base_root: string;
  record_id: string;
}

export type ChildCodeResult = { kind: 'not_applicable' } | { kind: 'pending' } | { kind: 'settling'; publication_id: string } | { kind: 'candidate'; candidate: KernelWorkingResultCandidate } | { kind: 'published'; result: ChildWorkingResultRef; effect: Effect } | { kind: 'no_changes' } | { kind: 'unavailable'; code: string; effect: Effect };

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
  source: LaunchSourceParams | null;
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
  source_requirement: 'none' | 'source' | 'physical' | 'live';
  default_presets: ('worker' | 'verifier' | 'retrieval')[];
  process?: boolean;
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
  tools_source: 'default' | 'explicit';
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
  sourceAgent?: string;
  name?: string;
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

export interface ChildReportPage {
  format: 'text' | 'output_body';
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
  agent_id?: string;
  name?: string;
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
  sourceAgent?: string;
  name?: string;
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

export type DelegatedExecutionTrigger = { kind: 'dispatch' } | { kind: 'user_continuation'; key: string; name?: string; source_agent?: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'computer_event'; event_id: string; input_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'message_request'; message_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'followup'; followup_id: string; occurrence_id: string; input_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null } | { kind: 'calendar'; definition_id: string; occurrence_id: string; input_id: string; previous_execution_id: string; previous_run_id: string; previous_run_revision: number; expected_head: string | null };

export type ChildSourceBasis = { kind: 'refreshed'; source: LaunchSource; root: string; provenance: ChildSourceProvenance; result: ChildWorkingResultRef | null; incoming: { run_id: string; source: LaunchSource } } | { kind: 'working_result'; source: LaunchSource; root: string; provenance: ChildSourceProvenance; result: ChildWorkingResultRef } | { kind: 'immutable_source'; source: LaunchSource; root: string; provenance: ChildSourceProvenance; pin: ChildSourcePin };

export interface DelegatedExecution {
  name?: string;
  agent_id?: string;
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
  filePath?: string;
  parentThreadId?: string;
  parentBranchId?: string;
  workspaceId?: string;
  updatedAfterMs?: number;
  updatedBeforeMs?: number;
  scope?: string;
  query?: string;
  cursor?: string;
  limit?: number;
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
  source?: LaunchSource | null;
  sourceRunId?: string | null;
  operationId?: string | null;
  latestExecutionId?: string | null;
  agentId?: string;
  name?: string;
  current?: boolean;
  updatedAtMs?: number;
  threadId: string;
  parentThreadId: string | null;
  task: string | null;
  state: string;
  branches: FamilyBranch[];
}

export interface FamilyList {
  nextCursor?: string | null;
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

export interface FamilyItem { threadId: string; branchId: string; runId: string | null; headId: string | null; anchor: string; itemId: string; format: 'conversation_json'; text: string; offset: number; nextOffset: number | null; totalBytes: number }

export type HostJobSubject = {kind:'workspace';workspaceId:string;subjectId:string} | {kind:'mcp';endpoint:McpEndpoint;dispatchId:string} | {kind:'environment_forward';hostId:string;hostEpoch:string;target:SourceResourceOwner;serviceHost:string;servicePort:number};

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskState {
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}

export interface McpTaskLink {
  task: McpTaskState;
  observationRef: unknown;
  availability: McpTaskAvailability;
  resultReady: boolean;
  problem?: McpTaskProblem;
  revision: number;
  resultRef?: unknown;
  resultOutcome?: Outcome;
  resultEffect?: Effect;
  resultKind?: McpTaskResultKind;
}

export interface HostJobTaskUpdateParams {
  binding: HostJobBinding;
  expectedRevision: number;
  task: McpTaskState;
  availability: McpTaskAvailability;
  content: unknown;
  problem?: McpTaskProblem;
  result?: McpTaskResultInput;
}

export interface HostJobAccessParams {
  runId: string;
  targetOperationId: string;
  control?: boolean;
}

export type McpTaskAvailability = 'available' | 'unavailable';

export type HostJobWaitMode = 'stopped' | 'result';

export type McpTaskAction = 'get' | 'wait' | 'cancel';

export type McpTaskProblemKind = 'transport' | 'protocol' | 'expired' | 'owner' | 'unsupported';

export type McpTaskStage = 'status' | 'result' | 'cancel' | 'interaction' | 'rebind';

export interface McpTaskProblem {
  kind: McpTaskProblemKind;
  stage: McpTaskStage;
  rpcCode?: number;
}

export interface ExternalReceiptView {
  executor: string;
  identity: string;
  epoch: string;
  outcome: Outcome;
  effect: Effect;
  result: OutputBody;
  executor_stopped: boolean;
}

export interface McpTaskResultInput {
  outcome: Outcome;
  effect: Effect;
  content: OutputBody<IncomingMedia>;
  kind: McpTaskResultKind;
}

export interface HostJobView extends HostJobLink {
  mcpTaskResult?: OutputBody;
}

export type McpTaskResultKind = 'response' | 'protocol_error';

export interface McpResourceBinding {
  operationId: string;
  executionOwner: ExecutorOwner;
  endpoint: McpEndpoint;
  schemaVersion: string;
  uri: string;
}

export interface McpResourceSubscription {
  binding: McpResourceBinding;
  sourceScope: McpExecutionScope;
  acceptanceRef: unknown | null;
  listenerId: string | null;
  availability: McpResourceAvailability;
  localReleased: boolean;
  mcpHolderReleased: boolean;
  remoteCleanup: McpResourceCleanup;
  lastEventCursor: number | null;
  problem: string | null;
}

export interface McpResourcePending {
  revision: number;
  operationId: string;
  runId: string;
  threadId: string;
  branchId: string;
  cancelRequested: boolean;
  subscription: McpResourceSubscription;
}

export type McpResourceAvailability = 'pending' | 'active' | 'gap' | 'unavailable' | 'closed';

export type McpResourceCleanup = 'not_requested' | 'shared' | 'acknowledged' | 'unknown';

export type McpResourceFactKind = 'updated' | 'unresolved_association' | 'gap';

export interface McpResourceBeginParams {
  binding: McpResourceBinding;
}

export interface McpResourceHolderReleasedParams {
  binding: McpResourceBinding;
}

export interface McpResourceCreationFailedParams {
  binding: McpResourceBinding;
  error: SourceMcpCreationError;
}

export interface McpResourceAcceptParams {
  binding: McpResourceBinding;
  listenerId: string;
  content: unknown;
}

export interface McpResourceListenerParams {
  binding: McpResourceBinding;
  expectedListenerId: string | null;
  listenerId: string | null;
  availability: McpResourceAvailability;
  localReleased: boolean;
  remoteCleanup: McpResourceCleanup;
  problem: string | null;
}

export interface McpResourceNotifyParams {
  binding: McpResourceBinding;
  listenerId: string;
  factId: string;
  kind: McpResourceFactKind;
  notification?: unknown;
}

export interface McpResourceAccessParams {
  runId: string;
  targetOperationId: string;
  control: boolean;
}

export interface McpEndpoint {
  server: string;
  resourceKey: string;
  configurationVersion: string;
  credentialVersion: string;
}

export type McpChildDerivationOrigin = {kind:'dispatch';parent_source_authority:McpSourceAuthority;binding:SourceMcpChildBinding}|{kind:'continuation';previous_run_id:string};

export interface McpChildDerivationProof { execution_id:string;child_run_id:string;child_thread_id:string;source_authority:McpSourceAuthority;source:LaunchSource;physical_root:LiveRoot;pin:ChildSourcePin;handoff:ChildSourceHandoff;materialization_operation_id:string;materialization_receipt_hash:string;origin:McpChildDerivationOrigin;selection:McpBinding; }

export interface McpChildDerivationReceipt {
  proof: McpChildDerivationProof;
  provenance: McpProvenance;
}

export interface SourceMcpChildBinding { operationId:string;parentRunId:string;executionOwner:ExecutorOwner;executionEpoch:number; }

export interface SourceMcpCreationError { code:string;dispatched:boolean;settlement:'unknown'|'session_expired'|'rpc_response';taskKind?:'protocol'|'transport'|'unsupported'|'owner';rpcCode?:number;protocolError?:Record<string,unknown>;interactionProblem?:string; }

export type SourceResourceOwner = {kind: 'local'} | {kind: 'managed_host'; hostId: string; connectionId: string; endpointIdentity: string};

export interface ChildSourceAuthority { authority_id:string;resource_epoch:string }
