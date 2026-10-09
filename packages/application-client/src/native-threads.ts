import type { NativeEvent, NativeHistoryItem, NativeInputMode, NativeInputReceipt, NativeQueuedInput, NativeReceipt, NativeRun, NativeOperation, NativeRuntimeStreamEvent, NativeThreadSummary, NativeLaunchIntent, ImageAttachment } from '@varin/protocol';

/** Explicit authority selection. A nativeThread never opens a Pi session. */
export interface NativeThreadIdentity { runtime: 'nativeThread'; threadId: string; branchId: string }
export interface NativeThreadModel { providerId: string; modelId: string }
export interface NativeThreadSource {
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string;
  revision: number;
  mode: 'fixed_branch' | 'materialized';
  tools: Array<'file_read' | 'file_list' | 'file_search' | 'file_write' | 'file_edit' | 'process_inspect' | 'process_read' | 'process_spawn'>;
}
export interface NativeThreadPrepareSource extends NativeThreadIdentity {
  key: string;
  path: string;
  mode: NativeThreadSource['mode'];
}
export interface NativeThreadPreparedSource {
  path: string;
  source: NativeThreadSource;
}
export interface NativeThreadSubmit extends NativeThreadIdentity {
  key: string;
  expectedHead: string | null;
  text: string;
  images?: ImageAttachment[];
  model: NativeThreadModel;
  source?: NativeThreadSource;
}
export interface NativeThreadHistoryPage {
  head: string | null;
  previous: string | null;
  items: NativeHistoryItem[];
}
/** Durable context records projected by the Host; original conversation history stays intact. */
export interface NativeContextJob {
  request: { key: string; branch_id: string; through_id: string; expected_revision: number;
    effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
  receipt: NativeReceipt;
}
export interface NativeContextCheckpoint {
  id: string;
  revision: number;
  proposal: { key: string; branch_id: string; through_id: string | null; expected_revision: number;
    summary: string; effective_system_prompt: string; instruction_sources: string[]; memory_checkpoint: string | null };
}
export interface NativeThreadContextState {
  checkpoint: NativeContextCheckpoint | null;
  jobs: Array<{ job: NativeContextJob; run: NativeRun }>;
}
export interface NativeThreadCompact extends NativeThreadIdentity {
  key: string;
  throughId: string;
  expectedRevision: number;
  model: NativeThreadModel;
}
export interface NativeThreadSnapshot {
  identity: NativeThreadIdentity;
  thread: NativeThreadSummary;
  activeRun: NativeRun | null;
  history: NativeHistoryItem[];
  historyPage: Pick<NativeThreadHistoryPage, 'head' | 'previous'>;
  inputs: NativeQueuedInput[];
  operations: NativeOperation[];
  launch: NativeLaunchIntent | null;
  context: NativeThreadContextState;
}
export interface NativeThreadsAPI {
  listModels(): Promise<Array<NativeThreadModel & { name?: string; acceptsImages?: boolean }>>;
  list(): Promise<NativeThreadSummary[]>;
  create(key: string): Promise<NativeThreadIdentity>;
  prepareSource(input: NativeThreadPrepareSource): Promise<NativeThreadPreparedSource>;
  /** Fork immutable conversation ancestry; live runs and resource grants are not copied. */
  fork(input: NativeThreadIdentity & { key: string; headId: string | null }): Promise<NativeThreadIdentity>;
  compact(input: NativeThreadCompact): Promise<NativeContextJob>;
  publishContext(identity: NativeThreadIdentity, runId: string): Promise<NativeContextCheckpoint>;
  cancelContext(identity: NativeThreadIdentity, runId: string): Promise<NativeRun>;
  resumeContext(identity: NativeThreadIdentity, runId: string): Promise<void>;
  submit(input: NativeThreadSubmit): Promise<NativeReceipt>;
  enqueue(input: NativeThreadIdentity & { key: string; text: string; images?: ImageAttachment[]; mode: NativeInputMode }): Promise<NativeInputReceipt>;
  editInput(inputId: string, expectedRevision: number, text: string, images?: ImageAttachment[]): Promise<NativeQueuedInput>;
  cancelInput(inputId: string, expectedRevision: number): Promise<NativeQueuedInput>;
  historyPage(identity: NativeThreadIdentity, cursor: { headId: string; beforeId: string }): Promise<NativeThreadHistoryPage>;
  snapshot(identity: NativeThreadIdentity): Promise<NativeThreadSnapshot>;
  run(runId: string): Promise<NativeRun>;
  cancelRun(runId: string): Promise<NativeRun>;
  operation(operationId: string): Promise<NativeOperation>;
  cancelOperation(operationId: string): Promise<NativeOperation>;
  resume(runId: string): Promise<void>;
  events(cursor: number): Promise<NativeEvent[]>;
  /** Reconnect from the last durable cursor; progress is presentation-only. */
  observe(cursor: number, listener: (event: NativeEvent | NativeRuntimeStreamEvent) => void, options: { signal: AbortSignal }): Promise<void>;
}
