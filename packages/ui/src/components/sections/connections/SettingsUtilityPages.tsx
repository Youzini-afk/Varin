import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { OutboundNetworkSettings } from '@/components/sections/harness/OutboundNetworkSettings';
import { SessionRetentionSettings } from '@/components/sections/varin/SessionRetentionSettings';
import { RecoverySettings } from '@/components/sections/varin/RecoverySettings';
import { PasskeySettings } from '@/components/sections/varin/PasskeySettings';
import { DesktopNetworkSettings } from '@/components/sections/varin/DesktopNetworkSettings';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { isDesktopShell, isDesktopLocalOriginActive, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';
export function HistorySettingsPage() {
  const { t } = useI18n();
  return <SettingsPageLayout title={t('settings.page.history.title')} description={t('settings.page.history.description')} showSaveStatus>
    <SessionRetentionSettings /><RecoverySettings />
  </SettingsPageLayout>;
}
export function NetworkSettingsPage() {
  const { t } = useI18n();
  return <SettingsPageLayout title={t('settings.page.network.title')} description={t('settings.page.network.description')}><OutboundNetworkSettings /></SettingsPageLayout>;
}
export function AccessSettingsIntro() {
  const { t } = useI18n();
  return <>
    {isDesktopShell() && isDesktopLocalOriginActive() ? <DesktopNetworkSettings section="access" /> : null}
    {isWebRuntime() && !isDesktopShell() && !isCapacitorApp() ? <PasskeySettings /> : null}
    <SettingsSection description={t('settings.page.access.description')} divider={false}><p className="typography-meta text-muted-foreground">{t('settings.connections.accessHint')}</p></SettingsSection>
  </>;
}
export function AccessSettingsPage() { return <RemoteInstancesPage view="access" intro={<AccessSettingsIntro />} />; }
