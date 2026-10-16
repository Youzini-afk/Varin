import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useI18n } from '@/lib/i18n';
import { StorageSettings } from './StorageSettings';

export function StorageSettingsPage() {
  const { t } = useI18n();
  return <SettingsPageLayout title={t('settings.page.storage.title')}><StorageSettings /></SettingsPageLayout>;
}
