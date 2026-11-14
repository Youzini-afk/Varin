import React from 'react';
import type { BrowserPage, BrowserResource, BrowserResourceBinding } from '@varin/protocol';
import { browserResources, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type BrowserPageBinding, type BrowserPageSnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { browserResourceBindingKey } from '@/lib/browser-resource-binding';

const selectClass = 'h-7 min-w-0 rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro outline-none focus:border-ring';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** An observation of the owner's exact page, never a second browser at the same URL. */
export function ConnectedBrowserPage({ resource, binding, onObservedPage }: { resource: BrowserResource; binding: BrowserPageBinding; onObservedPage?(page: BrowserPage): void }) {
  const { t } = useI18n();
  const { browserId, instanceId, pageId } = binding;
  const [snapshot, setSnapshot] = React.useState<BrowserPageSnapshot>();
  const [observedAt, setObservedAt] = React.useState<string>();
  const [view, setView] = React.useState<'structure' | 'screenshot'>(() => resource.capabilities.includes('read') ? 'structure' : 'screenshot');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const observed = React.useRef(onObservedPage); observed.current = onObservedPage;
  const pending = React.useRef(false);
  const lifetime = React.useRef<AbortController | null>(null);
  const connected = resource.state === 'online' && resource.instanceId === binding.instanceId;
  const canRead = resource.capabilities.includes(view === 'screenshot' ? 'screenshot' : 'read');
  const perform = React.useCallback(async (action?: 'takeover' | 'resume' | 'activate') => {
    if (pending.current || !connected || !lifetime.current) return;
    pending.current = true; setBusy(true); setError('');
    const signal = lifetime.current.signal;
    const target = { browserId, instanceId, pageId };
    try {
      if (action) {
        const result = await browserResources.control(target, action, signal);
        if (signal.aborted) return;
        setSnapshot(previous => previous ? { ...previous, usage: result.usage } : previous);
      }
      if (canRead) {
        const next = await browserResources.observe(target, view, signal);
        if (signal.aborted) return;
        setSnapshot(next); setObservedAt(new Date().toLocaleTimeString()); observed.current?.(next.observation.page);
      }
    } catch (cause) { if (!signal.aborted) setError(errorText(cause)); }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  }, [browserId, instanceId, pageId, canRead, connected, view]);
  React.useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller; pending.current = false; setBusy(false);
    void perform();
    return () => { controller.abort(); lifetime.current = null; };
  }, [perform]);
  const page = snapshot?.observation.page;
  const usage = snapshot?.usage;
  const observation = snapshot?.observation;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
      <div className="min-w-0 flex-1"><p className="truncate typography-meta">{page?.title || binding.pageId}</p><p className="truncate typography-micro text-muted-foreground">{page?.url || t('browser.resource.notObserved')}</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={busy || !connected || !canRead} onClick={() => void perform()} aria-label={t('browser.resource.observe')}><Icon name="refresh" className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} /></Button>
      {resource.capabilities.includes('read') && resource.capabilities.includes('screenshot') && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setView(current => current === 'structure' ? 'screenshot' : 'structure')}>{t(view === 'structure' ? 'browser.resource.screenshot' : 'browser.resource.structure')}</Button>}
      {resource.capabilities.includes('act') && <Button type="button" variant="outline" size="sm" disabled={busy || !connected || !usage} onClick={() => void perform(usage?.controller === 'human' ? 'resume' : 'takeover')}>{t(usage?.controller === 'human' ? 'browser.resume' : 'browser.takeOver')}</Button>}
      {resource.capabilities.includes('activate') && <Button type="button" variant="ghost" size="sm" disabled={busy || !connected} onClick={() => void perform('activate')}>{t('browser.resource.openOnDevice')}</Button>}
    </div>
    <div className="space-y-1 border-b border-border/50 px-3 py-2 typography-micro text-muted-foreground">
      <p className="break-all">{t('browser.resource.identity', { instance: binding.instanceId, page: binding.pageId })}</p>
      <p role="status">{t('browser.resource.observationOnly')}{observedAt ? ` · ${t('browser.resource.observedAt', { time: observedAt })}` : ''}</p>
      {usage && <p>{t(usage.controller === 'human' ? 'browser.userControl' : usage.activeThreadId ? 'browser.agentWorking' : 'browser.resource.available')}{usage.activeThreadId ? ` · ${usage.activeThreadId}` : ''}</p>}
      {usage?.waitingThreadIds.length ? <p className="break-all">{t('browser.resource.waiting', { threads: usage.waitingThreadIds.join(', ') })}</p> : null}
      {!resource.capabilities.includes('activate') && <p>{t('browser.resource.openUnavailable')}</p>}
      {!connected && <p role="status">{t(resource.instanceId !== binding.instanceId ? 'browser.resource.instanceEnded' : 'browser.resource.offline')}</p>}
      {!canRead && <p role="status">{t('browser.resource.observationUnavailable')}</p>}
    </div>
    {error && <p role="alert" className="shrink-0 break-words px-3 py-2 typography-meta text-destructive">{error}{snapshot ? ` · ${t('browser.resource.lastObservation')}` : ''}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {observation?.image && <img src={`data:${observation.image.mimeType};base64,${observation.image.base64}`} alt={page?.title || binding.pageId} className="mx-auto max-w-full" />}
      {observation?.text && <pre className="whitespace-pre-wrap break-words typography-meta">{observation.text}</pre>}
      {observation?.elements?.length ? <ul className="space-y-2 typography-meta">{observation.elements.map((element, index) => <li key={`${observation.observationId}:${element.ref ?? index}`} className="break-words"><span className="text-muted-foreground">{element.role}</span>{element.name ? ` · ${element.name}` : ''}{element.value ? ` · ${element.value}` : ''}{element.description ? <p className="typography-micro text-muted-foreground">{element.description}</p> : null}</li>)}</ul> : null}
      {!observation && <p className="typography-meta text-muted-foreground">{t(busy ? 'common.loading' : 'browser.resource.notObserved')}</p>}
    </div>
  </div>;
}

