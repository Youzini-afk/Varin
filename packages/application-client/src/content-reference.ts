import type { AttachmentSelection } from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';
import type { ChatMemoryPassage } from './chat-memory.js';
/** Frozen user-selected content. Source owners keep their own readable identities.
 * Source metadata is for history/navigation, never model instructions or resource authority. */
export interface ContentReference {
  ref: string;
  title: string;
  /** Message-local quote number. Reordering occurrences never changes this identity. */
  number?: number;
  /** Human-readable author or content kind, without internal source locators. */
  label?: string;
  text?: string;
  image?: { mimeType: string; data: string };
  /** Binding to the same input's original media owner after image preparation. */
  imageReference?: number;
  /** The existing attachment owner fixes this selection before input admission. */
  attachment?: AttachmentSelection;
  /** Original prepared attachment identity, never a path-derived grant. */
  attachmentRef?: string;
  source:
    | { kind: 'ui'; snapshotRef: string; thread?: ThreadIdentity; itemId?: string; viewRef?: string; revisionRef?: string; previewCallId?: string; region?: { x: number; y: number; width: number; height: number } }
    | { kind: 'object'; thread: ThreadIdentity; objectRef: string; capturedAt: string; state?: string }
    | { kind: 'chat'; thread: ThreadIdentity; itemId?: string; passages: ChatMemoryPassage[]; href?: string; capturedAt?: string; streaming?: boolean; role?: 'assistant' | 'user' | 'tool' }
    | { kind: 'document'; snapshotId: string; sourceHash: string; page: number; region?: { x: number; y: number; width: number; height: number } }
    | { kind: 'file'; thread: ThreadIdentity; path: string; capturedAt?: string }
    | { kind: 'tool'; thread: ThreadIdentity; itemId?: string; toolCallId: string; operationId?: string; name: string; status: 'running' | 'background' | 'waiting' | 'unknown' | 'success' | 'error' | 'cancelled'; capturedAt: string };
}
/** Explicit bound occurrences in the original draft's UTF-16 coordinates. Plain text
 * with a marker's spelling never acquires a binding. Images use their frozen input number. */
export type ContentReferenceOccurrence =
  | { kind: 'content'; ref: string; start: number; end: number }
  | { kind: 'image'; reference: number; start: number; end: number };
export interface ContentReferenceInput {
  contentReferences?: ContentReference[];
  contentReferenceOccurrences?: ContentReferenceOccurrence[];
}
