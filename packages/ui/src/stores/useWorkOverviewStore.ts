import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type OverviewDisclosure = 'overview' | 'mobile' | 'questions' | 'review' | 'plan' | 'outputs' | 'threads' | 'endedThreads' | 'sources' | 'memory';
type OverviewChoices = Partial<Record<OverviewDisclosure, boolean>>;

interface WorkOverviewStore {
  bySession: Record<string, OverviewChoices>;
  parentBySession: Record<string, { sessionId: string; directory?: string }>;
  setDisclosure: (key: string, disclosure: OverviewDisclosure, open: boolean) => void;
}

export const workOverviewStateKey = (runtimeKey: string, sessionId: string): string => (
  JSON.stringify([runtimeKey, sessionId])
);

export const EMPTY_WORK_OVERVIEW_CHOICES: OverviewChoices = {};

export const useWorkOverviewStore = create<WorkOverviewStore>()(
  persist(
    (set) => ({
      bySession: {},
      parentBySession: {},
      setDisclosure: (key, disclosure, open) => set((state) => {
        const current = state.bySession[key] ?? EMPTY_WORK_OVERVIEW_CHOICES;
        if (current[disclosure] === open) return state;
        return { bySession: { ...state.bySession, [key]: { ...current, [disclosure]: open } } };
      }),
    }),
    {
      name: 'varin.workOverview.v1',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ bySession: state.bySession }),
    },
  ),
);
