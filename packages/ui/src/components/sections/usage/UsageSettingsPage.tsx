import React from 'react';
import { createUsageHttpAPI, createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, getThreadObservationBus, subscribeRuntimeEndpointChanged, getRuntimeApiBaseUrl, type ModelChannel, type ThreadIdentity } from '@varin/application-client';
import type { UsageSummary, UsageSummaryRow, UsageTokenCount } from '@varin/protocol';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ThreadTokenUsage } from '@/components/thread/ThreadTokenUsage';
import { addCounts, dayKey, grouped, knownCount, modelKey, seriesColor, summarize, tokensOf, uncachedOf, usageCsv, usageWindow, type UsageRange } from './usage-data';
import './usage.css';

const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 4 }).format(value);
const count = (value: UsageTokenCount) => value.known === null ? '—' : `${BigInt(value.known).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 })}${value.missing ? ' + ?' : ''}`;
const numeric = (row: UsageSummaryRow, metric: 'cost' | 'tokens') => metric === 'cost' ? row.costUsd : Number(knownCount(tokensOf(row)));
const priceFields = ['inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion', 'reasoningPerMillion'] as const;
const tierPriceFields = [priceFields[0], priceFields[1], priceFields[2], priceFields[3]] as const;
const priceLabels = ['usage.input', 'usage.cacheRead', 'usage.cacheWrite', 'usage.output', 'usage.reasoning'] as const;
const ranges: UsageRange[] = ['7d', '30d', 'month', 'lastMonth', '90d'];

