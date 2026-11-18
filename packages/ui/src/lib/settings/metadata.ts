import type { IconName } from '@/components/icon/icons';
import {
  getSettingsPageRegistrations,
  subscribeSettingsPageRegistrations,
} from './surface-registry';
import type {
  SettingsPageMeta,
  SettingsPageSlug,
} from './page-types';
import { SETTINGS_SLUG_ALIASES } from './navigation';

export type {
  SettingsPageGroup,
  SettingsPageImplementation,
  SettingsPageMeta,
  SettingsPageRegistration,
  SettingsPageSlug,
  SettingsRuntimeContext,
} from './page-types';

export function getSettingsPageMetadata(): SettingsPageMeta[] {
  return getSettingsPageRegistrations().map((registration) => registration.meta);
}

export { subscribeSettingsPageRegistrations };

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const requested = slug.trim().toLowerCase();
  const pages = getSettingsPageMetadata();
  return pages.find((page) => page.slug === requested)
    ?? pages.find((page) => page.slug === SETTINGS_SLUG_ALIASES[requested])
    ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const requested = (value ?? '').trim().toLowerCase();
  if (!requested) return 'home';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested)) return 'home';
  const registrations = getSettingsPageRegistrations();
  const normalized = registrations.some((registration) => registration.meta.slug === requested)
    ? requested
    : SETTINGS_SLUG_ALIASES[requested] ?? requested;
  if (registrations.length === 0) return normalized;
  return registrations.some((registration) => registration.meta.slug === normalized) ? normalized : 'home';
}

export function getSettingsNavIcon(slug: SettingsPageSlug): IconName | null {
  const icon = getSettingsPageMeta(slug)?.icon;
  return icon && icon !== 'mcp' ? icon : null;
}
