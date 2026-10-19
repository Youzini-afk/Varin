import type { AgentInputContext, ChildSourceProvenance, ContextSummaryRecipe, ContextCompactionCandidate, ContextCompactionProducer, SourceFailureCode, SourceResourceOwner } from '@varin/protocol';
import type { DocumentReadRequest, FetchResult } from '@varin/protocol';
import type { McpInteractionListParams, McpInteractionReadParams, McpInteractionRespondParams, McpInteractionPage, McpInteractionView, McpSamplingRequestReviewParams, McpSamplingOutputReviewParams } from '@varin/protocol';
import type { MediaReadParams, MediaReadChunk } from '@varin/protocol';
import type { ComputerAutomationProjection, ComputerAutomationState } from '@varin/protocol';
import type { MessageSendParams, MessageListParams, MessageReceipt, MessagePage, MessageView } from '@varin/protocol';
import type { FamilyList, FamilyListParams, FamilyRuns, FamilyRead, FamilyItem, FamilyRunsParams, FamilyReadParams, FamilyItemParams } from '@varin/protocol';
import type { PlanSnapshot, PlanMutationResult, ChildReportPage, ChildTask, DelegatedExecution, ChildWait, TreeCancellationReceipt, Followup, FollowupView, FollowupRegisterParams, LiveRoot, ContextPersonalization, ContextResources, ResourceActivation, RuntimeEvent, HistoryItem, InputMode, InputReceipt, QueuedInput, InputSubmitReceipt, Run, Operation, RunCancellationReceipt, OperationCancellationReceipt, AgentRuntimeStreamEvent, ThreadSummary, LaunchIntent, PolicyResumeReceipt, ImageAttachment } from '@varin/protocol';

import type { RunModelSelection, RunModelSelections } from '@varin/protocol';
import type { HostJobSource, FollowupOccurrenceView, FollowupOccurrencesResult, FollowupPendingRegistration, FollowupRegistrationCancelResult, FollowupControlAction } from '@varin/protocol';
import type { Goal, GoalBudget, GoalControlAction, GoalControlReceipt } from '@varin/protocol';
import type { PolicySelection, PolicySelections } from '@varin/protocol';
import type { ExtensionToolBinding, LaunchTool, McpBinding } from '@varin/protocol';
import type { VarinExtensionServiceProvision } from '@varin/extension-contract';

