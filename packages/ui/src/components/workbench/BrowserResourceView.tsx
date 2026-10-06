import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { useUIStore } from '@/stores/useUIStore';
import { registerBrowserMaterialCapture } from '@/lib/agent-editor/material-navigation';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { addPiDraftImageFile, usePiDraftStore } from '@/stores/usePiDraftStore';
import { runtimeFetch, getRuntimeUrlResolver, getRuntimeApiBaseUrl, refreshRuntimeUrlAuthToken } from '@varin/application-client';
import { isPreviewElementMetadata, formatPreviewAnnotationMarkdown, renderPreviewScreenshot, desktopAnnotationToFile, getCachedProxyTarget, getBrowserProxyTargetKey, previewProxyTargetCache, type PreviewElementMetadata } from '@/lib/preview/screenshot-capture';
import { DESKTOP_BROWSER_INSPECT_SCRIPT, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT, DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, normalizeBrowserUrl, runIframeScript, stripPreviewQueryParams, type PreviewBridgeMessage, type PreviewProxyState } from '@/lib/preview/browser-view';

type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
  onNavigate?(url: string): void;
  initialPosition?: { x: number; y: number };
};

const isElectronBrowserRuntime = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__VARIN_ELECTRON__);
};

const IframeBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID, onNavigate, initialPosition }) => {
  const { t } = useI18n();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const onNavigateRef = React.useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const initialPositionRef = React.useRef(initialPosition);
  React.useEffect(() => registerBrowserMaterialCapture(directory, tabID, async () => {
    const frame = iframeRef.current;
    if (!frame?.isConnected || frame.closest('.hidden, [inert], [aria-hidden="true"], [data-varin-workbench-shell-staging]')) return;
    try {
      const frameWindow = frame.contentWindow;
      return frameWindow ? { x: frameWindow.scrollX, y: frameWindow.scrollY } : undefined;
    } catch { return undefined; }
  }), [directory, tabID]);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(() => startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(() => startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  const [isLoading, setIsLoading] = React.useState(Boolean(startUrl));
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const [urlAuthReadyKey, setUrlAuthReadyKey] = React.useState('');
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const appendPiDraftText = usePiDraftStore((state) => state.appendText);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
    onNavigateRef.current?.(url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const applyUrl = React.useCallback((url: string, options?: { replaceHistory?: boolean; inFrame?: boolean }) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    const nextUrl = normalizedUrl !== 'about:blank' ? normalizedUrl : '';
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    if (!options?.inFrame) {
      setLoadedUrl(nextUrl);
      setIsLoading(Boolean(nextUrl));
    } else {
      setIsLoading(false);
    }
    persistUrl(nextUrl);

    setHistory((current) => {
      if (!nextUrl) {
        setHistoryIndex(-1);
        return [];
      }

      if (options?.replaceHistory) {
        return current;
      }

      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      const previous = kept[kept.length - 1];
      if (previous === nextUrl) {
        setHistoryIndex(kept.length - 1);
        return kept;
      }

      const nextHistory = [...kept, nextUrl];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex, persistUrl]);

  const goToHistory = React.useCallback((nextIndex: number) => {
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setCurrentUrl(nextUrl);
    setLoadedUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(true);
    persistUrl(nextUrl);
  }, [history, persistUrl]);

  const handleReload = React.useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      bumpReload();
    }
  }, [currentUrl]);

  React.useEffect(() => {
    if (!loadedUrl) {
      setProxyState({ status: 'idle' });
      return;
    }

    const proxyTargetKey = getBrowserProxyTargetKey(loadedUrl);
    const cached = getCachedProxyTarget(proxyTargetKey);
    if (cached?.previewToken) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, previewToken: cached.previewToken, expiresAt: cached.expiresAt });
      return;
    }
    if (cached) {
      previewProxyTargetCache.delete(proxyTargetKey);
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });
    setIsLoading(true);

    void (async () => {
      try {
        const response = await runtimeFetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: loadedUrl, allowExternal: true }),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; previewToken?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
        const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!proxyBasePath || !previewToken) {
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        previewProxyTargetCache.set(proxyTargetKey, { proxyBasePath, previewToken, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, previewToken, expiresAt });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadedUrl, t]);

  const proxyUrlAuthKey = loadedUrl && proxyState.status === 'ready'
    ? `${proxyState.proxyBasePath}|${proxyState.previewToken || ''}|${reloadNonce}`
    : '';

  React.useEffect(() => {
    if (!proxyUrlAuthKey) {
      setUrlAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setUrlAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setUrlAuthReadyKey(proxyUrlAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [proxyUrlAuthKey]);

  const proxySrc = React.useMemo(() => {
    if (urlAuthReadyKey !== proxyUrlAuthKey) return '';
    if (!loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsed = new URL(loadedUrl);
      const path = parsed.pathname || '/';
      const searchParams = new URLSearchParams(parsed.search);
      searchParams.delete('varin_url_token');
      searchParams.delete('varin_client_token');
      searchParams.set('ocPreview', String(reloadNonce));
      searchParams.set('varin_preview_token', proxyState.previewToken || '');
      const search = searchParams.toString();
      return getRuntimeUrlResolver().authenticatedAsset(`${proxyState.proxyBasePath}${path}${search ? `?${search}` : ''}${parsed.hash}`);
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState, proxyUrlAuthKey, reloadNonce, urlAuthReadyKey]);

  const iframeSrc = proxySrc || (proxyState.status === 'error' ? loadedUrl : '');

  const getCurrentUrlFromFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.origin !== window.location.origin || !parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      const rest = parsedFrameUrl.pathname.slice(proxyBasePath.length) || '/';
      const upstreamOrigin = new URL(loadedUrl).origin;
      return stripPreviewQueryParams(new URL(`${rest}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const getUpstreamUrlFromLocalFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const upstreamOrigin = new URL(loadedUrl).origin;
      if (parsedFrameUrl.origin !== window.location.origin || upstreamOrigin === window.location.origin) {
        return '';
      }

      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      return stripPreviewQueryParams(new URL(`${parsedFrameUrl.pathname}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const postInspectMode = React.useCallback((enabled: boolean) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;
    frameWindow.postMessage({
      source: 'varin-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled,
    }, window.location.origin);
  }, []);

  const attachBrowserAnnotation = React.useCallback(async (target: PreviewElementMetadata) => {
    const sessionKey = currentSessionId;
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const iframe = iframeRef.current;
    const frameWindow = iframe?.contentWindow;
    const rect = iframe?.getBoundingClientRect();
    const viewport = {
      width: Number.isFinite(frameWindow?.innerWidth) ? frameWindow?.innerWidth ?? rect?.width ?? 0 : rect?.width ?? 0,
      height: Number.isFinite(frameWindow?.innerHeight) ? frameWindow?.innerHeight ?? rect?.height ?? 0 : rect?.height ?? 0,
    };

    const file = iframe ? await renderPreviewScreenshot(iframe, target) : null;
    const screenshotAttached = Boolean(file);
    if (file) {
      await addPiDraftImageFile(sessionKey, file);
    }

    appendPiDraftText(sessionKey, formatPreviewAnnotationMarkdown({
        pageUrl: currentUrl,
        viewport,
        devicePixelRatio: window.devicePixelRatio || 1,
        target,
        screenshotAttached,
        intro: t(screenshotAttached
          ? 'contextPanel.preview.inspect.attachAnnotationWithScreenshot'
          : 'contextPanel.preview.inspect.attachAnnotation'),
      }));
    toast.success(t('contextPanel.preview.inspect.attached'));
  }, [appendPiDraftText, currentSessionId, currentUrl, t]);

  const cancelInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    setHoverTarget(null);
    postInspectMode(false);
    if (!iframe) return;
    void runIframeScript<unknown>(iframe, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {});
  }, [postInspectMode]);

  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      cancelInspect();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [cancelInspect, isInspecting]);

  React.useEffect(() => () => cancelInspect(), [cancelInspect]);

  React.useEffect(() => {
    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== 'varin-preview-bridge' || data.version !== 1) return;

      if (data.type === 'ready') {
        const frameUrl = typeof data.url === 'string' ? data.url : '';
        const nextUrl = getCurrentUrlFromFrameUrl(frameUrl);
        if (nextUrl && nextUrl !== currentUrl) {
          applyUrl(nextUrl, { inFrame: true });
        }
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(null);
        setIsInspecting(false);
        postInspectMode(false);
        void attachBrowserAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(nextUrl);
        if (upstreamUrl) {
          applyUrl(upstreamUrl);
          return;
        }
        if (nextUrl) {
          applyUrl(nextUrl);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [applyUrl, attachBrowserAnnotation, currentUrl, getCurrentUrlFromFrameUrl, getUpstreamUrlFromLocalFrameUrl, postInspectMode]);

  const handleInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !currentUrl) return;

    if (isInspecting) {
      setIsInspecting(false);
      cancelInspect();
      return;
    }

    if (proxySrc) {
      setHoverTarget(null);
      setIsInspecting(true);
      postInspectMode(true);
      return;
    }

    setIsInspecting(true);
    void (async () => {
      try {
        const target = await runIframeScript<unknown>(iframe, DESKTOP_BROWSER_INSPECT_SCRIPT);
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;
        await attachBrowserAnnotation(target);
      } catch {
        setIsInspecting(false);
        toast.error(t('contextPanel.browser.inspectUnavailable'));
      }
    })();
  }, [attachBrowserAnnotation, cancelInspect, currentUrl, isInspecting, postInspectMode, proxySrc, t]);

  const handleIframeLoad = React.useCallback(() => {
    const position = initialPositionRef.current;
    if (position) {
      initialPositionRef.current = undefined;
      try { iframeRef.current?.contentWindow?.scrollTo(position.x, position.y); }
      catch { /* Cross-origin frames retain their existing access boundary. */ }
    }
    try {
      const frameUrl = iframeRef.current?.contentWindow?.location.href || '';
      const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(frameUrl);
      if (upstreamUrl) {
        applyUrl(upstreamUrl, { inFrame: true });
        return;
      }
    } catch {
      // Cross-origin direct iframe fallback; regular load handling still applies.
    }

    setIsLoading(false);
    if (isInspecting && proxySrc) {
      postInspectMode(true);
    }
  }, [applyUrl, getUpstreamUrlFromLocalFrameUrl, isInspecting, postInspectMode, proxySrc]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex <= 0} onClick={() => goToHistory(historyIndex - 1)}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goToHistory(historyIndex + 1)}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={handleReload}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); applyUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!currentUrl}
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {iframeSrc ? (
          <div className="absolute inset-0">
            <iframe
              key={`${tabID}:${reloadNonce}`}
              ref={iframeRef}
              src={iframeSrc}
              title={t('contextPanel.browser.empty')}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              allow="clipboard-read; clipboard-write; fullscreen"
              allowFullScreen
              onLoad={handleIframeLoad}
            />
            {isInspecting && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <VarinLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
            <span className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
            <span className="max-w-md typography-micro leading-relaxed text-status-warning/70">{t('contextPanel.browser.trustNotice')}</span>
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const DesktopBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID, onNavigate, initialPosition }) => {
  const { t } = useI18n();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const onNavigateRef = React.useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const initialPositionRef = React.useRef(initialPosition);
  React.useEffect(() => registerBrowserMaterialCapture(directory, tabID, async () => {
    const webview = webviewRef.current;
    if (!webview?.isConnected || webview.closest('.hidden, [inert], [aria-hidden="true"], [data-varin-workbench-shell-staging]')) return;
    const position = await webview.executeJavaScript?.('({ x: window.scrollX, y: window.scrollY })', false);
    if (position && typeof position === 'object' && 'x' in position && 'y' in position
      && typeof position.x === 'number' && typeof position.y === 'number'
      && Number.isFinite(position.x) && Number.isFinite(position.y)) return { x: position.x, y: position.y };
  }), [directory, tabID]);
  React.useEffect(() => {
    const position = initialPositionRef.current;
    if (!position) return;
    const webview = webviewRef.current;
    const restore = () => {
      const x = Number(position.x), y = Number(position.y);
      if (Number.isFinite(x) && Number.isFinite(y)) void webview?.executeJavaScript?.(`window.scrollTo(${x}, ${y})`, false).catch(() => undefined);
    };
    webview?.addEventListener('did-stop-loading', restore, { once: true });
    return () => webview?.removeEventListener('did-stop-loading', restore);
  }, []);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const initialWebviewSrcRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLoading = isLoading;

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
    onNavigateRef.current?.(url);
  }, [directory, tabID, setContextPanelTabTargetPath]);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const appendPiDraftText = usePiDraftStore((state) => state.appendText);

  // Listen to webview navigation events
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const syncUrl = () => {
      try {
        const url = webview.getURL();
        if (url && url !== 'about:blank') {
          setCurrentUrl(url);
          setUrlInput(url);
          persistUrl(url);
        }
      } catch { /* webview not ready */ }
    };

    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string }>).detail;
      if (typeof detail?.url === 'string' && detail.url) {
        setCurrentUrl(detail.url);
        setUrlInput(detail.url);
        persistUrl(detail.url);
      }
    };

    const onStartLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(true), 200);
    };
    const onStopLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
      syncUrl();
    };

    const onNewWindow = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; disposition: string }>).detail;
      if (detail?.disposition === 'new-window' || detail?.disposition === 'foreground-tab' || detail?.disposition === 'background-tab') {
        event.preventDefault();
        const w = webviewRef.current;
        if (typeof w?.loadURL === 'function' && detail.url) {
          w.loadURL(detail.url);
        }
      }
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true).catch(() => {});
      } catch { /* webview not ready */ }
    };

    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('new-window', onNewWindow);
    webview.addEventListener('dom-ready', installSameWebviewNavigation);

    // Check current loading state imperatively — we may have missed the event
    try {
      if (!webview.isLoading()) {
        setIsLoading(false);
        syncUrl();
      }
    } catch { /* webview not ready */ }
    installSameWebviewNavigation();

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('new-window', onNewWindow);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
    };
  }, [persistUrl]);

  // Safety timeout: hide loading overlay after 30s even if events fire late
  React.useEffect(() => {
    const safety = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(safety);
  }, []);

  // Escape key cancels inspect mode
  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      const webview = webviewRef.current;
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isInspecting]);

  // Cancel inspect on unmount
  React.useEffect(() => {
    const webview = webviewRef.current;
    return () => {
      try {
        const url = webview?.getURL?.();
        if (url && url !== 'about:blank') {
          setContextPanelTabTargetPath(directory, tabID, url);
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const loadUrl = React.useCallback((value: string) => {
    const webview = webviewRef.current;
    if (typeof webview?.loadURL !== 'function') return;
    const nextUrl = normalizeBrowserUrl(value);
    try { webview.loadURL(nextUrl); } catch { /* webview may not be ready */ }
  }, []);

  const handleInspect = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isInspecting) {
      setIsInspecting(false);
      try { webview.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
      return;
    }

    setIsInspecting(true);
    webview.executeJavaScript?.(DESKTOP_BROWSER_INSPECT_SCRIPT, true)
      .then(async (target: unknown) => {
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;

        const sessionKey = currentSessionId;
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }

        const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (wcId === null || wcId === undefined) return;

        const capture = await invokeDesktopCommand(
          'desktop_browser_capture_page', { webContentsId: wcId }
        );
        if (!capture) throw new Error('Desktop screenshot capture is not available');

        const cssViewport = await webview.executeJavaScript?.(
          '({ width: window.innerWidth, height: window.innerHeight })', true
        ).catch(() => null) as { width: number; height: number } | null | undefined;

        const cssWidth = Number.isFinite(cssViewport?.width) ? (cssViewport as { width: number }).width : capture.width;
        const cssHeight = Number.isFinite(cssViewport?.height) ? (cssViewport as { height: number }).height : capture.height;

        const file = await desktopAnnotationToFile(capture.base64, capture.width, capture.height, cssWidth, cssHeight, target);
        const screenshotAttached = Boolean(file);
        if (file) {
          await addPiDraftImageFile(sessionKey, file);
        }

        appendPiDraftText(sessionKey, formatPreviewAnnotationMarkdown({
            pageUrl: currentUrl,
            viewport: { width: cssWidth, height: cssHeight },
            devicePixelRatio: window.devicePixelRatio || 1,
            target,
            screenshotAttached,
            intro: t('contextPanel.preview.inspect.attachAnnotationWithScreenshot'),
          }));
        toast.success(t('contextPanel.preview.inspect.attached'));
      })
      .catch(() => setIsInspecting(false));
  }, [appendPiDraftText, currentSessionId, currentUrl, isInspecting, t]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goBack?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goForward?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.reload?.(); } catch { /* webview not ready */ } }}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); loadUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
          />
        </form>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleInspect}
          title={t('contextPanel.preview.inspect.toggle')}
          aria-label={t('contextPanel.preview.inspect.toggle')}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        <webview
          ref={webviewRef}
          src={initialWebviewSrcRef.current}
          partition="persist:varin-browser"
          allowpopups
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
        {(!currentUrl || currentUrl === 'about:blank') && !isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <VarinLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{t('contextPanel.browser.empty')}</span>
          </div>
        ) : null}
        {showLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {t('common.loading')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export function BrowserResourceView(props: DesktopBrowserPaneProps) {
  return isElectronBrowserRuntime() ? <DesktopBrowserPane {...props} /> : <IframeBrowserPane {...props} />;
}
