export type DocumentIdentity = {
  workspaceId: string;
  resourceId: string;
  /** Host-resolved environment and actual location; never used as a display path. */
  coordinationId?: string;
};

export const documentKey = (identity: DocumentIdentity): string => (
  identity.coordinationId ?? `${identity.workspaceId}\0${identity.resourceId}`
);

export type DocumentLineEnding = 'lf' | 'crlf' | 'cr';

export type DocumentLoadStatus =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'missing'
  | 'binary'
  | 'unsupported-encoding'
  | 'deleted'
  | 'error'
  | 'conflict';

export type DocumentChange = {
  from: number;
  to: number;
  insert: string;
};

export type DocumentConflictState = {
  diskRevision: string;
  ancestorContent: string;
  ancestorRevision: string | null;
  diskContent: string;
};

export type DocumentExternalSource = 'agent' | 'disk' | null;

export type DocumentRecord = {
  identity: DocumentIdentity;
  /** Internal identity for editor-engine projections. It survives move/rename within this registry. */
  documentInstanceId: string;
  connectionGeneration: number;
  workspaceEpoch: number;
  status: DocumentLoadStatus;
  dirty: boolean;
  saving: boolean;
  baseContent: string;
  buffer: string;
  baseRevision: string | null;
  localEditRevision: number;
  encoding: string;
  bom: boolean;
  lineEnding: DocumentLineEnding;
  byteLength: number;
  saveOperationId: string | null;
  saveCapturedEditRevision: number | null;
  conflict: DocumentConflictState | null;
  errorMessage: string | null;
  recoveryJournalId: string | null;
  recoveryJournalRevision: number | null;
  lastOrigin: string | null;
  lastChanges: DocumentChange[] | null;
  externalSource: DocumentExternalSource;
};

export type DocumentEditFailureReason = 'invalid-range' | 'overlapping-ranges';

export type DocumentEditResult =
  | { status: 'applied'; record: DocumentRecord }
  | {
      status: 'stale';
      record: DocumentRecord;
      expectedLocalEditRevision: number;
      actualLocalEditRevision: number;
    }
  | { status: 'invalid'; reason: DocumentEditFailureReason; record: DocumentRecord }
  | { status: 'unsupported'; record: DocumentRecord };

export type DocumentTextPosition = {
  line: number;
  character: number;
};

export type DocumentTextRange = {
  start: DocumentTextPosition;
  end: DocumentTextPosition;
};

export type DocumentWorkspaceTextEdit = {
  range: DocumentTextRange;
  newText: string;
  annotationId?: string;
};

export type DocumentWorkspaceTextDocumentEdit = {
  identity: DocumentIdentity;
  version: number | null;
  edits: DocumentWorkspaceTextEdit[];
};

export type DocumentWorkspaceResourceOperation =
  | { kind: 'create'; identity: DocumentIdentity }
  | { kind: 'rename'; from: DocumentIdentity; to: DocumentIdentity }
  | { kind: 'delete'; identity: DocumentIdentity };

export type DocumentWorkspaceEditInput = {
  workspaceId: string;
  origin: string;
  /** When set, apply/undo use this group id (thread integration operationId). */
  groupId?: string;
  textEdits: DocumentWorkspaceTextDocumentEdit[];
  resourceOperations?: DocumentWorkspaceResourceOperation[];
  changeAnnotations?: Record<string, {
    label: string;
    description?: string;
    needsConfirmation?: boolean;
  }>;
};

export type DocumentWorkspaceEditFailureReason =
  | 'workspace-mismatch'
  | 'resource-operation-unsupported'
  | 'missing'
  | 'binary'
  | 'unsupported-encoding'
  | 'conflict'
  | 'saving'
  | 'not-ready'
  | 'stale-version'
  | 'invalid-range'
  | 'overlapping-ranges'
  | 'stale-plan';

export type DocumentWorkspaceEditFailure = {
  identity?: DocumentIdentity;
  reason: DocumentWorkspaceEditFailureReason;
  message: string;
};

export type DocumentWorkspaceEditPreviewFile = {
  identity: DocumentIdentity;
  beforeContent: string;
  afterContent: string;
  editCount: number;
};

export type DocumentWorkspaceEditPreview = {
  status: 'ready';
  groupId: string;
  workspaceId: string;
  origin: string;
  files: DocumentWorkspaceEditPreviewFile[];
  requiresConfirmation: boolean;
};

export type DocumentWorkspaceEditPrepareResult =
  | DocumentWorkspaceEditPreview
  | { status: 'rejected'; failures: DocumentWorkspaceEditFailure[] };

export type DocumentWorkspaceEditApplyResult =
  | { status: 'applied'; groupId: string; records: DocumentRecord[] }
  | { status: 'rejected'; failures: DocumentWorkspaceEditFailure[] };

export type DocumentWorkspaceEditUndoResult =
  | { status: 'undone'; groupId: string; records: DocumentRecord[] }
  | { status: 'unavailable'; groupId: string }
  | { status: 'rejected'; groupId: string; failures: DocumentWorkspaceEditFailure[] };

export type DocumentMeta = {
  identity: DocumentIdentity;
  workspaceEpoch: number;
  status: DocumentLoadStatus;
  dirty: boolean;
  saving: boolean;
  localEditRevision: number;
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  lineEnding: DocumentLineEnding;
  byteLength: number;
  errorMessage: string | null;
  conflict: DocumentConflictState | null;
  externalSource: DocumentExternalSource;
};

export const toDocumentMeta = (record: DocumentRecord): DocumentMeta => ({
  identity: record.identity,
  workspaceEpoch: record.workspaceEpoch,
  status: record.status,
  dirty: record.dirty,
  saving: record.saving,
  localEditRevision: record.localEditRevision,
  baseRevision: record.baseRevision,
  encoding: record.encoding,
  bom: record.bom,
  lineEnding: record.lineEnding,
  byteLength: record.byteLength,
  errorMessage: record.errorMessage,
  conflict: record.conflict,
  externalSource: record.externalSource,
});
