import type { ThreadIdentity } from '@varin/application-client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

/** Navigation metadata only. Catalog remains the execution/history authority. */
export interface ReviewThreadLink {
  directory: string;
  original: ThreadIdentity;
  review: ThreadIdentity;
  hostKey: string;
}
export const reviewLinkKey = (hostKey: string, identity: ThreadIdentity): string => (
  JSON.stringify([hostKey, identity.threadId, identity.branchId])
);
interface ReviewFlowState {
  linksByOriginal: Record<string, ReviewThreadLink>;
  upsertLink(link: ReviewThreadLink): void;
}
export const useReviewFlowStore = create<ReviewFlowState>()(persist(set => ({
  linksByOriginal: {},
  upsertLink: link => set(state => ({ linksByOriginal: {
    ...state.linksByOriginal, [reviewLinkKey(link.hostKey, link.original)]: link,
  } })),
}), {
  // Older session links are user assets; they are neither read nor imported.
  name: 'varin-thread-review-links', storage: createDeferredSafeJSONStorage(),
  partialize: state => ({ linksByOriginal: state.linksByOriginal }),
}));
