import { useI18n } from '@/lib/i18n';
import { SettingsSection, SettingsCheckboxRow } from '../shared/SettingsSection';
import { HarnessModelField } from './HarnessModelField';
import { useHarnessSettings } from './useHarnessSettings';

export function NextStepSettings() {
  const { t } = useI18n();
  const { harness, update, error, retry } = useHarnessSettings();
  if (!harness) return <p role={error ? 'alert' : 'status'} className="typography-meta">{error || t('common.loading')}{error && <button type="button" onClick={() => void retry()}>{t('settings.harness.retry')}</button>}</p>;
  return <SettingsSection title={t('settings.page.harness.nextStep.title')} settingsItem="harness.next-step" description={t('settings.scope.hostGlobalHint')} contentClassName="space-y-3">
      <SettingsCheckboxRow checked={harness.nextStep.enabled && harness.models.nextStep?.enabled !== false}
        onChange={enabled => update({ nextStep: { enabled }, models: { nextStep: { enabled } } })}
        label={t('settings.page.harness.nextStep.enabled')} description={t('settings.page.harness.nextStep.description')} />
      <HarnessModelField harness={harness} update={update} slot="nextStep" enableControl={false} />
    </SettingsSection>;
}
