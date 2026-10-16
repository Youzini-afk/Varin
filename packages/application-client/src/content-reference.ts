import type { ThreadIdentity } from './threads.js';
import type { ChatMemoryPassage } from './chat-memory.js';
/** Frozen user-selected content. Source owners keep their own readable identities. */
export interface ContentReference {
  ref: string; title: string; text?: string; image?: { mimeType: string; data: string };
  source:
    | { kind: 'ui'; snapshotRef: string; thread?: ThreadIdentity; itemId?: string; viewRef?: string; revisionRef?: string; previewCallId?: string; region?: { x: number; y: number; width: number; height: number } }
    | { kind: 'chat'; thread: ThreadIdentity; itemId?: string; passages: ChatMemoryPassage[]; href?: string }
    | { kind: 'document'; snapshotId: string; sourceHash: string; page: number; region?: { x: number; y: number; width: number; height: number } };
}
