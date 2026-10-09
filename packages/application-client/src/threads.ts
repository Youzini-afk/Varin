import type { PlanSnapshot, PlanMutationResult, ChildTextPage, ChildTask, ChildWait, LiveRoot, ContextPersonalization, RuntimeEvent, HistoryItem, InputMode, InputReceipt, QueuedInput, InputSubmitReceipt, Run, Operation, RunCancellationReceipt, OperationCancellationReceipt, AgentRuntimeStreamEvent, ThreadSummary, LaunchIntent, ImageAttachment } from '@varin/protocol';

/** Explicit authority selection. A thread never opens a Pi session. */
export interface ThreadIdentity { runtime: 'agent'; threadId: string; branchId: string }
export type ThreadThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface ThreadModel { providerId: string; modelId: string; thinkingLevel?: ThreadThinkingLevel }
export interface ThreadModelInfo extends ThreadModel { name?: string; acceptsImages?: boolean; contextWindowTokens?: number; thinkingLevels?: ThreadThinkingLevel[] }
interface ThreadSourceBase {
  workspaceId: string;
  executionWorkspaceId: string;
  tools: Array<'file_read' | 'file_list' | 'file_search' | 'file_write' | 'file_edit' | 'process_inspect' | 'process_read' | 'process_spawn' | 'language_definition' | 'language_references' | 'language_diagnostics' | 'code_retrieval'>;
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
  request: { personalization?: ContextPersonalization; key: string; branch_id: string; through_id: string; expected_revision: number;
    effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
  receipt: InputSubmitReceipt;
}
export interface ContextCheckpoint {
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
export interface ThreadCollaborationAPI {
  readReport(identity: ThreadIdentity, operationId: string, itemId: string, offset?: number, maxBytes?: number): Promise<ChildTextPage>;
  children(identity: ThreadIdentity): Promise<ChildTask[]>;
  cancelChild(identity: ThreadIdentity, operationId: string): Promise<ChildTask>;
  cancelWait(identity: ThreadIdentity, waitId: string): Promise<ChildWait>;
  cancelTree(identity: ThreadIdentity): Promise<void>;
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
  launch: LaunchIntent | null;
  context: ThreadContextState;
  children?: ChildTask[];
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
export interface ThreadsAPI {
  plan?: ThreadPlanAPI;
  collaboration?: ThreadCollaborationAPI;
  listModels(): Promise<ThreadModelInfo[]>;
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
  run(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<RunCancellationReceipt>;
  operation(operationId: string): Promise<Operation>;
  cancelOperation(operationId: string): Promise<OperationCancellationReceipt>;
  decidePermission(input: ThreadIdentity & { operationId: string; permissionId: string; decision: 'allow_once' | 'deny' }): Promise<Operation>;
  answerQuestion(input: ThreadIdentity & { operationId: string; answer: string }): Promise<Operation>;
  resume(runId: string): Promise<void>;
  events(cursor: number): Promise<RuntimeEvent[]>;
  /** Reconnect from the last durable cursor; progress is presentation-only. */
  observe(cursor: number, listener: (event: RuntimeEvent | AgentRuntimeStreamEvent) => void, options: { signal: AbortSignal }): Promise<void>;
}
