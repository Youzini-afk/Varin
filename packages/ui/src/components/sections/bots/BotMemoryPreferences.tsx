import React from 'react';
import { useI18n } from '@/lib/i18n';
import { SettingsSection, SettingsCheckboxRow } from '../shared/SettingsSection';
import { useHarnessSettings } from '../harness/useHarnessSettings';
import { HarnessModelField } from '../harness/HarnessModelField';

export function BotMemoryPreferences() {
  const { t } = useI18n();
  const { harness, update, error } = useHarnessSettings();
  return <SettingsSection title={t('settings.knowledge.automation.title')} settingsItem="knowledge.model">
    {error ? <p role="alert" className="text-destructive typography-meta">{error}</p> : null}
    {harness ? <>
      <HarnessModelField harness={harness} update={update} slot="memoryOrganizer" />
      {(['bot', 'user'] as const).map(scope => <SettingsCheckboxRow key={scope}
        label={t(`settings.knowledge.automation.autoOrganize.${scope}`)} checked={harness.knowledge.autoOrganize[scope]}
        onChange={enabled => update({ knowledge: { autoOrganize: { [scope]: enabled } } })} />)}
    </> : null}
  </SettingsSection>;
}
