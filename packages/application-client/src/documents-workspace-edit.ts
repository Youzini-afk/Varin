import type { VarinLanguageWorkspaceEdit, VarinResourceReference } from './types.js';

/** Editor state is separate from saved file bytes. All text is editor-normalized. */
export interface VarinWorkspaceEditBuffer {
  resource: VarinResourceReference;
  documentInstanceId: string;
  localEditRevision: number;
  baseRevision: string | null;
  buffer: string;
  baseContent: string;
  encoding: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
  status: 'ready' | 'missing' | 'deleted';
}

export interface VarinWorkspaceEditBufferSlot {
  resource: VarinResourceReference;
  buffer: VarinWorkspaceEditBuffer | null;
}

/** Delivered only through the authenticated surface-operation body channel. */
export interface VarinWorkspaceEditSurfaceChange {
  stepId: string;
  mode: 'capture' | 'validate' | 'apply';
  captureScopes?: Array<{ resource: VarinResourceReference; subtree: boolean }>;
  origin: string;
  epoch: number;
  before: VarinWorkspaceEditBufferSlot[];
  after: VarinWorkspaceEditBufferSlot[];
}

export interface VarinWorkspaceEditSurfaceReceipt {
  stepId: string;
  status: 'applied' | 'rejected';
  /** Exact after states, allowing the Host to validate identity and versions. */
  buffers: VarinWorkspaceEditBufferSlot[];
  message?: string;
}

export interface VarinWorkspaceEditPrepareRequest {
  operationId: string;
  workspaceId: string;
  origin: string;
  /** Omit for Host callers; affected live surfaces are captured by Documents. */
  ownerId?: string;
  generation?: number;
  edit: VarinLanguageWorkspaceEdit;
  /** Existing affected records, including clean records and deleted drafts. */
  buffers?: VarinWorkspaceEditBuffer[];
}

export interface VarinWorkspaceEditPreviewFile {
  resource: VarinResourceReference;
  from?: VarinResourceReference;
  kind: 'text' | 'create' | 'rename' | 'delete';
  beforeContent: string;
  afterContent: string;
  editCount: number;
  affectsDraft: boolean;
  annotationIds: string[];
}

export interface VarinWorkspaceEditFailure {
  resource?: VarinResourceReference;
  step?: number;
  reason: string;
  message: string;
}

export type VarinWorkspaceEditPreparation =
  | {
      status: 'ready';
      operationId: string;
      workspaceId: string;
      hostId: string;
      epoch: number;
      files: VarinWorkspaceEditPreviewFile[];
      requiresConfirmation: boolean;
    }
  | { status: 'rejected'; failures: VarinWorkspaceEditFailure[] };

export interface VarinWorkspaceEditReceipt {
  operationId: string;
  workspaceId: string;
  status: 'pending' | 'applied' | 'compensated' | 'undone' | 'needs-attention' | 'rejected';
  appliedSteps: number[];
  restoredSteps: number[];
  affectedResources: VarinResourceReference[];
  resourceResults?: Array<{
    resource: VarinResourceReference;
    status: 'unchanged' | 'pending' | 'applied' | 'restored' | 'needs-attention';
  }>;
  failures: VarinWorkspaceEditFailure[];
}

export interface DocumentsWorkspaceEditAPI {
  discardWorkspaceEdit(request: { workspaceId: string; operationId: string }): Promise<{ discarded: boolean }>;
  readWorkspaceEditRecovery(request: {
    workspaceId: string;
    operationId: string;
  }): Promise<{ receipt: VarinWorkspaceEditReceipt; buffers: VarinWorkspaceEditBuffer[] }>;
  listWorkspaceEdits(request: { workspaceId: string }): Promise<VarinWorkspaceEditReceipt[]>;
  prepareWorkspaceEdit(request: VarinWorkspaceEditPrepareRequest): Promise<VarinWorkspaceEditPreparation>;
  applyWorkspaceEdit(request: { workspaceId: string; operationId: string }): Promise<VarinWorkspaceEditReceipt>;
  /** Read the original receipt after transport loss; never replay the batch. */
  readWorkspaceEdit(request: {
    workspaceId: string;
    operationId: string;
  }): Promise<VarinWorkspaceEditReceipt | { status: 'missing' }>;
  undoWorkspaceEdit(request: { workspaceId: string; operationId: string }): Promise<VarinWorkspaceEditReceipt>;
}
