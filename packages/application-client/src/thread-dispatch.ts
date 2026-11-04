import type { ThreadIdentity, ThreadThinkingLevel } from './threads.js';
import type { AttachmentSelection, WorkFocusId } from '@varin/protocol';

/** Metadata from the original native dispatch and configured-model owners. */
export interface ThreadDispatchCatalog {
  runId: string | null;
  headId: string | null;
  models: Array<{ id: string; name: string; channelName: string; thinkingLevels: ThreadThinkingLevel[]; defaultThinkingLevel: ThreadThinkingLevel }>;
  projects: Array<{ id: string; name: string; path: string }>;
  unavailable?: string;
}
export interface ThreadDispatchInput extends ThreadIdentity {
  key: string;
  runId: string;
  expectedHead: string | null;
  text: string;
  name?: string;
  /** Stable configured channel/model identity returned by dispatchCatalog. */
  model: string;
  thinking?: string;
  /** null explicitly selects no file source. It never silently inherits a worktree. */
  projectId: string | null;
  workMode: 'shared' | 'read_only' | 'isolated_write';
  /** Omission inherits the original dispatching Run's work focus. */
  workFocus?: WorkFocusId;
  background?: Array<{ threadId: string; branchId: string; headId: string; itemIds: string[] }>;
  attachments?: AttachmentSelection[];
}
export interface ThreadDispatchReceipt {
  operationId: string;
  executionId: string;
  threadId: string;
  branchId: string;
  actor: { kind: 'user' };
  acceptedCursor: number;
  acceptedAtMs: number;
}
