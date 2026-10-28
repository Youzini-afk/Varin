import { create } from 'zustand';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import type { InlineCommentDraft } from './useInlineCommentDraftStore';
import type { ImageAttachment } from '@varin/protocol';
import type { ThreadAgentChoice, ThreadIdentity, ThreadModel, ThreadPrepareSource, ThreadPreparedSource, ThreadsAPI } from '@varin/application-client';

export type ThreadPendingInput = {
  fingerprint: string;
  editorText: string;
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
export interface DraftPdfAttachment { id: string; filename: string; data: string; mimeType?: import('@varin/protocol').DocumentMimeType }
export interface DraftSourceSelection {
  path: string;
  resourceOwner: ThreadPrepareSource['resourceOwner'];
  mode: ThreadPrepareSource['mode'];
  contentMode: ThreadPrepareSource['content']['mode'];
  captureScopes: string[];
}
export interface ThreadFirstSend {
  key: string;
  text: string;
  editorText: string;
  images: ImageAttachment[];
  pdfs: DraftPdfAttachment[];
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
  harnessId?: string | null;
  externalConversationId?: string;
  externalInput?: import('@varin/application-client').ExternalInput & { key: string };
  externalModels?: Record<string, string>;
  externalOptions?: Record<string, { thinking?: string; mode?: string }>;
  text: string;
  images: ImageAttachment[];
  /** High-water mark retained after removing an image, reset after sending the draft. */
  imageReferenceSequence?: number;
  materials: ThreadMaterialAttachment[];
  model?: ThreadModel;
  workFocus?: import('@varin/protocol').WorkFocusId;
  preparedSource: ThreadPreparedSource | null;
  workspacePath?: string;
  goalArmed?: boolean;
  pendingInput?: ThreadPendingInput;
  identity?: ThreadIdentity;
  pdfs?: DraftPdfAttachment[];
  firstSend?: ThreadFirstSend;
  /** Paint the accepted first input until its native history snapshot arrives. */
  firstMessageReceipt?: Pick<ThreadFirstSend, 'key' | 'text' | 'images'> & { inputId: string };
  sendError?: string;
  sourceSelection?: DraftSourceSelection;
  /** Unsent collaboration input and exact per-recipient attempts, retained in memory only. */
  collaboration?: {
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
    if (change.images) {
      let reference = Math.max(next.imageReferenceSequence ?? 0, ...change.images.map(image => image.reference ?? 0));
      next.images = change.images.map(image => image.reference === undefined ? { ...image, reference: ++reference } : image);
      next.imageReferenceSequence = reference;
    }
    return { drafts: { ...state.drafts, [key]: next } };
  }),
  remove: key => set(state => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts }; }),
}));
