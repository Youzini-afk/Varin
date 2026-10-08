import type { NativeEvent, NativeHistoryItem, NativeInputMode, NativeInputReceipt, NativeQueuedInput, NativeReceipt, NativeRun, NativeOperation, NativeRuntimeStreamEvent, NativeThreadSummary, NativeLaunchIntent } from '@varin/protocol';

/** Explicit authority selection. A nativeThread never opens a Pi session. */
export interface NativeThreadIdentity { runtime: 'nativeThread'; threadId: string; branchId: string }
export interface NativeThreadModel { providerId: string; modelId: string }
export interface NativeThreadSource {
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string;
  revision: number;
  mode: 'fixed_branch' | 'materialized';
  tools: Array<'file_read' | 'file_write' | 'file_edit' | 'process_inspect' | 'process_read' | 'process_spawn'>;
}
export interface NativeThreadSubmit extends NativeThreadIdentity {
  key: string;
  expectedHead: string | null;
  text: string;
  model: NativeThreadModel;
  source?: NativeThreadSource;
}
export interface NativeThreadSnapshot {
  identity: NativeThreadIdentity;
  thread: NativeThreadSummary;
  activeRun: NativeRun | null;
  history: NativeHistoryItem[];
  inputs: NativeQueuedInput[];
  operations: NativeOperation[];
  launch: NativeLaunchIntent | null;
}
export interface NativeThreadsAPI {
  listModels(): Promise<Array<NativeThreadModel & { name?: string }>>;
  list(): Promise<NativeThreadSummary[]>;
  create(key: string): Promise<NativeThreadIdentity>;
  submit(input: NativeThreadSubmit): Promise<NativeReceipt>;
  enqueue(input: NativeThreadIdentity & { key: string; text: string; mode: NativeInputMode }): Promise<NativeInputReceipt>;
  editInput(inputId: string, expectedRevision: number, text: string): Promise<NativeQueuedInput>;
  cancelInput(inputId: string, expectedRevision: number): Promise<NativeQueuedInput>;
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
