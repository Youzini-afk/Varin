import type { ThreadIdentity, ThreadThinkingLevel } from './threads.js';
// Same original-owner selection contract as the file handoff API.
type AttachmentSelection = { ref: string } | { path: string };

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
