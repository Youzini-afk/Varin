import type { MessageSendParams, MessageListParams, MessageReceipt, MessagePage, MessageView } from '@varin/protocol';
import type { FamilyList, FamilyRuns, FamilyRead, FamilyItem, FamilyRunsParams, FamilyReadParams, FamilyItemParams } from '@varin/protocol';
import type { PlanSnapshot, PlanMutationResult, ChildTextPage, ChildTask, DelegatedExecution, ChildWait, TreeCancellationReceipt, Followup, LiveRoot, ContextPersonalization, ContextResources, ResourceActivation, RuntimeEvent, HistoryItem, InputMode, InputReceipt, QueuedInput, InputSubmitReceipt, Run, Operation, RunCancellationReceipt, OperationCancellationReceipt, AgentRuntimeStreamEvent, ThreadSummary, LaunchIntent, PolicyResumeReceipt, ImageAttachment } from '@varin/protocol';

import type { RunModelSelection, RunModelSelections } from '@varin/protocol';
import type { FollowupControlAction } from '@varin/protocol';
import type { Goal, GoalBudget, GoalControlAction, GoalControlReceipt } from '@varin/protocol';
import type { PolicySelection, PolicySelections } from '@varin/protocol';
import type { ExtensionToolBinding, LaunchTool, McpBinding } from '@varin/protocol';
import type { VarinExtensionServiceProvision } from '@varin/extension-contract';

