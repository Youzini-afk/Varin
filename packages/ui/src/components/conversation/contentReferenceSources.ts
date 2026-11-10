import type { ContentReference, ThreadIdentity } from '@varin/application-client';
import type { ReferenceSourceTarget } from './ReferenceNavigation';

export interface ContentReferenceSourceTarget extends ReferenceSourceTarget { thread: ThreadIdentity }
/** Every passage retains its own real message. There is no inferred reply parent. */
export function contentReferenceSources(reference: ContentReference): ContentReferenceSourceTarget[] {
  const source = reference.source;
  if (source.kind === 'chat') {
    const passages = source.passages.map(passage => ({ thread: source.thread, entryId: passage.entryId,
      start: passage.start, end: passage.start + passage.text.length, text: passage.text }));
    return passages.length ? passages : source.itemId ? [{ thread: source.thread, entryId: source.itemId }] : [];
  }
  if (source.kind === 'tool' && source.itemId) return [{ thread: source.thread, entryId: source.itemId, toolCallId: source.toolCallId }];
  if (source.kind === 'ui' && source.thread && source.itemId) return [{ thread: source.thread, entryId: source.itemId, viewRef: source.viewRef, revisionRef: source.revisionRef, toolCallId: source.previewCallId }];
  return [];
}
export function sameReferenceThread(left: ThreadIdentity, right: ThreadIdentity): boolean {
  return left.runtime === right.runtime && left.threadId === right.threadId && left.branchId === right.branchId;
}
