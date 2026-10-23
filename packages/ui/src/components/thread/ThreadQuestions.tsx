import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { readUserQuestions, type Operation, type QuestionAnswer } from '@varin/protocol';
import { ThreadQuestion } from './ThreadQuestion';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useQuestionDraftStore } from '@/stores/useQuestionDraftStore';

/** Layout-owned, nonmodal question dock. The composer remains a separate input. */
export function ThreadQuestions({ scopeKey, operations, enabled, onAnswer, onCancel, onRead, revealKey, revealOperationId }: {
  scopeKey: string;
  revealKey?: number;
  revealOperationId?: string;
  operations: Operation[];
  enabled(operation: Operation): boolean;
  onCancel(operation: Operation): Promise<Operation>;
  onRead(operation: Operation): Promise<Operation>;
  onAnswer(operation: Operation, answers: QuestionAnswer[]): Promise<Operation>;
}) {
  const { t } = useI18n(), reduced = usePrefersReducedMotion();
  const [hidden, setHidden] = React.useState(false);
  const [selected, setSelected] = React.useState<string>();
  const dock = React.useRef<HTMLElement>(null), reopen = React.useRef<HTMLButtonElement>(null);
  const returnFocus = React.useRef(false);
  React.useEffect(() => { if (revealKey) { setHidden(false); if (revealOperationId) setSelected(revealOperationId); } }, [revealKey, revealOperationId]);
  const questions = operations.filter(operation => operation.executor === 'ask_user' && operation.phase !== 'terminal');
  const current = questions.find(operation => operation.id === selected) ?? questions.find(enabled) ?? questions[0];
  React.useEffect(() => {
    for (const operation of operations) if (operation.executor === 'ask_user' && operation.phase === 'terminal') {
      useQuestionDraftStore.getState().release(JSON.stringify([scopeKey, operation.id]));
    }
  }, [operations, scopeKey]);
  const close = () => { returnFocus.current = Boolean(dock.current?.contains(document.activeElement)); setHidden(true); };
  const transition = { duration: reduced ? 0 : .2, ease: [.22, 1, .36, 1] as const };
  return <div className="chat-input-column thread-questions" onKeyDown={event => {
    if (event.key === 'Escape' && !hidden) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <AnimatePresence initial={false} mode="wait">
      {current && (hidden ? <motion.button key="reopen" ref={reopen} type="button" className="thread-question-reopen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}
        onAnimationComplete={() => { if (returnFocus.current) { reopen.current?.focus({ preventScroll: true }); returnFocus.current = false; } }}
        onClick={() => setHidden(false)}><Icon name="question" className="size-4" /><span>{t('chat.questionCard.inputNeeded')}{questions.length > 1 && <> · {questions.length}</>}</span><Icon name="arrow-up-s" className="size-4" /></motion.button>
        : <motion.section key="questions" ref={dock} className="thread-question-dock" aria-label={t('chat.questionCard.inputNeeded')}
          initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>
          <header className="thread-question-header"><Icon name="question" className="size-4" /><span>{t('chat.questionCard.inputNeeded')}</span>
            <button type="button" aria-label={t('chat.question.fold')} title={t('chat.question.fold')} onClick={close}><Icon name="arrow-down-s" className="size-4" /></button>
          </header>
          {questions.length > 1 && <select className="thread-question-requests" aria-label={t('chat.question.requests')} value={current.id} onChange={event => setSelected(event.target.value)}>
            {questions.map((operation, index) => <option key={operation.id} value={operation.id}>{index + 1} / {questions.length} · {readUserQuestions((operation.intent as { call?: { arguments?: unknown } })?.call?.arguments)[0]?.question}</option>)}
          </select>}
          <ThreadQuestion key={current.id} scopeKey={scopeKey} operation={current} enabled={enabled(current)} onAnswer={answers => onAnswer(current, answers)}
            onCancel={() => onCancel(current)} onRead={() => onRead(current)} />
        </motion.section>)}
    </AnimatePresence>
  </div>;
}
