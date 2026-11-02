import React from 'react';
import { modelThinkingLevels } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsCheckboxRow, SettingsFieldRow, SettingsSection } from '../shared/SettingsSection';
import { ModelThinkingSelect } from '../shared/ModelThinkingSelect';
import { useModelChannels } from './ConfigurationModels';
import { useWorkspaceHarnessSettings } from './useHarnessSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';

/** A purpose binding, not another Agent profile or conversation loop. */
export function DelegationModelSelectionSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const catalog = useModelChannels();
  const selection = harness.delegationModelSelection;
  const candidates = catalog.channels.filter(channel => channel.enabled).flatMap(channel => channel.models
    .filter(model => model.enabled && (model.operations.includes('chat') || model.operations.includes('decision')))
    .map(model => ({ channel, model, key: JSON.stringify([channel.id, model.id]) })));
  const key = selection.model ? JSON.stringify([selection.model.providerId, selection.model.modelId]) : '__none';
  const selected = candidates.find(candidate => candidate.key === key);
  const levels = selected && !selected.model.operations.includes('decision') ? modelThinkingLevels(selected.model) : undefined;
  const label = t('settings.delegationModelSelection.model');
  return <SettingsSection settingsItem="harness.delegationModelSelection" divider={false}>
    <SettingsCheckboxRow checked={selection.enabled} disabled={!selection.enabled && !selected}
      label={t('settings.delegationModelSelection.enabled')} ariaLabel={t('settings.delegationModelSelection.enabled')}
      onChange={enabled => update({ delegationModelSelection: { enabled } })} />
    {catalog.error ? <p role="alert" className="typography-meta text-destructive">{catalog.error}</p> : null}
    <SettingsFieldRow label={label}>
      <Select value={key} onValueChange={value => {
        const candidate = candidates.find(entry => entry.key === value);
        if (value !== '__none' && !candidate) return;
        update({ delegationModelSelection: { model: candidate ? { providerId: candidate.channel.id, modelId: candidate.model.id } : undefined,
          thinkingLevel: undefined, ...(!candidate ? { enabled: false } : {}) } });
      }}>
        <SelectTrigger size="settings" className="w-72 max-w-full" aria-label={label}>
          <SelectValue>{selected ? <span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={selected.model.id} requestModelId={selected.model.requestModelId} displayName={selected.model.name} /><span className="truncate">{selected.model.name} · {selected.channel.name}</span></span>
            : selection.model ? `${selection.model.modelId} · ${selection.model.providerId}` : t('settings.harness.models.noModel')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t('settings.harness.models.noModel')}</SelectItem>
          {selection.model && !selected ? <SelectItem value={key} disabled>{selection.model.modelId} · {selection.model.providerId}</SelectItem> : null}
          {candidates.map(candidate => <SelectItem key={candidate.key} value={candidate.key}>
            <span className="flex min-w-0 items-center gap-2"><ModelLogo modelId={candidate.model.id} requestModelId={candidate.model.requestModelId} displayName={candidate.model.name} /><span className="truncate">{candidate.model.name} · {candidate.channel.name}</span></span>
          </SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {!selected ? <p role="status" className="typography-meta text-muted-foreground">{t(selection.model ? 'settings.delegationModelSelection.unavailable' : 'settings.delegationModelSelection.chooseModel')}</p> : null}
    {levels ? <SettingsFieldRow label={t('settings.delegationModelSelection.thinking')} description={t('settings.delegationModelSelection.thinkingHint')}>
      <ModelThinkingSelect value={selection.thinkingLevel} levels={levels} label={t('settings.delegationModelSelection.thinking')}
        onChange={thinkingLevel => update({ delegationModelSelection: { thinkingLevel } })} />
    </SettingsFieldRow> : null}
  </SettingsSection>;
}

export function DelegationModelSelectionPage() {
  const { t } = useI18n();
  const { harness, update, status, error, retry, targetKey } = useWorkspaceHarnessSettings();
  return <SettingsPageLayout title={t('settings.delegationModelSelection.title')}
    description={t('settings.delegationModelSelection.description')} scope={t('settings.scope.hostGlobalHint')} showSaveStatus>
    {status === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {error ? <div role="alert" className="mb-4 space-y-2">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" onClick={() => { void retry(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {harness ? <DelegationModelSelectionSettings key={targetKey} harness={harness} update={update} /> : null}
  </SettingsPageLayout>;
}
