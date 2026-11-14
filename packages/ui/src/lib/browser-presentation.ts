import type { I18nKey } from './i18n';

type Translate = (key: I18nKey) => string;

export function browserResourceLabel(resource: { source?: string | undefined; label: string }, t: Translate): string {
  return resource.source === 'embedded' && resource.label === 'Varin Browser'
    ? t('settings.browser.builtinName') : resource.label;
}

/** Localize provider-owned fallback labels; retain device and connection names. */
export function browserDeviceLabel(resource: { source?: string | undefined; deviceName: string }, t: Translate): string {
  const fallback = resource.source === 'connector' ? ['Paired browser', 'settings.browser.pairedBrowser'] as const
    : resource.source === 'cdp' || resource.source === 'embedded' ? ['This Host', 'settings.browser.currentHost'] as const : undefined;
  if (!fallback) return resource.deviceName;
  if (resource.deviceName === fallback[0]) return t(fallback[1]);
  const suffix = ` · ${fallback[0]}`;
  return resource.deviceName.endsWith(suffix)
    ? `${resource.deviceName.slice(0, -suffix.length)} · ${t(fallback[1])}` : resource.deviceName;
}