export function UsageSettingsPage() {
  const { t } = useI18n();
  const isMobile = useUIStore(state => state.isMobile);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const usage = React.useMemo(() => createUsageHttpAPI(generation), [generation]);
  const models = React.useMemo(() => createModelConnectionsHttpAPI(generation), [generation]);
  const threadsApi = useRuntimeAPIs().threads;
  const [range, setRange] = React.useState<UsageRange>('30d');
  const [metric, setMetric] = React.useState<'cost' | 'tokens'>('cost');
  const [dimension, setDimension] = React.useState<'model' | 'channel' | 'purpose' | 'thread'>('model');
  const [sort, setSort] = React.useState<'cost' | 'tokens' | 'requests'>('cost');
  const [revision, setRevision] = React.useState(0);
  const [calendarTime, setCalendarTime] = React.useState(() => new Date());
  const window_ = React.useMemo(() => usageWindow(range, calendarTime), [range, calendarTime]);
  const owner = `${generation}:${range}:${revision}:${calendarTime.getTime()}`;
  const [view, setView] = React.useState<{ owner: string; data?: UsageSummary; channels: ModelChannel[]; issue?: string; directoryUpdated?: number }>({ owner: '', channels: [] });
  const [selectedDay, setSelectedDay] = React.useState<string | null>(null);
  const [hoverDay, setHoverDay] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [inspect, setInspect] = React.useState<{ generation: number; identity: ThreadIdentity } | null>(null);
  React.useEffect(() => {
    if (!threadsApi) return;
    const controller = new AbortController(); let alive = true, dirty = false, observationUnavailable = false, reading: Promise<void> | undefined;
    const current = () => alive && generation === getRuntimeEndpointGeneration();
    const fail = (error: unknown) => { if (current()) setView(previous => ({ ...(previous.owner === owner ? previous : { owner, channels: [] }), issue: error instanceof Error ? error.message : String(error) })); };
    const read = () => {
      dirty = true;
      if (!reading) reading = (async () => { while (dirty && current()) {
        dirty = false; const data = await usage.summary(window_.query, controller.signal);
        if (current()) setView(previous => ({ ...previous, owner, data, issue: observationUnavailable ? t('usage.disconnected') : undefined }));
      } })().finally(() => { reading = undefined; if (dirty && current()) void read().catch(fail); });
      return reading;
    };
    setSelectedDay(null); setExpanded(null);
    const unsubscribe = getThreadObservationBus(threadsApi).subscribe({kinds: ['usage.updated']}, event => {
      if ('stream' in event && event.stream === 'resync') { observationUnavailable = event.reason === 'connection-lost'; if (observationUnavailable) fail(new Error(t('usage.disconnected'))); }
      void read().catch(fail);
    });
    void read().catch(fail);
    void models.read(controller.signal).then(catalog => {
      if (current()) setView(previous => ({...previous, owner, channels: catalog.channels, directoryUpdated: catalog.directory?.updatedAt}));
    }, fail);
    return () => { alive = false; unsubscribe(); controller.abort(); };

  }, [usage, models, threadsApi, generation, owner, window_, t]);
  React.useEffect(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setCalendarTime(new Date()), +next - +now);
    return () => clearTimeout(timer);
  }, [calendarTime]);
  const data = view.owner === owner ? view.data : undefined;
  const channels = view.owner === owner ? view.channels : [];
  const rows = React.useMemo(() => data?.rows.filter(row => row.day >= window_.firstDay) ?? [], [data, window_]);
  const totals = React.useMemo(() => summarize(rows), [rows]);
  const before = summarize(data?.rows.filter(row => row.day < window_.firstDay) ?? []);
  const details = selectedDay ? rows.filter(row => row.day === selectedDay) : rows;
  const groups = grouped(details, dimension === 'thread' ? 'model' : dimension).sort((a, b) => sort === 'tokens'
    ? knownCount(b.totals.tokens) > knownCount(a.totals.tokens) ? 1 : knownCount(b.totals.tokens) < knownCount(a.totals.tokens) ? -1 : 0
    : b.totals[sort] - a.totals[sort]);
  const channelName = (id: string | null) => channels.find(channel => channel.id === id)?.name ?? id ?? t('usage.unknownChannel');
  const modelName = (row: UsageSummaryRow) => {
    const models = channels.find(channel => channel.id === row.providerId)?.models ?? [];
    const exact = models.find(model => model.id === row.modelId), aliases = models.filter(model => model.requestModelId === row.modelId);
    return exact?.name ?? (aliases.length === 1 ? aliases[0]!.name : row.modelId);
  };
  const purposeName = (purpose: string) => {
    const key = purpose.endsWith('-embedding') ? 'embedding' : ({ title: 'title', embedding: 'embedding', embeddings: 'embedding', memory: 'memory', 'memory-organize': 'memory', 'memory-organizer': 'memory', image: 'image', 'image-generation': 'image', 'image-edit': 'image', conversation: 'conversation', context: 'context', retrieval: 'retrieval', explore: 'retrieval', planning: 'planning', mcp_sampling: 'mcp_sampling', auxiliary: 'auxiliary' } as Record<string, string>)[purpose];
    return key ? t(`usage.purpose.${key}` as I18nKey) : purpose;
  };
  const modelGroups = grouped(rows, 'model').sort((a, b) => b.rows.reduce((sum, row) => sum + numeric(row, metric), 0) - a.rows.reduce((sum, row) => sum + numeric(row, metric), 0));
  const top = modelGroups.slice(0, 6), topKeys = new Set(top.map(group => group.key));
  const series = [...top.map(group => ({ key: group.key, title: modelName(group.rows[0]!), color: seriesColor(group.key), rows: group.rows })),
    ...(modelGroups.length > 6 ? [{ key: 'other', title: t('usage.other'), color: 'var(--usage-c5)', rows: modelGroups.slice(6).flatMap(group => group.rows) }] : [])];
  const days = window_.days.map(day => ({ ...day, rows: rows.filter(row => row.day === day.day) }));
  const dailyValues = days.map(day => day.rows.reduce((sum, row) => sum + numeric(row, metric), 0));
  const peak = Math.max(...dailyValues, 0), totalValue = metric === 'cost' ? totals.cost : Number(knownCount(totals.tokens));
  const previousValue = metric === 'cost' ? before.cost : Number(knownCount(before.tokens));
  const completeComparison = data?.recordingStartedAtMs !== null && data?.recordingStartedAtMs !== undefined && data.recordingStartedAtMs <= window_.query.fromMs;
  const totalLabel = metric === 'cost' ? totals.costMissing > 0 && totals.cost === 0 ? '—' : money(totals.cost) : count(totals.tokens);
  const partial = metric === 'cost' ? totals.costMissing > 0 : totals.tokens.missing > 0;
  const billingLabel = (subset: UsageSummaryRow[]) => subset.every(row => row.billing === 'local') ? t('usage.local')
    : subset.every(row => row.billing === 'subscription') ? t('usage.subscription') : subset.every(row => !row.priced) ? t('usage.unpriced') : null;
  const costLabel = (rows: UsageSummaryRow[]) => {
    const label = billingLabel(rows); if (label) return label;
    const sum = summarize(rows); return sum.costMissing && !sum.cost ? '—' : money(sum.cost) + (sum.costMissing ? '+' : '');
  };
  const openUsage = async (threadId: string) => {
    try { const resolved = await useThreadStore.getState().resolveThread({ threadId }); if (generation === getRuntimeEndpointGeneration()) setInspect({ generation, identity: resolved.identity }); }
    catch (error) { if (generation === getRuntimeEndpointGeneration()) setView(previous => ({ ...previous, issue: error instanceof Error ? error.message : String(error) })); }
  };
  const exportCsv = () => {
    const csv = usageCsv(['day', 'channel', 'model', 'purpose', 'billing', 'measurement', 'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'estimated_usd', 'unpriced_requests', 'reference_usd', 'current_price_requests'], details.map(row => [
      row.day, channelName(row.providerId), row.modelId, row.purpose ?? row.kind, row.billing ?? 'unknown', row.measurement, row.requests,
      row.completeInputTokens.known ?? '', row.outputTokens.known ?? '', row.cachedInputTokens.known ?? '', row.cacheWriteTokens.known ?? '',
      row.priced && row.billing === 'metered' ? row.costUsd : '', row.priced ? row.costUnknownRequests : row.requests, row.referenceUsd, row.currentPriceRequests,
    ]));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `varin-usage-${selectedDay ?? window_.firstDay}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const hostOrigin = (() => { try { return new URL(getRuntimeApiBaseUrl() || window.location.origin).origin; } catch { return ''; } })();
  const navigatePrices = () => useUIStore.getState().setSettingsPage('model-connections');
  const threadGroups = new Map<string, NonNullable<UsageSummary['threads'][number]>[]>();
  for (const thread of data?.threads ?? []) if (thread.day >= window_.firstDay && (!selectedDay || thread.day === selectedDay)) {
    const items = threadGroups.get(thread.threadId) ?? []; items.push(thread); threadGroups.set(thread.threadId, items);
  }
  const external = (data?.external ?? []).filter(turn => turn.atMs >= window_.start && turn.atMs < window_.end);
  return <SettingsPageLayout title={t('usage.title')} description={t('usage.description')} className="usage-page" headerEnd={<div className="flex flex-wrap items-center justify-end gap-3">{hostOrigin && <button className="text-xs text-muted-foreground" onClick={() => useUIStore.getState().setSettingsPage('work-connections')}>{hostOrigin}</button>}{!isMobile && <Button variant="outline" size="sm" disabled={!data} onClick={exportCsv}><Icon name="download" className="mr-2 size-3.5" />{t('usage.export')}</Button>}</div>}>
    <div className="usage-controls">
      <div className="usage-segments" aria-label={t('usage.trend')}>{ranges.map(value => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{t(`usage.${value}`)}</button>)}</div>
      <div className="usage-segments" aria-label={t('usage.tokens')}>{(['cost', 'tokens'] as const).map(value => <button key={value} aria-pressed={metric === value} onClick={() => { setMetric(value); setSort(value); }}>{t(`usage.${value}`)}</button>)}</div>
    </div>
    {view.owner === owner && view.issue && <p role="alert" className="usage-note text-destructive">{view.issue} <Button variant="ghost" size="sm" onClick={() => setRevision(value => value + 1)}>{t('usage.retry')}</Button></p>}
    {!data ? <p role="status" className="py-10 text-muted-foreground">{view.owner === owner && view.issue ? '' : t('usage.loading')}</p> : <>
      <div className="usage-total"><strong>{totalLabel}{partial && totalLabel !== '—' && <sup>+</sup>}</strong><span>{new Date(window_.start).toLocaleDateString()} – {new Date(window_.end - 1).toLocaleDateString()}</span></div>
      {completeComparison && previousValue > 0 && !partial && (metric === 'cost' ? before.costMissing === 0 : before.tokens.missing === 0) && <p className="usage-comparison">{t('usage.previous')} {((totalValue - previousValue) / previousValue * 100).toFixed(1)}%</p>}
      <div className="usage-facts"><span><b>{count(totals.tokens)}</b> Token</span><span><b>{totals.requests.toLocaleString()}</b> {t('usage.requests')}</span>
        {knownCount(totals.cached) > 0n && knownCount(totals.input) > 0n && <span>{t('usage.cacheRate')} <b>{(Number(knownCount(totals.cached) * 1000n / knownCount(totals.input)) / 10).toFixed(1)}%</b></span>}
        {totals.saved !== 0 && <span>{t('usage.cacheSaved')} <b>{money(totals.saved)}</b></span>}
        {rows.some(row => row.kind !== 'conversation') && <span>{t('usage.background')} <b>{metric === 'cost' && totals.background > 0 ? money(totals.background) : count(addCounts(rows.filter(row => row.kind !== 'conversation').map(tokensOf))) + ' Token'}</b></span>}
      </div>
      {rows.length > 0 && <><div className="usage-composition" aria-hidden>{series.map(item => { const value = item.rows.reduce((sum, row) => sum + numeric(row, metric), 0); return value > 0 ? <span key={item.key} style={{ flexGrow: value, background: item.color }} /> : null; })}</div>
      <div className="usage-legend">{series.map(item => <div key={item.key}><i style={{ background: item.color }} /><span title={item.title}>{item.title}</span><strong>{metric === 'cost' ? costLabel(item.rows) : count(summarize(item.rows).tokens)}</strong></div>)}</div></>}
      <div className="usage-notes">
        {totals.missing > 0 && <p>{t('usage.missing', { count: totals.missing })}</p>}
        {totals.estimated > 0 && <p>{t('usage.estimated', { count: totals.estimated })}</p>}
        {totals.unpriced > 0 && <p className="usage-warning">{t('usage.unpricedHint', { count: totals.unpriced })} <button onClick={navigatePrices}>{t('usage.managePrices')}</button></p>}
        {totals.costUnknown > 0 && <p>{t('usage.costUnknown', { count: totals.costUnknown })}</p>}
        {totals.currentPrice > 0 && <p>{t('usage.currentPriceHint', { count: totals.currentPrice })}</p>}
        {data.recordingStartedAtMs !== null && data.recordingStartedAtMs > window_.start && <p>{t('usage.started', { date: new Date(data.recordingStartedAtMs).toLocaleString() })}</p>}
      </div>
      {rows.length === 0 ? <div className="usage-empty"><Icon name="bar-chart-2" className="mx-auto mb-3 size-6" /><strong>{t('usage.empty')}</strong><p>{t('usage.emptyHint')}</p></div> : <>
      <section className="usage-section"><div className="usage-section-head"><div><h2>{t('usage.trend')}</h2><p>{t('usage.trendHint')}</p></div><span className="usage-meta">{window_.timeZone}</span></div>
        <div className="usage-chart" onMouseLeave={() => setHoverDay(null)}>
          <div className="usage-chart-grid" aria-hidden><span /><span /><span /></div>
          <div className="usage-columns">{days.map((day, index) => <button key={day.day} className={`usage-column${selectedDay === day.day ? ' selected' : ''}${day.day === dayKey(new Date()) ? ' today' : ''}`} onClick={() => setSelectedDay(value => value === day.day ? null : day.day)}
            onFocus={() => setHoverDay(day.day)} onBlur={() => setHoverDay(null)} onMouseEnter={() => setHoverDay(day.day)} aria-label={`${day.day}: ${metric === 'cost' ? money(dailyValues[index]!) : count(summarize(day.rows).tokens)}`} aria-pressed={selectedDay === day.day}>
            <span className="usage-column-fill" style={{ height: `${peak ? dailyValues[index]! / peak * 90 : 0}%` }}>{series.map(item => { const subset = day.rows.filter(row => item.key === 'other' ? !topKeys.has(modelKey(row)) : modelKey(row) === item.key); const value = subset.reduce((sum, row) => sum + numeric(row, metric), 0); return value > 0 ? <i key={item.key} style={{ flexGrow: value, background: item.color }} /> : null; })}</span>
            {day.rows.some(row => row.measurement === 'missing') && <em>?</em>}
          </button>)}</div>
          {hoverDay && <div className="usage-chart-tip" role="status"><strong>{hoverDay}</strong>{series.map(item => { const subset = item.rows.filter(row => row.day === hoverDay); return subset.length ? <p key={item.key}><i style={{ background: item.color }} />{item.title}<b>{metric === 'cost' ? costLabel(subset) : count(summarize(subset).tokens)}</b></p> : null; })}</div>}
        </div><div className="usage-axis"><span>{days[0]?.day.slice(5)}</span><span>{days.at(-1)?.day.slice(5)}</span></div>
        <div className="usage-facts"><span>{t('usage.dailyAverage')} <b>{metric === 'cost' ? money(totalValue / days.length) : count({ known: (knownCount(totals.tokens) / BigInt(days.length)).toString(), missing: totals.tokens.missing })}</b></span><span>{t('usage.peak')} <b>{metric === 'cost' ? money(peak) : new Intl.NumberFormat(undefined, { notation: 'compact' }).format(peak)}</b></span></div>
      </section>
      <section className="usage-section"><div className="usage-tabs" role="tablist">{(['model', 'channel', 'purpose', 'thread'] as const).map(value => <button role="tab" key={value} aria-selected={dimension === value} onClick={() => { setDimension(value); setExpanded(null); }}>{t(({ model: 'usage.models', channel: 'usage.channels', purpose: 'usage.purposes', thread: 'usage.threads' } as const)[value])}</button>)}</div>
        <div className="usage-detail-toolbar"><div className="usage-segments">{(['cost', 'tokens', 'requests'] as const).map(value => <button key={value} aria-pressed={sort === value} onClick={() => setSort(value)}>{t(`usage.${value}`)}</button>)}</div>
          {selectedDay && <button className="usage-day-chip" onClick={() => setSelectedDay(null)} aria-label={t('usage.clearDay')}>{selectedDay} ×</button>}</div>
        {dimension === 'thread' ? [...threadGroups].sort(([, a], [, b]) => { const value = (items: typeof a) => sort === 'cost' ? items.reduce((sum, item) => sum + item.costUsd, 0) : sort === 'requests' ? items.reduce((sum, item) => sum + item.requests, 0) : Number(knownCount(addCounts(items.map(item => item.tokens)))); return value(b) - value(a); }).map(([id, items]) => {
          const token = addCounts(items.map(item => item.tokens)), cost = items.reduce((sum, item) => sum + item.costUsd, 0), deleted = items.some(item => item.deleted);
          return <button className="usage-thread-row" key={id} disabled={deleted} onClick={() => void openUsage(id)} title={deleted ? undefined : t('usage.openThread')}><span>{items[0]?.title ?? t('usage.deleted')}<small>{items.reduce((sum, item) => sum + item.requests, 0)} {t('usage.requests')} · {count(token)} Token</small></span><b>{metric === 'tokens' ? count(token) : money(cost) + (items.some(item => item.costUnknownRequests) ? '+' : '')}</b>{!deleted && <Icon name="arrow-right-s" className="size-4" />}</button>;
        }) : <><div className="usage-table-head"><span>{t(({ model: 'usage.models', channel: 'usage.channels', purpose: 'usage.purposes' } as const)[dimension])}</span><span>{t('usage.requests')}</span><span>{t('usage.input')}</span><span>{t('usage.cacheRead')}</span><span>{t('usage.output')}</span><span>{t(`usage.${metric}`)}</span></div>
        {groups.map(group => {
          const row = group.rows[0]!, label = dimension === 'model' ? modelName(row) : dimension === 'channel' ? channelName(row.providerId) : purposeName(group.key), open = expanded === `${dimension}:${group.key}`;
          return <div key={group.key} className="usage-detail-row"><button className="usage-table-row" onClick={() => setExpanded(open ? null : `${dimension}:${group.key}`)} aria-expanded={open}>
            <span className="usage-row-name"><i style={{ background: seriesColor(modelKey(row)) }} /><span><strong>{label}</strong><small>{dimension === 'model' ? channelName(row.providerId) : dimension === 'channel' ? [...new Set(group.rows.map(modelName))].join(' · ') : row.kind === 'conversation' ? '' : t('usage.background')}</small><small className="usage-phone-meta">{count(group.totals.tokens)} Token · {group.totals.requests} {t('usage.requests')}</small></span><Icon name="arrow-right-s" className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} /></span>
            <span>{group.totals.requests.toLocaleString()}</span><span>{count(group.totals.input)}</span><span>{knownCount(group.totals.cached) ? count(group.totals.cached) : '—'}</span><span>{count(group.totals.output)}</span>
            <span className="usage-row-cost">{metric === 'cost' ? costLabel(group.rows) : count(group.totals.tokens)}<i style={{ width: `${metric === 'cost' ? totals.cost ? group.totals.cost / totals.cost * 100 : 0 : Number(knownCount(group.totals.tokens)) / (Number(knownCount(totals.tokens)) || 1) * 100}%`, background: seriesColor(modelKey(row)) }} /></span>
          </button><div className="usage-expand" data-open={open}><div><div className="usage-detail-content" aria-hidden={!open}>
            <dl>{([['usage.input', group.totals.input], ['usage.uncached', uncachedOf(group.rows)], ['usage.cacheRead', group.totals.cached], ['usage.cacheWrite', group.totals.written], ['usage.output', group.totals.output], ['usage.reasoning', group.totals.reasoning]] as const).filter(([key, value]) => key === 'usage.input' || key === 'usage.output' || key === 'usage.uncached' || knownCount(value) > 0n).map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{count(value)}</dd></div>)}</dl>
            <p>{t('usage.actual')} {group.rows.filter(row => row.measurement === 'actual').reduce((sum, row) => sum + row.requests, 0)}{group.totals.estimated > 0 && ` · ${t('usage.estimated', { count: group.totals.estimated })}`}{group.totals.missing > 0 && ` · ${t('usage.missing', { count: group.totals.missing })}`}</p>
            {group.rows.some(row => row.referenceUsd > 0) && <p>{t('usage.reference')} {money(group.rows.reduce((sum, row) => sum + row.referenceUsd, 0))}</p>}
            {group.totals.saved !== 0 && <p>{t('usage.cacheSaved')} {money(group.totals.saved)}</p>}
            {group.totals.currentPrice > 0 && <p>{t('usage.currentPriceHint', { count: group.totals.currentPrice })}</p>}
            {Array.from(new Map(group.rows.flatMap(row => row.prices).map(price => [price.version, price])).values()).filter(price => priceFields.some(key => price[key] !== undefined)).map(price => <p key={price.version}>{t('usage.frozenPrice')} · {t(price.source === 'custom' ? 'usage.custom' : 'usage.directory')} · {priceFields.filter(key => price[key] !== undefined).map(key => `${t(priceLabels[priceFields.indexOf(key)]!)} ${money(price[key]!)}`).join(' / ')}{[...(price.contextTiers ?? []), ...(price.longContext ? [price.longContext] : [])].map(tier => ` · >${tier.aboveInputTokens.toLocaleString()} Token: ${tierPriceFields.filter(key => tier[key] !== undefined).map(key => `${t(priceLabels[priceFields.indexOf(key)]!)} ${money(tier[key]!)}`).join(' / ')}`).join('')}</p>)}
          </div></div></div></div>;
        })}</>}
      </section></>}
      <section className="usage-section"><div className="usage-section-head"><div><h2>{t('usage.prices')}</h2><p>{t('usage.priceHint')}</p></div><Button size="sm" variant="outline" onClick={navigatePrices}>{t('usage.managePrices')}</Button></div>
        <div className="usage-price-row"><span>{t('usage.directory')}<small>{view.directoryUpdated ? new Date(view.directoryUpdated).toLocaleString() : '—'}</small></span><Button variant="ghost" size="sm" onClick={() => { void models.refreshDirectory().then(() => { if (generation === getRuntimeEndpointGeneration()) setRevision(value => value + 1); }).catch(error => { if (generation === getRuntimeEndpointGeneration()) setView(previous => ({ ...previous, issue: String(error) })); }); }}><Icon name="refresh" className="mr-1 size-3.5" />{t('usage.refresh')}</Button></div>
        {modelGroups.filter(group => group.rows.some(row => !row.priced && row.billing !== 'local' && row.billing !== 'subscription')).map(group => <div className="usage-price-row" key={group.key}><span>{modelName(group.rows[0]!)}<small>{channelName(group.rows[0]!.providerId)}</small></span><span className="usage-warning">{t('usage.unpriced')}</span></div>)}
      </section>
      <section className="usage-section"><div className="usage-section-head"><div><h2>{t('usage.external')}</h2><p>{t('usage.externalHint')}</p></div></div>
        {['codex', 'claude', 'pi', 'acp'].map(harness => {
          const turns = external.filter(turn => turn.harness === harness), incremental = turns.filter(turn => turn.usage?.scope === 'turn'), cumulatives = new Map<string, typeof turns[number]>();
          for (const turn of turns) if (turn.usage?.scope !== 'turn' && turn.usage) { const old = cumulatives.get(turn.conversationId); if (!old || old.atMs < turn.atMs) cumulatives.set(turn.conversationId, turn); }
          const tokens = addCounts(incremental.flatMap(turn => {
            const u = turn.usage!;
            return [u.input, u.output, ...(u.inputIncludesCache === false ? [u.cachedInput, u.cacheCreated] : [])]
              .map(value => ({ known: value === undefined ? null : String(value), missing: value === undefined ? 1 : 0 }));
          }));
          return <div key={harness} className="usage-price-row"><span>{({ codex: 'Codex', claude: 'Claude Code', pi: 'Pi', acp: 'ACP' } as Record<string, string>)[harness]}<small>{turns.length} {t('usage.turns')} · {incremental.length ? `${count(tokens)} Token` : t('usage.notReported')}</small>{[...cumulatives.values()].map(turn => <small key={turn.conversationId}>{t(turn.usage?.scope === 'conversation' ? 'usage.cumulative' : 'usage.lastRequest')} · ↓ {turn.usage?.input?.toLocaleString() ?? '—'} · ↑ {turn.usage?.output?.toLocaleString() ?? '—'}</small>)}</span></div>;
        })}
      </section><p className="usage-scope">{t('usage.scope')}</p>
    </>}
    <Dialog open={inspect?.generation === generation} onOpenChange={open => { if (!open) setInspect(null); }}><DialogContent className="max-w-lg p-0"><DialogTitle className="sr-only">{t('usage.title')}</DialogTitle>{inspect?.generation === generation && <><ThreadTokenUsage identity={inspect.identity} /><Button className="m-4 mt-0" variant="outline" onClick={() => void openThreadFromNavigation(inspect.identity)}>{t('usage.openThread')}</Button></>}</DialogContent></Dialog>
  </SettingsPageLayout>;
}
