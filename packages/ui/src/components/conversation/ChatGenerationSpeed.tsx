import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n, getCurrentIntlLocale } from '@/lib/i18n';
import { CountUp } from '@/components/motion/CountUp';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ProgressActivity } from '@/lib/agent-runtime/thread-projection';
import type { ChatUsage } from './types';
import { generationPresentation } from './generationPresentation';

export function ChatGenerationSpeed({ usages, live, active }: { usages: readonly ChatUsage[]; live?: ProgressActivity; active: boolean }) {
  const visible = useUIStore(state => state.showGenerationSpeed);
  const { t } = useI18n();
  const [details, setDetails] = React.useState(false);
  const [age, setAge] = React.useState(0);
  const current = visible && active && live?.generation && !live.generation.finished ? live.generation : undefined;
  React.useEffect(() => {
    setAge(0);
    if (!current) return;
    const received = performance.now();
    const timer = setInterval(() => setAge(performance.now() - received), 500);
    return () => clearInterval(timer);
  }, [current]);
  const completed = React.useMemo(() => generationPresentation(usages, live), [usages, live]);
  if (!visible) return null;
  const lastOutputMs = current?.lastOutputMs == null ? undefined : current.elapsedMs - current.lastOutputMs + age;
  const recentMs = current ? Math.min(2000, current.recentMs + age) : 0;
  const rate = current ? recentMs > 0 ? (lastOutputMs !== undefined && lastOutputMs >= 2000 ? 0 : current.recentTokens * 1000 / recentMs) : undefined : completed?.rate;
  if (rate === undefined || !Number.isFinite(rate)) return null;
  const firstOutputMs = current?.firstOutputMs ?? completed?.firstOutputMs;
  const number = (value: number) => value.toLocaleString(getCurrentIntlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return <Tooltip open={details} onOpenChange={setDetails}>
    <TooltipTrigger asChild><button type="button" aria-label={t('chat.speed.title')} onClick={() => setDetails(true)}
      className="inline-flex min-w-[12ch] shrink-0 items-baseline justify-end gap-1 rounded-sm typography-micro tabular-nums text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden="true"><CountUp value={rate} animate={Boolean(current)} format={number} /></span><span>tok/s</span>
    </button></TooltipTrigger>
    <TooltipContent className="max-w-72 space-y-1.5">
      <p>{t(current ? 'chat.speed.live' : 'chat.speed.finished')} · {number(rate)} tok/s</p>
      {firstOutputMs != null && <p>{t('chat.speed.first', { seconds: number(firstOutputMs / 1000) })}</p>}
      {lastOutputMs !== undefined && <p>{t('chat.speed.last', { seconds: number(lastOutputMs / 1000) })}</p>}
      <p>{t(current || !completed?.actual ? 'chat.speed.estimated' : 'chat.speed.actual')}</p>
      {!current && <p>{t('chat.speed.scope')}</p>}
    </TooltipContent>
  </Tooltip>;
}
