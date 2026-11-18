import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useServiceIdentity } from '@/lib/settings/service-identity';
import { Scope } from './kit';

/** Where a page's settings are stored, shown under the page title; the hint explains who shares it. */
export type SettingsScopeKind = 'device' | 'host' | 'hostProject' | 'mixed';

export function SettingsScopeLabel({ kind, project }: { kind: SettingsScopeKind | 'project'; project?: string }) {
  const { t } = useI18n();
  const service = useServiceIdentity();
  const name = service?.name ?? '…';
  switch (kind) {
    case 'device': return <Scope icon="computer" label={t('settings.scope.device')} hint={t('settings.scope.deviceHint')} />;
    case 'mixed': return <Scope icon="stack" label={t('settings.scope.mixed')} hint={t('settings.scope.mixedHint')} />;
    case 'project': return <Scope icon="folder" label={t('settings.scope.project', { name: project ?? '' })} hint={t('settings.scope.projectHint')} />;
    case 'hostProject': return <Scope icon="server" label={t('settings.scope.service', { name })} hint={t('settings.scope.serviceProjectHint')} />;
    default: return <Scope icon="server" label={t('settings.scope.service', { name })} hint={t('settings.scope.serviceHint')} />;
  }
}

/** Kept for existing callers: the host scope label's text. */
export function HostSettingsScope() {
  const { t } = useI18n();
  const service = useServiceIdentity();
  return <span>{t('settings.scope.service', { name: service?.name ?? '…' })}</span>;
}

/** Field-level owner marks are replaced by the page scope and section notes. */
export function SettingsItemScope(_: { item?: string }) {
  return null;
}
