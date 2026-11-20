import React from 'react';
import { requiresRetrievalModelSelection, type HarnessModelRole } from '@varin/protocol';
import { modelThinkingLevels } from '@varin/application-client';
import { ModelThinkingSelect } from '../shared/ModelThinkingSelect';
import { Row } from '../shared/kit';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { useConfigurationModels } from './ConfigurationModels';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function HarnessModelField({ harness, update, slot, enableControl = true, status, openModel, item = `harness.models.${slot}` }: HarnessSettingsPageProps & {
  slot: HarnessModelRole; enableControl?: boolean; status?: React.ReactNode; openModel?(): void; item?: string;
}) {
  const { t } = useI18n();
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const selected = harness.models[slot];
  const catalog = useConfigurationModels();
  const selectedModel = catalog.modelsFor(selected?.providerId ?? '', 'chat').find(model => model.id === selected?.modelId);
  const inherited = ['worker', 'verifier', 'explore', 'retrievalAgent', 'contextCompaction'].includes(slot);
  const label = t(`settings.harness.role.${slot}`);
  const emptyLabel = t(inherited ? 'settings.page.harness.models.mainModel' : 'settings.harness.models.noModel');
  const requiresSelection = slot === 'explore' && requiresRetrievalModelSelection(harness);
  const thinkingLevels = selectedModel ? modelThinkingLevels(selectedModel) : undefined;
  const changeModel = (providerId?: string, modelId?: string) => update({ models: { [slot]: {
    providerId, modelId, inherit: !modelId,
    ...(slot === 'permissionJudge' && modelId ? { enabled: true } : {}),
    agent: { modelSettings: { thinkingLevel: undefined } },
  } } });
  return <Row item={item} label={label} description={<>
    {slot !== 'explore' ? t(`settings.harness.role.${slot}.description`) : null}
    {requiresSelection ? <div className="text-[var(--status-warning)]">{t('settings.harness.retrieval.selectOrdinaryModel')}</div> : null}
    {status}
  </>}>
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {enableControl ? <Switch checked={selected?.enabled !== false} aria-label={label}
        onCheckedChange={(enabled) => update({ models: { [slot]: { enabled } } })} /> : null}
      <div className="min-w-0 w-52 max-w-full">
      {openModel ? <Button type="button" variant="outline" size="sm" className="w-full justify-start" onClick={openModel}>
        {selected?.modelId ? <ModelLogo modelId={selected.modelId} requestModelId={selectedModel?.requestModelId} displayName={selectedModel?.name} /> : null}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.modelId
          ? `${selectedModel?.name || selected.modelId} · ${catalog.providers.find(provider => provider.id === selected.providerId)?.name ?? selected.providerId}`
          : emptyLabel}</span>
        <Icon name="arrow-right-s" className="size-3.5" />
      </Button> : catalog.runtime === 'agent' ? <Select value={selected?.modelId ? JSON.stringify([selected.providerId, selected.modelId]) : requiresSelection ? '__required' : '__none'} onValueChange={key => {
        const [providerId, modelId] = key === '__none' ? [] : JSON.parse(key) as string[];
        changeModel(providerId, modelId);
      }}><SelectTrigger size="settings" className="w-full" aria-label={label}><SelectValue>{selected?.modelId ? <span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={selected.modelId} requestModelId={selectedModel?.requestModelId} displayName={selectedModel?.name} /><span className="truncate">{selectedModel?.name || selected.modelId} · {catalog.providers.find(provider => provider.id === selected.providerId)?.name ?? selected.providerId}</span></span> : requiresSelection ? t('settings.page.harness.models.notConfigured') : emptyLabel}</SelectValue></SelectTrigger><SelectContent>
        {requiresSelection ? <SelectItem value="__required" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem> : null}
        <SelectItem value="__none">{emptyLabel}</SelectItem>{catalog.providers.flatMap(provider => catalog.modelsFor(provider.id, 'chat').map(model => <SelectItem key={JSON.stringify([provider.id, model.id])} value={JSON.stringify([provider.id, model.id])}><span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} /><span className="truncate">{model.name ?? model.id} · {provider.name}</span></span></SelectItem>))}
      </SelectContent></Select> : <ModelSelector cwd={cwd} providerId={selected?.providerId ?? ''} modelId={selected?.modelId ?? ''}
        className="w-full max-w-none" allowNone placeholder={emptyLabel} defaultSelectionLabel={emptyLabel}
        onChange={(providerId, modelId) => changeModel(providerId || undefined, modelId || undefined)} />}
      </div>
      <ModelThinkingSelect value={selected?.agent?.modelSettings?.thinkingLevel} levels={thinkingLevels} defaultLevel={thinkingLevels?.[0]}
        className="w-auto min-w-24" disabled={enableControl && selected?.enabled === false} label={`${label} · ${t('settings.varin.agents.detail.thinking')}`}
        onChange={thinkingLevel => update({ models: { [slot]: { agent: { modelSettings: { thinkingLevel } } } } })} />
    </div>
  </Row>;
}