/** Explicit authority selection. A thread never opens a Pi session. */
export interface ThreadIdentity { runtime: 'agent'; threadId: string; branchId: string }
export type ThreadThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThreadModel { providerId: string; modelId: string; thinkingLevel?: ThreadThinkingLevel; temperature?: number }
export interface ThreadModelInfo extends ThreadModel { name?: string; acceptsImages?: boolean; contextWindowTokens?: number; thinkingLevels?: ThreadThinkingLevel[] }
interface ThreadSourceBase {
  workspaceId: string;
  executionWorkspaceId: string;
  tools: Array<'file_read' | 'file_list' | 'file_search' | 'file_write' | 'file_edit' | 'process_inspect' | 'process_read' | 'process_spawn' | 'process_write' | 'process_resize' | 'language_definition' | 'language_references' | 'language_diagnostics' | 'code_retrieval'>;
}
export type ThreadSource = ThreadSourceBase & (
  | { mode: 'fixed_branch' | 'materialized'; branchId: string; revision: number; liveRoot?: never }
  | { mode: 'live_root'; liveRoot: LiveRoot; branchId?: never; revision?: never }
);
export interface ThreadPrepareSource extends ThreadIdentity {
  key: string;
  path: string;
  mode: ThreadSource['mode'];
}
export interface ThreadPreparedSource {
  path: string;
  source: ThreadSource;
}
export interface ThreadSubmit extends ThreadIdentity {
  key: string;
  expectedHead: string | null;
  text: string;
  images?: ImageAttachment[];
  model: ThreadModel;
  source?: ThreadSource;
}
export interface ThreadHistoryPage {
  head: string | null;
  previous: string | null;
  items: HistoryItem[];
}
/** Durable context records projected by the Host; original conversation history stays intact. */
export interface ContextJob {
  request: { owner_run_id?: string; personalization?: ContextPersonalization; key: string; branch_id: string; through_id: string; expected_revision: number;
    effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
  receipt: InputSubmitReceipt;
}
export interface ContextCheckpoint {
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
  list(identity: ThreadIdentity, includeSelf?: boolean, signal?: AbortSignal): Promise<FamilyList>;
  runs(identity: ThreadIdentity, request: Omit<FamilyRunsParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyRuns>;
  read(identity: ThreadIdentity, request: Omit<FamilyReadParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyRead>;
  item(identity: ThreadIdentity, request: Omit<FamilyItemParams, 'callerThreadId'>, signal?: AbortSignal): Promise<FamilyItem>;
}
/** Immutable task-family information. Acceptance and history delivery do not imply execution. */
export interface ThreadMessagesAPI {
  send(identity: ThreadIdentity, request: Omit<MessageSendParams, 'senderThreadId' | 'senderBranchId'>, signal?: AbortSignal): Promise<MessageReceipt>;
  list(identity: ThreadIdentity, request: Omit<MessageListParams, 'threadId' | 'branchId'>, signal?: AbortSignal): Promise<MessagePage>;
  get(identity: ThreadIdentity, messageId: string, signal?: AbortSignal): Promise<MessageView>;
}
export interface ThreadChildContinuation extends ThreadIdentity {
  key: string;
  previousRunId: string;
  expectedHead: string | null;
  text: string;
  images?: ImageAttachment[];
}
export interface ThreadCollaborationAPI {
  /** Explicit User input, retaining this child's exact previous execution configuration. */
  continueChild(input: ThreadChildContinuation, signal?: AbortSignal): Promise<DelegatedExecution>;
  executions(identity: ThreadIdentity, operationId?: string, signal?: AbortSignal): Promise<DelegatedExecution[]>;
  readExecutionReport(identity: ThreadIdentity, executionId: string, itemId: string, offset?: number, maxBytes?: number, signal?: AbortSignal): Promise<ChildTextPage>;
  readReport(identity: ThreadIdentity, operationId: string, itemId: string, offset?: number, maxBytes?: number): Promise<ChildTextPage>;
  children(identity: ThreadIdentity): Promise<ChildTask[]>;
  cancelChild(identity: ThreadIdentity, operationId: string): Promise<TreeCancellationReceipt>;
  cancelWait(identity: ThreadIdentity, waitId: string): Promise<ChildWait>;
  cancelTree(identity: ThreadIdentity): Promise<TreeCancellationReceipt>;
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
/** One continuation of the original work after the exact native process has stopped. */
export interface ThreadFollowupsAPI {
  register(input: ThreadIdentity & { key: string; runId: string; operationId: string }): Promise<Followup>;
  list(identity: ThreadIdentity): Promise<Followup[]>;
  /** Revision-checked definition control; a consumed occurrence returns its existing receipt. */
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
  identity: ThreadIdentity;
  /** Read before the snapshot's component queries. Replay after this cursor covers concurrent commits. */
  eventCursor: number;
  thread: ThreadSummary;
  activeRun: Run | null;
  history: HistoryItem[];
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
  sessionId: string;
  cwd: string;
  operationId: string;
  processId: string;
}
export interface ThreadProcessesAPI {
  /** Open a view of the original PTY job; this never launches another shell. */
  openTerminal(input: ThreadIdentity & { operationId: string }): Promise<ThreadProcessTerminal>;
}
export interface ThreadsAPI {
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
  list(): Promise<ThreadSummary[]>;
  create(key: string): Promise<ThreadIdentity>;
  prepareSource(input: ThreadPrepareSource): Promise<ThreadPreparedSource>;
  /** Fork immutable conversation ancestry; live runs and resource grants are not copied. */
  fork(input: ThreadIdentity & { key: string; headId: string | null }): Promise<ThreadIdentity>;
  compact(input: ThreadCompact): Promise<ContextJob>;
  publishContext(identity: ThreadIdentity, runId: string): Promise<ContextCheckpoint>;
  cancelContext(identity: ThreadIdentity, runId: string): Promise<RunCancellationReceipt>;
  resumeContext(identity: ThreadIdentity, runId: string): Promise<void>;
  submit(input: ThreadSubmit): Promise<InputSubmitReceipt>;
  enqueue(input: ThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; mode: InputMode }): Promise<InputReceipt>;
  editInput(inputId: string, expectedRevision: number, text: string, images?: ImageAttachment[]): Promise<QueuedInput>;
  cancelInput(inputId: string, expectedRevision: number): Promise<QueuedInput>;
  historyPage(identity: ThreadIdentity, cursor: { headId: string; beforeId: string }): Promise<ThreadHistoryPage>;
  snapshot(identity: ThreadIdentity): Promise<ThreadSnapshot>;
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
  answerQuestion(input: ThreadIdentity & { operationId: string; answer: string }): Promise<Operation>;
  resume(runId: string, waitId: string): Promise<PolicyResumeReceipt>;
  retryPreparation(runId: string): Promise<void>;
  events(cursor: number): Promise<RuntimeEvent[]>;
  /** Reconnect from the last durable cursor; progress is presentation-only. */
  observe(cursor: number, listener: (event: RuntimeEvent | AgentRuntimeStreamEvent) => void, options: { signal: AbortSignal }): Promise<void>;
}
