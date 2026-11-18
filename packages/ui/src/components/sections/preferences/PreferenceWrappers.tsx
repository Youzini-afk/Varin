import { useI18n } from '@/lib/i18n';
import { Page } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { NotificationSettings } from '@/components/sections/varin/NotificationSettings';
import { VoiceSettings } from '@/components/sections/varin/VoiceSettings';
import { KeyboardShortcutsSettings } from '@/components/sections/varin/KeyboardShortcutsSettings';

/** 通知: how Varin tells you when work finishes or needs you. */
export function NotificationsPage() {
  const { t } = useI18n();
  return <Page title={t('settings.page.notifications.title')} description={t('settings.notificationsx.description')} scope={<SettingsScopeLabel kind="device" />}>
    <NotificationSettings />
  </Page>;
}

/** 语音: reading replies aloud and voice input; each chooses where it is processed. */
export function VoicePage() {
  const { t } = useI18n();
  return <Page title={t('settings.page.voice.title')} description={t('settings.voicex.description')} scope={<SettingsScopeLabel kind="mixed" />}>
    <VoiceSettings />
  </Page>;
}

/** 快捷键: click a shortcut to record a new one. */
export function ShortcutsPage() {
  const { t } = useI18n();
  return <Page title={t('settings.page.shortcuts.title')} description={t('settings.shortcutsx.description')} scope={<SettingsScopeLabel kind="device" />}>
    <KeyboardShortcutsSettings />
  </Page>;
}
