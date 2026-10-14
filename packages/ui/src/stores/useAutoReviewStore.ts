import type { InputSubmitReceipt } from '@varin/protocol';
import type { ThreadIdentity, ThreadModel, ThreadSource, ThreadSubmit, ThreadUpdate } from '@varin/application-client';
import { create } from 'zustand';

export interface ReviewCommand {
  input: ThreadSubmit;
  status: 'sending' | 'unknown' | 'accepted' | 'rejected';
  receipt?: InputSubmitReceipt;
}
export interface AutoReviewRun {
  key: string;
  hostKey: string;
  hostGeneration: number;
  original: ThreadIdentity;
  review?: ThreadIdentity;
  directory: string;
  source: ThreadSource;
  originalModel: ThreadModel;
  reviewModel: ThreadModel;
  originalHead: string | null;
  reviewHead: string | null;
  createKey: string;
  reviewTitle: string;
  titleCommand?: ThreadUpdate;
  reviewTitled?: boolean;
  autoReview: boolean;
  generateHandoff: boolean;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  phase: 'creating_review' | 'handoff' | 'review' | 'implementation';
  iteration: number;
  maxIterations: number;
  prompt: string;
  command?: ReviewCommand;
  error?: string;
}
interface AutoReviewState {
  runs: Record<string, AutoReviewRun>;
  put(run: AutoReviewRun): void;
  update(key: string, patch: Partial<AutoReviewRun>): void;
  stopAll(): void;
}
/** Transient UI coordination only. Accepted commands and runs live in the native Catalog.
 * Reloading does not restart forwarding or replay uncertain commands. */
export const useAutoReviewStore = create<AutoReviewState>(set => ({
  runs: {},
  put: run => set(state => ({ runs: { ...state.runs, [run.key]: run } })),
  update: (key, patch) => set(state => state.runs[key] ? { runs: {
    ...state.runs, [key]: { ...state.runs[key], ...patch },
  } } : state),
  stopAll: () => set(state => ({ runs: Object.fromEntries(Object.entries(state.runs).map(([key, run]) => [key,
    run.status === 'running' || run.status === 'paused' ? { ...run, status: 'stopped', error: 'Application Host changed. Accepted work remains with its original Host.' } : run,
  ])) })),
}));
