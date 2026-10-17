import { create } from 'zustand';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import type { InlineCommentDraft } from './useInlineCommentDraftStore';
import type { ImageAttachment } from '@varin/protocol';
import type { ThreadIdentity, ThreadModel, ThreadPrepareSource, ThreadPreparedSource, ThreadsAPI } from '@varin/application-client';
import { useMessageQueueStore } from './messageQueueStore';

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
/** A retained PDF reference, never the original upload bytes or a filesystem grant. */
export interface ThreadMaterialAttachment {
  snapshotId: string;
  filename: string;
  sourceHash?: string;
}
export interface DraftPdfAttachment { id: string; filename: string; data: string }
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
  text: string;
  images: ImageAttachment[];
  materials: ThreadMaterialAttachment[];
  model?: ThreadModel;
  inputMode: 'boundary' | 'interrupt' | 'next_run';
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
}
export const EMPTY_THREAD_DRAFT: ThreadDraft = Object.freeze({ text: '', images: [], materials: [], inputMode: 'boundary', preparedSource: null });
/** Composer state only; accepted execution and history remain with the native Catalog. Never persisted. */
export const useThreadDraftStore = create<{
  drafts: Record<string, ThreadDraft>;
  patch(key: string, patch: Partial<ThreadDraft> | ((draft: ThreadDraft) => Partial<ThreadDraft>)): void;
  remove(key: string): void;
}>((set) => ({
  drafts: {},
  patch: (key, patch) => set(state => {
    const draft = state.drafts[key] ?? { ...EMPTY_THREAD_DRAFT,
      inputMode: useMessageQueueStore.getState().followUpBehavior === 'queue' ? 'next_run' as const : 'boundary' as const };
    return { drafts: { ...state.drafts, [key]: { ...draft, ...(typeof patch === 'function' ? patch(draft) : patch) } } };
  }),
  remove: key => set(state => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts }; }),
}));
