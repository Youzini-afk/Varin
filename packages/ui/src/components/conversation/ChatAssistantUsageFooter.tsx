import React from 'react';
import type { ChatUsage } from './types';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import {
  projectChatUsagePresentation,
  type ChatUsageMetricKey,
} from './usagePresentation';

const LABEL_KEYS: Record<ChatUsageMetricKey, I18nKey> = {
  cacheRead: 'contextSidebar.tokens.cacheRead',
  cacheWrite: 'contextSidebar.tokens.cacheWrite',
  cacheWrite1h: 'contextSidebar.tokens.cacheWrite1h',
  input: 'contextSidebar.tokens.input',
  output: 'contextSidebar.tokens.output',
  reasoning: 'contextSidebar.tokens.reasoning',
};

const ICON_NAMES: Record<ChatUsageMetricKey, React.ComponentProps<typeof Icon>['name']> = {
  cacheRead: 'database-2',
  cacheWrite: 'archive-stack',
  cacheWrite1h: 'time',
  input: 'arrow-down',
  output: 'arrow-up',
  reasoning: 'brain',
};

const formatNumber = (value: number): string => value.toLocaleString(getCurrentIntlLocale());

const UsageMetric: React.FC<{
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  value: number;
}> = ({ icon, label, value }) => {
  const formatted = formatNumber(value);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums"
      title={`${label}: ${formatted}`}
    >
      <Icon name={icon} className="size-3 shrink-0" />
      <span aria-hidden="true">{formatted}</span>
      <span className="sr-only">{label} {formatted}</span>
    </span>
  );
};

export const ChatAssistantUsageFooter: React.FC<{ tokensPerSecond?: number; usage: ChatUsage }> = ({ tokensPerSecond, usage }) => {
  const { t } = useI18n();
  const presentation = projectChatUsagePresentation(usage);
  if (!presentation) return null;
  return (
    <footer
      className="flex w-max max-w-full flex-wrap items-center justify-end gap-x-2.5 gap-y-1 typography-micro text-muted-foreground"
      aria-label={t('chat.messageUsage.label')}
      data-conversation-assistant-usage="true"
      data-conversation-turn-usage="true"
    >
      {usage.measurement === 'estimated' && <span title={t('chat.messageUsage.estimated')}>≈</span>}
      {usage.unknownReceipts > 0 && <span title={t('chat.messageUsage.unreported')}>?</span>}
      {presentation.metrics.map((metric) => (
        <UsageMetric
          key={metric.key}
          icon={ICON_NAMES[metric.key]}
          label={t(LABEL_KEYS[metric.key])}
          value={metric.value}
        />
      ))}
      {presentation.cacheHitPercent !== undefined && <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums"
        title={t('chat.usage.cacheRateHint')}>
        {t('chat.usage.cacheRate')} {presentation.cacheHitPercent.toLocaleString(getCurrentIntlLocale(), { maximumFractionDigits: 1 })}%
      </span>}
      {presentation.total !== undefined ? (
        <UsageMetric
          icon="bar-chart-box"
          label={t('contextSidebar.tokens.total')}
          value={presentation.total}
        />
      ) : null}
      {tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums"
          title={`Output token rate: ${tokensPerSecond.toFixed(1)} Tok/s`}
        >
          <span aria-hidden="true">{tokensPerSecond.toFixed(1)} Tok/s</span>
          <span className="sr-only">Output token rate {tokensPerSecond.toFixed(1)} tokens per second</span>
        </span>
      ) : null}
    </footer>
  );
};