export function ConnectedBrowserSurface({ binding, onBindingChange, onObservedPage, preview }: {
  binding?: BrowserResourceBinding; onBindingChange(binding?: BrowserResourceBinding): void; onObservedPage?(page: BrowserPage): void; preview: React.ReactNode;
}) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [catalog, setCatalog] = React.useState<{ host: number; resources: BrowserResource[] }>();
  const [pages, setPages] = React.useState<{ key: string; pages: BrowserPage[] }>();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const resources = catalog?.host === host ? catalog.resources : [];
  const resource = resources.find(candidate => candidate.browserId === binding?.browserId);
  const pageListKey = binding ? JSON.stringify([host, binding.browserId, binding.instanceId]) : '';
  const availablePages = pages?.key === pageListKey ? pages.pages : [];
  const bindingKey = browserResourceBindingKey(binding);
  const browserId = binding?.browserId, instanceId = binding?.instanceId;
  React.useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void browserResources.list(controller.signal).then(next => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setCatalog({ host, resources: next });
    }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [host, refresh]);
  React.useEffect(() => {
    if (!browserId || !instanceId || resource?.state !== 'online' || resource.instanceId !== instanceId || !resource.capabilities.includes('tabs')) return;
    const controller = new AbortController();
    void browserResources.pages({ browserId, instanceId }, controller.signal).then(next => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setPages({ key: pageListKey, pages: next });
    }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [browserId, instanceId, host, pageListKey, resource]);
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-[var(--surface-background)] px-2 py-1">
      <Icon name="global" className="size-3.5 shrink-0 text-muted-foreground" />
      <select className={`${selectClass} flex-1`} value={binding?.browserId ?? ''} aria-label={t('browser.resource.select')} onChange={event => {
        const next = resources.find(candidate => candidate.browserId === event.target.value);
        onBindingChange(next?.instanceId ? { browserId: next.browserId, instanceId: next.instanceId } : undefined);
      }}>
        <option value="">{t('browser.resource.separatePreview')}</option>
        {binding && !resource && <option value={binding.browserId}>{binding.browserId}</option>}
        {resources.map(item => <option key={item.browserId} value={item.browserId} disabled={!item.instanceId}>{item.deviceName} · {item.label} · {t(`browser.resource.state.${item.state}`)}</option>)}
      </select>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)} aria-label={t('browser.resource.refresh')}><Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /></Button>
    </div>
    {binding && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
      <span className="typography-micro text-muted-foreground">{resource ? `${resource.deviceName} · ${resource.label} · ${t(`browser.resource.state.${resource.state}`)}` : t('browser.resource.offline')}</span>
      {resource?.instanceId && resource.instanceId !== binding.instanceId && resource.state === 'online' && <Button type="button" size="sm" variant="outline" onClick={() => onBindingChange({ browserId: resource.browserId, instanceId: resource.instanceId! })}>{t('browser.resource.useCurrentInstance')}</Button>}
      <select className={`${selectClass} flex-1`} aria-label={t('browser.resource.page')} value={binding.pageId ?? ''} onChange={event => onBindingChange({ ...binding, pageId: event.target.value || undefined })}>
        <option value="">{t('browser.resource.choosePage')}</option>
        {binding.pageId && !availablePages.some(page => page.pageId === binding.pageId) && <option value={binding.pageId}>{binding.pageId}</option>}
        {availablePages.map(page => <option key={page.pageId} value={page.pageId}>{page.title || page.url || page.pageId}</option>)}
      </select>
    </div>}
    {error && <p role="alert" className="shrink-0 break-words px-3 py-2 typography-meta text-destructive">{error}</p>}
    {binding ? binding.pageId && resource ? <ConnectedBrowserPage key={`${host}:${bindingKey}`} resource={resource} binding={binding as BrowserPageBinding} onObservedPage={onObservedPage} />
      : <p role="status" className="p-3 typography-meta text-muted-foreground">{t(resource ? 'browser.resource.choosePage' : loading ? 'common.loading' : 'browser.resource.offline')}</p>
      : <><p className="shrink-0 border-b border-border/50 px-3 py-1 typography-micro text-muted-foreground">{t('browser.resource.separatePreviewHint')}</p><div className="relative min-h-0 flex-1">{preview}</div></>}
  </div>;
}
