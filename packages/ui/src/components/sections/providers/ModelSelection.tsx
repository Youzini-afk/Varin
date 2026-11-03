import React from 'react';
import type { ChannelModel, ChannelTypeInfo, DiscoveredModel } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { modelCandidates } from './model-edits';
import './model-connections.css';

/** Shared by the new-service flow and the existing service's add-model dialog. */
export function ModelPicker({ available, initialIds = [], busy, onConfirm, confirmLabel }: {
  available: DiscoveredModel[]; initialIds?: string[]; busy: boolean;
  onConfirm(entries: DiscoveredModel[]): void; confirmLabel?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [manual, setManual] = React.useState('');
  const [picked, setPicked] = React.useState(() => new Set(initialIds));
  const [manualModels, setManualModels] = React.useState<DiscoveredModel[]>([]);
  const entries = [...available, ...manualModels.filter(model => !available.some(entry => entry.id === model.id))];
  const filtered = entries.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string, checked: boolean) => setPicked(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  const addManual = () => {
    const ids = [...new Set(manual.split(/[,\n]/).map(id => id.trim()).filter(Boolean))];
    setManualModels(previous => [...previous, ...ids.filter(id => !previous.some(model => model.id === id)).map(id => ({ id, name: id }))]);
    setPicked(previous => new Set([...previous, ...ids])); setManual('');
  };
  const selected = entries.filter(model => picked.has(model.id));
  return <div className="space-y-4">
    <Input aria-label={t('settings.models.filterModels')} placeholder={t('settings.models.filterModels')} value={query} onChange={event => setQuery(event.target.value)} />
    {entries.length ? <>
      <div className="flex items-center justify-between gap-3"><label className="flex items-center gap-2 typography-meta"><Checkbox ariaLabel={t('settings.models.selectAll')} checked={filtered.length > 0 && filtered.every(model => picked.has(model.id))} disabled={busy || !filtered.length} onChange={checked => setPicked(previous => { const next = new Set(previous); filtered.forEach(model => checked ? next.add(model.id) : next.delete(model.id)); return next; })} />{t('settings.models.selectAll')}</label><span className="typography-micro text-muted-foreground">{filtered.length}</span></div>
      <div className="max-h-[40dvh] overflow-y-auto divide-y divide-border/40">
        {filtered.map(model => <label key={model.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-3 hover:bg-interactive-hover"><Checkbox ariaLabel={model.name || model.id} checked={picked.has(model.id)} disabled={busy} onChange={checked => toggle(model.id, checked)} /><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} /><span className="min-w-0"><span className="block truncate typography-meta">{model.name || model.id}</span>{model.name !== model.id ? <span className="block truncate typography-micro text-muted-foreground">{model.id}</span> : null}</span></label>)}
        {!filtered.length ? <p className="py-4 typography-meta text-muted-foreground">{t('settings.models.noMatches')}</p> : null}
      </div>
    </> : <p className="typography-meta text-muted-foreground">{t('settings.models.manualHint')}</p>}
    <div className="flex gap-2 border-t border-border/50 pt-4"><Input aria-label={t('settings.models.modelId')} placeholder={t('settings.models.modelIdsPlaceholder')} value={manual} disabled={busy} onChange={event => setManual(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && manual.trim()) { event.preventDefault(); addManual(); } }} /><Button variant="outline" disabled={busy || !manual.trim()} onClick={addManual}>{t('settings.models.addModel')}</Button></div>
    <div className="flex justify-end"><Button disabled={busy} onClick={() => onConfirm(selected)}>{confirmLabel ?? t('settings.models.addSelected')} · {selected.length}</Button></div>
  </div>;
}

export function ModelSelection({ models, type, candidates, busy, usages, onToggle, onAdd, onConfigure, onDiscover }: {
  models: ChannelModel[]; type: ChannelTypeInfo; candidates: DiscoveredModel[]; busy: boolean;
  usages: Record<string, string[]>;
  onToggle(id: string, enabled: boolean): void; onAdd(entries: DiscoveredModel[]): Promise<boolean>;
  onConfigure(id: string): void; onDiscover(): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = React.useState(false);
  const available = modelCandidates(type, candidates).filter(candidate => !models.some(model => model.id === candidate.id));
  const missing = models.filter(model => model.enabled && model.operations.includes('chat') && !model.description?.trim()).length;
  return <section className="mt-8 border-t border-border/60 pt-6">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="typography-ui-label">{t('settings.models.models')} <span className="ml-1 text-muted-foreground">{models.length}</span></h2>
      <div className="flex gap-2">{type.discovery ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void onDiscover().then(ok => { if (ok) setPicking(true); }); }}><Icon name="refresh" className="size-3.5" />{t('settings.models.discover')}</Button> : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}><Icon name="add" className="size-3.5" />{t('settings.models.addModel')}</Button>
      </div>
    </div>
    <p className="mb-3 typography-micro text-muted-foreground">{t('settings.models.instantSave')}{missing ? ` · ${t('settings.models.missingDescriptions').replace('{count}', String(missing))}` : ''}</p>
    <div className="model-service-list divide-y divide-border/50">
      {models.map(model => {
        const description = model.description?.trim();
        const operations = model.operations.filter(operation => operation !== 'chat');
        const hasCapabilities = Boolean(model.input?.includes('image') || model.reasoning || operations.length);
        const roles = usages[model.id] ?? [];
        return <div key={model.id} data-enabled={model.enabled} className="model-service-row flex items-start gap-3">
          <button type="button" aria-label={model.name || model.id} onClick={() => onConfigure(model.id)} className="model-service-row-main group flex min-w-0 flex-1 items-start gap-3 rounded-lg py-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1"><span className="model-service-row-name break-all typography-ui-label font-semibold">{model.name || model.id}</span>{model.name !== model.id ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{model.id}</span> : null}</span>
              {description || model.enabled && model.operations.includes('chat') ? <span data-empty={!description} className="model-service-row-description mt-1.5 block truncate typography-meta">{description || t('settings.models.missingDescription')}</span> : null}
              {hasCapabilities || roles.length ? <span className="model-service-row-meta mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5 typography-micro">
                {hasCapabilities ? <span className="flex flex-wrap items-center gap-1.5">
                  {model.input?.includes('image') ? <span className="model-capability" data-capability="vision"><Icon name="eye" className="size-3" />{t('settings.models.imageInput')}</span> : null}
                  {model.reasoning ? <span className="model-capability" data-capability="reasoning"><Icon name="brain" className="size-3" />{t('settings.models.reasoning')}</span> : null}
                  {operations.map(operation => <span key={operation} className="model-capability" data-capability="operation">{t(`settings.models.operation.${operation}`)}</span>)}
                </span> : null}
                {roles.length ? <span className="model-service-row-usage flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1.5">
                  <span className="model-service-row-usage-label shrink-0">{t('settings.models.usedFor')}</span>
                  {roles.map((role, index) => <span key={`${role}:${index}`} className="model-service-row-role">{role}</span>)}
                </span> : null}
              </span> : null}
            </span>
            <Icon name="arrow-right-s" className="model-service-row-arrow mt-0.5 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
          </button>
          <Switch className="mt-5 shrink-0" aria-label={`${t('settings.models.enabled')}: ${model.name || model.id}`} checked={model.enabled} onCheckedChange={enabled => onToggle(model.id, enabled)} />
        </div>;
      })}
      {!models.length ? <p className="py-5 typography-meta text-muted-foreground">{t('settings.models.noModels')}</p> : null}
    </div>
    <Dialog open={picking} onOpenChange={setPicking}>
      <DialogContent className="max-w-xl"><DialogTitle>{t('settings.models.addModel')}</DialogTitle>
        <ModelPicker available={available} busy={busy} onConfirm={entries => { void onAdd(entries).then(ok => { if (ok) setPicking(false); }); }} />
      </DialogContent>
    </Dialog>
  </section>;
}
