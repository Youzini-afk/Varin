import React from 'react';
import { cn, getModifierLabel } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import {
  SETTINGS_SECTION_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { McpIcon } from '@/components/icons/McpIcon';
import {
  getSettingsNavIcon,
  getSettingsPageMeta,
  resolveSettingsSlug,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
  type SettingsPageMeta,
} from '@/lib/settings/metadata';
import { useSettingsPageRegistrations } from '@/lib/settings/surface-registry';
import { buildSettingsSearchResults, type SettingsSearchResult } from '@/lib/settings/search';
import { SettingsSearchTargetContext } from '@/lib/settings/search-target';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import {
  refreshMcpSettingsAvailability,
  useMcpSettingsAvailabilityState,
} from '@/lib/settings/mcp-availability';

// UI Kit: fixed settings navigation width
const SETTINGS_NAV_WIDTH = 256;
const SETTINGS_SPLIT_SIDEBAR_WIDTH = 280;

type MobileStage = 'nav' | 'page-sidebar' | 'page-content';

interface SettingsViewProps {
  onClose?: () => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  /** Rendered inside a window/dialog (skip traffic light padding) */
  isWindowed?: boolean;
  /** Restrict top-level settings navigation to a specific product surface. */
  visiblePageSlugs?: SettingsPageSlug[];
  initialMobileStage?: MobileStage;
}

const NAV_GROUP_ORDER = ['general', 'projects', 'harness', 'pi'] as const;

const ADD_PROVIDER_SETTINGS_ID = '__add_provider__';

function buildRuntimeContext(
  isDesktop: boolean,
  isMobile: boolean,
  mcpInstalled: boolean,
): SettingsRuntimeContext {
  const isWeb = !isDesktop && isWebRuntime();
  return { isWeb, isDesktop, isMobile, mcpInstalled };
}

function isPageAvailable(page: SettingsPageMeta, ctx: SettingsRuntimeContext): boolean {
  if (!page.isAvailable) {
    return true;
  }
  return page.isAvailable(ctx);
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile, isWindowed, visiblePageSlugs, initialMobileStage = 'nav' }) => {
  const { t } = useI18n();
  const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;
  const { runtimeTarget, targetKey: mcpTargetKey } = useResourceRuntimeTarget();
  const mcpAvailability = useMcpSettingsAvailabilityState();
  const mcpInstalled = mcpAvailability.targetKey === mcpTargetKey
    && mcpAvailability.installed === true;
  const settingsPageRegistrations = useSettingsPageRegistrations();

  React.useEffect(() => {
    void refreshMcpSettingsAvailability(runtimeTarget, mcpTargetKey);
  }, [mcpTargetKey, runtimeTarget]);

  const settingsPageRaw = useUIStore((state) => state.settingsPage);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const settingsSlug = resolveSettingsSlug(settingsPageRaw);

  const [mobileStage, setMobileStage] = React.useState<MobileStage>(initialMobileStage);
  const autoNavSlugRef = React.useRef<string | null>(null);

  // No starter page on desktop: 'home' (fresh state) resolves to General.
  // settingsPage persists in the UI store, so subsequent opens restore the
  // last visited page. Mobile keeps 'home' — its entry stage is the nav list.
  React.useEffect(() => {
    if (!isMobile && settingsSlug === 'home') {
      setSettingsPage('general');
    }
  }, [isMobile, setSettingsPage, settingsSlug]);

  const [settingsSearchQuery, setSettingsSearchQuery] = React.useState('');
  const [pendingSearchItemId, setPendingSearchItemId] = React.useState<string | null>(null);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchResultRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const activeSearchResultIndexRef = React.useRef(0);
  const keyboardSearchNavigationRef = React.useRef(false);

  const isDesktopApp = React.useMemo(() => {
    return isDesktopShell();
  }, []);
  const isDesktopLocalOrigin = React.useMemo(() => {
    return isDesktopShell() && isDesktopLocalOriginActive();
  }, []);
  const isMac = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ === 'darwin';
  }, []);
  const isWindows = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ === 'win32';
  }, []);
  const isLinux = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ === 'linux';
  }, []);
  const runtimeCtx = React.useMemo(
    () => buildRuntimeContext(isDesktopApp, isMobile, mcpInstalled),
    [isDesktopApp, isMobile, mcpInstalled],
  );

  React.useEffect(() => {
    if (
      settingsSlug === 'mcp'
      && mcpAvailability.targetKey === mcpTargetKey
      && mcpAvailability.installed === false
    ) {
      setSettingsPage('plugins');
    }
  }, [mcpAvailability.installed, mcpAvailability.targetKey, mcpTargetKey, setSettingsPage, settingsSlug]);

  const visiblePages = React.useMemo(() => {
    const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
    return settingsPageRegistrations
      .map((registration) => registration.meta)
      .filter((page) => page.slug !== 'home')
      .filter((page) => !allowedPages || allowedPages.has(page.slug))
      .filter((page) => isPageAvailable(page, runtimeCtx))
  }, [runtimeCtx, settingsPageRegistrations, visiblePageSlugs]);

  const openPage = React.useCallback((slug: SettingsPageSlug) => {
    setSettingsPage(slug);
    autoNavSlugRef.current = slug;
    if (!isMobile) {
      return;
    }
    const def = getSettingsPageMeta(slug);
    if (!def || def.slug === 'home') {
      setMobileStage('nav');
      return;
    }
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, setSettingsPage]);

  const activePageMeta = React.useMemo(() => {
    return settingsPageRegistrations.find((registration) => registration.meta.slug === settingsSlug)?.meta ?? null;
  }, [settingsPageRegistrations, settingsSlug]);

  // Nav is always open (collapsed state removed)

  const getPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    const meta = settingsPageRegistrations.find((registration) => registration.meta.slug === slug)?.meta;
    return meta ? t(meta.titleKey) : t('settings.view.home.title');
  }, [settingsPageRegistrations, t]);

  const settingsSearchResults = React.useMemo(() => {
    return buildSettingsSearchResults({
      query: settingsSearchQuery,
      runtimeCtx: { ...runtimeCtx, isDesktopLocalOrigin, isMac, isWindows, isLinux },
      visiblePageSlugs,
      t,
      getPageTitle,
    });
  }, [getPageTitle, isDesktopLocalOrigin, isMac, isWindows, isLinux, runtimeCtx, settingsSearchQuery, t, visiblePageSlugs]);

  const prepareSettingsSearchTarget = React.useCallback((result: SettingsSearchResult): string => {
    if (result.id === 'providers.connect') {
      usePiProviderStore.getState().setSelectedProvider(ADD_PROVIDER_SETTINGS_ID);
    }

    return result.id;
  }, []);

  const groupedSettingsSearchResults = React.useMemo(() => {
    const groups: Array<{ page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }> = [];
    const groupByPage = new Map<SettingsPageSlug, { page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }>();
    for (const result of settingsSearchResults) {
      let group = groupByPage.get(result.page);
      if (!group) {
        group = { page: result.page, pageTitle: result.pageTitle, results: [] };
        groupByPage.set(result.page, group);
        groups.push(group);
      }
      group.results.push(result);
    }
    return groups;
  }, [settingsSearchResults]);

  React.useEffect(() => {
    setActiveSearchResultIndex(0);
    activeSearchResultIndexRef.current = 0;
    keyboardSearchNavigationRef.current = false;
  }, [settingsSearchQuery]);

  React.useEffect(() => {
    activeSearchResultIndexRef.current = activeSearchResultIndex;
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    searchResultRefs.current[activeSearchResultIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    if (activeSearchResultIndex >= settingsSearchResults.length) {
      setActiveSearchResultIndex(Math.max(0, settingsSearchResults.length - 1));
    }
    searchResultRefs.current.length = settingsSearchResults.length;
  }, [activeSearchResultIndex, settingsSearchResults.length]);

  const openSearchResult = React.useCallback((result: SettingsSearchResult) => {
    const targetId = prepareSettingsSearchTarget(result);
    setPendingSearchItemId(result.focusTargetId === null ? null : targetId);
    openPage(result.page);
    if (isMobile) {
      setMobileStage('page-content');
    }
  }, [isMobile, openPage, prepareSettingsSearchTarget]);

  const handleSettingsSearchKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!settingsSearchQuery.trim()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSettingsSearchQuery('');
      return;
    }

    if (settingsSearchResults.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current + 1) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current - 1 + settingsSearchResults.length) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const safeIndex = ((activeSearchResultIndexRef.current % settingsSearchResults.length) + settingsSearchResults.length) % settingsSearchResults.length;
      const result = settingsSearchResults[safeIndex] ?? settingsSearchResults[0];
      if (result) {
        openSearchResult(result);
      }
    }
  }, [openSearchResult, settingsSearchQuery, settingsSearchResults]);

  React.useEffect(() => {
    const targetId = pendingSearchItemId;
    if (!targetId) {
      return;
    }

    let cancelled = false;
    let frame = 0;
    const reveal = () => {
      if (cancelled) {
        return;
      }
      const escapedId = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(targetId)
        : targetId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const target = containerRef.current?.querySelector<HTMLElement>(`[data-settings-item="${escapedId}"]`);
      if (!target || target.closest('[hidden]')) {
        return;
      }
      observer.disconnect();
      setPendingSearchItemId(null);
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute('data-settings-search-highlight', 'true');
      window.setTimeout(() => {
        target.removeAttribute('data-settings-search-highlight');
      }, 1600);
    };
    const scheduleReveal = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(reveal);
    };
    const observer = new MutationObserver(scheduleReveal);
    if (containerRef.current) observer.observe(containerRef.current, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'],
    });
    scheduleReveal();

    return () => {
      cancelled = true;
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [pendingSearchItemId, settingsSlug]);

  const renderUnavailable = React.useCallback(() => {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.view.unavailable.title')}</div>
          <p className="typography-ui text-muted-foreground mt-1">{t('settings.view.unavailable.description')}</p>
        </div>
      </div>
    );
  }, [t]);

  const renderPageSidebar = React.useCallback((slug: SettingsPageSlug, opts: { onItemSelect?: () => void }) => {
    const registration = settingsPageRegistrations.find((candidate) => candidate.meta.slug === slug);
    return registration?.implementation.renderSidebar?.(opts) ?? null;
  }, [settingsPageRegistrations]);

  const renderPageContent = React.useCallback((slug: SettingsPageSlug) => {
    const registration = settingsPageRegistrations.find((candidate) => candidate.meta.slug === slug);
    if (!registration) return null;
    if (!isPageAvailable(registration.meta, runtimeCtx)) {
      return renderUnavailable();
    }
    return <SettingsSearchTargetContext.Provider value={pendingSearchItemId}>
      {registration.implementation.renderContent()}
    </SettingsSearchTargetContext.Provider>;
  }, [pendingSearchItemId, renderUnavailable, runtimeCtx, settingsPageRegistrations]);

  // Mobile: if opened via deep-link / palette to a non-home page, jump into it once.
  React.useEffect(() => {
    if (!isMobile) {
      return;
    }
    if (mobileStage !== 'nav') {
      return;
    }
    if (settingsSlug === 'home') {
      return;
    }
    if (autoNavSlugRef.current === settingsSlug) {
      return;
    }
    const def = getSettingsPageMeta(settingsSlug);
    if (!def || def.slug === 'home') {
      return;
    }
    autoNavSlugRef.current = settingsSlug;
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, mobileStage, settingsSlug]);

  const showBackButton = isMobile && mobileStage !== 'nav';
  const showOpenPageSidebarButton = mobileStage === 'page-content'
    && activePageMeta?.kind === 'split';
  const mobileBackButtonLabel = showBackButton
    ? t('settings.view.actions.backToSettings')
    : t('settings.view.actions.closeSettings');
  const shortcutKey = getModifierLabel();

  const handleMobilePageSidebarItemSelect = React.useCallback(() => {
    setMobileStage('page-content');
  }, []);

  const handleBack = React.useCallback(() => {
    setMobileStage('nav');
  }, []);

  const handleOpenPageSidebar = React.useCallback(() => {
    setMobileStage('page-sidebar');
  }, []);

  const renderSettingsNav = () => {
    const hasSearchQuery = settingsSearchQuery.trim().length > 0;
    const aboutPage = visiblePages.find((page) => page.slug === 'about') ?? null;

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-4 pt-3">
          <div className="flex h-10 items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 text-muted-foreground focus-within:ring-2 focus-within:ring-primary/40 sm:h-8">
            <Icon name="search" className="h-4 w-4 shrink-0" />
            <input
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
              onKeyDown={handleSettingsSearchKeyDown}
              placeholder={t('settings.view.search.placeholder')}
              aria-label={t('settings.view.search.aria')}
              className="typography-ui min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {hasSearchQuery && (
              <button
                type="button"
                onClick={() => setSettingsSearchQuery('')}
                aria-label={t('settings.view.search.clear')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground sm:h-5 sm:w-5"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable nav items */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-col gap-0.5 px-4 pt-4 pb-2">
            {hasSearchQuery ? (
              settingsSearchResults.length > 0 ? (() => {
                let resultIndex = 0;
                return groupedSettingsSearchResults.map((group) => (
                  <div key={group.page} className="space-y-0.5">
                    <div className="px-2 pb-0.5 pt-2 typography-micro font-medium text-muted-foreground/70">
                      {group.pageTitle}
                    </div>
                    {group.results.map((result) => {
                      const currentIndex = resultIndex;
                      resultIndex += 1;
                      const active = currentIndex === activeSearchResultIndex;
                      const hasDescription = Boolean(result.description);
                      return (
                        <button
                          key={result.id}
                          type="button"
                          ref={(element) => {
                            searchResultRefs.current[currentIndex] = element;
                          }}
                          onMouseMove={() => {
                            keyboardSearchNavigationRef.current = false;
                            setActiveSearchResultIndex(currentIndex);
                          }}
                          onClick={() => openSearchResult(result)}
                          className={cn(
                            'flex w-full flex-col rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                            hasDescription ? 'min-h-11 py-1.5' : 'py-2',
                            active ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                          )}
                        >
                          <span className="typography-ui-label text-foreground truncate">{result.title}</span>
                          {hasDescription && (
                            <span className="typography-micro text-muted-foreground/70 line-clamp-2">{result.description}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })() : (
                <div className="px-2 py-6 text-center typography-ui text-muted-foreground">
                  {t('settings.view.search.noResults')}
                </div>
              )
            ) : (() => {
              const pagesByGroup = new Map<string, typeof visiblePages>();
              for (const page of visiblePages) {
                if (page.slug === 'about') continue;
                const group = page.group;
                const existing = pagesByGroup.get(group);
                if (existing) {
                  existing.push(page);
                } else {
                  pagesByGroup.set(group, [page]);
                }
              }

              const visibleGroups = NAV_GROUP_ORDER
                .map((group) => ({ group, pages: pagesByGroup.get(group) ?? [] }))
                .filter((entry) => entry.pages.length > 0);

              return visibleGroups.map(({ group, pages }, groupIndex) => (
                <div key={group} className="space-y-0.5">
                  <div
                    className={cn(
                      'px-3 pb-1 typography-micro font-semibold uppercase tracking-wide text-muted-foreground sm:px-2 sm:pb-0.5',
                      groupIndex === 0 ? 'pt-1' : 'pt-4 sm:pt-3',
                    )}
                  >
                    {t(`settings.view.nav.group.${group}`)}
                  </div>
                  {pages.map((page) => {
                    const selected = settingsSlug === page.slug;
                    const iconName = getSettingsNavIcon(page.slug);
                    if (!iconName && page.icon !== 'mcp') return null;

                    return (
                      <Tooltip key={page.slug}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => openPage(page.slug)}
                            aria-current={selected ? 'page' : undefined}
                            className={cn(
                              'flex h-11 w-full items-center gap-2.5 rounded-md px-3 overflow-hidden sm:h-8 sm:gap-2 sm:px-2',
                              selected
                                ? 'bg-interactive-selection text-foreground'
                                : 'text-foreground hover:bg-interactive-hover'
                            )}
                          >
                            {page.icon === 'mcp'
                              ? <McpIcon className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />
                              : <Icon name={iconName!} className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />}
                            <span className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150 opacity-100">
                              <span className="typography-ui-label font-normal truncate">{getPageTitle(page.slug)}</span>
                              {page.badgeKey && (
                                <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
                                  {t(page.badgeKey)}
                                </span>
                              )}
                            </span>
                          </button>
                        </TooltipTrigger>
                      </Tooltip>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>

        {!hasSearchQuery && aboutPage ? (
          <div className="shrink-0 border-t border-border/60 px-4 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => openPage(aboutPage.slug)}
                  aria-current={settingsSlug === aboutPage.slug ? 'page' : undefined}
                  className={cn(
                    'flex h-11 w-full items-center gap-2.5 overflow-hidden rounded-md px-3 sm:h-8 sm:gap-2 sm:px-2',
                    settingsSlug === aboutPage.slug
                      ? 'bg-interactive-selection text-foreground'
                      : 'text-foreground hover:bg-interactive-hover',
                  )}
                >
                  <Icon name={getSettingsNavIcon(aboutPage.slug)!} className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />
                  <span className="truncate typography-ui-label font-normal">{getPageTitle(aboutPage.slug)}</span>
                </button>
              </TooltipTrigger>
            </Tooltip>
          </div>
        ) : null}

      </div>
    );
  };

  const renderMobileStage = () => {
    if (mobileStage === 'nav') {
      return (
        <div className="flex-1 min-h-0 overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-col">
            <ErrorBoundary>{renderSettingsNav()}</ErrorBoundary>
          </div>
        </div>
      );
    }

    if (!activePageMeta) {
      return <div className="flex-1 bg-background" />;
    }

    if (mobileStage === 'page-sidebar') {
      if (activePageMeta.kind !== 'split') {
        // No sidebar available; fall back to direct content.
        const fallback = renderPageContent(settingsSlug);
        return (
          <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
            <ErrorBoundary>{fallback}</ErrorBoundary>
          </div>
        );
      }
      return (
        <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
          <ErrorBoundary>
            {renderPageSidebar(settingsSlug, { onItemSelect: handleMobilePageSidebarItemSelect })}
          </ErrorBoundary>
        </div>
      );
    }

    // page-content
    const content = renderPageContent(settingsSlug);

    return (
      <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>{content}</ErrorBoundary>
      </div>
    );
  };

  const renderDesktopContent = () => {
    if (!activePageMeta || settingsSlug === 'home') {
      return null;
    }

    if (activePageMeta.kind === 'split') {
      return (
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className="border-r bg-sidebar" style={{ width: SETTINGS_SPLIT_SIDEBAR_WIDTH, minWidth: SETTINGS_SPLIT_SIDEBAR_WIDTH, borderColor: 'var(--interactive-border)' }}>
            <ErrorBoundary>{renderPageSidebar(settingsSlug, {})}</ErrorBoundary>
          </div>
          <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
            <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
      </div>
    );
  };

  return (
    <div ref={containerRef} data-settings-view="true" className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-background')}>
      {isMobile ? (
        <div
          className={cn(
            'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b px-3',
            'bg-background'
          )}
          style={{ borderColor: 'var(--interactive-border)' }}
        >
          {(showBackButton || onClose) ? (
            <button
              type="button"
              onClick={showBackButton ? handleBack : onClose}
              aria-label={mobileBackButtonLabel}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="arrow-left-s" className="h-5 w-5" />
            </button>
          ) : null}

          <div className="min-w-0 flex-1 px-2 typography-ui-label font-medium text-foreground truncate">
            {mobileStage === 'nav'
              ? t('settings.view.home.title')
              : (activePageMeta ? getPageTitle(activePageMeta.slug) : t('settings.view.home.title'))}
          </div>

          {showOpenPageSidebarButton && (
            <button
              type="button"
              onClick={handleOpenPageSidebar}
              aria-label={t('settings.view.actions.openSectionList')}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="list-unordered" className="h-5 w-5" />
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('settings.view.actions.closeSettings')}
              title={t('settings.view.actions.closeSettingsWithShortcut', { shortcut: shortcutKey })}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : (
        <>
          {showBackButton && (
            <div className={cn('absolute left-3 z-50', isWindowed ? 'top-2' : 'top-3')}>
              <button
                type="button"
                onClick={handleBack}
                aria-label={t('settings.view.actions.back')}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="arrow-left-s" className="h-5 w-5" />
              </button>
            </div>
          )}

      {onClose && (
        <div className={cn('absolute right-0.5 z-50', isWindowed ? 'top-0.5' : 'top-1')}>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.view.actions.closeSettings')}
            title={t('settings.view.actions.closeSettingsWithShortcut', { shortcut: shortcutKey })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
      )}
        </>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isMobile ? (
          renderMobileStage()
        ) : (
          <>
            <div
              className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                'bg-sidebar',
              )}
              style={{
                width: `${SETTINGS_NAV_WIDTH}px`,
                minWidth: `${SETTINGS_NAV_WIDTH}px`,
                borderColor: 'var(--interactive-border)',
              }}
            >
              <ErrorBoundary>
                {renderSettingsNav()}
              </ErrorBoundary>
            </div>

            <div className="flex-1 overflow-hidden bg-background">
              {renderDesktopContent()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
