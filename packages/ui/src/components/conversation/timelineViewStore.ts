import { create } from 'zustand';
import {
  DEFAULT_CHAT_TIMELINE_VIEW, cancelChatTimelineAutomation, completeChatTimelineReturn,
  requestChatTimelineReturn, saveChatTimelineCheckpoint, prepareChatTimelineEntry,
  armChatTimelineTurn, type ChatTimelineViewState, type ChatTimelineViewportAnchor,
} from './chatTimelineScrollState';

interface TimelineViewStore {
  views: Record<string, ChatTimelineViewState>;
  enter(key: string, head: string | null, working: boolean): void;
  anchor(key: string, entryId: string): void;
  cancelTimelineAutomation(key: string): void;
  completeTimelineReturn(key: string, token: number): void;
  requestTimelineReturn(key: string): number;
  saveTimelineCheckpoint(key: string, epoch: number, head: string | null, viewport?: ChatTimelineViewportAnchor): void;
}

/** Scroll and viewport state only; it never owns conversation or execution state. */
export const useTimelineViewStore = create<TimelineViewStore>((set, get) => {
  const update = (key: string, transform: (view: ChatTimelineViewState) => ChatTimelineViewState | undefined) => set(state => {
    const next = transform(state.views[key] ?? DEFAULT_CHAT_TIMELINE_VIEW);
    return next ? { views: { ...state.views, [key]: next } } : state;
  });
  return {
    views: {},
    enter: (key, leafId, working) => update(key, view => prepareChatTimelineEntry(view, { leafId, working, hasAttention: false, hasLiveOverlay: false })),
    anchor: (key, id) => update(key, view => armChatTimelineTurn(view, id, `turn:${id}`)),
    cancelTimelineAutomation: key => update(key, cancelChatTimelineAutomation),
    completeTimelineReturn: (key, token) => update(key, view => completeChatTimelineReturn(view, token)),
    requestTimelineReturn: key => {
      const result = requestChatTimelineReturn(get().views[key]);
      update(key, () => result.view);
      return result.token;
    },
    saveTimelineCheckpoint: (key, epoch, head, viewport) => update(key, view => saveChatTimelineCheckpoint(view, epoch, head, viewport)),
  };
});
