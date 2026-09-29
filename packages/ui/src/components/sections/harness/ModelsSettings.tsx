import React from 'react';
import { applyHarnessModelPreset, type HarnessModelRole, type HarnessModelPreset } from '@varin/protocol';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { HarnessModelField } from './HarnessModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';

const groups = [
  { key: 'retrieval', slots: ['explore', 'retrievalAgent'] },
  { key: 'execution', slots: ['quickImplement', 'hardImplement', 'frontend'] },
  { key: 'assistance', slots: ['review', 'check', 'reader', 'permissionJudge', 'nextStep', 'memoryOrganizer'] },
  { key: 'research', slots: ['researchInvestigation', 'researchExperimentalDesign', 'researchFastExploration', 'researchHighThroughputExecution'] },
] as const satisfies readonly { key: string; slots: readonly HarnessModelRole[] }[];

export function ModelsSettings(props: HarnessSettingsPageProps) {
  const { harness, update } = props;
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
  const [preset, setPreset] = React.useState<HarnessModelPreset | null>(null);
  const preview = preset ? providers.map((provider) => applyHarnessModelPreset(preset, {
    providerId: provider.id, modelIds: provider.models.filter((model) => model.available).map((model) => model.id),
  })).find((slots) => Object.keys(slots).length) : undefined;
  const additions = Object.entries(preview ?? {}).filter(([slot]) => !harness.models[slot as HarnessModelRole]);
  return <>
    <SettingsSection title={t('settings.page.harness.nextStep.title')} settingsItem="harness.nextStep" contentClassName="space-y-3">
      <SettingsCheckboxRow checked={harness.nextStep.enabled}
        onChange={(enabled) => update({ nextStep: { enabled } })}
        label={t('settings.page.harness.nextStep.enabled')} ariaLabel={t('settings.page.harness.nextStep.enabled')}
        description={t('settings.page.harness.nextStep.description')} />
    </SettingsSection>
    {groups.map((group) => <SettingsSection key={group.key} title={t(`settings.harness.models.${group.key}`)} settingsItem={`harness.models.${group.key}`} contentClassName="space-y-3">
      {group.slots.map((slot) => <HarnessModelField key={slot} {...props} slot={slot} />)}
    </SettingsSection>)}
    <SettingsSection title={t('settings.page.harness.section.review')} settingsItem="harness.review" contentClassName="space-y-4">
      <SettingsCheckboxRow checked={harness.review.enabled} onChange={(enabled) => update({ review: { enabled } })}
        label={t('settings.page.harness.review.enabled')} ariaLabel={t('settings.page.harness.review.enabled')}
        description={t('settings.page.harness.section.review.description')} />
      {harness.review.enabled ? <SettingsCheckboxRow checked={harness.review.gate} onChange={(gate) => update({ review: { gate } })}
        label={t('settings.page.harness.review.gate')} ariaLabel={t('settings.page.harness.review.gate')}
        description={t('settings.page.harness.review.gate.description')} /> : null}
    </SettingsSection>
    <SettingsSection>
      <details>
        <summary className="cursor-pointer typography-settings-field-label">{t('settings.harness.models.batch')}</summary>
        <p className="my-3 typography-meta text-muted-foreground">{t('settings.page.harness.models.presetDescription')}</p>
        <div className="flex flex-wrap gap-2">{(['anthropic', 'openai', 'gemini'] as const).map((value) => <Button
          key={value} size="sm" variant={preset === value ? 'secondary' : 'outline'} onClick={() => setPreset(value)}
          aria-pressed={preset === value}>{value === 'anthropic' ? 'Anthropic' : value === 'openai' ? 'OpenAI' : 'Gemini'}</Button>)}</div>
        {preset ? <div className="mt-3 space-y-2">
          {additions.length ? <>
            {additions.map(([slot, model]) => <div key={slot} className="flex flex-wrap justify-between gap-2 typography-meta">
              <span>{t(`settings.harness.role.${slot as HarnessModelRole}`)}</span><span>{model.providerId} / {model.modelId}</span>
            </div>)}
            <Button size="sm" onClick={() => { update({ models: Object.fromEntries(additions) }); setPreset(null); }}>{t('settings.harness.models.fillEmpty')}</Button>
          </> : <p className="typography-meta text-muted-foreground">{t('settings.harness.models.noChanges')}</p>}
        </div> : null}
      </details>
    </SettingsSection>
  </>;
}
