import React from 'react';
import { createPortal } from 'react-dom';
import type { Operation } from '@varin/protocol';
import { ThreadQuestion } from './ThreadQuestion';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

/** Pending native Operations stay answerable after the popup is folded. */
export function ThreadQuestions({ operations, enabled, onAnswer, onCancel }: {
  operations: Operation[]; enabled(operation: Operation): boolean;
  onCancel(operation: Operation): Promise<unknown>;
  onAnswer(operation: Operation, answer: string): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set());
  const questions = operations.filter(operation => operation.executor === 'ask_user' && operation.phase !== 'terminal');
  const open = questions.filter(operation => !hidden.has(operation.id));
  if (!questions.length) return null;
  return <>
    {!open.length && <button type="button" className="chat-input-column mb-2 flex items-center gap-2 typography-meta text-primary" onClick={() => setHidden(new Set())}><Icon name="question" className="size-4" />{t('chat.questionCard.inputNeeded')}</button>}
    {createPortal(<section hidden={!open.length} role="region" aria-label={t('chat.questionCard.inputNeeded')} className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl border border-border bg-background px-4 py-3 shadow-xl animate-in slide-in-from-bottom-3">
      <header className="mb-3 flex items-center gap-2"><Icon name="question" className="size-4 text-primary" /><span className="min-w-0 flex-1 typography-ui-label font-medium">{t('chat.questionCard.inputNeeded')}</span>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-interactive-hover" aria-label={t('chat.context.close')} onClick={() => setHidden(new Set(questions.map(question => question.id)))}><Icon name="close" className="size-4" /></button>
      </header>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto">{questions.map(operation => <div key={operation.id} hidden={hidden.has(operation.id)}><ThreadQuestion operation={operation} enabled={enabled(operation)} onAnswer={answer => onAnswer(operation, answer)} onCancel={() => onCancel(operation)} /></div>)}</div>
    </section>, document.body)}
  </>;
}
