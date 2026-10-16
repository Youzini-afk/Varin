import React from 'react';
import type { ChannelModel, ChannelTypeInfo, DiscoveredModel } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ModelCommonSettings } from './ModelCommonSettings';

interface Props {
  models: ChannelModel[]; type: ChannelTypeInfo; candidates: DiscoveredModel[]; busy: boolean;
  onChange(models: ChannelModel[]): void;
  onConfigure(id: string): void;
  onDiscover(): Promise<boolean>;
  validity(modelId: string, field: string, valid: boolean): void;
}
export function ModelSelection({ models, type, candidates, busy, onChange, onConfigure, onDiscover, validity }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [manual, setManual] = React.useState('');
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());
  const available = [...candidates, ...(type.catalog ?? []).filter(model => !candidates.some(candidate => candidate.id === model.id))]
    .filter(candidate => !models.some(model => model.id === candidate.id));
  const matches = (model: { id: string; name: string }) => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase());
  const filtered = available.filter(matches);
  const selected = available.filter(model => picked.has(model.id));
  const add = (entries: DiscoveredModel[]) => {
    const seen = new Set(models.map(model => model.id));
    const added: ChannelModel[] = [];
    for (const entry of entries) {
      const id = entry.id.trim(); if (!id || seen.has(id)) continue; seen.add(id);
      const catalog = type.catalog?.find(model => model.id === id);
      const operations = (entry.operations ?? catalog?.operations)?.filter(operation => type.operations.includes(operation));
      const compat = { ...(type.id === 'deepseek' ? { thinkingFormat: 'deepseek' } : type.id === 'openrouter' ? { thinkingFormat: 'openrouter' } : {}), ...catalog?.compat, ...entry.compat };
      added.push({ ...structuredClone(catalog), ...structuredClone(entry), id, name: entry.name && entry.name !== id ? entry.name : catalog?.name || entry.name || id, enabled: true,
        operations: operations?.length ? operations : type.operations.includes('chat') ? ['chat'] : [type.operations[0]!],
        ...(Object.keys(compat).length ? { compat } : {}),
      });
    }
    onChange([...models, ...added]); setPicked(new Set()); setManual('');
  };
  return <section className="mt-7 border-t border-border/60 pt-6">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="typography-ui-label">{t('settings.models.models')} <span className="ml-1 text-muted-foreground">{models.length}</span></h2>
      <div className="flex gap-2">{type.discovery ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void onDiscover().then(ok => { if (ok) { setPicking(true); setQuery(''); } }); }}><Icon name="refresh" className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />{t('settings.models.discover')}</Button> : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPicking(value => !value); setQuery(''); }}><Icon name="add" className="size-3.5" />{t('settings.models.addModel')}</Button>
      </div>
    </div>
    {picking ? <div className="mb-5 rounded-xl border border-border/60 bg-muted/15 p-4">
      <div className="mb-3 flex items-center gap-2"><Input aria-label={t('settings.models.filterModels')} placeholder={t('settings.models.filterModels')} value={query} onChange={event => setQuery(event.target.value)} />
        <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>{t('settings.models.close')}</Button></div>
      {available.length ? <>
        <div className="mb-2 flex items-center justify-between gap-3"><label className="flex items-center gap-2 typography-meta"><Checkbox ariaLabel={t('settings.models.selectAll')} checked={filtered.length > 0 && filtered.every(model => picked.has(model.id))} disabled={busy || !filtered.length} onChange={checked => setPicked(previous => { const next = new Set(previous); filtered.forEach(model => checked ? next.add(model.id) : next.delete(model.id)); return next; })} />{t('settings.models.selectAll')}</label><span className="typography-micro text-muted-foreground">{filtered.length}</span></div>
        <div className="max-h-72 overflow-y-auto divide-y divide-border/40 rounded-lg border border-border/50">
          {filtered.map(model => <label key={model.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-interactive-hover"><Checkbox ariaLabel={model.name} checked={picked.has(model.id)} disabled={busy} onChange={checked => setPicked(previous => { const next = new Set(previous); if (checked) next.add(model.id); else next.delete(model.id); return next; })} /><ModelLogo modelId={model.id} displayName={model.name} /><span className="min-w-0"><span className="block truncate typography-meta">{model.name}</span>{model.name !== model.id ? <span className="block truncate typography-micro text-muted-foreground">{model.id}</span> : null}</span></label>)}
          {!filtered.length ? <p className="p-4 typography-meta text-muted-foreground">{t('settings.models.noMatches')}</p> : null}
        </div>
        <div className="mt-3 flex justify-end"><Button size="sm" disabled={busy || !selected.length} onClick={() => add(selected)}>{t('settings.models.addSelected')} · {selected.length}</Button></div>
      </> : <p className="mb-4 typography-meta text-muted-foreground">{t('settings.models.manualHint')}</p>}
      <div className="mt-4 flex gap-2 border-t border-border/50 pt-4"><Input aria-label={t('settings.models.modelId')} placeholder={t('settings.models.modelIdsPlaceholder')} value={manual} disabled={busy} onChange={event => setManual(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && manual.trim()) { event.preventDefault(); add(manual.split(/[,\n]/).map(id => ({ id: id.trim(), name: id.trim() }))); } }} /><Button variant="outline" disabled={busy || !manual.trim()} onClick={() => add(manual.split(/[,\n]/).map(id => ({ id: id.trim(), name: id.trim() })))}>{t('settings.models.addModel')}</Button></div>
    </div> : null}
    <div className="divide-y divide-border/60">
      {models.map(model => <Collapsible key={model.id}>
        <div className="flex items-center gap-4 py-2">
          <CollapsibleTrigger aria-label={model.name || model.id} disabled={busy} className="group min-w-0 flex-1 justify-start gap-3 px-0 py-3">
            <ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} />
            <span className="min-w-0 flex-1"><span className="block truncate typography-ui-label">{model.name || model.id}</span>{model.name && model.name !== model.id ? <span className="mt-1 block truncate typography-micro text-muted-foreground">{model.id}</span> : null}</span>
            <span className="hidden flex-wrap justify-end gap-1 @2xl:flex">{model.input?.includes('image') ? <span className="rounded bg-muted px-2 py-1 typography-micro text-muted-foreground">{t('settings.models.imageInput')}</span> : null}{model.reasoning ? <span className="rounded bg-muted px-2 py-1 typography-micro text-muted-foreground">{t('settings.models.reasoning')}</span> : null}{model.operations.filter(operation => operation !== 'chat').map(operation => <span key={operation} className="rounded bg-muted px-2 py-1 typography-micro text-muted-foreground">{t(`settings.models.operation.${operation}`)}</span>)}</span>
            <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded:rotate-180 motion-reduce:transition-none" />
          </CollapsibleTrigger>
          <Switch aria-label={`${t('settings.models.enabled')}: ${model.name || model.id}`} checked={model.enabled} disabled={busy} onCheckedChange={enabled => onChange(models.map(value => value.id === model.id ? { ...value, enabled } : value))} />
        </div>
        <CollapsibleContent className="h-[var(--collapsible-panel-height)] transition-[height,opacity] duration-200 ease-out data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0 motion-reduce:transition-none">
          <div className="mb-4 space-y-4 rounded-xl border border-border/50 bg-muted/15 p-4 @xl:ml-8 @xl:p-5">
            {model.operations.includes('chat') ? <ModelCommonSettings model={model} disabled={busy} onChange={next => onChange(models.map(value => value.id === model.id ? next : value))} validity={(field, valid) => validity(model.id, field, valid)} /> : null}
            <div className="flex justify-end"><Button variant="ghost" size="sm" disabled={busy} onClick={() => onConfigure(model.id)}>{t('settings.models.advanced')}<Icon name="arrow-right-s" className="size-4" /></Button></div>
          </div>
        </CollapsibleContent>
      </Collapsible>)}
      {!models.length ? <p className="py-5 typography-meta text-muted-foreground">{t('settings.models.noModels')}</p> : null}
    </div>
  </section>;
}
