import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export interface TreeNavigation {
  token: string;
  kind: 'reveal' | 'recover';
  entryId: string;
  runId: string;
  source?: import('@/components/conversation/ReferenceNavigation').ReferenceSourceTarget;
}
interface TreeView {
  expanded: Record<string, boolean>;
  scrollTop: number;
  selected?: string;
}
interface TreeStore {
  views: Record<string, TreeView>;
  navigation: Record<string, TreeNavigation>;
  setView(key: string, patch: Partial<TreeView>): void;
  request(key: string, command: Omit<TreeNavigation, 'token'>): void;
  consume(key: string, token: string): void;
}
export const EMPTY_TREE_VIEW: TreeView = { expanded: {}, scrollTop: 0 };
/** Presentation choices and explicit navigation intents; no conversation data is persisted. */
export const useConversationTreeStore = create<TreeStore>()(persist((set) => ({
  views: {}, navigation: {},
  setView: (key, patch) => set(state => ({ views: { ...state.views, [key]: { ...(state.views[key] ?? EMPTY_TREE_VIEW), ...patch } } })),
  request: (key, command) => set(state => ({ navigation: { ...state.navigation, [key]: { ...command, token: crypto.randomUUID() } } })),
  consume: (key, token) => set(state => {
    if (state.navigation[key]?.token !== token) return state;
    const navigation = { ...state.navigation };
    delete navigation[key];
    return { navigation };
  }),
}), { name: 'varin.conversationTree.v1', storage: createDeferredSafeJSONStorage(), partialize: state => ({ views: state.views }) }));
