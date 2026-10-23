import type { QuestionAnswer } from './agent-runtime.generated.js';

export interface UserQuestion {
  id: string;
  question: string;
  options: { id: string; label: string }[];
  selection: 'single' | 'multiple';
  required: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read projection only; the original question's runtime validates submissions. */
export function readUserQuestions(argumentsValue: unknown): UserQuestion[] {
  const args = record(argumentsValue);
  if (Array.isArray(args.questions)) return args.questions.flatMap(value => {
    const q = record(value);
    if (typeof q.id !== 'string' || typeof q.question !== 'string') return [];
    const options = Array.isArray(q.options) ? q.options.flatMap(value => {
      const option = record(value);
      return typeof option.id === 'string' && typeof option.label === 'string' ? [{ id: option.id, label: option.label }] : [];
    }) : [];
    return [{ id: q.id, question: q.question, options, selection: q.selection === 'multiple' ? 'multiple' as const : 'single' as const, required: q.required !== false }];
  });
  // Historical single-question calls keep their original text; this does not
  // admit the retired shape to the current tool or answer API.
  return typeof args.question === 'string' ? [{ id: 'question', question: args.question,
    options: Array.isArray(args.options) ? args.options.flatMap((label, index) => typeof label === 'string' ? [{ id: String(index), label }] : []) : [],
    selection: 'single', required: true }] : [];
}
export function userQuestionAnswered(answer: QuestionAnswer | undefined): boolean {
  return Boolean(answer && (answer.selectedOptionIds.length || answer.text.trim()));
}
export function userAnswerText(question: UserQuestion, answer: QuestionAnswer | undefined): string {
  if (!answer) return '';
  return [...question.options.filter(option => answer.selectedOptionIds.includes(option.id)).map(option => option.label), answer.text].filter(Boolean).join('\n');
}
