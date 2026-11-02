import type {
  ExternalInteraction,
  ExternalInteractionResponse,
} from '@varin/application-client';
import { record, text, type RecordValue } from './transport.js';

export type AcpInteraction = {
  request: Omit<ExternalInteraction, 'turnId'>;
  reply(response: ExternalInteractionResponse): unknown;
  cancelled: unknown;
};

export function acpPermission(
  id: string,
  params: RecordValue,
): AcpInteraction | undefined {
  const options = (Array.isArray(params.options) ? params.options : []).flatMap(
    (value) => {
      const row = record(value);
      return text(row.optionId) && typeof row.name === 'string'
        ? [{ id: text(row.optionId), label: row.name }]
        : [];
    },
  );
  if (!options.length) return undefined;
  const cancelled = { outcome: { outcome: 'cancelled' } };
  return {
    request: {
      id,
      kind: 'permission',
      title: text(record(params.toolCall).title) || 'Permission requested',
      options,
      ...(record(params.toolCall).rawInput === undefined
        ? {}
        : {
            detail: JSON.stringify(record(params.toolCall).rawInput, null, 2),
          }),
    },
    cancelled,
    reply: (response) =>
      !response.cancelled &&
      options.some((option) => option.id === response.optionId)
        ? { outcome: { outcome: 'selected', optionId: response.optionId } }
        : cancelled,
  };
}

export { formInteraction as acpForm } from './interaction-form.js';

export function grokInteraction(
  id: string,
  method: string,
  params: RecordValue,
): AcpInteraction | undefined {
  if (method === 'x.ai/exit_plan_mode')
    return {
      request: {
        id,
        kind: 'permission',
        title: 'Approve implementation of this plan?',
        detail: text(params.planContent),
        options: [
          { id: 'approved', label: 'Approve implementation' },
          { id: 'keep_planning', label: 'Keep planning' },
        ],
      },
      cancelled: { outcome: 'keep_planning', feedback: '' },
      reply: (response) => ({
        outcome:
          !response.cancelled && response.optionId === 'approved'
            ? 'approved'
            : 'keep_planning',
        feedback: '',
      }),
    };
  if (
    method !== 'x.ai/ask_user_question' ||
    !Array.isArray(params.questions) ||
    !params.questions.length
  )
    return undefined;
  const questions = params.questions.map(record);
  if (
    questions.some(
      (question) =>
        !text(question.question) || !Array.isArray(question.options),
    )
  )
    return undefined;
  if (
    new Set(questions.map((question) => question.question)).size !==
    questions.length
  )
    return undefined;
  return {
    request: {
      id,
      kind: 'question',
      title: 'Grok question',
      options: [],
      questions: questions.map((question, index) => ({
        id: `q${index}`,
        question: text(question.question),
        multiple: question.multiSelect === true,
        options: (question.options as unknown[]).map((option) => ({
          label: text(record(option).label),
          ...(typeof record(option).description === 'string'
            ? { description: text(record(option).description) }
            : {}),
        })),
      })),
    },
    cancelled: { outcome: 'skip_interview' },
    reply(response) {
      if (response.cancelled) return { outcome: 'skip_interview' };
      const answers: Record<string, string | string[]> = Object.create(null);
      const annotations: Record<string, { notes: string }> =
        Object.create(null);
      for (const [index, question] of questions.entries()) {
        const selected = response.answers?.[`q${index}`];
        if (
          !selected?.length ||
          selected.some(
            (value) => typeof value !== 'string' || !value.trim(),
          ) ||
          new Set(selected).size !== selected.length
        )
          return { outcome: 'skip_interview' };
        const offered = selected.filter((value) =>
          (question.options as unknown[]).some(
            (option) => record(option).label === value,
          ),
        );
        const notes = selected.filter((value) => !offered.includes(value));
        if (
          (question.multiSelect !== true && offered.length > 1) ||
          notes.length > 1
        )
          return { outcome: 'skip_interview' };
        // Grok distinguishes chosen labels from free-text annotations, including a standalone Other answer.
        const values = offered.length ? offered : ['Other'];
        answers[text(question.question)] =
          question.multiSelect === true ? values : values[0]!;
        if (notes.length)
          annotations[text(question.question)] = { notes: notes[0]! };
      }
      return {
        outcome: 'accepted',
        answers,
        partial_answers: {},
        ...(Object.keys(annotations).length ? { annotations } : {}),
      };
    },
  };
}
