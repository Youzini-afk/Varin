import { create } from 'zustand';
import { ChangeSet } from '@codemirror/state';
import { mapInteractionRanges, type InteractionRange } from '@/components/chat/composer/editor/interactionRanges';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import type { InlineCommentDraft } from './useInlineCommentDraftStore';
import type { Attachment, ImageAttachment } from '@varin/protocol';
import type { ThreadAgentChoice, ThreadIdentity, ThreadModel, ThreadPrepareSource, ThreadPreparedSource, ThreadsAPI } from '@varin/application-client';

export type ThreadPendingInput = {
  fingerprint: string;
  editorText: string;
  fileIds?: readonly string[];
  selectedAttachmentIds?: readonly string[];
  goalObjective?: string;
  goalBudget?: number;
  editorContext?: readonly EditorContextAttachment[];
  inlineContext?: ReadonlyArray<{ key: string; drafts: readonly InlineCommentDraft[] }>;
  preparedSource?: ThreadPreparedSource | null;
  status: 'sending' | 'unknown';
} & (
  | { kind: 'submit'; acceptedRunId?: string; acceptedInputId?: string; input: Parameters<ThreadsAPI['submit']>[0] }
  | { kind: 'enqueue'; input: Parameters<ThreadsAPI['enqueue']>[0] }
  | { kind: 'continue'; input: Parameters<NonNullable<ThreadsAPI['collaboration']>['continueChild']>[0] }
);
/** A retained document reference, never the original upload bytes or a filesystem grant. */
export interface ThreadMaterialAttachment {
  snapshotId: string;
  filename: string;
  sourceHash?: string;
  format?: 'pdf' | import('@varin/protocol').OfficeFormat;
}
/** Original bytes stay in memory until the original upload owner confirms its fixed reference. */
export interface DraftFileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  data: Blob;
  imageReference?: number;
  annotation?: import('@/lib/images/annotations').ImageAnnotationDocument;
  uploadKey?: string;
  status: 'selected' | 'preparing' | 'ready' | 'failed';
  attachment?: Attachment;
  preparedScope?: string;
  preparationHost?: number;
  error?: string;
}
export interface DraftSourceSelection {
  path: string;
  resourceOwner: ThreadPrepareSource['resourceOwner'];
  mode: ThreadPrepareSource['mode'];
  contentMode: ThreadPrepareSource['content']['mode'];
  captureScopes: string[];
}
export interface DraftSelectedAttachment { id: string; host: number; filename: string; selection: import('@varin/protocol').AttachmentSelection; sourceKey?: string; attachment?: Attachment }
export interface ThreadFirstSend {
  selectedAttachments?: readonly DraftSelectedAttachment[];
  referenceScope?: string;
  skills?: import('@varin/application-client').ThreadSkillSelection[];
  references?: import('@varin/application-client').ThreadObjectReference[];
  key: string;
  text: string;
  editorText: string;
  images: ImageAttachment[];
  files: DraftFileAttachment[];
  model: ThreadModel;
  agent?: ThreadAgentChoice;
  workspacePath?: string;
  sourceSelection?: DraftSourceSelection;
  editorContext: readonly EditorContextAttachment[];
  inlineContext: ReadonlyArray<{ key: string; drafts: readonly InlineCommentDraft[] }>;
  goalObjective?: string;
  goalBudget?: number;
  status: 'sending' | 'failed';
  error?: string;
}
export interface ThreadDraft {
  /** Unsent edits of historical images, owned by this conversation's local draft. */
  imageAnnotations?: Record<string, import('@/lib/images/annotations').ImageAnnotationDocument>;
  /** Latest explicit action per source; retry snapshots share this draft's in-memory lifetime. */
  interactionSends?: Record<string, { fingerprint: string; pending?: ThreadPendingInput; receipt?: { status: 'sent' | 'queued'; inputId?: string } }>;
  interactions?: readonly InteractionRange[];
  interactionAttachments?: Record<string, string>;
  selectedAttachments?: readonly DraftSelectedAttachment[];
  composerWorkflow?: import('@/components/thread/composerWorkflowState').ComposerWorkflowState;
  references?: readonly import('@/components/chat/composer/editor/references').ComposerReference[];
  harnessId?: string | null;
  externalConversationId?: string;
  /** Idempotent preparation identity, retained after uncertain create/connection results. */
  externalPreparationKey?: string;
  externalConversationHost?: number;
  externalInput?: import('@varin/application-client').ExternalInput & { key: string };
  externalModels?: Record<string, string>;
  externalOptions?: Record<string, { thinking?: string; mode?: string; config?: Record<string, string> }>;
  text: string;
  images: import('@/lib/images/annotations').EditableImageAttachment[];
  materials: ThreadMaterialAttachment[];
  model?: ThreadModel;
  workFocus?: import('@varin/protocol').WorkFocusId;
  preparedSource: ThreadPreparedSource | null;
  workspacePath?: string;
  goalArmed?: boolean;
  pendingInput?: ThreadPendingInput;
  identity?: ThreadIdentity;
  files?: DraftFileAttachment[];
  firstSend?: ThreadFirstSend;
  /** Paint the accepted first input until its native history snapshot arrives. */
  firstMessageReceipt?: Pick<ThreadFirstSend, 'key' | 'text' | 'images' | 'files'> & { inputId: string };
  sendError?: string;
  sourceSelection?: DraftSourceSelection;
  /** Unsent collaboration input and exact per-recipient attempts, retained in memory only. */
  collaboration?: {
    afterCurrent?: boolean;
    targets: ThreadIdentity[];
    reply?: import('@varin/protocol').MessageFeedEntry;
    attempts?: Array<{ request: Parameters<NonNullable<ThreadsAPI['messages']>['send']>[1]; receipt?: import('@varin/protocol').MessageReceipt; error?: string }>;
    sending?: boolean;
  };
}
export const EMPTY_THREAD_DRAFT: ThreadDraft = Object.freeze({ text: '', images: [], materials: [], preparedSource: null });
/** Composer state only; accepted execution and history remain with the native Catalog. Never persisted. */
export const useThreadDraftStore = create<{
  drafts: Record<string, ThreadDraft>;
  patch(key: string, patch: Partial<ThreadDraft> | ((draft: ThreadDraft) => Partial<ThreadDraft>)): void;
  remove(key: string): void;
}>((set) => ({
  drafts: {},
  patch: (key, patch) => set(state => {
    const draft = state.drafts[key] ?? EMPTY_THREAD_DRAFT;
    const change = typeof patch === 'function' ? patch(draft) : patch;
    const next = { ...draft, ...change };
    if (typeof change.text === 'string' && change.text !== draft.text && change.interactions === undefined && draft.interactions?.length) {
      let from = 0, to = draft.text.length, end = change.text.length;
      while (from < to && from < end && draft.text[from] === change.text[from]) from++;
      while (to > from && end > from && draft.text[to - 1] === change.text[end - 1]) { to--; end--; }
      next.interactions = mapInteractionRanges(draft.interactions, ChangeSet.of({ from, to, insert: change.text.slice(from, end) }, draft.text.length));
    }
    if (change.images) {
      let reference = Math.max(0, ...(next.files ?? []).map(file => file.imageReference ?? 0), ...change.images.map(image => image.reference ?? 0));
      next.images = change.images.map(image => image.reference === undefined ? { ...image, reference: ++reference } : image);
    }
    return { drafts: { ...state.drafts, [key]: next } };
  }),
  remove: key => set(state => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts }; }),
}));
