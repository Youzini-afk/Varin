import type { ThreadIdentity } from '@varin/application-client';
import type { DocumentIdentity } from '@/lib/documents/types';

export type EditorContextAttachmentKind = 'editor' | 'selection' | 'diagnostic' | 'diff' | 'test-failure' | 'stack';
export type EditorContextAttachmentSource = 'saved' | 'unsaved-buffer';

export type EditorContextRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type EditorContextAttachment = {
  id: string;
  runtimeKey: string;
  threadKey: string;
  workspaceId: string;
  resourceId: string;
  label: string;
  documentInstanceId: string | null;
  documentRevision: string | null;
  localEditRevision: number;
  source: EditorContextAttachmentSource;
  kind: EditorContextAttachmentKind;
  range?: EditorContextRange;
  languageId?: string;
  text?: string;
  diagnosticMessage?: string;
  patch?: string;
};

export type AgentFileChangeKind = 'write' | 'edit' | 'patch' | 'delete' | 'move';

export type AgentFileChangeHint = {
  runtimeKey: string;
  threadKey: string;
  toolCallId: string;
  workspaceId: string;
  resourceId: string;
  kind: AgentFileChangeKind;
  at: number;
  fromResourceId?: string;
  entryId?: string;
};

export type ToolFileChange = {
  path: string;
  kind: AgentFileChangeKind;
  fromPath?: string;
};

export type ParsedPatchHunkLine = {
  kind: 'context' | 'add' | 'remove';
  text: string;
};

export type ParsedPatchHunk = {
  index: number;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedPatchHunkLine[];
};

export type HunkDecision = 'accept' | 'reject';

export type PatchApplyTextResult =
  | { status: 'applied'; content: string }
  | { status: 'mismatch'; hunkIndex: number };

export type DocumentPatchWriteResult =
  | { status: 'applied'; localEditRevision: number }
  | { status: 'conflict'; currentRevision: string | null; dirty: boolean }
  | { status: 'missing' }
  | { status: 'failure'; errorMessage: string };

export type MergeRegion =
  | { kind: 'same'; text: string }
  | { kind: 'ours'; text: string }
  | { kind: 'theirs'; text: string }
  | { kind: 'conflict'; ancestor: string; ours: string; theirs: string };

export type MergeDecision = 'ours' | 'theirs' | 'edit';

export type MergeRegionDecision = {
  index: number;
  choice: MergeDecision;
  edited?: string;
};

export type EditorSessionLink = {
  identity: DocumentIdentity;
  thread: ThreadIdentity;
  entryId?: string;
  toolCallId?: string;
};
