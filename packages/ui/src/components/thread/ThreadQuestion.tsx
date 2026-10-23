import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { readUserQuestions, userAnswerText, userQuestionAnswered, type Operation, type QuestionAnswer } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { newQuestionDraft, useQuestionDraftStore } from '@/stores/useQuestionDraftStore';

export function ThreadQuestion({ scopeKey, operation, enabled, onAnswer, onCancel, onRead }: {
  scopeKey: string;
  operation: Operation;
  enabled: boolean;
  onAnswer(answers: QuestionAnswer[]): Promise<Operation>;
  onRead(): Promise<Operation>;
  onCancel(): Promise<Operation>;
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
  const view = draft.review ? 'review' : String(draft.index);
  React.useLayoutEffect(() => { if (body.current) body.current.scrollTop = draft.scroll[view] ?? 0; }, [key, view]);
  const active = questions[draft.index] ?? questions[0];
  if (!active || operation.phase === 'terminal') return null;
  const answer = draft.answers[active.id] ?? { questionId: active.id, selectedOptionIds: [], text: '' };
  const locked = !enabled || draft.busy || Boolean(draft.intent) || Boolean(draft.cancelIntent) || draft.submitted;
  const ready = questions.every(q => !q.required || userQuestionAnswered(draft.answers[q.id]));
  const count = questions.filter(q => userQuestionAnswered(draft.answers[q.id])).length;
  const change = (value: Partial<QuestionAnswer>) => patch({ answers: { ...draft.answers, [active.id]: { ...answer, ...value } }, error: undefined });
  const move = (index: number, review = false) => patch({ index: Math.max(0, Math.min(index, questions.length - 1)), review });
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
  return <form className="thread-question-form" aria-labelledby={questionId} onSubmit={event => { event.preventDefault(); void act(); }}>
    {questions.length > 1 && <nav className="thread-question-nav" aria-label={t('chat.question.navigation')}>
      {questions.map((q, index) => <button key={q.id} type="button" disabled={draft.busy} aria-current={!draft.review && draft.index === index ? 'step' : undefined}
        aria-label={t('chat.question.number', { number: index + 1 })} onClick={() => move(index)}>
        {userQuestionAnswered(draft.answers[q.id]) && <Icon name="check" className="size-3" />}{index + 1}
      </button>)}
      <button type="button" disabled={draft.busy} aria-current={draft.review ? 'step' : undefined} onClick={() => move(draft.index, true)}>{t('chat.question.review')}</button>
      <span>{t('chat.question.progress', { count, total: questions.length })}</span>
    </nav>}
    <div ref={body} className="thread-question-body" onScroll={event => {
      const current = useQuestionDraftStore.getState().drafts[key];
      if (current) patch({ scroll: { ...current.scroll, [view]: event.currentTarget.scrollTop } });
    }}>
      {draft.review ? <div aria-label={t('chat.question.review')} id={questionId}>
        {questions.map((q, index) => <section key={q.id} className="thread-question-review">
          <header><p>{q.question}</p><button type="button" disabled={draft.busy} onClick={() => move(index)}>{t('common.edit')}</button></header>
          <p className="text-muted-foreground">{userAnswerText(q, draft.answers[q.id]) || t(q.required ? 'chat.question.unanswered' : 'chat.question.skipped')}</p>
        </section>)}
      </div> : <>
        <h3 id={questionId}>{active.question}</h3>
        <p className="thread-question-hint">{t(active.options.length ? active.selection === 'multiple' ? 'chat.question.multiple' : 'chat.question.single' : 'chat.question.free')}{!active.required && <> · {t('chat.question.optional')}</>}</p>
        {active.options.length > 0 && <div className="tool-question-options" role={active.selection === 'multiple' ? 'group' : 'radiogroup'} aria-labelledby={questionId}>
          {active.options.map(option => <label key={option.id} className="tool-question-option" data-selected={answer.selectedOptionIds.includes(option.id)}>
            <input type={active.selection === 'multiple' ? 'checkbox' : 'radio'} name={questionId} value={option.id} disabled={locked}
              checked={answer.selectedOptionIds.includes(option.id)} onChange={event => change({ selectedOptionIds: active.selection === 'single' ? [option.id]
                : event.target.checked ? [...answer.selectedOptionIds, option.id] : answer.selectedOptionIds.filter(id => id !== option.id) })} />
            <span>{option.label}</span>
          </label>)}
        </div>}
        {answer.selectedOptionIds.length > 0 && <button type="button" className="tool-text-button" disabled={locked} onClick={() => change({ selectedOptionIds: [] })}>{t('chat.tools.clearChoice')}</button>}
        <Textarea aria-label={t('chat.questionCard.yourAnswer')} placeholder={t('chat.question.freeHint')} disabled={locked} value={answer.text}
          onChange={event => change({ text: event.target.value })} className="thread-question-text" />
      </>}
    </div>
    {draft.error && <div className="thread-question-error" role="alert"><p>{t(draft.intent || draft.cancelIntent ? 'chat.question.uncertain' : 'chat.question.failed')}</p><p>{draft.error}</p></div>}
    {!enabled && <p className="thread-question-hint px-4">{t('chat.question.waiting')}</p>}
    <footer className="thread-question-actions">
      {questions.length > 1 && !draft.review && <>
        <Button type="button" variant="ghost" size="sm" disabled={draft.busy || !draft.index} onClick={() => move(draft.index - 1)}>{t('chat.question.previous')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={draft.busy} onClick={() => move(draft.index + 1, draft.index === questions.length - 1)}>{t(draft.index === questions.length - 1 ? 'chat.question.review' : 'chat.question.next')}</Button>
      </>}
      <span className="flex-1" />
      <Button type="button" variant="ghost" size="sm" disabled={!enabled || draft.busy || Boolean(draft.intent)} onClick={() => void act(true)}>{t(draft.cancelIntent ? 'chat.question.confirmReceipt' : 'chat.question.cancel')}</Button>
      <Button type="submit" size="sm" disabled={!enabled || draft.busy || Boolean(draft.cancelIntent) || !ready && !draft.intent}>
        {draft.busy && <Icon name="loader-4" className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {t(draft.intent && !draft.busy ? 'chat.question.confirmReceipt' : questions.length > 1 ? 'chat.question.submitAll' : 'chat.questionCard.submit')}
      </Button>
    </footer>
  </form>;
}
