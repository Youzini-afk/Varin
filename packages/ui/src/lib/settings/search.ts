import {
  SETTINGS_CATALOG,
  isCatalogEntryAvailable,
  type SettingsCatalogContext,
} from '@varin/application-client';
import type { I18nKey } from '@/lib/i18n/store';
import type { SettingsPageSlug, SettingsRuntimeContext } from './metadata';
import { getSettingsPageMeta, getSettingsPageMetadata } from './metadata';

/**
 * Settings search derives its item table from the shared catalog in
 * `@varin/application-client` (D-306). The same descriptors drive the
 * agent-facing settings directory, so a setting searchable here is the same
 * identity an agent can read/update through `settings_*` tools.
 */
interface SettingsSearchItem {
  id: string;
  page: SettingsPageSlug;
  titleKey?: I18nKey;
  descriptionKey?: I18nKey;
  keywords?: string[];
}

export interface SettingsSearchResult extends SettingsSearchItem {
  title: string;
  description: string | null;
  pageTitle: string;
  focusTargetId?: string | null;
}

export interface SettingsSearchAvailabilityContext
  extends SettingsRuntimeContext, SettingsCatalogContext {}

const toAvailabilityContext = (ctx: SettingsSearchAvailabilityContext): SettingsCatalogContext => ({
  isDesktop: ctx.isDesktop,
  isWeb: ctx.isWeb,
  isMobile: ctx.isMobile,
  isDesktopLocalOrigin: ctx.isDesktopLocalOrigin,
  isMac: ctx.isMac,
  isWindows: ctx.isWindows,
  isLinux: ctx.isLinux,
});

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = SETTINGS_CATALOG.flatMap((entry) => {
  const { ui } = entry;
  if (!ui.page) return [];
  return [{
    id: entry.id,
    page: ui.page as SettingsPageSlug,
    titleKey: ui.titleKey as I18nKey,
    ...(ui.descriptionKey ? { descriptionKey: ui.descriptionKey as I18nKey } : {}),
    ...(ui.keywords ? { keywords: [...ui.keywords] } : {}),
  }];
});

const isItemAvailable = (
  entryId: string,
  ctx: SettingsSearchAvailabilityContext,
): boolean => {
  const entry = SETTINGS_CATALOG.find((candidate) => candidate.id === entryId);
  return !entry ? true : isCatalogEntryAvailable(entry.ui.availability, toAvailabilityContext(ctx));
};

interface BuildSettingsSearchResultsOptions {
  query: string;
  runtimeCtx: SettingsSearchAvailabilityContext;
  visiblePageSlugs?: SettingsPageSlug[];
  t: (key: I18nKey) => string;
  getPageTitle: (slug: SettingsPageSlug) => string;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSettingsSearchResults({
  query,
  runtimeCtx,
  visiblePageSlugs,
  t,
  getPageTitle,
}: BuildSettingsSearchResultsOptions): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  const pageResults = getSettingsPageMetadata().flatMap((page): SettingsSearchResult[] => {
    if (page.slug === 'home' || (allowedPages && !allowedPages.has(page.slug))) return [];
    if (page.isAvailable && !page.isAvailable(runtimeCtx)) return [];
    const title = getPageTitle(page.slug);
    const haystack = normalizeSearchText([
      title,
      page.title,
      page.group,
      ...(page.keywords ?? []),
    ].join(' '));
    if (!terms.every((term) => haystack.includes(term))) return [];
    return [{
      id: `settings-page:${page.slug}`,
      page: page.slug,
      titleKey: page.titleKey,
      keywords: page.keywords,
      title,
      description: null,
      pageTitle: title,
      focusTargetId: null,
    }];
  });

  const itemResults = SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    if (allowedPages && !allowedPages.has(item.page)) {
      return [];
    }

    const pageMeta = getSettingsPageMeta(item.page);
    if (!pageMeta || (pageMeta.isAvailable && !pageMeta.isAvailable(runtimeCtx)) || !isItemAvailable(item.id, runtimeCtx)) {
      return [];
    }

    const title = item.titleKey ? t(item.titleKey) : getPageTitle(item.page);
    const description = item.descriptionKey ? t(item.descriptionKey) : null;
    const haystack = normalizeSearchText([
      title,
      description,
      getPageTitle(item.page),
      ...(item.keywords ?? []),
    ].filter(Boolean).join(' '));

    if (!terms.every((term) => haystack.includes(term))) {
      return [];
    }

    return [{
      ...item,
      title,
      description,
      pageTitle: getPageTitle(item.page),
    }];
  });
  return [...pageResults, ...itemResults];
}
