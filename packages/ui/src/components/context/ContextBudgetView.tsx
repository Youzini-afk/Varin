import React from 'react';
import type { ThreadSnapshot, ThreadContextInspection } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { threadContextModel, type ThreadContextUsage } from '@/stores/useThreadContextUsageStore';
import './context-manager.css';

const categories = ['system', 'user', 'assistant', 'tools', 'mcp', 'summary', 'other'] as const;
type Category = typeof categories[number];
const labels: Record<Category, I18nKey> = {
  system: 'contextManager.category.system', user: 'contextManager.category.user', assistant: 'contextManager.category.assistant',
  tools: 'contextManager.category.tools', mcp: 'contextManager.category.mcp', summary: 'contextManager.category.summary', other: 'contextManager.category.other',
};
const parts: Record<string, I18nKey> = { definitions: 'contextManager.part.definitions', calls: 'contextManager.part.calls', results: 'contextManager.part.results', messages: 'contextManager.part.messages', envelope: 'contextManager.part.envelope' };
const number = (n: number) => n.toLocaleString();
export function ContextBudgetView({ snapshot, inspection, usage }: { snapshot: ThreadSnapshot; inspection?: ThreadContextInspection; usage?: ThreadContextUsage | null }) {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState<Category | null>(null), [hovered, setHovered] = React.useState<Category | null>(null);
  const [detail, setDetail] = React.useState<Category | null>(null);
  const select = (key: Category) => { setDetail(key); setSelected(selected === key ? null : key); };
  const model = threadContextModel(snapshot), policy = snapshot.context.policy;
  const capacity = model?.contextWindowTokens ?? policy?.capacityTokens;
  const request = inspection?.contextRequest ?? inspection?.latestRequest;
  const composition = request && request.modelId === model?.model && request.providerFamily === model?.providerFamily ? request.context : undefined;
  const pending = Boolean(inspection?.latestRequest && !inspection.contextRequest);
  const total = composition?.totalTokens ?? usage?.totalTokens;
  const percentage = total !== undefined && capacity ? total / capacity * 100 : undefined;
  const replace = policy && capacity ? Math.max(0, 1 - policy.reserveTokens / capacity) * 100 : undefined;
  const prepare = replace !== undefined && policy?.backgroundPreparation ? replace * policy.preparationWaterline : undefined;
  const detailId = React.useId(), highlight = hovered ?? selected;
  const visible = categories.filter(key => (composition?.categories[key] ?? 0) > 0 || key === 'other' && !!(composition?.unmeasuredMedia || composition?.unmeasuredProviderItems));
  return <section className="context-budget-view" aria-label={t('contextSidebar.section.context')} data-pending={pending} data-highlight={highlight ?? ''}>
    <div className="context-budget-caption"><span>{t(pending ? 'contextManager.previousContext' : 'contextManager.currentContext')}</span><small>{t(composition ? 'contextManager.classifiedEstimate' : 'contextManager.lastMeasurement')}</small></div>
    <div className="context-budget-total"><strong>{pending ? t('contextManager.awaitMeasurement') : percentage === undefined ? '—' : <>{percentage.toFixed(1)}<small>%</small></>}</strong>
      <span>{total === undefined ? '—' : number(total)} / {capacity ? number(capacity) : '—'}</span></div>
    <div className="context-budget-scale" aria-hidden="true">{[0, 25, 50, 75, 100].map(n => <span key={n}>{n}%</span>)}</div>
    <div className="context-budget-track" role="group" aria-label={t('contextManager.composition')}>
      {replace !== undefined && <div className="context-budget-reserve" style={{ left: `${replace}%` }} />}
      <div className="context-budget-segments">
        {capacity && composition ? visible.map(key => <Tooltip key={key}><TooltipTrigger asChild>
          <button type="button" className="context-budget-segment" data-category={key} data-highlighted={highlight === key}
            style={{ width: `${(composition.categories[key] ?? 0) / capacity * 100}%` }}
            aria-label={`${t(labels[key])}: ${number(composition.categories[key] ?? 0)}`} aria-controls={detailId} aria-expanded={selected === key}
            onPointerEnter={() => setHovered(key)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(key)} onBlur={() => setHovered(null)}
            onClick={() => select(key)} />
        </TooltipTrigger><TooltipContent>{t(labels[key])} · {number(composition.categories[key] ?? 0)} tokens · {((composition.categories[key] ?? 0) / capacity * 100).toFixed(1)}%</TooltipContent></Tooltip>)
          : percentage !== undefined && <div className="context-budget-unclassified" style={{ width: `${Math.min(100, percentage)}%` }} />}
      </div>
      {[[prepare, 'prepare'], [replace, 'replace']] .map(([position, kind]) => typeof position === 'number' && policy?.enabled && <Tooltip key={kind}><TooltipTrigger asChild>
        <span className="context-budget-tick" tabIndex={0} style={{ left: `${position}%` }} aria-label={t(kind === 'prepare' ? 'contextManager.prepareMarker' : 'contextManager.replaceMarker', { percent: position.toFixed(2) })} />
      </TooltipTrigger><TooltipContent>{t(kind === 'prepare' ? 'contextManager.prepareMarker' : 'contextManager.replaceMarker', { percent: position.toFixed(2) })}</TooltipContent></Tooltip>)}
    </div>
    <div className="context-budget-boundaries" aria-hidden="true">
      {policy?.enabled && prepare !== undefined && <span style={{ left: `${prepare}%` }}>{t('contextManager.prepareTick')}<small>{Number(prepare.toFixed(2))}%</small></span>}
      {policy?.enabled && replace !== undefined && <span style={{ left: `${replace}%` }}>{t('contextManager.replaceTick')}<small>{Number(replace.toFixed(2))}%</small></span>}
    </div>
    <div className="context-budget-footnote"><span>{pending ? t('contextManager.measureAfterReplacement') : percentage === undefined || replace === undefined ? t('contextManager.waitForRequest')
      : percentage >= replace ? t('contextManager.atReplace') : t('contextManager.untilReplace', { percent: (replace - percentage).toFixed(1) })}</span>
      {replace !== undefined && <span>{t('contextManager.reserve', { percent: Number((100 - replace).toFixed(2)) })}</span>}</div>
    {composition ? <>
      <div className="context-composition-caption"><span>{t('contextManager.composition')}</span><span>{t('contextManager.windowShare')}</span></div>
      <div className="context-composition-legend">{visible.map(key => <button key={key} type="button" data-category={key} data-highlighted={highlight === key}
        aria-expanded={selected === key} aria-controls={detailId} onClick={() => select(key)}
        onPointerEnter={() => setHovered(key)} onPointerLeave={() => setHovered(null)}>
        <i /><span>{t(labels[key])}</span><b>{capacity ? ((composition.categories[key] ?? 0) / capacity * 100).toFixed(1) + '%' : number(composition.categories[key] ?? 0)}</b>
      </button>)}</div>
      {!!(composition.unmeasuredMedia || composition.unmeasuredProviderItems) && <p className="context-measurement-note">{t('contextManager.unmeasured')}</p>}
      <div className="context-category-fold context-fold" data-open={!!selected} id={detailId} inert={!selected} aria-hidden={!selected}><div>{detail && <div className="context-category-detail">
        <header><strong>{t(labels[detail])} · {number(composition.categories[detail] ?? 0)} tokens</strong><button type="button" aria-label={t('dialog.common.actions.close')} onClick={() => setSelected(null)}><Icon name="close" className="size-3" /></button></header>
        {Object.entries(composition.parts[detail] ?? {}).map(([part, value]) => <div className="context-category-part" key={part}><span>{t(parts[part] ?? 'contextManager.part.envelope')}</span><span>{number(value)}</span></div>)}
        <p>{t(`contextManager.categoryHint.${detail}`)}</p>
      </div>}</div></div>
    </> : <p className="context-measurement-note">{t('contextManager.compositionUnavailable')}</p>}
  </section>;
}
