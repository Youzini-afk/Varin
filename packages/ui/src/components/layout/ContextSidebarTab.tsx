import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { ThreadHistoryWindow } from '@/lib/agent-runtime/thread-history';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { Icon } from '@/components/icon/Icon';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { ThreadTokenUsage } from '@/components/thread/ThreadTokenUsage';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { contextUsageKey, useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';

const card = 'mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5';
const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString(getCurrentIntlLocale());

export const ContextPanelContent: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const { t } = useI18n();
  const { identity, snapshot, error } = useSelectedThreadSnapshot(active);
  const api = useRuntimeAPIs().threads;
  const host = useThreadStore(state => state.hostKey);
  if (!identity) return <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">{t('contextSidebar.empty.openSession')}</div>;
  if (!snapshot || !api) return <p role={error ? 'alert' : 'status'} className="p-4 typography-meta">{error || t('common.loading')}</p>;
  return <ContextDetails key={JSON.stringify([host, identity.threadId, identity.branchId])} {...{ api, identity, snapshot, active, error }} />;
};

function ContextDetails({ api, identity, snapshot, active, error }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot: ThreadSnapshot; active: boolean; error?: string;
}) {
  const { t } = useI18n();
  const timeFormat = useUIStore(state => state.timeFormatPreference);
  const view = useThreadContextUsageStore(state => state.views[contextUsageKey(identity)]);
  const inspection = view?.inspection;
  const usage = view?.usage;
  const counts = inspection?.counts;
  const request = inspection?.latestRequest;
  const tokens = request?.usage;
  const model = snapshot.modelSelection.active?.configuration;
  const channel = useModelCatalogStore(state => state.channels.find(channel => channel.id === model?.providerId));
  const modelName = channel?.models.find(candidate => candidate.id === (model?.catalogModelId ?? model?.model))?.name
    || model?.model || request?.modelId || '—';
  const checkpoint = snapshot.context.checkpoint;
  const latestJob = snapshot.context.jobs.at(-1);
  const preparing = snapshot.context.jobs.some(({ run }) => !['completed', 'failed', 'cancelled'].includes(run.state));
  const ready = latestJob?.run.state === 'completed' && latestJob.job.request.expected_revision === (checkpoint?.revision ?? 0);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [copied, setCopied] = React.useState<string>();
  const [usageOpen, setUsageOpen] = React.useState(false);
  const scroll = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);
  // This inspector has its own paginated view; its snapshot cannot rewind the chat viewport.
  const historyWindow = React.useMemo(() => new ThreadHistoryWindow(api, identity, { usage: false }), [api, identity]);
  const subscribe = React.useCallback((listener: () => void) => active ? historyWindow.subscribe(listener) : () => {}, [active, historyWindow]);
  const history = React.useSyncExternalStore(subscribe, historyWindow.getSnapshot, historyWindow.getSnapshot);
  React.useEffect(() => { if (active) historyWindow.accept(snapshot); }, [active, historyWindow, snapshot]);
  React.useEffect(() => {
    if (!active || !history.previous || history.loading || history.error || !sentinel.current || !scroll.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void historyWindow.loadEarlier();
    }, { root: scroll.current, rootMargin: '600px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, history.previous, history.loading, history.error, historyWindow]);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(undefined), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const date = (value: number) => formatDateTimeForPreference(value, timeFormat, {
    day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', year: 'numeric',
  });
  const inputFootprint = request?.contextTokens != null && tokens?.outputTokens != null ? request.contextTokens - tokens.outputTokens : undefined;
  const cacheHit = inputFootprint && tokens?.cachedInputTokens != null ? tokens.cachedInputTokens / inputFootprint * 100 : undefined;
  const metrics = tokens ? [
    { key: 'input', value: tokens.inputTokens }, { key: 'output', value: tokens.outputTokens },
    { key: 'reasoning', value: tokens.reasoningTokens }, { key: 'cacheRead', value: tokens.cachedInputTokens },
    { key: 'cacheWrite', value: tokens.cacheWriteTokens }, { key: 'total', value: request?.contextTokens },
    { key: 'cacheHit', value: cacheHit },
  ] as const : [];
  // contextTokens includes protocol-specific cache accounting. Partition it once.
  const segments = inputFootprint === undefined ? [] : [
    { key: 'input', color: 'var(--status-success)', value: inputFootprint - (tokens?.cachedInputTokens ?? 0) - (tokens?.cacheWriteTokens ?? 0) },
    { key: 'output', color: 'var(--primary-base)', value: tokens?.outputTokens ?? 0 },
    { key: 'cacheRead', color: 'var(--status-warning)', value: tokens?.cachedInputTokens ?? 0 },
    { key: 'cacheWrite', color: 'var(--surface-muted-foreground)', value: tokens?.cacheWriteTokens ?? 0 },
  ] as const;
  const visibleSegments = segments.filter(segment => segment.value > 0);
  const segmentTotal = visibleSegments.reduce((sum, segment) => sum + segment.value, 0);
  const percent = usage ? Math.min(100, usage.percentage) : 0;
  const items = history.ready ? history.items : snapshot.history;

  return <div ref={scroll} className="h-full overflow-y-auto bg-background"><div className="mx-auto w-full max-w-[52rem] px-5 py-6">
    {(error || view?.error) && <p role="alert" className="mb-4 typography-meta text-destructive">{error || view?.error}</p>}
    <header className="mb-6">
      <h2 className="truncate typography-ui-header font-semibold text-foreground">{snapshot.thread.title || t('contextSidebar.session.untitled')}</h2>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
        <span>{channel?.name ? `${channel.name} / ${modelName}` : modelName}</span>
        {snapshot.thread.created_at_ms > 0 && <><span>·</span><span>{date(snapshot.thread.created_at_ms)}</span></>}
        {snapshot.thread.updated_at_ms > snapshot.thread.created_at_ms && <><span>·</span><span>{date(snapshot.thread.updated_at_ms)}</span></>}
      </div>
    </header>

    {(checkpoint || latestJob) && <div className={card}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="typography-micro text-muted-foreground">{t('contextSidebar.section.contextPreparation')}</span>
        <span className="typography-micro text-muted-foreground/70">{t(preparing ? 'contextSidebar.context.candidate.preparing' : ready ? 'contextSidebar.context.candidate.ready' : 'contextSidebar.context.candidate.none')}</span>
      </div>
      {latestJob?.run.state === 'failed' && <p className="mt-2 typography-micro text-status-warning">{t('contextSidebar.context.status.preparationFailed')}</p>}
      {checkpoint && <details className="mt-3 typography-meta">
        <summary className="cursor-pointer text-muted-foreground">{t('contextSidebar.section.context')}</summary>
        {checkpoint.proposal.summary && <div className="mt-3"><MarkdownRenderer content={checkpoint.proposal.summary} messageId={checkpoint.id} /></div>}
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words typography-micro">{checkpoint.proposal.effective_system_prompt}</pre>
      </details>}
    </div>}

    {usage && <section className={card} aria-label={t('contextSidebar.section.context')}>
      <div className="flex items-baseline justify-between">
        <span className="typography-micro text-muted-foreground">{t('contextSidebar.section.context')}</span>
        <span className="typography-micro tabular-nums text-muted-foreground/70">{number(usage.totalTokens)} / {number(usage.contextLimit)}</span>
      </div>
      <div className="mt-2.5 flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]" role="progressbar" aria-label={t('contextUsage.aria.label')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        {percent > 0 && <div className="rounded-full transition-all duration-300" style={{ backgroundColor: percent > 80 ? 'var(--status-warning)' : 'var(--primary-base)', width: `${Math.max(0.5, percent)}%` }} />}
      </div>
      <div className="mt-1.5 typography-micro font-medium tabular-nums text-foreground/80">{t('contextSidebar.context.percentUsed', { percent: usage.percentage.toFixed(1) })}</div>
    </section>}

    <div className="mb-5 grid grid-cols-2 gap-2">
      {([
        { key: 'messages', value: counts?.total }, { key: 'user', value: counts?.user },
        { key: 'assistant', value: counts?.assistant }, { key: 'cost', value: undefined },
      ] as const).map(item => <div key={item.key} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
        <div className="typography-micro text-muted-foreground/70">{t(`contextSidebar.stats.${item.key}`)}</div>
        <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{number(item.value)}</div>
      </div>)}
    </div>

    {tokens && <section className={card} aria-label={t('contextSidebar.section.lastAssistantMessage')}>
      <div className="mb-2.5 flex items-center justify-between gap-2 typography-micro text-muted-foreground">
        <span>{t('contextSidebar.section.lastAssistantMessage')}</span>
        {tokens.measurement !== 'actual' && <span>{t(tokens.measurement === 'estimated' ? 'chat.usage.estimated' : 'chat.usage.missing')}</span>}
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">{metrics.filter(metric => metric.value != null || metric.key === 'input' || metric.key === 'output').map(metric => <div key={metric.key}>
        <div className="typography-micro text-muted-foreground/70">{t(`contextSidebar.tokens.${metric.key}`)}</div>
        <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{metric.key === 'cacheHit' && metric.value != null ? `${metric.value.toFixed(1)}%` : number(metric.value)}</div>
      </div>)}</div>
    </section>}

    {visibleSegments.length > 0 && <div className="mb-6">
      <div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">{visibleSegments.map(segment => <div key={segment.key} style={{ backgroundColor: segment.color, width: `${segment.value / segmentTotal * 100}%` }} />)}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">{visibleSegments.map(segment => <div key={segment.key} className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
        <span className="typography-micro text-muted-foreground/70">{t(`contextSidebar.tokens.${segment.key}`)} <span className="tabular-nums">{(segment.value / segmentTotal * 100).toFixed(0)}%</span></span>
      </div>)}</div>
    </div>}

    <details className="mb-5 typography-micro text-muted-foreground" onToggle={event => { if (event.target === event.currentTarget) setUsageOpen(event.currentTarget.open); }}>
      <summary className="cursor-pointer">{t('chat.usage.title')}</summary>
      {usageOpen && <ThreadTokenUsage active={active} />}
    </details>

    <section><h3 className="typography-micro text-muted-foreground">{t('contextSidebar.section.rawMessages')}</h3>
      <div className="mt-2.5 space-y-1">{[...items].reverse().map(item => {
        const preview = historyParts(item.content, item.source).flatMap(part => part.kind === 'text' ? [part.text] : []).join(' ').slice(0, 100);
        const label = t(item.source === 'user' ? 'contextSidebar.breakdown.user' : item.source === 'assistant' ? 'contextSidebar.breakdown.assistant' : item.source === 'tool' ? 'contextSidebar.breakdown.toolCalls' : 'contextSidebar.breakdown.other');
        const json = expanded[item.id] ? JSON.stringify(item, null, 2) : '';
        return <div key={item.id} className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70">
          <button type="button" className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]" aria-expanded={expanded[item.id] === true} onClick={() => setExpanded(current => ({ ...current, [item.id]: !current[item.id] }))}>
            <div className="truncate typography-micro text-muted-foreground">{label}{preview ? `: ${preview}` : ''}</div>
          </button>
          {expanded[item.id] && <div className="border-t border-[var(--surface-subtle)]">
            <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
              <button type="button" className="absolute right-2 top-1 z-10 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-interactive-hover/60 hover:text-foreground" aria-label={t(copied === item.id ? 'contextSidebar.actions.copied' : 'contextSidebar.actions.copyJson')}
                onClick={() => void copyTextToClipboard(json).then(result => { if (result.ok) setCopied(item.id); })}>
                <Icon name={copied === item.id ? 'check' : 'file-copy'} className="size-3.5" />
              </button>
              <WorkerHighlightedCode language="json" code={json} style={{ background: 'transparent', margin: 0 }} codeStyle={{ fontSize: 'var(--text-micro)', lineHeight: '1.35', padding: '0.75rem' }} wrap />
            </div>
          </div>}
        </div>;
      })}</div>
      {history.error && <button type="button" className="mt-3 typography-micro text-status-warning" onClick={() => void historyWindow.loadEarlier(true)}>{t('chat.context.retry')}</button>}
      <div ref={sentinel} className="h-px" />
    </section>
  </div></div>;
}
