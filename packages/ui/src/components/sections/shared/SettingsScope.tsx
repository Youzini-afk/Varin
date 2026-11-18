import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, getSettingsCatalogEntry, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { SettingsMixedScopeContext } from './settings-context';

/** Use only the URL host for display; a path, query or userinfo may contain secrets. */
export function HostSettingsScope() {
  const { t } = useI18n();
  React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  let authority = '';
  try { authority = new URL(getRuntimeApiBaseUrl() || '/', window.location.href).host; } catch { /* Native scheme or offline startup. */ }
  return <span title={t('settings.scope.hostGlobalHint')}>{t('settings.scope.host')}{authority ? ' · ' + authority : ''}</span>;
}

export function SettingsItemScope({ item }: {item?: string}) {
  const mixed = React.useContext(SettingsMixedScopeContext);
  return mixed && item ? <FieldOwner item={item} /> : null;
}
function FieldOwner({item}: {item: string}) {
  const { t } = useI18n();
  const owner = getSettingsCatalogEntry(item)?.owner;
  const scope = owner === 'client' ? 'settings.scope.client' : owner === 'app' || owner === 'agent-settings' ? 'settings.scope.host' : undefined;
  return scope ? <span className="settings-field-scope">{t(scope)}</span> : null;
}
