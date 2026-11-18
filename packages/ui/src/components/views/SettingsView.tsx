import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { SettingsNavigationContext } from '@/components/sections/shared/settings-context';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { SettingsDraftDialog } from '@/components/sections/shared/SettingsDraftDialog';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { McpIcon } from '@/components/icons/McpIcon';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn, getModifierLabel } from '@/lib/utils';
import { SETTINGS_GROUP_ORDER, settingsNavigationGroup, settingsNavigationOrder } from '@/lib/settings/navigation';
import { getSettingsNavIcon, getSettingsPageMeta, resolveSettingsSlug, type SettingsPageMeta, type SettingsPageSlug, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { useSettingsPageRegistrations } from '@/lib/settings/surface-registry';
import { buildSettingsSearchResults, type SettingsSearchResult } from '@/lib/settings/search';
import { SettingsItemNavigationContext, SettingsSearchTargetContext } from '@/lib/settings/search-target';
import { useServiceIdentity } from '@/lib/settings/service-identity';
import { useSettingsNavBadges } from '@/lib/settings/nav-badges';
import {
  Btn, Ic, SettingsShellContext, publishSettingsTitlebar,
  type CatalogStage, type SettingsLayout, type SettingsShellValue,
} from '@/components/sections/shared/kit';

type Stage = 'nav' | 'page';
interface SettingsViewProps {
  onClose?: () => void;
  /** Force the phone layout regardless of device detection. */
  forceMobile?: boolean;
  /** Restrict top-level settings navigation to a specific product surface. */
  visiblePageSlugs?: SettingsPageSlug[];
  initialMobileStage?: 'nav' | 'page-sidebar' | 'page-content';
  backActionRef?: React.RefObject<(() => void) | null>;
}

const COMPACT_WIDTH = 1000;
const STACKED_CATALOG_WIDTH = 630;

function isPageAvailable(page: SettingsPageMeta, ctx: SettingsRuntimeContext) {
  return page.isAvailable ? page.isAvailable(ctx) : true;
}
function platform(): string | undefined {
  return isDesktopShell() && typeof window !== 'undefined' ? (window as unknown as { __VARIN_PLATFORM__?: string }).__VARIN_PLATFORM__ : undefined;
}
const escapeAttribute = (value: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
const reducedMotion = () => typeof window !== 'undefined' && (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off');

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile, visiblePageSlugs, backActionRef, initialMobileStage = 'nav' }) => {
  const { t } = useI18n();
  const runtimeEpoch = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const deviceInfo = useDeviceInfo();
  const phone = forceMobile ?? deviceInfo.isMobile;
  const registrations = useSettingsPageRegistrations();
  const settingsPageRaw = useUIStore(state => state.settingsPage);
  const setSettingsPage = useUIStore(state => state.setSettingsPage);
  const requested = resolveSettingsSlug(settingsPageRaw);
  const service = useServiceIdentity();
  const badges = useSettingsNavBadges();

  /* Width of the settings surface decides between two columns and stacked stages. */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  React.useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width || window.innerWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout: SettingsLayout = phone ? 'phone' : width < COMPACT_WIDTH ? 'narrow' : 'desktop';
  const compact = layout !== 'desktop';
  const stackedCatalog = phone || width < STACKED_CATALOG_WIDTH;

  const runtimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isWeb: !isDesktop && isWebRuntime(), isDesktop, isMobile: phone, mcpInstalled: true };
  }, [phone]);
  const visiblePages = React.useMemo(() => {
    const allowed = visiblePageSlugs ? new Set(visiblePageSlugs) : null;
    return registrations.map(registration => registration.meta)
      .filter(page => page.slug !== 'home' && (!allowed || allowed.has(page.slug)) && isPageAvailable(page, runtimeCtx))
      .sort((a, b) => settingsNavigationOrder(a) - settingsNavigationOrder(b));
  }, [registrations, runtimeCtx, visiblePageSlugs]);
  const groups = React.useMemo(() => {
    const byGroup = new Map<string, SettingsPageMeta[]>();
    for (const page of visiblePages) {
      const group = settingsNavigationGroup(page);
      byGroup.set(group, [...(byGroup.get(group) ?? []), page]);
    }
    const known = SETTINGS_GROUP_ORDER.filter(group => byGroup.has(group)).map(group => ({ group, pages: byGroup.get(group)! }));
    const extra = [...byGroup.keys()].filter(group => !(SETTINGS_GROUP_ORDER as readonly string[]).includes(group)).map(group => ({ group, pages: byGroup.get(group)! }));
    return [...known, ...extra];
  }, [visiblePages]);

  /* 'home' opens General on wide windows and the navigation on narrow ones. */
  const slug = requested === 'home' && !compact ? (visiblePages[0]?.slug ?? 'general') : requested;
  React.useEffect(() => { if (requested === 'home' && !compact && visiblePages[0]) setSettingsPage(visiblePages[0].slug); }, [compact, requested, setSettingsPage, visiblePages]);
  const activeMeta = React.useMemo(() => registrations.find(registration => registration.meta.slug === slug)?.meta ?? null, [registrations, slug]);

  const [stage, setStage] = React.useState<Stage>(() => (initialMobileStage === 'nav' && (requested === 'home') ? 'nav' : 'page'));
  const [catalogStage, setCatalogStage] = React.useState<CatalogStage>('list');
  const [enterKey, setEnterKey] = React.useState(0);
  const pendingSelection = React.useRef(new Map<string, string>());
  const [pendingItem, setPendingItem] = React.useState<string | null>(null);

  const pageTitle = React.useCallback((page: SettingsPageSlug) => {
    const meta = registrations.find(registration => registration.meta.slug === page)?.meta;
    return meta ? (meta.titleKey ? t(meta.titleKey) : meta.title) : t('settings.view.home.title');
  }, [registrations, t]);

  const commit = React.useCallback((next: SettingsPageSlug, options?: { item?: string; select?: string }) => {
    const target = getSettingsPageMeta(next)?.slug ?? next;
    if (options?.select) pendingSelection.current.set(target, options.select);
    setSettingsPage(target);
    setStage('page');
    setCatalogStage(options?.select || options?.item ? 'detail' : 'list');
    setEnterKey(key => key + 1);
    setPendingItem(options?.item ?? null);
  }, [setSettingsPage]);
  const openPage = React.useCallback((next: SettingsPageSlug, options?: { item?: string; select?: string }) => {
    const target = getSettingsPageMeta(next)?.slug ?? next;
    if (target === slug && !options?.select && !options?.item) { setStage('page'); return; }
    requestSettingsNavigation(() => commit(target, options));
  }, [commit, slug]);
  const openItem = React.useCallback((page: string, item: string) => openPage(page, { item }), [openPage]);

  const close = React.useCallback(() => { if (onClose) requestSettingsNavigation(onClose); }, [onClose]);
  const back = React.useCallback(() => {
    if (stage === 'page' && stackedCatalog && catalogStage === 'detail' && activeMeta?.kind === 'split') { setCatalogStage('list'); return; }
    if (stage === 'page' && stackedCatalog && catalogStage === 'detail' && rootRef.current?.querySelector('.sk-cat')) { setCatalogStage('list'); return; }
    if (compact && stage === 'page') { requestSettingsNavigation(() => setStage('nav')); return; }
    close();
  }, [activeMeta, catalogStage, close, compact, stackedCatalog, stage]);

  /* Search */
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const results = React.useMemo(() => buildSettingsSearchResults({
    query,
    runtimeCtx: { ...runtimeCtx, isDesktopLocalOrigin: isDesktopShell() && isDesktopLocalOriginActive(), isMac: platform() === 'darwin', isWindows: platform() === 'win32', isLinux: platform() === 'linux' },
    visiblePageSlugs, t, getPageTitle: pageTitle,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query, runtimeCtx, visiblePageSlugs, t, pageTitle, runtimeEpoch]);
  React.useEffect(() => setActive(0), [query]);
  const grouped = React.useMemo(() => {
    const map = new Map<string, { page: string; title: string; results: SettingsSearchResult[] }>();
    for (const result of results) {
      const group = map.get(result.page) ?? { page: result.page, title: result.pageTitle, results: [] };
      group.results.push(result); map.set(result.page, group);
    }
    return [...map.values()];
  }, [results]);
  const openResult = React.useCallback((result: SettingsSearchResult) => {
    setQuery('');
    openPage(result.page, result.focusTargetId === null ? undefined : { item: result.id });
  }, [openPage]);

  /* Reveal a requested item once the page has rendered it. */
  const canvasRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!pendingItem) return;
    let cancelled = false; let frame = 0;
    const reveal = () => {
      if (cancelled) return;
      const root = canvasRef.current;
      const target = root?.querySelector<HTMLElement>(`[data-settings-item="${escapeAttribute(pendingItem)}"]`);
      if (!target || target.closest('[hidden]')) return;
      for (let node: HTMLElement | null = target; node && node !== root; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
      observer.disconnect(); setPendingItem(null);
      target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'instant' : 'smooth' });
      target.removeAttribute('data-settings-search-highlight');
      void target.offsetWidth;
      target.setAttribute('data-settings-search-highlight', 'true');
      window.setTimeout(() => target.removeAttribute('data-settings-search-highlight'), 1600);
    };
    const schedule = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(reveal); };
    const observer = new MutationObserver(schedule);
    if (canvasRef.current) observer.observe(canvasRef.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    schedule();
    const giveUp = window.setTimeout(() => { observer.disconnect(); setPendingItem(null); }, 6000);
    return () => { cancelled = true; observer.disconnect(); window.cancelAnimationFrame(frame); window.clearTimeout(giveUp); };
  }, [pendingItem, slug, enterKey]);

  /* Keyboard: Ctrl/Cmd+K focuses search; Esc closes unless an overlay owns it. */
  React.useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopPropagation();
        requestSettingsNavigation(() => {
          if (compact) setStage('nav');
          requestAnimationFrame(() => searchRef.current?.focus());
        });
        return;
      }
      if (event.key !== 'Escape' || event.defaultPrevented || !onClose) return;
      const blocking = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')]
        .some(surface => !surface.closest('[inert], [hidden], [aria-hidden="true"], [data-state="closed"]'));
      if (blocking || (event.target as HTMLElement | null)?.closest?.('.sk-search')) return;
      event.preventDefault(); close();
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [close, compact, onClose]);

  React.useEffect(() => {
    if (!backActionRef) return;
    backActionRef.current = back;
    return () => { backActionRef.current = null; };
  }, [back, backActionRef]);

  /* The app header shows return, breadcrumb and the connected service while settings is open. */
  const openDevices = React.useCallback(() => openPage('devices'), [openPage]);
  React.useEffect(() => {
    publishSettingsTitlebar({
      title: activeMeta ? pageTitle(activeMeta.slug) : t('settings.view.home.title'),
      stage: compact ? stage : 'page', compact, back, close: onClose ? close : undefined,
      host: service ? { name: service.name, state: service.reachable ? 'ok' : 'warn', hint: t('settings.shell.hostHint'), open: openDevices } : undefined,
    });
  }, [activeMeta, back, close, compact, onClose, openDevices, pageTitle, service, stage, t]);
  React.useEffect(() => () => publishSettingsTitlebar(null), []);

  /* Leaving the page stage on wide windows is not a thing; entering compact keeps the current page. */
  React.useEffect(() => { if (!compact) setStage('page'); }, [compact]);
  React.useEffect(() => { setCatalogStage('list'); }, [runtimeEpoch]);

  const shellValue = React.useMemo<SettingsShellValue>(() => ({
    layout, catalogStage: stackedCatalog ? catalogStage : 'detail', setCatalogStage, openPage, closeSettings: onClose ? close : undefined,
    takeSelection: (page: string) => { const value = pendingSelection.current.get(page); if (value) pendingSelection.current.delete(page); return value; },
  }), [catalogStage, close, layout, onClose, openPage, stackedCatalog]);

  const renderContent = () => {
    const registration = registrations.find(candidate => candidate.meta.slug === slug);
    if (!registration || slug === 'home') return null;
    if (!isPageAvailable(registration.meta, runtimeCtx)) {
      return <div className="sk-scroll"><div className="sk-page"><div className="sk-empty"><span className="sk-ei"><Ic name="forbid" size="lg" /></span><b>{t('settings.view.unavailable.title')}</b><p>{t('settings.view.unavailable.description')}</p></div></div></div>;
    }
    const content = <SettingsSearchTargetContext.Provider value={pendingItem}>{registration.implementation.renderContent()}</SettingsSearchTargetContext.Provider>;
    if (registration.meta.kind === 'split' && registration.implementation.renderSidebar) {
      return <div className="sk-cat" data-mstage={stackedCatalog ? catalogStage : 'detail'}>
        <aside className="sk-cat-list">
          <div className="sk-cat-items"><ErrorBoundary>{registration.implementation.renderSidebar({ onItemSelect: () => setCatalogStage('detail') })}</ErrorBoundary></div>
        </aside>
        <section className="sk-cat-detail"><div className="sk-scroll" data-settings-page-scroll="">{content}</div></section>
      </div>;
    }
    return content;
  };

  const shortcut = `${getModifierLabel()} K`;
  const hasQuery = query.trim().length > 0;
  let resultIndex = -1;
  const nav = <nav className="sk-nav" aria-label={t('settings.shell.navigation')}>
    {phone ? <div className="sk-hstack" style={{ padding: '4px 10px 0' }}>
      {onClose ? <Btn kind="ghost" icon="arrow-left-s" tip={t('settings.view.actions.closeSettings')} onClick={close} /> : null}
    </div> : null}
    <span className="sk-nav-title">{t('settings.view.home.title')}</span>
    <div className="sk-search">
      <Ic name="search" size="sm" />
      <input ref={searchRef} value={query} placeholder={t('settings.view.search.placeholder')} aria-label={t('settings.view.search.aria')} autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (query) setQuery(''); else event.currentTarget.blur(); return; }
          if (!results.length) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(results.length - 1, index + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); const result = results[active] ?? results[0]; if (result) { openResult(result); event.currentTarget.blur(); } }
        }} />
      {hasQuery ? <button type="button" className="sk-clear" aria-label={t('settings.view.search.clear')} onClick={() => { setQuery(''); searchRef.current?.focus(); }}><Ic name="close" size="xs" /></button>
        : <span className="sk-kbd">{shortcut}</span>}
    </div>
    <div className={cn('sk-list', hasQuery && 'sk-results')}>
      {hasQuery ? (results.length ? grouped.map(group => <React.Fragment key={group.page}>
        <div className="sk-rg">{group.title}</div>
        {group.results.map(result => {
          resultIndex += 1;
          const index = resultIndex;
          return <SearchResult key={result.id} result={result} query={query} active={index === active} onHover={() => setActive(index)} onOpen={() => openResult(result)} />;
        })}
      </React.Fragment>) : <div className="sk-none">{t('settings.shell.noResults', { query: query.trim() })}</div>)
        : groups.map(({ group, pages }) => <React.Fragment key={group}>
          <div className="sk-gt">{t(`settings.view.nav.group.${group}` as never)}</div>
          {pages.map(page => {
            const icon = getSettingsNavIcon(page.slug);
            const badge = badges[page.slug];
            return <button key={page.slug} type="button" className="sk-it" aria-current={slug === page.slug && (!compact || stage === 'page') ? 'page' : undefined}
              onClick={() => openPage(page.slug)}>
              {page.icon === 'mcp' ? <McpIcon className="sk-ic" /> : icon ? <Ic name={icon} /> : <span className="sk-ic" />}
              <span className="sk-trunc">{pageTitle(page.slug)}</span>
              {page.badgeKey ? <span className="sk-badge">{t(page.badgeKey)}</span> : badge ? <span className={cn('sk-badge dot')} title={badge.hint} aria-label={badge.hint} /> : null}
            </button>;
          })}
        </React.Fragment>)}
    </div>
    {phone && service ? <div className="sk-foot"><button type="button" onClick={openDevices}><span className={cn('sk-dot', service.reachable ? 'ok' : 'warn')} /><span className="sk-grow"><span className="sk-trunc" style={{ display: 'block' }}>{service.name}</span><small>{t('settings.shell.connectedService')}</small></span><Ic name="arrow-right-s" size="sm" className="sk-faint" /></button></div> : null}
  </nav>;

  const mobileTitle = activeMeta ? pageTitle(activeMeta.slug) : '';
  return <SettingsNavigationContext.Provider value={true}><SettingsItemNavigationContext.Provider value={openItem}><SettingsShellContext.Provider value={shellValue}>
    <div ref={rootRef} data-settings-view="true" data-settings-layout={layout} className={cn('sk sk-shell', layout === 'phone' && 'phone')} data-stage={compact ? stage : 'page'}>
      <SettingsDraftDialog />
      {nav}
      <main ref={canvasRef} className={cn('sk-canvas', 'sk-enter')} key={`${slug}:${enterKey}:${runtimeEpoch}`} aria-label={mobileTitle || undefined}>
        <div className="sk-mhead">
          <Btn kind="ghost" icon="arrow-left-s" tip={stackedCatalog && catalogStage === 'detail' ? t('settings.shell.backTo', { page: mobileTitle }) : t('settings.view.actions.backToSettings')} onClick={back} />
          {phone ? <span className="sk-mt">{mobileTitle}</span> : <span className="sk-small">{mobileTitle}</span>}
        </div>
        <ErrorBoundary>{renderContent()}</ErrorBoundary>
      </main>
    </div>
  </SettingsShellContext.Provider></SettingsItemNavigationContext.Provider></SettingsNavigationContext.Provider>;
};

function SearchResult({ result, query, active, onHover, onOpen }: { result: SettingsSearchResult; query: string; active: boolean; onHover(): void; onOpen(): void }) {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  return <button ref={ref} type="button" className={cn('sk-r', active && 'kb')} onMouseMove={onHover} onClick={onOpen}>
    <b><Mark text={result.title} query={query} /></b>
    {result.description ? <small><Mark text={result.description} query={query} /></small> : null}
  </button>;
}
function Mark({ text, query }: { text: string; query: string }) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const spans: Array<[number, number]> = [];
  for (const term of terms) { let from = 0; for (;;) { const index = lower.indexOf(term, from); if (index < 0) break; spans.push([index, index + term.length]); from = index + term.length; } }
  if (!spans.length) return <>{text}</>;
  spans.sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = []; let cursor = 0;
  spans.forEach(([start, end], index) => {
    if (start < cursor) return;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