/** Explicit authority selection. A thread never opens a Pi session. */
export interface ThreadIdentity { runtime: 'agent'; threadId: string; branchId: string }
export type ThreadThinkingLevel = import('@varin/protocol').ThinkingLevel;
export interface ThreadModel { providerId: string; modelId: string; thinkingLevel?: ThreadThinkingLevel; temperature?: number }
export interface ThreadModelInfo extends ThreadModel { name?: string; acceptsImages?: boolean; contextWindowTokens?: number; thinkingLevels?: ThreadThinkingLevel[] }
export interface ThreadAgentChoice { profileId: string | null; workFocus: import('@varin/protocol').WorkFocusId }
/** A public model selection resolves only through the Host's existing model/credential authority. */
export type ThreadMcpSamplingRequestReview = ThreadIdentity & Omit<McpSamplingRequestReviewParams, 'action' | 'editedRequest'> & (
  | { action: 'generate'; model: ThreadModel; editedRequest: Record<string, unknown> }
  | { action: Exclude<McpSamplingRequestReviewParams['action'], 'generate'>; model?: never; editedRequest?: never }
);
interface ThreadSourceBase {
  resourceOwner: SourceResourceOwner;
  workspaceId: string;
  executionWorkspaceId: string;
  /** Names are admitted by the Rust source-tool directory, not a client-side capability list. */
  tools: string[];
}
export type ThreadSource = ThreadSourceBase & (
  | { mode: 'fixed_branch' | 'materialized'; branchId: string; revision: number; liveRoot?: never; environmentRunId?: string }
  | { mode: 'live_root'; liveRoot: LiveRoot; branchId?: never; revision?: never; environmentRunId?: never }
);
export interface ThreadPrepareSource extends ThreadIdentity {
  resourceOwner: SourceResourceOwner;
  key: string;
  workspaceId: string;
  mode: ThreadSource['mode'];
  content: { mode: 'saved-files' } | { mode: 'surface-drafts'; context: AgentInputContext };
  captureScopes: string[];
}
/** Configured connection identities are returned by the trusted Host, never renderer credentials. */
export interface ThreadSourceTarget {
  resourceOwner: SourceResourceOwner;
  label: string;
  capabilities: string[];
}
export interface ThreadSourceTargets {
  targets: ThreadSourceTarget[];
  unavailable: Array<{ connectionId: string; label: string; message: string }>;
}
export interface ThreadResolvedSource {
  resourceOwner: SourceResourceOwner;
  workspaceId: string;
  path: string;
}
export interface ThreadSourcesAPI {
  /** A draft may discover configured Hosts before a Thread exists; discovery grants no source access. */
  list(identity: ThreadIdentity | null, signal?: AbortSignal): Promise<ThreadSourceTargets>;
  resolve(identity: ThreadIdentity, request: { resourceOwner: SourceResourceOwner; path: string }, signal?: AbortSignal): Promise<ThreadResolvedSource>;
}
export interface ThreadPreparedSource {
  path: string;
  source: ThreadSource;
  provenance?: ChildSourceProvenance;
}
export interface ThreadSubmit extends ThreadIdentity {
  key: string;
  expectedHead: string | null;
  text: string;
  images?: ImageAttachment[];
  materials?: ThreadMaterialAttachment[];
  model: ThreadModel;
  agent?: ThreadAgentChoice;
  source?: ThreadSource;
}
export interface ThreadHistoryPage {
  head: string | null;
  previous: string | null;
  items: ThreadHistoryItem[];
}
/** One real Run on the selected branch's visible ancestry, independent of loaded bodies. */
export interface ThreadHistoryRun {
  runId: string;
  firstItemId: string | null;
  lastItemId: string | null;
}
export interface ThreadHistoryRuns {
  head: string | null;
  runs: ThreadHistoryRun[];
}
/** Original model receipts through the displayed history cut, once per ended Run. */
export interface ThreadRunUsage {
  runId: string;
  /** Last original item included in this Run's summary. */
  throughId: string;
  requests: Array<Pick<import('@varin/protocol').ModelPresentation, 'requestId' | 'usage'>>;
}
/** Current file in the historical operation's original source, never the navigation project. */
export type ThreadFileTarget = { kind: 'document'; workspaceId: string; root: string; resourceId: string }
  | { kind: 'unavailable'; reason: 'no_source' | 'fixed_source' | 'managed_source' };
