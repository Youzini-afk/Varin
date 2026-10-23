import { create } from 'zustand';
import type { QuestionAnswer, UserQuestion } from '@varin/protocol';

export interface QuestionDraft {
  answers: Record<string, QuestionAnswer>;
  index: number;
  review: boolean;
  scroll: Record<string, number>;
  busy: boolean;
  submitted: boolean;
  cancelled?: boolean;
  closed?: boolean;
  cancelIntent?: boolean;
  intent?: QuestionAnswer[];
  error?: string;
}
export function newQuestionDraft(questions: readonly UserQuestion[]): QuestionDraft {
  return { answers: Object.fromEntries(questions.map(q => [q.id, { questionId: q.id, selectedOptionIds: [], text: '' }])),
    index: 0, review: false, scroll: {}, busy: false, submitted: false };
}
/** Memory-only drafts, keyed by Host/Thread/branch and original Operation. */
export const useQuestionDraftStore = create<{
  drafts: Record<string, QuestionDraft>;
  ensure(key: string, draft: QuestionDraft): void;
  patch(key: string, patch: Partial<QuestionDraft>): void;
  release(key: string): void;
}>((set) => ({
  drafts: {},
  ensure: (key, draft) => set(state => state.drafts[key] ? state : { drafts: { ...state.drafts, [key]: draft } }),
  patch: (key, patch) => set(state => state.drafts[key] ? { drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...patch } } } : state),
  release: key => set(state => { if (!state.drafts[key]) return state; const drafts = { ...state.drafts }; delete drafts[key]; return { drafts }; }),
}));
