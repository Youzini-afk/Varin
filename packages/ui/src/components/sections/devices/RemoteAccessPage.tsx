import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { DesktopNetworkSettings } from '@/components/sections/varin/DesktopNetworkSettings';
import { PasskeySettings } from '@/components/sections/varin/PasskeySettings';
import { TunnelSettings } from '@/components/sections/varin/TunnelSettings';
import { Disclosure, Section } from '@/components/sections/shared/kit';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useI18n } from '@/lib/i18n';

export function RemoteAccessPage() {
  const { t } = useI18n();
  const localDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  return <RemoteInstancesPage view="access" intro={<>
    <Section>
      {localDesktop ? <Disclosure label={t('settings.remoteAccess.lan')}>
        <div className="sk-pad"><DesktopNetworkSettings section="access" /></div>
      </Disclosure> : null}
      <Disclosure label={t('settings.varin.externalAccess.legacyTitle')}>
        <div className="sk-pad"><TunnelSettings only="provider" /></div>
      </Disclosure>
      <Disclosure label={t('settings.varin.externalAccess.title')}>
        <div className="sk-pad"><TunnelSettings only="self-hosted" /></div>
      </Disclosure>
    </Section>
    {isWebRuntime() && !isDesktopShell() && !isCapacitorApp() ? <PasskeySettings /> : null}
  </>} />;
}
