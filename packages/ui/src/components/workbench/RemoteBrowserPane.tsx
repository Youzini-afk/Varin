import React from 'react';
import { createBrowserHttpClient, type BrowserHttpClient } from '@varin/application-client';
import type { BrowserCatalog, BrowserDeviceStatus, BrowserDownload, BrowserFrame, BrowserPage, BrowserUserInput } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getDesktopRuntime } from '@/lib/desktopRuntime';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { createBrowserInputQueue, browserModifiers } from '@/lib/remote-browser-input';
import { normalizeBrowserUrl } from '@/lib/preview/browser-view';
import { useUIStore } from '@/stores/useUIStore';
import { getRemoteBrowserPage, rememberRemoteBrowserPage, prepareRemoteBrowserPage } from '@/lib/browser-page';
import type { DesktopBrowserPaneProps } from './DesktopBrowserPane';

/** The canvas is a viewer of the original BrowserOwner's compositor stream.
 * No iframe, local page substitute or screenshot timer participates. */
export function RemoteBrowserPane({ initialUrl, directory, tabID, onNavigate }: DesktopBrowserPaneProps) {
  const { t } = useI18n();
  const [api] = React.useState<BrowserHttpClient>(createBrowserHttpClient);
  const [streamId] = React.useState(() => crypto.randomUUID());
  const [catalog, setCatalog] = React.useState<BrowserCatalog>();
  const [page, setPage] = React.useState<BrowserPage>();
  const [address, setAddress] = React.useState(initialUrl);
  const [error, setError] = React.useState('');
  const [working, setWorking] = React.useState(false);
  const [permission, setPermission] = React.useState<BrowserDeviceStatus>();
  const [prompt, setPrompt] = React.useState('');
  const [live, setLive] = React.useState(false);
  const [downloads, setDownloads] = React.useState<BrowserDownload[]>([]);
  const [showDownloads, setShowDownloads] = React.useState(false);
  const canvas = React.useRef<HTMLCanvasElement>(null), input = React.useRef<HTMLTextAreaElement>(null), viewport = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<BrowserFrame>(undefined), pageRef = React.useRef(page); pageRef.current = page;
  const callback = React.useRef(onNavigate); callback.current = onNavigate;
  const mounted = React.useRef(true), busy = React.useRef(false), composing = React.useRef(false), editAddress = React.useRef(false);
  const inputQueue = React.useRef<ReturnType<typeof createBrowserInputQueue>>(undefined);
  const accept = React.useCallback((value: BrowserPage) => {
    if (!mounted.current) return; setPage(value);
    rememberRemoteBrowserPage(directory, tabID, value, api);
    if (value.url && value.url !== 'about:blank') {
      if (!editAddress.current) setAddress(value.url);
      useUIStore.getState().setContextPanelTabTargetPath(directory, tabID, value.url); callback.current?.(value.url);
    }
  }, [api, directory, tabID]);
  const refresh = React.useCallback(async () => { const value = await api.catalog(); if (mounted.current) setCatalog(value); return value; }, [api]);
  const perform = async (work: () => Promise<unknown>) => {
    if (busy.current) return; busy.current = true; setWorking(true); setError('');
    try { await work(); } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { busy.current = false; if (mounted.current) setWorking(false); }
  };
  React.useEffect(() => {
    mounted.current = true; let disposed = false;
    void refresh().then(async current => {
      if (disposed) return;
      const selected = tabID.startsWith('browser:page:') ? tabID.slice('browser:page:'.length) : getRemoteBrowserPage(directory, tabID)?.pageId;
      if (selected) {
        const original = current.pages.find(page => page.pageId === selected);
        if (!original) throw new Error(t('browser.originalUnavailable'));
        accept(original); return;
      }
      if (current.defaultBrowserId) { const opened = await prepareRemoteBrowserPage(directory, tabID, api, normalizeBrowserUrl(initialUrl)); if (!disposed) accept(opened); }
    }).catch(cause => { if (mounted.current) setError(String(cause)); });
    return () => { disposed = true; mounted.current = false; };
  }, [api, accept, directory, initialUrl, refresh, t, tabID]);
  React.useEffect(() => {
    if (!page?.pageId) return;
    const pageId = page.pageId, cancellation = new AbortController(); let stopped = false, decoding = false;
    let pendingFrame: BrowserFrame | undefined;
    frame.current = undefined; setLive(false);
    const draw = async () => {
      if (decoding || stopped) return; decoding = true;
      try {
        while (pendingFrame && !stopped) {
          const next = pendingFrame; pendingFrame = undefined;
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(next.bytes)], { type: next.mimeType }));
          try { if (!stopped && canvas.current) { canvas.current.width = bitmap.width; canvas.current.height = bitmap.height; canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0); frame.current = next; setLive(true); } }
          finally { bitmap.close(); }
        }
      } catch (cause) { if (!stopped) setError(String(cause)); }
      finally { decoding = false; }
    };
    inputQueue.current = createBrowserInputQueue({ frame: () => pageRef.current?.agentPaused && pageRef.current.controlViewerId === streamId ? frame.current : undefined,
      send: request => api.input(request), failed: cause => { if (!stopped) setError(String(cause)); } });
    const stopEvents = api.events(pageId, event => {
      if (stopped) return;
      if (event.kind === 'page') accept(event.page);
      if (event.kind === 'download') setDownloads(previous => [...previous.filter(item => item.downloadId !== event.download.downloadId), event.download]);
      if (event.kind === 'closed') { setError(t('browser.pageClosed')); cancellation.abort(); }
    });
    void api.frames(pageId, streamId, value => { pendingFrame = value; void draw(); }, cancellation.signal).then(() => {
      if (!stopped) { setLive(false); setError(t('browser.streamEnded')); }
    }).catch(cause => { if (!stopped) { setLive(false); setError(String(cause)); } });
    const blur = () => inputQueue.current?.enqueue({ type: 'release' }); window.addEventListener('blur', blur);
    return () => { stopped = true; void inputQueue.current?.stop(); inputQueue.current = undefined; pendingFrame = undefined; cancellation.abort(); stopEvents(); window.removeEventListener('blur', blur); };
  }, [api, page?.pageId, streamId, accept, t]);
  const controlled = page?.agentPaused && page.controlViewerId === streamId;
  const send = (value: BrowserUserInput) => { if (controlled && live) inputQueue.current?.enqueue(value); };
  const position = (clientX: number, clientY: number) => {
    const rect = canvas.current?.getBoundingClientRect(), current = frame.current;
    if (!rect || !current) return { x: 0, y: 0 };
    const scale = Math.min(rect.width / current.viewport.width, rect.height / current.viewport.height);
    return { x: Math.max(0, Math.min(current.viewport.width, (clientX - rect.left - (rect.width - current.viewport.width * scale) / 2) / scale)),
      y: Math.max(0, Math.min(current.viewport.height, (clientY - rect.top - (rect.height - current.viewport.height * scale) / 2) / scale)) };
  };
  const pointer = (event: React.PointerEvent, phase: 'move' | 'down' | 'up') => {
    if (!controlled || event.pointerType === 'touch') return;
    if (phase === 'down') { input.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); }
    send({ type: 'pointer', phase, ...position(event.clientX, event.clientY), button: phase === 'move' ? 'none' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', buttons: event.buttons,
      clickCount: phase === 'move' ? 0 : Math.min(3, Math.max(1, event.detail)), modifiers: browserModifiers(event) });
    if (phase === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.preventDefault();
  };
  const key = (event: React.KeyboardEvent, phase: 'down' | 'up') => {
    if (!controlled || composing.current || event.nativeEvent.isComposing) return;
    send({ type: 'key', phase, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, location: event.location, modifiers: browserModifiers(event), autoRepeat: event.repeat });
    if (event.key.length !== 1 && event.key !== 'Unidentified' || event.ctrlKey || event.metaKey) event.preventDefault();
  };
  const takeover = () => perform(async () => {
    if (!page) return; const next = await api.control(page.pageId, streamId, !controlled); accept(next); inputQueue.current?.resume();
    if (next.agentPaused && viewport.current) { const rect = viewport.current.getBoundingClientRect(); if (rect.width >= 1 && rect.height >= 1) await api.resize(page.pageId, streamId, Math.round(rect.width), Math.round(rect.height)); input.current?.focus(); }
  });
  const action = (value: import('@varin/protocol').BrowserAction) => perform(async () => { if (page) accept((await api.action(page.pageId, value)).page); });
  const device = catalog?.devices.find(value => value.browserId === page?.browserId);
  return <div className="absolute inset-0 flex min-w-0 flex-col bg-background">
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <Button size="sm" variant="ghost" disabled={!page?.canGoBack || working} aria-label={t('browser.back')} onClick={() => void action({ action: 'back' })}><Icon name="arrow-left" /></Button>
      <Button size="sm" variant="ghost" disabled={!page?.canGoForward || working} aria-label={t('browser.forward')} onClick={() => void action({ action: 'forward' })}><Icon name="arrow-right" /></Button>
      <Button size="sm" variant="ghost" disabled={!page || working} aria-label={t('office.reader.refresh')} onClick={() => void action({ action: 'reload' })}><Icon name="refresh" /></Button>
      <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); editAddress.current = false; void action({ action: 'navigate', url: normalizeBrowserUrl(address) }); }}>
        <input aria-label={t('contextPanel.browser.addressAria')} value={address} onFocus={() => { editAddress.current = true; }} onBlur={() => { editAddress.current = false; }} onChange={event => setAddress(event.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 typography-meta" />
      </form>
      <Button size="sm" variant={controlled ? 'secondary' : 'ghost'} disabled={!page || working || !live} onClick={() => void takeover()}>{t(controlled ? 'browser.resume' : 'browser.takeOver')}</Button>
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 typography-micro">
      <span>{t('browser.device')}: {device?.label ?? t('browser.selectDevice')}</span>
      <select aria-label={t('browser.selectDevice')} value={catalog?.defaultBrowserId ?? ''} disabled={working} onChange={event => { const selected = event.target.value; void perform(async () => { await api.select(selected || null); await refresh(); if (!page && selected) accept(await prepareRemoteBrowserPage(directory, tabID, api, normalizeBrowserUrl(address))); }); }} className="max-w-52 rounded border border-border bg-background px-2 py-1">
        <option value="">{t('browser.selectDevice')}</option>{catalog?.devices.map(device => <option key={device.browserId} value={device.browserId} disabled={device.state !== 'connected'}>{device.label} · {device.state}</option>)}
      </select>
      {getDesktopRuntime()?.runtime === 'tauri' && <Button size="sm" variant="ghost" disabled={working || !catalog} onClick={() => void perform(async () => { const status = await invokeDesktopCommand('desktop_browser_device', { action: 'status' }); if (status) setPermission(status); })}>{t('browser.connectLocal')}</Button>}
      {device && !device.local && <Button size="sm" variant="ghost" disabled={working} onClick={() => void perform(async () => { await api.revoke(device.browserId); await refresh(); })}>{t('browser.revokeDevice')}</Button>}
      {page && <Button size="sm" variant="ghost" onClick={() => void perform(async () => { setDownloads(await api.downloads(page.pageId)); setShowDownloads(value => !value); })}>{t('browser.downloads')}</Button>}
      {page && <span className="text-muted-foreground">{live ? t('browser.live') : t('browser.connectingStream')}</span>}
    </div>
    {permission && catalog && <div className="space-y-2 border-b border-border p-3 typography-meta" role="dialog" aria-label={t('browser.authorizeDevice')}>
      <p>{t('browser.shareProfileWarning')}</p><p className="break-all text-muted-foreground">{permission.label} → {catalog.hostId}</p>
      <div className="flex gap-2"><Button disabled={working} onClick={() => void perform(async () => {
        const status = await invokeDesktopCommand('desktop_browser_device', { action: 'connect', expectedHostId: catalog.hostId, shareInteractiveProfile: true });
        if (!status) throw new Error(t('browser.originalUnavailable')); await api.select(status.browserId); setPermission(undefined); await refresh();
        if (!page) accept(await prepareRemoteBrowserPage(directory, tabID, api, normalizeBrowserUrl(address)));
      })}>{t('browser.authorizeDevice')}</Button><Button variant="ghost" disabled={working} onClick={() => setPermission(undefined)}>{t('browser.cancel')}</Button></div>
    </div>}
    {showDownloads && page && <div className="max-h-40 shrink-0 overflow-auto border-b border-border p-3 typography-meta">{downloads.length ? downloads.map(download => <div key={download.downloadId} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{download.name} · {download.state}</span><Button size="sm" variant="ghost" disabled={download.state !== 'completed' || working} onClick={() => void perform(async () => { const blob = await api.download(page.pageId, download.downloadId); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = download.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>{t('browser.saveDownload')}</Button></div>) : t('browser.noDownloads')}</div>}
    {page?.dialog && <form className="space-y-2 border-b border-border p-3 typography-meta" onSubmit={event => { event.preventDefault(); void action({ action: 'dialog', accept: true, text: prompt }); setPrompt(''); }}>
      <p>{page.dialog.message}</p>{page.dialog.type === 'prompt' && <input value={prompt} onChange={event => setPrompt(event.target.value)} aria-label={page.dialog.message} />}
      <Button type="submit" disabled={working}>{t('browser.confirm')}</Button><Button type="button" variant="ghost" disabled={working} onClick={() => void action({ action: 'dialog', accept: false })}>{t('browser.cancel')}</Button>
    </form>}
    {page?.fileChooser && <div className="flex gap-2 border-b border-border p-3 typography-meta"><input type="file" multiple={page.fileChooser.multiple} aria-label={t('browser.chooseFiles')} onChange={event => { const files = [...event.target.files ?? []], chooserId = page.fileChooser!.chooserId; void perform(() => api.chooseFiles(page.pageId, chooserId, files)); }} /><Button variant="ghost" onClick={() => void perform(() => api.chooseFiles(page.pageId, page.fileChooser!.chooserId, []))}>{t('browser.cancel')}</Button></div>}
    {error && <div role="alert" className="shrink-0 break-words px-3 py-2 text-destructive typography-meta">{error}</div>}
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-black" onContextMenu={event => event.preventDefault()}
      onPointerDown={event => pointer(event, 'down')} onPointerMove={event => pointer(event, 'move')} onPointerUp={event => pointer(event, 'up')} onPointerCancel={() => send({ type: 'release' })}
      onWheel={event => { if (controlled) { const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current?.clientHeight ?? 800 : 1; send({ type: 'wheel', ...position(event.clientX, event.clientY), deltaX: event.deltaX * multiplier, deltaY: event.deltaY * multiplier, modifiers: browserModifiers(event) }); } }}
      onTouchStart={event => { if (controlled) { event.preventDefault(); send({ type: 'touch', phase: 'start', modifiers: browserModifiers(event), points: Array.from(event.touches).map(touch => ({ id: touch.identifier, ...position(touch.clientX, touch.clientY), radiusX: ('radiusX' in touch ? Number(touch.radiusX) : 1), radiusY: ('radiusY' in touch ? Number(touch.radiusY) : 1), force: ('force' in touch ? Number(touch.force) : 1) })) }); } }}
      onTouchMove={event => { if (controlled) { event.preventDefault(); send({ type: 'touch', phase: 'move', modifiers: browserModifiers(event), points: Array.from(event.touches).map(touch => ({ id: touch.identifier, ...position(touch.clientX, touch.clientY), radiusX: ('radiusX' in touch ? Number(touch.radiusX) : 1), radiusY: ('radiusY' in touch ? Number(touch.radiusY) : 1), force: ('force' in touch ? Number(touch.force) : 1) })) }); } }}
      onTouchEnd={event => send({ type: 'touch', phase: 'end', points: [], modifiers: browserModifiers(event) })} onTouchCancel={event => send({ type: 'touch', phase: 'cancel', points: [], modifiers: browserModifiers(event) })}>
      <canvas ref={canvas} aria-label={t('browser.remotePage')} className="absolute inset-0 h-full w-full object-contain" />
      <textarea ref={input} aria-label={t('browser.pageInput')} className="absolute bottom-0 left-0 h-px w-px resize-none opacity-[0.01]" disabled={!controlled} autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onKeyDown={event => key(event, 'down')} onKeyUp={event => key(event, 'up')} onBlur={() => send({ type: 'release' })}
        onCompositionStart={() => { composing.current = true; }} onCompositionUpdate={event => send({ type: 'composition', text: event.data, selectionStart: event.data.length, selectionEnd: event.data.length })}
        onCompositionEnd={event => { composing.current = false; send({ type: 'text', text: event.data }); event.currentTarget.value = ''; }}
        onInput={event => { if (!composing.current && event.currentTarget.value) { send({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = ''; } }}
        onPaste={event => { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text/plain') }); }}
        onCopy={() => { if (page) void api.action(page.pageId, { action: 'evaluate', script: 'String(window.getSelection())' }).then(result => navigator.clipboard.writeText(String(result.value ?? ''))).catch(cause => setError(String(cause))); }} />
      {!live && <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-white typography-meta">{page ? t('browser.connectingStream') : t('browser.noDevice')}</div>}
    </div>
  </div>;
}