/** Display metadata from the original frozen request; absent for non-model history. */
export interface ThreadHistoryItem extends HistoryItem {
  modelRequest?: import('@varin/protocol').ModelPresentation;
}
/** Context facts at an immutable history cut, independent of loaded message pages. */
export interface ThreadContextInspection {
  head: string | null;
  counts: { total: number; user: number; assistant: number; tool: number };
  latestRequest: import('@varin/protocol').ModelPresentation | null;
  /** Cleared by a compaction until the next model request reports its footprint. */
  contextRequest: import('@varin/protocol').ModelPresentation | null;
}
/** Durable context records projected by the Host; original conversation history stays intact. */
export interface ContextJob {
  compaction: { producer: ContextCompactionProducer; kind: 'text' | 'model_plan'; sourceCutHash: string; planHash: string };
  request: { compaction: ContextCompactionCandidate | null; summary_recipe: ContextSummaryRecipe; owner_run_id?: string; personalization?: ContextPersonalization; key: string; branch_id: string; through_id: string; expected_revision: number;
    effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
  receipt: InputSubmitReceipt;
}
export interface ContextCheckpoint {
  bot_memory_snapshot?: { botId: string; threadId: string; revision: number; state: { content_object: string } };
  resource_activations: ResourceActivation[];
  resources?: ContextResources;
  personalization?: ContextPersonalization;
  id: string;
  revision: number;
  proposal: { key: string; branch_id: string; through_id: string | null; expected_revision: number;
    summary: string; effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
}
export interface ThreadContextState {
  checkpoint: ContextCheckpoint | null;
  jobs: Array<{ job: ContextJob; run: Run }>;
}
export interface ThreadCompact extends ThreadIdentity {
  key: string;
  throughId: string;
  expectedRevision: number;
  model: ThreadModel;
}
/** Read-only discovery and immutable conversation views inside the original task family. */
export interface ThreadFamilyAPI {
  list(identity: ThreadIdentity, options?: boolean | Omit<FamilyListParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyList>;
  runs(identity: ThreadIdentity, request: Omit<FamilyRunsParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyRuns>;
  read(identity: ThreadIdentity, request: Omit<FamilyReadParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyRead>;
  item(identity: ThreadIdentity, request: Omit<FamilyItemParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyItem>;
}
/** Durable same-family messages. Acceptance, history delivery, request activation and Agent reply
 * observations are distinct facts. User sends do not create a Run or an observation. */
export interface ThreadMessagesAPI {
  send(identity: ThreadIdentity, request: Omit<MessageSendParams, 'senderThreadId' | 'senderBranchId'>, signal?: AbortSignal): Promise<MessageReceipt>;
  list(identity: ThreadIdentity, request: Omit<MessageListParams, 'threadId' | 'branchId'>, signal?: AbortSignal): Promise<MessagePage>;
  get(identity: ThreadIdentity, messageId: string, signal?: AbortSignal): Promise<MessageView>;
}
export interface ThreadChildContinuation extends ThreadIdentity {
  sourceAgent?: string;
  name?: string;
  key: string;
  previousRunId: string;
  expectedHead: string | null;
  text: string;
  images?: ImageAttachment[];
  materials?: ThreadMaterialAttachment[];
}
export interface ThreadCollaborationAPI {
  page?(identity: ThreadIdentity, options?: Omit<FamilyListParams,'callerThreadId'>, signal?:AbortSignal):Promise<ThreadChildPage>;
  integration(input: ThreadIntegrationCommand, signal?: AbortSignal): Promise<ThreadIntegrationState>;
  /** Explicit User input, retaining this child's exact previous execution configuration. */
  continueChild(input: ThreadChildContinuation, signal?: AbortSignal): Promise<DelegatedExecution>;
  executions(identity: ThreadIdentity, operationId?: string, signal?: AbortSignal): Promise<DelegatedExecution[]>;
  readExecutionReport(identity: ThreadIdentity, executionId: string, itemId: string, offset?: number, maxBytes?: number, signal?: AbortSignal): Promise<ChildReportPage>;
  readReport(identity: ThreadIdentity, operationId: string, itemId: string, offset?: number, maxBytes?: number, signal?: AbortSignal): Promise<ChildReportPage>;
  children(identity: ThreadIdentity): Promise<ChildTask[]>;
  cancelChild(identity: ThreadIdentity, operationId: string): Promise<TreeCancellationReceipt>;
  cancelWait(identity: ThreadIdentity, waitId: string): Promise<ChildWait>;
  cancelTree(identity: ThreadIdentity): Promise<TreeCancellationReceipt>;
}
export interface ThreadChildPage {
  directory:FamilyList;
  children:ChildTask[];
  executions:DelegatedExecution[];
}
export type ThreadIntegrationCommand = ThreadIdentity & {
  key: string;
  executionId: string;
  publicationId: string;
  sourceOwner?: { ownerId: string; generation: number };
} & (
  | { action: 'preview' }
  | { action: 'apply'; expectedBindingFingerprint: string; resolutions: import('@varin/protocol').ThreadConflictResolution[] }
  | { action: 'undo'; operationId: string; sourceRunId: string }
);
export interface ThreadIntegrationRecord {
  sourceRunId: string;
  operationId: string;
  state: string;
  appliedPaths: string[];
  conflictPaths: string[];
  needsAttentionPaths: string[];
  failure?: string;
  effect: 'none' | 'confirmed' | 'partial' | 'unknown';
  executorStopped: boolean;
}
export interface ThreadIntegrationState {
  preview?: import('@varin/protocol').ThreadIntegrationPreview;
  operations: ThreadIntegrationRecord[];
  problem?: string;
}
/** Prepare and atomically publish instructions and skills for this Thread branch. */
export interface ThreadResourceRefresh extends ThreadIdentity {
  expectedRevision: number;
  instructionDirectories?: string[];
  supportingFiles?: Array<{ skillName: string; relativePath: string }>;
}
export interface ThreadResourcesAPI {
  /** Prepare a new resource snapshot; old in-flight requests keep their original version. */
  refresh(input: ThreadResourceRefresh): Promise<ContextCheckpoint>;
}
/** Explicit follow-up authorization; occurrences are delivered through the original Run owner. */
export interface ThreadFollowupsAPI {
  /** Accepted family Jobs; sourceRunId is target attribution, never the registration source. */
  jobSources(identity: ThreadIdentity, runId: string, signal?: AbortSignal): Promise<HostJobSource[]>;
  register(input: ThreadIdentity & FollowupRegisterParams): Promise<Followup>;
  /** Original accepted file resources awaiting Catalog admission; never another definition ledger. */
  pendingRegistrations(identity: ThreadIdentity, signal?: AbortSignal): Promise<FollowupPendingRegistration[]>;
  cancelRegistration(input: ThreadIdentity & { key: string; runId: string }): Promise<FollowupRegistrationCancelResult>;
  list(identity: ThreadIdentity, signal?: AbortSignal): Promise<Followup[]>;
  get(identity: ThreadIdentity, followupId: string, signal?: AbortSignal): Promise<FollowupView>;
  /** Original occurrence rows, in accepted-cursor order. Reading never activates or cancels work. */
  occurrences(identity: ThreadIdentity, followupId: string, after?: number, signal?: AbortSignal): Promise<FollowupOccurrencesResult>;
  /** Read the specified occurrence's immutable accepted metadata, without switching to the latest occurrence. */
  occurrence(identity: ThreadIdentity, followupId: string, occurrenceId: string, signal?: AbortSignal): Promise<FollowupOccurrenceView>;
  /** Revision-checked definition control; delivered occurrences keep their original delivery facts. */
  control(input: ThreadIdentity & { followupId: string; expectedRevision: number; action: FollowupControlAction }): Promise<Followup>;
}
/** Explicit continuing-work authorization. Usage is reported by the original inference owner. */
export interface ThreadGoalsAPI {
  start(input: ThreadIdentity & { key: string; runId: string; objective: string; budget: GoalBudget | null }): Promise<GoalControlReceipt>;
  update(input: ThreadIdentity & { goalId: string; expectedRevision: number; objective: string; budget: GoalBudget | null }): Promise<GoalControlReceipt>;
  control(input: ThreadIdentity & { goalId: string; expectedRevision: number; action: GoalControlAction }): Promise<GoalControlReceipt>;
  list(identity: ThreadIdentity): Promise<Goal[]>;
}
export interface ThreadSnapshot {
  recovery?: {
    /** The owner could not establish current recovery metadata. */
    unavailable?: string;
    /** Combined file recovery is unavailable; independent navigation receipts remain valid. */
    combinedUnavailable?: string;
    navigation: import("@varin/protocol").NavigationReceipt | null;
    operations: import("@varin/extension-contract").WorkspaceCombinedRecoveryOperation[];
  };
  identity: ThreadIdentity;
  /** Read before the snapshot's component queries. Replay after this cursor covers concurrent commits. */
  eventCursor: number;
  thread: ThreadSummary;
  activeRun: Run | null;
  /** Original Catalog terminal failure for the displayed Run; never inferred from missing output. */
  runFailure?: import('@varin/protocol').RunFailure | null;
  history: ThreadHistoryItem[];
  historyPage: Pick<ThreadHistoryPage, 'head' | 'previous'>;
  inputs: QueuedInput[];
  operations: Operation[];
  followups: Followup[];
  goals: Goal[];
  launch: LaunchIntent | null;
  modelSelection: RunModelSelections;
  policySelection: ThreadPolicyInspection | null;
  context: ThreadContextState;
  children?: ChildTask[];
  childDirectory?:FamilyList;
  /** Executions of this exact parent branch's children, in each child's admission order. */
  childExecutions?: DelegatedExecution[];
  childActivity?: Record<string, { state: 'preparing' | 'running' | 'waiting' | 'settling' | 'preparation_failed'; reason?: string }>;
  /** This Thread branch's own initial and subsequent delegated executions. */
  delegatedExecutions?: DelegatedExecution[];
}
export interface ThreadPlanState {
  identity: ThreadIdentity;
  headId: string | null;
  plan: PlanSnapshot | null;
}
export interface ThreadPlanAPI {
  read(identity: ThreadIdentity): Promise<ThreadPlanState>;
  update(input: ThreadIdentity & { key: string; expectedHeadId: string | null; expectedRef: string | null; content: string }): Promise<PlanMutationResult>;
}
/** Preparation is not admission: only the activated Run directory is callable. */
export interface ThreadToolPreparation {
  serviceId: string;
  version: number;
  declarations: VarinExtensionServiceProvision[];
  status: 'preparing' | 'ready' | 'unavailable';
  prepared?: ExtensionToolBinding;
  error?: string;
}
export interface ThreadToolInspection {
  runId: string;
  generation: number | null;
  /** A listed tool still requires authorization for its exact invocation. */
  permission: 'checked_on_invocation';
  callable: LaunchTool[];
  /** Durable selected identities; these records do not grant invocation authority. */
  bindings: { mcp: McpBinding | null; extensions: ExtensionToolBinding[] };
  preparations: ThreadToolPreparation[];
}
/** Current Host preparation only; committed choices remain in the Catalog projection. */
export interface ThreadPolicyPreparation {
  status: 'preparing' | 'failed';
  code: string | null;
}
export interface ThreadPolicyInspection extends PolicySelections {
  preparation: ThreadPolicyPreparation | null;
}
export interface ThreadProcessTerminal {
  resourceOwner: SourceResourceOwner;
  sessionId: string;
  cwd: string;
  operationId: string;
  processId: string;
}
export interface ThreadProcessesAPI {
  /** Open a view of the original PTY job; this never launches another shell. */
  openTerminal(input: ThreadIdentity & { operationId: string }): Promise<ThreadProcessTerminal>;
}
export interface ThreadComputerAPI {
  /** Read the original Computer owner without probing or capturing the desktop. */
  state(identity: ThreadIdentity, signal?: AbortSignal): Promise<ComputerAutomationProjection>;
  /** Stop only the displayed execution; transport cancellation does not undo acceptance. */
  stop(identity: ThreadIdentity, request: { runId: string; desktopId?: string }, signal?: AbortSignal): Promise<{ state: ComputerAutomationState }>;
  /** Root-work decision on the displayed request revision, including while the root is idle.
   * An uncertain retry keeps the original key and decision; no Run is created by this command. */
  decide(identity: ThreadIdentity, request: { requestId: string; expectedRevision: number; decision: 'grant' | 'deny'; key: string; reason?: string }, signal?: AbortSignal): Promise<{ state: ComputerAutomationState }>;
}
/** Fixed retained material; authority is resolved by the Host from the real Thread. */
export type ThreadMaterialReadRequest = Omit<DocumentReadRequest, 'path' | 'artifact' | 'snapshotId'> & { snapshotId: string };
/** Original experiment artifact selected through a retained source Run; never a file-path grant. */
export type ThreadMaterialArtifactReadRequest = Omit<DocumentReadRequest, 'path' | 'artifact' | 'snapshotId'> & { artifact: NonNullable<DocumentReadRequest['artifact']> };
export type ThreadMaterialSourceReadRequest = Omit<DocumentReadRequest, 'artifact' | 'snapshotId' | 'path'> & { path: string };
/** A retained PDF reference. The Host resolves provenance and authority at admission. */
export interface ThreadMaterialAttachment { snapshotId: string }
export interface ThreadMaterialUpload {
  filename: string;
  mimeType: 'application/pdf';
  /** Original PDF bytes, encoded as canonical base64. No extracted browser text. */
  data: string;
}
export interface ThreadMaterialsAPI {
  upload(identity: ThreadIdentity, request: ThreadMaterialUpload, signal?: AbortSignal): Promise<FetchResult>;
  read(identity: ThreadIdentity, request: ThreadMaterialReadRequest, signal?: AbortSignal): Promise<FetchResult>;
  readSource(selection: import('./research.js').ThreadResearchSelection, request: ThreadMaterialSourceReadRequest, signal?: AbortSignal): Promise<FetchResult>;
  readArtifact(selection: import('./research.js').ThreadResearchSelection, request: ThreadMaterialArtifactReadRequest, signal?: AbortSignal): Promise<FetchResult>;
}
export type { ThreadSummary } from '@varin/protocol';
export interface ThreadCatalogIdentity { runtime: 'agent'; threadId: string; }
export type ThreadListOptions = import('@varin/protocol').ThreadCatalogQuery;
export type ThreadUpdate = ThreadCatalogIdentity & import('@varin/protocol').ThreadMetadataUpdateParams;
export type ThreadDelete = ThreadCatalogIdentity & import('@varin/protocol').ThreadDeleteParams;
export type ThreadRead = ThreadCatalogIdentity & import('@varin/protocol').ThreadReadPositionParams;

export interface ThreadsAPI {
  materials: ThreadMaterialsAPI;
  computer: ThreadComputerAPI;
  research?: import('./research.js').ThreadResearchAPI;
  messages?: ThreadMessagesAPI;
  family?: ThreadFamilyAPI;
  processes?: ThreadProcessesAPI;
  goals: ThreadGoalsAPI;
  plan?: ThreadPlanAPI;
  collaboration?: ThreadCollaborationAPI;
  followups: ThreadFollowupsAPI;
  resources: ThreadResourcesAPI;
  listModels(): Promise<ThreadModelInfo[]>;
  selectModel(input: ThreadIdentity & { runId: string; key: string; model: ThreadModel }): Promise<RunModelSelection>;
  /** Search title/identity. Default excludes archived and deleted Threads. */
  list(options?: ThreadListOptions, signal?: AbortSignal): Promise<ThreadSummary[]>;
  /** One Catalog command; an uncertain retry retains its key, patch and original revision. */
  update(input: ThreadUpdate): Promise<ThreadSummary>;
  /** Hide this Thread and close fresh user admission. Existing work and its resources continue. */
  delete(input: ThreadDelete): Promise<ThreadSummary>;
  /** Acknowledge only the event cursor actually presented; concurrent activity remains unread. */
  markRead(input: ThreadRead): Promise<ThreadSummary>;
  create(key: string): Promise<ThreadIdentity>;
  sources: ThreadSourcesAPI;
  prepareSource(input: ThreadPrepareSource, signal?: AbortSignal): Promise<ThreadPreparedSource>;
  /** Fork immutable conversation ancestry; live runs and resource grants are not copied. */
  prepareNavigation(input: ThreadIdentity & { entryId: string }): Promise<import("@varin/protocol").NavigationSelection & { editorImages?: ImageAttachment[] }>;
  recoverySource(input: ThreadIdentity & { entryId: string }): Promise<{ resourceOwner: SourceResourceOwner; workspaceId: string; mode: "live_root" | "materialized" | "fixed_branch"; runId: string } | null>;
  navigate(input: ThreadIdentity & { key: string; expectedHeadId: string | null; targetHeadId: string | null; undoOf?: string }): Promise<import("@varin/protocol").NavigationReceipt>;
  navigationReceipt(input: ThreadIdentity & { key: string }): Promise<import("@varin/protocol").NavigationReceipt | null>;
  fork(input: ThreadIdentity & { key: string; headId: string | null }): Promise<ThreadIdentity>;
  compact(input: ThreadCompact): Promise<ContextJob>;
  publishContext(identity: ThreadIdentity, runId: string): Promise<ContextCheckpoint>;
  contextHistory(identity: ThreadIdentity, runId: string, cursor?: { headId: string; beforeId: string }): Promise<ThreadHistoryPage>;
  cancelContext(identity: ThreadIdentity, runId: string): Promise<RunCancellationReceipt>;
  resumeContext(identity: ThreadIdentity, runId: string): Promise<void>;
  submit(input: ThreadSubmit): Promise<InputSubmitReceipt>;
  enqueue(input: ThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; materials?: ThreadMaterialAttachment[]; mode: InputMode }): Promise<InputReceipt>;
  editInput(inputId: string, expectedRevision: number, text: string, images?: ImageAttachment[]): Promise<QueuedInput>;
  cancelInput(inputId: string, expectedRevision: number): Promise<QueuedInput>;
  /** Read one original-holder media chunk; the expected reference is identity, never authority. */
  mediaRead(input: ThreadIdentity & Omit<MediaReadParams, 'threadId' | 'branchId'>, signal?: AbortSignal): Promise<MediaReadChunk>;
  historyPage(identity: ThreadIdentity, cursor: { headId: string; beforeId: string; limit?: number }, signal?: AbortSignal): Promise<ThreadHistoryPage>;
  historyRuns(identity: ThreadIdentity, cursor: { headId: string | null }, signal?: AbortSignal): Promise<ThreadHistoryRuns>;
  historyRunPreview(identity: ThreadIdentity, cursor: { headId: string; runId: string }, signal?: AbortSignal): Promise<string>;
  /** Secondary read; history bodies never wait for a whole Run's usage scan. */
  historyUsage(identity: ThreadIdentity, cursor: { headId: string; beforeId?: string; limit?: number }, signal?: AbortSignal): Promise<ThreadRunUsage[]>;
  fileTarget(input: ThreadIdentity & { itemId: string; path: string }, signal?: AbortSignal): Promise<ThreadFileTarget>;
  snapshot(identity: ThreadIdentity): Promise<ThreadSnapshot>;
  contextInspection(identity: ThreadIdentity, cursor: { headId: string | null }, signal?: AbortSignal): Promise<ThreadContextInspection>;
  /** Original execution usage on this branch, excluding child Threads and standalone utility work. */
  usage(identity: ThreadIdentity, signal?: AbortSignal): Promise<import('@varin/protocol').ThreadUsage>;
  inspectTools(identity: ThreadIdentity, runId: string): Promise<ThreadToolInspection>;
  inspectPolicy(identity: ThreadIdentity, runId: string): Promise<ThreadPolicyInspection>;
  /** Explicitly restart only the displayed candidate's private strategy state at a safe boundary. */
  restartPolicy(identity: ThreadIdentity, runId: string, selectionId: string): Promise<PolicySelection>;
  /** Cancel this unpublished update without cancelling the Run or its independent work. */
  cancelPolicyUpdate(identity: ThreadIdentity, runId: string, selectionId: string): Promise<PolicySelection>;
  run(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<RunCancellationReceipt>;
  operation(operationId: string): Promise<Operation>;
  cancelOperation(operationId: string): Promise<OperationCancellationReceipt>;
  decidePermission(input: ThreadIdentity & { operationId: string; permissionId: string; decision: 'allow_once' | 'deny' }): Promise<Operation>;
  /** Original-owner requests and RPC-error URL choices remain readable after their Run ends. Pages omit original JSON evidence; read/respond return it. */
  listMcpInteractions(input: ThreadIdentity & Omit<McpInteractionListParams, 'threadId' | 'branchId'>, signal?: AbortSignal): Promise<McpInteractionPage>;
  readMcpInteraction(input: ThreadIdentity & McpInteractionReadParams, signal?: AbortSignal): Promise<McpInteractionView>;
  respondMcpInteraction(input: ThreadIdentity & McpInteractionRespondParams, signal?: AbortSignal): Promise<McpInteractionView>;
  /** Generate only the reviewed request with an explicitly selected registered model; no response is sent yet. */
  reviewMcpSamplingRequest(input: ThreadMcpSamplingRequestReview, signal?: AbortSignal): Promise<McpInteractionView>;
  /** Separately review the original generation before returning its output to the requesting MCP server. */
  reviewMcpSamplingOutput(input: ThreadIdentity & McpSamplingOutputReviewParams, signal?: AbortSignal): Promise<McpInteractionView>;
  answerQuestion(input: ThreadIdentity & { operationId: string; answer: string }): Promise<Operation>;
  resume(runId: string, waitId: string): Promise<PolicyResumeReceipt>;
  retryPreparation(runId: string): Promise<void>;
  events(cursor: number): Promise<RuntimeEvent[]>;
  /** Reconnect from the last durable cursor; progress is presentation-only. */
  /** null subscribes from now; used alongside an initial snapshot to capture live deltas during its reads. */
  observe(cursor: number | null, listener: (event: RuntimeEvent | AgentRuntimeStreamEvent) => void, options: { signal: AbortSignal }): Promise<void>;
}

/** Safe projection of source-owned failures; arbitrary upstream messages are never displayed. */
export function threadSourceFailureMessage(code: string): string | undefined {
  const messages: Record<SourceFailureCode, string> = {
    source_unavailable: 'The selected source revision is unavailable. Select an available source and retry.',
    source_registration_missing: 'The source is not registered on this Host. Restore its original registration or select a new source.',
    source_authority_denied: 'Access to the selected source was denied. Restore its authorization before retrying.',
    source_environment_unavailable: 'The original working copy is unavailable. Restore that copy or explicitly select a new source.',
    source_changed: 'The source no longer matches its admitted identity. Select the intended source again.',
  };
  return Object.hasOwn(messages, code) ? messages[code as SourceFailureCode] : undefined;
}
