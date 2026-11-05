import React from 'react';
import type { OperationCancellationReceipt } from '@varin/protocol';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { readUserQuestions, userQuestionAnswered, type Operation, type QuestionAnswer } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { QuestionChoices, QuestionSupplement } from '@/components/ui/question-controls';
import { documentMotionLevel } from '@/lib/motion/preference';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { newQuestionDraft, useQuestionDraftStore } from '@/stores/useQuestionDraftStore';

export function ThreadQuestion({ scopeKey, operation, enabled, onAnswer, onCancel, onRead }: {
  scopeKey: string;
  operation: Operation;
  enabled: boolean;
  onAnswer(answers: QuestionAnswer[]): Promise<Operation>;
  onRead(): Promise<Operation>;
  onCancel(): Promise<OperationCancellationReceipt>;
}) {
  const { t } = useI18n();
  const args = (operation.intent as { call?: { arguments?: unknown } })?.call?.arguments;
  const questions = React.useMemo(() => readUserQuestions(args), [args]);
  const key = JSON.stringify([scopeKey, operation.id]);
  const initial = React.useMemo(() => newQuestionDraft(questions), [questions]);
  const draft = useQuestionDraftStore(state => state.drafts[key] ?? initial);
  const patch = (value: Partial<typeof draft>) => useQuestionDraftStore.getState().patch(key, value);
  React.useLayoutEffect(() => { useQuestionDraftStore.getState().ensure(key, initial); }, [key, initial]);
  const body = React.useRef<HTMLDivElement>(null);
  const questionId = React.useId();
  React.useLayoutEffect(() => { if (body.current) body.current.scrollTop = useQuestionDraftStore.getState().drafts[key]?.scrollTop ?? 0; }, [key]);
  if (!questions.length || operation.phase === 'terminal') return null;
  const locked = !enabled || draft.busy || Boolean(draft.intent) || Boolean(draft.cancelIntent) || draft.submitted;
  const ready = questions.every(q => !q.required || userQuestionAnswered(draft.answers[q.id]));
  const count = questions.filter(q => userQuestionAnswered(draft.answers[q.id])).length;
  const change = (questionId: string, value: Partial<QuestionAnswer>) => {
    const current = useQuestionDraftStore.getState().drafts[key] ?? draft;
    const previous = current.answers[questionId] ?? { questionId, selectedOptionIds: [], text: '' };
    patch({ answers: { ...current.answers, [questionId]: { ...previous, ...value } }, error: undefined });
  };
  const move = (index: number) => {
    patch({ index });
    const target = document.getElementById(`${questionId}:${questions[index]!.id}`);
    target?.scrollIntoView({ block: 'nearest', behavior: documentMotionLevel() === 'full' ? 'smooth' : 'auto' });
    target?.focus({ preventScroll: true });
  };
  const act = async (cancel = false) => {
    const current = useQuestionDraftStore.getState().drafts[key];
    if (cancel && current?.intent) return;
    cancel = Boolean(current?.cancelIntent) || cancel;
    if (!enabled || !current || current.busy || current.submitted || !cancel && !current.intent && !ready) return;
    const intent = current.intent ?? questions.map(q => ({ ...current.answers[q.id], skipped: !userQuestionAnswered(current.answers[q.id]) }));
    const host = getRuntimeEndpointGeneration();
    patch({ busy: true, error: undefined, ...(cancel ? { cancelIntent: true } : { intent }) });
    try {
      // Observe an uncertain original before reusing its exact answer. Equal
      // native answer admission returns the original receipt.
      const observed = current.intent || current.cancelIntent ? await onRead() : undefined;
      if (host !== getRuntimeEndpointGeneration()) throw new DOMException('Host changed while confirming the original question', 'AbortError');
      const receipt = observed?.phase === 'terminal' ? observed
        : cancel ? await onCancel() : await onAnswer(intent);
      if (receipt.phase !== 'terminal') throw new Error(t('chat.question.uncertain'));
      patch({ submitted: true, cancelled: receipt.outcome === 'cancelled', closed: receipt.outcome !== 'succeeded' && receipt.outcome !== 'cancelled', intent: undefined, cancelIntent: undefined });
    } catch (failure) {
      const status = Number((failure as { status?: unknown })?.status);
      const rejected = status >= 400 && status < 500 && status !== 408;
      patch({ error: failure instanceof Error ? failure.message : String(failure), ...(rejected ? { intent: undefined, cancelIntent: undefined } : {}) });
    } finally { patch({ busy: false }); }
  };
  if (draft.submitted) return <p className="thread-question-receipt" role="status">{t(draft.closed ? 'chat.question.closed' : draft.cancelled ? 'chat.timeline.tools.cancelled' : 'chat.question.received')}</p>;
  return <form className="thread-question-form" aria-label={t('chat.questionCard.inputNeeded')} onSubmit={event => { event.preventDefault(); void act(); }}>
    {questions.length > 1 && <nav className="thread-question-nav" aria-label={t('chat.question.navigation')}>
      {questions.map((q, index) => <button key={q.id} type="button" disabled={draft.busy} aria-current={draft.index === index ? 'location' : undefined}
        aria-label={t('chat.question.number', { number: index + 1 })} onClick={() => move(index)}>
        {userQuestionAnswered(draft.answers[q.id]) && <Icon name="check" className="size-3" />}{index + 1}
      </button>)}
      <span>{t('chat.question.progress', { count, total: questions.length })}</span>
    </nav>}
    <div ref={body} className="thread-question-body" onScroll={event => {
      const current = useQuestionDraftStore.getState().drafts[key];
      if (current) patch({ scrollTop: event.currentTarget.scrollTop });
    }}>
      {questions.map((question, index) => {
        const answer = draft.answers[question.id] ?? { questionId: question.id, selectedOptionIds: [], text: '' };
        const fieldId = `${questionId}:${question.id}`;
        return <fieldset key={question.id} id={fieldId} tabIndex={-1} className="question-field" onFocusCapture={() => { if (draft.index !== index) patch({ index }); }}>
          <legend id={`${fieldId}:label`} className="question-field-title">{questions.length > 1 && <span className="question-field-number">{String(index + 1).padStart(2, '0')}</span>}<span>{question.question}</span>
            {(question.selection === 'multiple' || !question.required) && <span className="question-field-meta">{[question.selection === 'multiple' && t('ui.question.multiple'), !question.required && t('chat.question.optional')].filter(Boolean).join(' · ')}</span>}
          </legend>
          {question.options.length > 0 ? <>
            <QuestionChoices name={fieldId} labelledBy={`${fieldId}:label`} options={question.options} selected={answer.selectedOptionIds} multiple={question.selection === 'multiple'} disabled={locked}
              onChange={selectedOptionIds => change(question.id, { selectedOptionIds })} />
            <div className="question-response-tools"><QuestionSupplement value={answer.text} disabled={locked} onChange={text => change(question.id, { text })} />
              {answer.selectedOptionIds.length > 0 && <button type="button" className="question-clear" disabled={locked} onClick={() => change(question.id, { selectedOptionIds: [] })}>{t('chat.tools.clearChoice')}</button>}
            </div>
          </> : <textarea className="question-text-input" rows={2} aria-labelledby={`${fieldId}:label`} placeholder={t('chat.question.freeHint')} disabled={locked} value={answer.text}
            onInput={event => change(question.id, { text: event.currentTarget.value })} />}
        </fieldset>;
      })}
    </div>
    {draft.error && <div className="thread-question-error" role="alert"><p>{t(draft.intent || draft.cancelIntent ? 'chat.question.uncertain' : 'chat.question.failed')}</p><p>{draft.error}</p></div>}
    {!enabled && <p className="thread-question-hint px-4">{t('chat.question.waiting')}</p>}
    <footer className="thread-question-actions">
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="sm" disabled={!enabled || draft.busy || Boolean(draft.intent)} onClick={() => void act(true)}>{t(draft.cancelIntent ? 'chat.question.confirmReceipt' : 'chat.question.cancel')}</Button>
      <Button type="submit" size="sm" disabled={!enabled || draft.busy || Boolean(draft.cancelIntent) || !ready && !draft.intent}>
        {draft.busy && <Icon name="loader-4" className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {t(draft.intent && !draft.busy ? 'chat.question.confirmReceipt' : questions.length > 1 ? 'chat.question.submitAll' : 'chat.questionCard.submit')}
        {!draft.busy && <Icon name="arrow-up" className="size-3.5" aria-hidden="true" />}
      </Button>
    </footer>
  </form>;
}
