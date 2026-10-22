import React from 'react';
import type { Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';

/** Questions are projected from the Operation; the component owns only the unsent draft. */
export function ThreadQuestion({ operation, enabled, onAnswer, onCancel }: {
  operation: Operation; enabled: boolean; onAnswer(answer: string): Promise<unknown>; onCancel?(): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = React.useState('');
  const [selected, setSelected] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const submitting = React.useRef(false);
  const questionId = React.useId();
  const args = (operation.intent as { call?: { arguments?: { question?: unknown; options?: unknown } } })?.call?.arguments;
  if (typeof args?.question !== 'string' || operation.phase === 'terminal') return null;
  const options = Array.isArray(args.options) ? args.options.filter((value): value is string => typeof value === 'string') : [];
  const act = async (action: () => Promise<unknown>) => {
    if (!enabled || submitting.current) return;
    submitting.current = true; setPending(true); setError(undefined);
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { submitting.current = false; setPending(false); }
  };
  const response = [selected, answer.trim()].filter(Boolean).join('\n\n');
  return <form aria-labelledby={questionId} className="tool-question space-y-3 border-t border-border/50 py-3" onSubmit={event => { event.preventDefault(); if (response) void act(() => onAnswer(response)); }}>
    <p id={questionId} className="mb-2 whitespace-pre-wrap break-words font-medium">{args.question}</p>
    {options.length > 0 && <div className="tool-question-options" role="radiogroup" aria-labelledby={questionId}>
      {options.map((option, index) => <label key={index} className="tool-question-option" data-selected={selected === option}>
        <input type="radio" name={questionId} value={option} checked={selected === option} disabled={!enabled || pending} onChange={() => setSelected(option)} />
        <span>{option}</span>
      </label>)}
    </div>}
    {selected && <button type="button" className="tool-text-button" disabled={!enabled || pending} onClick={() => setSelected('')}>{t('chat.tools.clearChoice')}</button>}
    <Textarea aria-label={t('chat.questionCard.yourAnswer')} placeholder={t('chat.questionCard.yourAnswer')} value={answer} disabled={!enabled || pending} onChange={event => setAnswer(event.target.value)} className="min-w-0 [overflow-wrap:anywhere]" />
    {error && <p role="alert" className="typography-meta text-destructive break-words">{error}</p>}
    <div className="flex flex-wrap items-center gap-2"><Button type="submit" size="sm" disabled={!enabled || pending || !response}>{pending && <Icon name="loader-4" className="size-3.5 animate-spin motion-reduce:animate-none" />}{t('chat.questionCard.submit')}</Button>{onCancel && <Button type="button" variant="ghost" size="sm" disabled={!enabled || pending} onClick={() => void act(onCancel)}>{t('chat.question.cancel')}</Button>}</div>
  </form>;
}
