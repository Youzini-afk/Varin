import React from 'react';
import type { Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';

/** Questions are projected from the Operation; the component owns only the unsent draft. */
export function ThreadQuestion({ operation, enabled, onAnswer }: {
  operation: Operation; enabled: boolean; onAnswer(answer: string): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = React.useState('');
  const args = (operation.intent as { call?: { arguments?: { question?: unknown; options?: unknown } } })?.call?.arguments;
  if (typeof args?.question !== 'string' || operation.phase === 'terminal') return null;
  const options = Array.isArray(args.options) ? args.options.filter((value): value is string => typeof value === 'string') : [];
  return <form aria-label={t('chat.questionCard.inputNeeded')} className="space-y-3 rounded-xl border border-border bg-[var(--surface-elevated)] p-4" onSubmit={event => { event.preventDefault(); if (enabled && answer.trim()) void onAnswer(answer); }}>
    <p className="mb-2 whitespace-pre-wrap font-medium">{args.question}</p>
    <div className="flex flex-wrap gap-2">{options.map((option, index) => <Button key={index} type="button" variant="outline" disabled={!enabled} onClick={() => setAnswer(option)}>{option}</Button>)}</div>
    <Textarea aria-label={t('chat.questionCard.yourAnswer')} placeholder={t('chat.questionCard.yourAnswer')} value={answer} disabled={!enabled} onChange={event => setAnswer(event.target.value)} />
    <Button type="submit" size="sm" disabled={!enabled || !answer.trim()}>{t('chat.questionCard.submit')}</Button>
  </form>;
}
