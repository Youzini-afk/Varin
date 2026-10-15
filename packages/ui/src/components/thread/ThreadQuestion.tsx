import React from 'react';
import type { Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';

/** Questions are projected from the Operation; the component owns only the unsent draft. */
export function ThreadQuestion({ operation, enabled, onAnswer, onCancel }: {
  operation: Operation; enabled: boolean; onAnswer(answer: string): Promise<unknown>; onCancel?(): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = React.useState('');
  const args = (operation.intent as { call?: { arguments?: { question?: unknown; options?: unknown } } })?.call?.arguments;
  if (typeof args?.question !== 'string' || operation.phase === 'terminal') return null;
  const options = Array.isArray(args.options) ? args.options.filter((value): value is string => typeof value === 'string') : [];
  return <form aria-label={t('chat.questionCard.inputNeeded')} className="space-y-3 border-t border-border/50 py-3" onSubmit={event => { event.preventDefault(); if (enabled && answer.trim()) void onAnswer(answer); }}>
    <p className="mb-2 whitespace-pre-wrap font-medium">{args.question}</p>
    <div className="grid gap-2 sm:grid-cols-2">{options.map((option, index) => <Button key={index} type="button" variant={answer === option ? "default" : "outline"} className="h-auto justify-start whitespace-normal py-2 text-left" disabled={!enabled} onClick={() => setAnswer(option)}>{option}</Button>)}</div>
    <Textarea aria-label={t('chat.questionCard.yourAnswer')} placeholder={t('chat.questionCard.yourAnswer')} value={answer} disabled={!enabled} onChange={event => setAnswer(event.target.value)} />
    <div className="flex items-center gap-2"><Button type="submit" size="sm" disabled={!enabled || !answer.trim()}>{t('chat.questionCard.submit')}</Button>{onCancel && <Button type="button" variant="ghost" size="sm" disabled={!enabled} onClick={() => void onCancel()}>{t('chat.question.cancel')}</Button>}</div>
  </form>;
}
