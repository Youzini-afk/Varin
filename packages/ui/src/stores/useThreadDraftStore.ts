import { create } from 'zustand';
import { ChangeSet, type EditorState } from '@codemirror/state';
import { mapComposerReferences } from '@/components/chat/composer/editor/references';
import type { ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { mapInteractionRanges, type InteractionRange } from '@/components/chat/composer/editor/interactionRanges';
import type { EditorContextAttachment } from '@/lib/agent-editor/types';
import type { InlineCommentDraft } from './useInlineCommentDraftStore';
import type { Attachment, ImageAttachment } from '@varin/protocol';
import type { ContentReference, ContentReferenceInput, ThreadAgentChoice, ThreadIdentity, ThreadModel, ThreadPrepareSource, ThreadPreparedSource, ThreadsAPI } from '@varin/application-client';

export type ThreadPendingInput = {
  fingerprint: string;
  editorText: string;
  editorImages?: readonly ImageAttachment[];
  fileIds?: readonly string[];
  selectedAttachmentIds?: readonly string[];
  goalObjective?: string;
  goalBudget?: number;
  editorContext?: readonly EditorContextAttachment[];
  markerObjectIds?: readonly string[];
  markerOccurrenceIds?: readonly string[];
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
  selection?: ThreadPrepareSource['selection'];
  /** Original project registration, checked after resolving the actual owner. */
  expectedWorkspaceId?: string;
  path: string;
  resourceOwner: ThreadPrepareSource['resourceOwner'];
  mode: ThreadPrepareSource['mode'];
  contentMode: ThreadPrepareSource['content']['mode'];
  captureScopes: string[];
}
export interface DraftSelectedAttachment { id: string; host: number; filename: string; selection: import('@varin/protocol').AttachmentSelection; sourceKey?: string; attachment?: Attachment }
export interface ThreadFirstSend extends ContentReferenceInput {
  imageObjects?: readonly ComposerMarkerObject[];
  attachmentImageReferences?: Record<string, number>;
  markerObjectIds?: readonly string[];
  markerOccurrenceIds?: readonly string[];
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
  /** Explicit chat-only source intent, distinct from omitted/inherited source. */
  sourceDisabled?: boolean;
  editorContext: readonly EditorContextAttachment[];
  inlineContext: ReadonlyArray<{ key: string; drafts: readonly InlineCommentDraft[] }>;
  goalObjective?: string;
  goalBudget?: number;
  status: 'sending' | 'failed';
  error?: string;
}
export interface ThreadDraft {
  /** Frozen at draft creation. Navigation moves never reselect this work's project/source. */
  organization?: import('@varin/application-client').ConversationOrganizationPlacement;
  projectId?: string;
  /** Original creation default consumed once; explicit source changes never reapply it. */
  creationDefaultsApplied?: boolean;
  botId?: string;
  /** Bound content and media objects share this draft's CodeMirror history. */
  markerObjects?: readonly ComposerMarkerObject[];
  editorState?: EditorState;
  /** Retain captures reachable through undo until this draft/history is released. */
  retainedContentReferences?: readonly ContentReference[];
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
  externalInputSnapshot?: { editorText: string; markerObjectIds?: readonly string[]; markerOccurrenceIds?: readonly string[]; images: readonly ImageAttachment[]; fileIds?: readonly string[] };
  externalModels?: Record<string, string>;
  externalOptions?: Record<string, { thinking?: string; mode?: string; config?: Record<string, string> }>;
  text: string;
  images: import('@/lib/images/annotations').EditableImageAttachment[];
  materials: ThreadMaterialAttachment[];
  /** Next-input selection. The active picker reads the Run, not this draft. */
  model?: ThreadModel;
  /** Consumed model transitions survive closing/reopening this in-memory draft. */
  modelObservation?: {
    preference?: { inheritWorkbench: boolean; model: ThreadModel | null };
    run?: { id: string; active: boolean; model: ThreadModel };
  };
  workFocus?: import('@varin/protocol').WorkFocusId;
  preparedSource: ThreadPreparedSource | null;
  workspacePath?: string;
  goalArmed?: boolean;
  pendingInput?: ThreadPendingInput;
  identity?: ThreadIdentity;
  files?: DraftFileAttachment[];
  firstSend?: ThreadFirstSend;
  /** Paint the accepted first input until its native history snapshot arrives. */
  firstMessageReceipt?: Pick<ThreadFirstSend, 'key' | 'text' | 'editorText' | 'images' | 'files' | 'selectedAttachments' | 'attachmentImageReferences' | 'contentReferences' | 'contentReferenceOccurrences'> & { inputId: string };
  sendError?: string;
  sourceSelection?: DraftSourceSelection;
  /** Explicit chat-only source intent, distinct from omitted/inherited source. */
  sourceDisabled?: boolean;
  /** Unsent collaboration input and exact per-recipient attempts, retained in memory only. */
  collaboration?: {
    afterCurrent?: boolean;
    targets: ThreadIdentity[];
    reply?: import('@varin/protocol').MessageFeedEntry;
    /** A receipt consumes the original editor batch, even after uncertain retry. */
    snapshot?: { editorText: string; markerObjectIds?: readonly string[]; markerOccurrenceIds?: readonly string[];
      images: readonly ImageAttachment[]; fileIds?: readonly string[]; selectedAttachmentIds?: readonly string[] };
    attempts?: Array<{ request: Parameters<NonNullable<ThreadsAPI['messages']>['send']>[1]; receipt?: import('@varin/protocol').MessageReceipt; error?: string }>;
    sending?: boolean;
  };
}
export function sameThreadModel(left: ThreadModel | null | undefined, right: ThreadModel | null | undefined): boolean {
  return left === right || Boolean(left && right && left.providerId === right.providerId && left.modelId === right.modelId
    && left.thinkingLevel === right.thinkingLevel && Object.is(left.temperature, right.temperature));
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
    if (typeof change.text === 'string' && change.text !== draft.text) {
      let from = 0, to = draft.text.length, end = change.text.length;
      while (from < to && from < end && draft.text[from] === change.text[from]) from++;
      while (to > from && end > from && draft.text[to - 1] === change.text[end - 1]) { to--; end--; }
      const changes = ChangeSet.of({ from, to, insert: change.text.slice(from, end) }, draft.text.length);
      if (change.interactions === undefined && draft.interactions?.length) next.interactions = mapInteractionRanges(draft.interactions, changes);
      if (change.references === undefined && draft.references?.length) next.references = mapComposerReferences(draft.references, changes);
    }
    if (change.markerObjects && change.markerObjects !== draft.markerObjects && change.retainedContentReferences === undefined) {
      const retained = new Map((draft.retainedContentReferences ?? []).map(reference => [reference.ref, reference]));
      for (const object of change.markerObjects) {
        const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference;
        if (reference) retained.set(reference.ref, reference);
      }
      next.retainedContentReferences = [...retained.values()];
    }
    if (change.images?.some(image => image.reference === undefined)) {
      let reference = Math.max(0, ...(next.files ?? []).map(file => file.imageReference ?? 0), ...change.images.map(image => image.reference ?? 0));
      next.images = change.images.map(image => image.reference === undefined ? { ...image, reference: ++reference } : image);
    }
    if (sameThreadModel(draft.model, next.model)) next.model = draft.model;
    // Empty/unchanged updates are observations, not new draft generations.
    if (state.drafts[key] && Object.keys(next).every(key => Object.is(draft[key as keyof ThreadDraft], next[key as keyof ThreadDraft]))) return state;
    return { drafts: { ...state.drafts, [key]: next } };
  }),
  remove: key => set(state => { const drafts = { ...state.drafts }; delete drafts[key]; return { drafts }; }),
}));
