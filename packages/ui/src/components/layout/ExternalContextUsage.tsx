import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { getRuntimeEndpointGeneration, type ExternalTurn } from '@varin/application-client';
import { useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { externalCacheRate, externalUsageSummary } from '@/components/thread/externalUsage';

function Usage({ usage, label }: { usage: NonNullable<ExternalTurn['usage']>; label: string }) {
  const { t } = useI18n();
  const rate = externalCacheRate(usage);
  return <section className="mt-3 border-t border-border/50 pt-3" aria-label={label}>
    <h3 className="mb-2 font-medium">{label}</h3>
    <dl className="space-y-1 tabular-nums">
      {usage.input !== undefined && <div className="flex justify-between gap-6"><dt>↓ {t('usage.input')}</dt><dd>{usage.input.toLocaleString()}</dd></div>}
      {usage.output !== undefined && <div className="flex justify-between gap-6"><dt>↑ {t('usage.output')}</dt><dd>{usage.output.toLocaleString()}</dd></div>}
      {usage.cachedInput !== undefined && <div className="flex justify-between gap-6"><dt>{t('external.cached')}</dt><dd>{usage.cachedInput.toLocaleString()}</dd></div>}
      {usage.cacheCreated !== undefined && <div className="flex justify-between gap-6"><dt>{t('external.cacheCreated')}</dt><dd>{usage.cacheCreated.toLocaleString()}</dd></div>}
      {rate !== undefined && <div className="flex justify-between gap-6"><dt>{t('external.cacheRate')}</dt><dd>{rate.toFixed(1)}%</dd></div>}
    </dl>
  </section>;
}

/** Same topbar occupancy indicator, with native-harness details rather than a Varin context panel. */
export function ExternalContextUsage() {
  const identity = useThreadStore(state => state.selectedIdentity);
  const draftKey = useThreadStore(state => state.selectedDraftKey);
  const draft = useThreadDraftStore(state => draftKey ? state.drafts[draftKey] : undefined);
  const selected = useExternalAgentStore(state => state.selectedId);
  const id = draftKey ? draft?.harnessId && draft.externalConversationHost === getRuntimeEndpointGeneration()
    ? draft.externalConversationId : undefined : selected;
  const snapshot = useExternalAgentStore(state =>
    state.host === getRuntimeEndpointGeneration() && id ? state.snapshots[id] : undefined);
  const usage = snapshot?.contextUsage;
  // Cross-Host or native/draft navigation must not retain another session's popup.
  if (identity || !id || !usage || !Number.isSafeInteger(usage.used) || usage.used < 0 ||
      !Number.isSafeInteger(usage.size) || usage.size <= 0) return null;
  return <ExternalContextDetails key={id} used={usage.used} size={usage.size} turns={snapshot!.turns} />;
}

function ExternalContextDetails({ used, size, turns }: { used: number; size: number; turns: ExternalTurn[] }) {
  const { t } = useI18n();
  const summary = React.useMemo(() => externalUsageSummary(turns), [turns]);
  return <Popover.Root>
    <Popover.Trigger aria-label={t('contextUsage.aria.label')}
      className="app-region-no-drag mr-1.5 rounded-md px-2 py-1.5 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ContextUsageDisplay totalTokens={used} contextLimit={size} percentage={used / size * 100}
        tooltipTitle={t('external.contextUsage')} size="compact" hideIcon showPercentIcon
        valueClassName="typography-ui-label font-medium leading-none text-foreground" percentIconClassName="h-4.5 w-4.5" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
        <Popover.Popup className="max-w-[calc(100vw-2rem)] min-w-60 rounded-xl border border-border bg-popover p-4 typography-meta text-popover-foreground shadow-lg outline-none">
          <Popover.Title className="mb-2 font-medium">{t('external.contextUsage')}</Popover.Title>
          <Popover.Description className="tabular-nums text-muted-foreground">
            {used.toLocaleString()} / {size.toLocaleString()} · {(used / size * 100).toFixed(1)}%
          </Popover.Description>
          {summary.total && <Usage usage={summary.total} label={t(summary.complete ? 'external.conversationUsage' : 'external.recordedUsage')} />}
          {summary.lastRequest && <Usage usage={summary.lastRequest} label={t('external.lastRequest')} />}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
