import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { getRuntimeEndpointGeneration, type ExternalTurn } from '@varin/application-client';
import { useShallow } from 'zustand/react/shallow';
import { useExternalAgentStore, type ExternalContextSnapshot } from '@/stores/useExternalAgentStore';
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

export function useExternalContextSnapshot(conversationId?: string) {
  const identity = useThreadStore(state => state.selectedIdentity);
  const draftKey = useThreadStore(state => state.selectedDraftKey);
  const draft = useThreadDraftStore(state => draftKey ? state.drafts[draftKey] : undefined);
  const selected = useExternalAgentStore(state => state.selectedId);
  const host = getRuntimeEndpointGeneration();
  const id = conversationId ?? (identity ? undefined : draftKey
    ? draft?.harnessId && draft.externalConversationHost === host ? draft.externalConversationId : undefined
    : selected);
  const snapshot = useExternalAgentStore(useShallow(state => {
    const value = state.host === host && id ? state.snapshots[id] : undefined;
    if (!value) return undefined;
    const { contextUsage, contextUsageSource, turns } = value;
    return { contextUsage, contextUsageSource, turns };
  }));
  return { id, snapshot };
}

export function ExternalContextUsage({ conversationId }: { conversationId?: string }) {
  const { id, snapshot } = useExternalContextSnapshot(conversationId);
  const { t } = useI18n();
  if (!snapshot) return null;
  const { contextUsage: usage, contextUsageSource } = snapshot;
  const title = t(contextUsageSource === 'recorded' ? 'external.lastRecordedContext' : 'external.contextUsage');
  return <Popover.Root key={id}>
    <Popover.Trigger aria-label={contextUsageSource === 'recorded' ? title : t('contextUsage.aria.label')}
      className="app-region-no-drag shrink-0 rounded-md px-2 py-1.5 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ContextUsageDisplay totalTokens={usage?.used} contextLimit={usage?.size}
        percentage={usage && usage.used / usage.size * 100} tooltipTitle={title} size="compact" hideIcon showPercentIcon
        className={contextUsageSource === 'recorded' ? 'opacity-65' : undefined}
        valueClassName="typography-ui-label font-medium leading-none text-foreground" percentIconClassName="h-4.5 w-4.5" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
        <Popover.Popup aria-label={t('contextUsage.aria.label')} className="w-max max-w-[calc(100vw-2rem)] min-w-60 rounded-xl border border-border bg-popover p-4 typography-meta text-popover-foreground shadow-lg outline-none">
          <ExternalContextDetails snapshot={snapshot} />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function ExternalContextDetails({ snapshot }: { snapshot: ExternalContextSnapshot }) {
  const { t } = useI18n();
  const { contextUsage: usage, contextUsageSource, turns } = snapshot;
  const summary = React.useMemo(() => externalUsageSummary(turns), [turns]);
  return <>
    <h3 className="mb-2 font-medium">{t(contextUsageSource === 'recorded' ? 'external.lastRecordedContext' : 'external.contextUsage')}</h3>
    <p className="tabular-nums text-muted-foreground">
      {usage ? `${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} · ${(usage.used / usage.size * 100).toFixed(1)}%`
        : t('external.contextUnavailable')}
    </p>
    {summary.total && <Usage usage={summary.total} label={t(summary.complete ? 'external.conversationUsage' : 'external.recordedUsage')} />}
    {summary.lastRequest && <Usage usage={summary.lastRequest} label={t('external.lastRequest')} />}
  </>;
}
