import React from 'react';
import type { BrowserAction, BrowserPage } from '@varin/protocol';
import type { VarinDesktopBridge } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { embeddedBrowserPageId } from '@/lib/browser-page';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { registerBrowserMaterialCapture } from '@/lib/agent-editor/material-navigation';
import { addThreadDraftImage } from '@/lib/agent-runtime/draftAttachments';
import { appendThreadDraftText } from '@/lib/agent-runtime/threadNavigation';
import { isPreviewElementMetadata, formatPreviewAnnotationMarkdown, desktopAnnotationToFile } from '@/lib/preview/screenshot-capture';
import { DESKTOP_BROWSER_INSPECT_SCRIPT, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT, normalizeBrowserUrl } from '@/lib/preview/browser-view';

export interface DesktopBrowserPaneProps {
  initialUrl: string; directory: string; tabID: string; onNavigate?(url: string): void; initialPosition?: { x: number; y: number };
}
/** The DOM supplies chrome and placement; Electron retains the same live page. */
export function DesktopBrowserPane({ initialUrl, directory, tabID, onNavigate }: DesktopBrowserPaneProps) {
  const { t } = useI18n();
  const pageId = embeddedBrowserPageId(directory, tabID);
  const [viewId] = React.useState(() => crypto.randomUUID());
  const viewport = React.useRef<HTMLDivElement>(null);
  const [page, setPage] = React.useState<BrowserPage>();
  const [address, setAddress] = React.useState(initialUrl);
  const editingAddress = React.useRef(false);
  const [error, setError] = React.useState('');
  const [inspecting, setInspecting] = React.useState(false);
  const [prompt, setPrompt] = React.useState('');
  const [coveredImage, setCoveredImage] = React.useState<string>();
  const selectedThread = useThreadStore(state => state.selectedIdentity);
  const navigate = React.useRef(onNavigate); navigate.current = onNavigate;
  const initial = React.useRef(normalizeBrowserUrl(initialUrl));
  const accept = React.useCallback((value: BrowserPage) => {
    setPage(value);
    if (value.url && value.url !== 'about:blank') {
      if (!editingAddress.current) setAddress(value.url);
      useUIStore.getState().setContextPanelTabTargetPath(directory, tabID, value.url); navigate.current?.(value.url);
    }
  }, [directory, tabID]);
  const act = React.useCallback(async (action: BrowserAction) => {
    const result = await invokeDesktopCommand('desktop_browser_action', { pageId, action });
    if (result) accept(result.page); return result;
  }, [pageId, accept]);
  React.useEffect(() => {
    let disposed = false, mounted = false, wasVisible = false, frame = 0, last = '', presenting = false;
    const element = viewport.current; if (!element) return;
    const update = () => {
      frame = 0; if (disposed || !element.isConnected) return;
      const rect = element.getBoundingClientRect();
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const blocked = document.documentElement.classList.contains('oc-dialog-open') || [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="tooltip"], [data-slot="popover-content"]')].some(popup => {
        if (!(popup instanceof HTMLElement) || !popup.checkVisibility()) return false;
        const box = popup.getBoundingClientRect(); return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
      });
      const visible = !document.hidden && element.checkVisibility() && !element.closest('[inert], [aria-hidden="true"], [data-varin-workbench-shell-staging]') && rect.width > 0 && rect.height > 0 && !blocked;
      if (!mounted && !visible) return;
      const key = JSON.stringify([bounds, visible]); if (key === last || presenting) return; last = key;
      if (visible && !wasVisible) {
        presenting = true;
        void invokeDesktopCommand('desktop_browser_present', { pageId, viewId, url: initial.current, bounds, visible: true }).then(value => {
          if (disposed) { void invokeDesktopCommand('desktop_browser_detach', { pageId, viewId }); return; }
          mounted = true; if (value) accept(value); setError('');
        }).catch(cause => { if (!disposed) setError(String(cause)); }).finally(() => { presenting = false; if (!disposed) schedule(); });
      } else {
        void invokeDesktopCommand('desktop_browser_layout', { pageId, viewId, bounds, visible }).catch(cause => { if (!disposed) setError(String(cause)); });
      }
      if (!visible && wasVisible && blocked) void invokeDesktopCommand('desktop_browser_read', { pageId, view: 'screenshot' }).then(observation => {
        if (!disposed && observation?.image) setCoveredImage(`data:image/png;base64,${observation.image.base64}`);
      }).catch(() => undefined);
      wasVisible = visible;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const size = new ResizeObserver(schedule); size.observe(element);
    const visibility = new MutationObserver(schedule); visibility.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-state'], childList: true });
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule);
    const bridge = (window as unknown as { __VARIN_DESKTOP__?: VarinDesktopBridge }).__VARIN_DESKTOP__;
    let unsubscribe: (() => void | Promise<void>) | undefined;
    void bridge?.listen('varin:browser', event => {
      if (disposed) return;
      if (event.payload.kind === 'page' && event.payload.page.pageId === pageId) accept(event.payload.page);
      if (event.payload.kind === 'closed' && event.payload.pageId === pageId) { setPage(undefined); setError(t('browser.pageClosed')); }
    }).then(stop => { if (disposed) void stop?.(); else unsubscribe = stop; });
    schedule();
    return () => {
      disposed = true; if (frame) cancelAnimationFrame(frame); size.disconnect(); visibility.disconnect(); void unsubscribe?.();
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule);
      void invokeDesktopCommand('desktop_browser_detach', { pageId, viewId }).catch(() => undefined);
      void invokeDesktopCommand('desktop_browser_action', { pageId, action: { action: 'evaluate', script: DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT } }).catch(() => undefined);
    };
  }, [pageId, viewId, accept, t]);
  React.useEffect(() => registerBrowserMaterialCapture(directory, tabID, async () => {
    const result = await act({ action: 'evaluate', script: '({x:scrollX,y:scrollY})' });
    const point = result?.value as { x?: unknown; y?: unknown } | undefined;
    return typeof point?.x === 'number' && typeof point.y === 'number' ? { x: point.x, y: point.y } : undefined;
  }), [directory, tabID, act]);
  const inspect = async () => {
    if (inspecting) { await act({ action: 'evaluate', script: DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT }); setInspecting(false); return; }
    setInspecting(true);
    try {
      const controlled = await invokeDesktopCommand('desktop_browser_control', { pageId, paused: true }); if (controlled) accept(controlled);
      const target = (await act({ action: 'evaluate', script: DESKTOP_BROWSER_INSPECT_SCRIPT }))?.value;
      if (!target || !isPreviewElementMetadata(target)) return;
      if (!selectedThread) { toast.error(t('contextPanel.preview.inspect.attachNoSession')); return; }
      const observation = await invokeDesktopCommand('desktop_browser_read', { pageId, view: 'screenshot' });
      if (!observation?.image) return;
      const { image, viewport } = observation;
      const file = await desktopAnnotationToFile(image.base64, image.width, image.height, viewport.width, viewport.height, target);
      if (file) await addThreadDraftImage(selectedThread, file);
      appendThreadDraftText(selectedThread, `Browser: ${observation.page.browserId}\nPage: ${pageId}\n` + formatPreviewAnnotationMarkdown({
        pageUrl: observation.page.url, viewport, devicePixelRatio: viewport.scale, target, screenshotAttached: Boolean(file), intro: t('contextPanel.preview.inspect.attachAnnotationWithScreenshot'),
      }));
      toast.success(t('contextPanel.preview.inspect.attached'));
    } catch (cause) { toast.error(String(cause)); } finally { setInspecting(false); }
  };
  const run = (action: BrowserAction) => { void act(action).catch(cause => setError(String(cause))); };
  return <div className="absolute inset-0 flex min-w-0 flex-col bg-background">
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!page?.canGoBack} aria-label={t('browser.back')} onClick={() => run({ action: 'back' })}><Icon name="arrow-left" className="size-3.5" /></Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!page?.canGoForward} aria-label={t('browser.forward')} onClick={() => run({ action: 'forward' })}><Icon name="arrow-right" className="size-3.5" /></Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t('office.reader.refresh')} onClick={() => run({ action: 'reload' })}><Icon name="refresh" className={page?.loading ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'} /></Button>
      <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); editingAddress.current = false; run({ action: 'navigate', url: normalizeBrowserUrl(address) }); }}>
        <input value={address} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={event => setAddress(event.target.value)} aria-label={t('contextPanel.browser.addressAria')} className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro outline-none focus:border-ring" />
      </form>
      <Button type="button" size="sm" variant={inspecting ? 'secondary' : 'ghost'} className="h-7 w-7 p-0" title={t('contextPanel.preview.inspect.toggle')} aria-label={t('contextPanel.preview.inspect.toggle')} onClick={() => void inspect()}><Icon name="cursor" className="size-3.5" /></Button>
      <Button type="button" size="sm" variant={page?.agentPaused ? 'secondary' : 'ghost'} className="h-7 w-7 p-0" title={t(page?.agentPaused ? 'browser.resume' : 'browser.takeOver')}
        aria-label={t(page?.agentPaused ? 'browser.resume' : 'browser.takeOver')} onClick={() => void invokeDesktopCommand('desktop_browser_control', { pageId, paused: !page?.agentPaused }).then(value => { if (value) accept(value); }).catch(cause => setError(String(cause)))}>
        <Icon name={page?.agentPaused ? 'play' : 'pause'} className="size-3.5" />
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={t('office.reader.openOriginal')} onClick={() => void openExternalUrl(page?.url || address)}><Icon name="external-link" className="size-3.5" /></Button>
    </div>
    {(page?.activeAction || page?.agentPaused || page?.scriptPending) && <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 py-1 typography-micro text-muted-foreground">
      <span>{t(page.scriptPending ? 'browser.scriptPending' : page.agentPaused ? 'browser.userControl' : 'browser.agentWorking')}</span>
      <button type="button" onClick={() => void invokeDesktopCommand('desktop_browser_control', { pageId, paused: !page.agentPaused }).then(value => { if (value) accept(value); }).catch(cause => setError(String(cause)))}>{t(page.agentPaused ? 'browser.resume' : 'browser.takeOver')}</button>
    </div>}
    {page?.dialog && <form className="shrink-0 space-y-2 border-b border-border p-3 typography-meta" onSubmit={event => { event.preventDefault(); run({ action: 'dialog', accept: true, text: prompt }); setPrompt(''); }}>
      <p className="whitespace-pre-wrap break-words">{page.dialog.message}</p>
      {page.dialog.type === 'prompt' && <input value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={page.dialog.defaultPrompt} className="w-full rounded border border-border bg-background px-2 py-1" />}
      <div className="flex gap-2"><Button type="submit" size="sm">{t('browser.confirm')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => run({ action: 'dialog', accept: false })}>{t('browser.cancel')}</Button></div>
    </form>}
    {error && <div role="alert" className="shrink-0 break-words px-3 py-2 typography-meta text-destructive">{error}</div>}
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-background">
      {coveredImage && <img src={coveredImage} alt="" className="absolute inset-0 h-full w-full object-fill" />}
      {!page && !error && <div className="flex h-full items-center justify-center typography-meta text-muted-foreground">{t('common.loading')}</div>}
    </div>
  </div>;
}
