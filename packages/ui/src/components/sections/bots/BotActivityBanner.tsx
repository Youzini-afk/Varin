import React from 'react';
import type { BotSummary } from '@/lib/bots';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export function BotActivityBanner({ bot, busy, onAction }: { bot: BotSummary; busy: boolean; onAction(action: 'sleep' | 'wake' | 'restore' | 'retry'): void }) {
  const { t } = useI18n();
  const state = bot.activity?.state ?? 'awake';
  if (state === 'awake' && !bot.archived) return null;
  const label = bot.archived ? 'settings.bots.archived' : state === 'sleeping' ? 'settings.bots.sleeping'
    : state === 'waking' ? 'settings.bots.waking' : state === 'sleep-failed' ? 'settings.bots.sleepFailed'
      : state === 'wake-failed' ? 'settings.bots.wakeFailed' : 'settings.bots.asleep';
  return <div className="space-y-2 border-b border-border px-4 py-3 typography-meta" role="status">
    <div className="flex items-center gap-2"><Icon name="moon" className="size-4" /><span className="flex-1">{t(label)}</span>
      {state === 'sleeping' || state === 'waking' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('retry')}>{t('settings.harness.retry')}</Button> : <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(bot.archived ? 'restore' : state === 'sleep-failed' || state === 'wake-failed' ? 'retry' : 'wake')}>
        {t(bot.archived ? 'settings.bots.restore' : state === 'sleep-failed' ? 'settings.bots.sleepRetry' : 'settings.bots.wakeContinue')}
      </Button>}
    </div>
    {state === 'asleep' ? <p className="text-muted-foreground">{t('settings.bots.sleepDescription')}</p> : null}
    {bot.activity?.error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{bot.activity.error}</p> : null}
    {bot.activity?.machines.length ? <details><summary className="cursor-pointer text-muted-foreground">{t('settings.bots.remoteComputers')}</summary>
      <ul className="mt-2 space-y-1">{bot.activity.machines.map((machine) => <li key={machine.machineId}>
        {machine.label} · {t(`settings.bots.machine.${machine.state}`)}{machine.detail ? ` — ${machine.detail}` : ''}
      </li>)}</ul>
    </details> : null}
  </div>;
}
