import React from 'react';
import { requiresRetrievalModelSelection, type HarnessModelRole } from '@varin/protocol';
import { modelThinkingLevels } from '@varin/application-client';
import { ModelThinkingSelect } from '../shared/ModelThinkingSelect';
import { SettingsFieldRow } from '../shared/SettingsSection';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Switch } from '@/components/ui/switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { useConfigurationModels } from './ConfigurationModels';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function HarnessModelField({ harness, update, slot, enableControl = true }: HarnessSettingsPageProps & { slot: HarnessModelRole; enableControl?: boolean }) {
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
    providerId, modelId, inherit: !modelId, agent: { modelSettings: { thinkingLevel: undefined } },
  } } });
  return <div data-settings-item={`harness.models.${slot}`}><div className="flex min-w-0 flex-col gap-2 py-2 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-3"><p className="typography-settings-field-label">{label}</p>
        {enableControl && <Switch checked={selected?.enabled !== false} aria-label={label}
          onCheckedChange={(enabled) => update({ models: { [slot]: { enabled } } })} />}</div>
      {slot !== 'explore' ? <p className="mt-1 typography-meta text-muted-foreground">{t(`settings.harness.role.${slot}.description`)}</p> : null}
    </div>
    <div className="w-full min-w-0 @xl:w-72 @xl:shrink-0">
      {catalog.runtime === 'agent' ? <Select value={selected?.modelId ? JSON.stringify([selected.providerId, selected.modelId]) : requiresSelection ? '__required' : '__none'} onValueChange={key => {
        const [providerId, modelId] = key === '__none' ? [] : JSON.parse(key) as string[];
        changeModel(providerId, modelId);
      }}><SelectTrigger size="settings" className="w-full" aria-label={label}><SelectValue>{selected?.modelId ? <span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={selected.modelId} requestModelId={selectedModel?.requestModelId} displayName={selectedModel?.name} /><span className="truncate">{selectedModel?.name || selected.modelId}</span></span> : requiresSelection ? t('settings.page.harness.models.notConfigured') : emptyLabel}</SelectValue></SelectTrigger><SelectContent>
        {requiresSelection ? <SelectItem value="__required" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem> : null}
        <SelectItem value="__none">{emptyLabel}</SelectItem>{catalog.providers.flatMap(provider => catalog.modelsFor(provider.id, 'chat').map(model => <SelectItem key={JSON.stringify([provider.id, model.id])} value={JSON.stringify([provider.id, model.id])}><span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} /><span className="truncate">{model.name ?? model.id} · {provider.name}</span></span></SelectItem>))}
      </SelectContent></Select> : <ModelSelector cwd={cwd} providerId={selected?.providerId ?? ''} modelId={selected?.modelId ?? ''}
        className="w-full max-w-none" allowNone placeholder={emptyLabel} defaultSelectionLabel={emptyLabel}
        onChange={(providerId, modelId) => changeModel(providerId || undefined, modelId || undefined)} />}
      {requiresSelection ? <p className="mt-1 typography-meta text-[var(--status-warning)]">{t('settings.harness.retrieval.selectOrdinaryModel')}</p> : !selected?.modelId ? <p className="mt-1 typography-meta text-muted-foreground">{t(inherited
        ? 'settings.page.harness.models.slot.mainFallback' : 'settings.page.harness.models.slot.optional')}</p> : null}
    </div>
  </div>
    <SettingsFieldRow label={t('settings.varin.agents.detail.thinking')}>
      <ModelThinkingSelect value={selected?.agent?.modelSettings?.thinkingLevel} levels={thinkingLevels} defaultLevel={thinkingLevels?.[0]}
        disabled={selected?.enabled === false} label={`${label} · ${t('settings.varin.agents.detail.thinking')}`}
        onChange={thinkingLevel => update({ models: { [slot]: { agent: { modelSettings: { thinkingLevel } } } } })} />
    </SettingsFieldRow>
  </div>;
}
