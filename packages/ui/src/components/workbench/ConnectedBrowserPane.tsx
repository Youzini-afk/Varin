import React from 'react';
import type { BrowserPage, BrowserResource, BrowserResourceBinding, BrowserTaskSelection } from '@varin/protocol';
import { browserResources, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type BrowserPageBinding, type BrowserPageSnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { browserDeviceLabel, browserResourceLabel } from '@/lib/browser-presentation';
import { browserResourceBindingKey } from '@/lib/browser-resource-binding';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
      <div className="min-w-0 flex-1"><p className="truncate typography-meta">{page?.title || t('browser.resource.notObserved')}</p><p className="truncate typography-micro text-muted-foreground">{page?.url || browserResourceLabel(resource, t)}</p></div>
      <Button type="button" variant="ghost" size="sm" disabled={busy || !connected || !canRead} onClick={() => void perform()} aria-label={t('browser.resource.observe')}><Icon name="refresh" className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} /></Button>
      {resource.capabilities.includes('read') && resource.capabilities.includes('screenshot') && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setView(current => current === 'structure' ? 'screenshot' : 'structure')}>{t(view === 'structure' ? 'browser.resource.screenshot' : 'browser.resource.structure')}</Button>}
      {resource.capabilities.includes('act') && <Button type="button" variant="outline" size="sm" disabled={busy || !connected || !usage} onClick={() => void perform(usage?.controller === 'human' ? 'resume' : 'takeover')}>{t(usage?.controller === 'human' ? 'browser.resume' : 'browser.takeOver')}</Button>}
      {resource.capabilities.includes('activate') && <Button type="button" variant="ghost" size="sm" disabled={busy || !connected} onClick={() => void perform('activate')}>{t('browser.resource.openOnDevice')}</Button>}
    </div>
    <div className="space-y-1 border-b border-border/50 px-3 py-2 typography-micro text-muted-foreground">
      <p role="status">{t('browser.resource.observationOnly')}{observedAt ? ` · ${t('browser.resource.observedAt', { time: observedAt })}` : ''}</p>
      {usage && <p>{t(usage.controller === 'human' ? 'browser.userControl' : usage.activeThreadId ? 'browser.agentWorking' : 'browser.resource.available')}</p>}
      {usage?.waitingThreadIds.length ? <p>{t('browser.resource.waitingCount', { count: usage.waitingThreadIds.length })}</p> : null}
      {!resource.capabilities.includes('activate') && <p>{t('browser.resource.openUnavailable')}</p>}
      {!connected && <p role="status">{t(resource.instanceId !== binding.instanceId ? 'browser.resource.instanceEnded' : 'browser.resource.offline')}</p>}
      {!canRead && <p role="status">{t('browser.resource.observationUnavailable')}</p>}
    </div>
    {error && <p role="alert" className="shrink-0 break-words px-3 py-2 typography-meta text-destructive">{error}{snapshot ? ` · ${t('browser.resource.lastObservation')}` : ''}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {observation?.image && <img src={`data:${observation.image.mimeType};base64,${observation.image.base64}`} alt={page?.title || browserResourceLabel(resource, t)} className="mx-auto max-w-full" />}
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
  const identity = useThreadStore(state => state.selectedIdentity);
  const threadId = identity?.runtime === 'agent' ? identity.threadId : undefined;
  const [taskState, setTask] = React.useState<{ threadId: string; selection: BrowserTaskSelection }>();
  const task = taskState?.threadId === threadId ? taskState?.selection : undefined;
  const taskResource = resources.find(item => item.browserId === (task?.preferredBrowserId ?? task?.binding?.browserId));
  const [selectingTask, setSelectingTask] = React.useState(false);
  React.useEffect(() => {
    setTask(undefined);
    if (!threadId) return;
    const controller = new AbortController();
    void browserResources.task(threadId, controller.signal).then(value => { if (!controller.signal.aborted) setTask({ threadId, selection: value }); }, cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [threadId, host, refresh]);
  const chooseTask = async (selected: string | null) => {
    if (!threadId || selectingTask) return;
    setSelectingTask(true); setError('');
    try { setTask({ threadId, selection: await browserResources.selectTask(threadId, selected) }); }
    catch (cause) { setError(errorText(cause)); }
    finally { setSelectingTask(false); }
  };
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
      <Select value={binding?.browserId ?? 'preview'} onValueChange={value => {
        const next = resources.find(candidate => candidate.browserId === value);
        onBindingChange(next?.instanceId ? { browserId: next.browserId, instanceId: next.instanceId } : undefined);
      }}>
        <SelectTrigger className="h-7 min-w-0 flex-1 typography-micro" aria-label={t('browser.resource.select')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="preview">{t('browser.resource.separatePreview')}</SelectItem>
          {binding && !resource && <SelectItem value={binding.browserId}>{t('browser.resource.offline')}</SelectItem>}
          {resources.map(item => <SelectItem key={item.browserId} value={item.browserId} disabled={!item.instanceId}>{browserDeviceLabel(item, t)} · {browserResourceLabel(item, t)} · {t(`browser.resource.state.${item.state}`)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)} aria-label={t('browser.resource.refresh')}><Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /></Button>
      <Button type="button" variant="ghost" size="sm" aria-label={t('browser.resource.manage')} onClick={() => { const ui = useUIStore.getState(); ui.setSettingsPage('browsers'); ui.setSettingsDialogOpen(true); }}><Icon name="settings-3" className="size-3.5" /></Button>
    </div>
    {threadId && task && <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 px-3 py-1 typography-micro text-muted-foreground">
      <span>{t('browser.resource.taskBrowser')} · {taskResource ? browserResourceLabel(taskResource, t) : t(task.preferredBrowserId ? 'browser.resource.offline' : 'browser.resource.taskDefault')}</span>
      {resource && <Button size="sm" variant="ghost" disabled={selectingTask || task.preferredBrowserId === resource.browserId} onClick={() => void chooseTask(resource.browserId)}>{t(task.preferredBrowserId === resource.browserId ? 'browser.resource.taskSelected' : 'browser.resource.useForTask')}</Button>}
      {task.preferredBrowserId && <Button size="sm" variant="ghost" disabled={selectingTask} onClick={() => void chooseTask(null)}>{t('browser.resource.taskDefault')}</Button>}
    </div>}
    {binding && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
      <span className="typography-micro text-muted-foreground">{resource ? `${browserDeviceLabel(resource, t)} · ${browserResourceLabel(resource, t)} · ${t(`browser.resource.state.${resource.state}`)}` : t('browser.resource.offline')}</span>
      {resource?.instanceId && resource.instanceId !== binding.instanceId && resource.state === 'online' && <Button type="button" size="sm" variant="outline" onClick={() => onBindingChange({ browserId: resource.browserId, instanceId: resource.instanceId! })}>{t('browser.resource.useCurrentInstance')}</Button>}
      <Select value={binding.pageId ?? 'choose'} onValueChange={value => onBindingChange({ ...binding, pageId: value === 'choose' ? undefined : value })}>
        <SelectTrigger className="h-7 min-w-0 flex-1 typography-micro" aria-label={t('browser.resource.page')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="choose">{t('browser.resource.choosePage')}</SelectItem>
          {binding.pageId && !availablePages.some(page => page.pageId === binding.pageId) && <SelectItem value={binding.pageId}>{t('browser.resource.notObserved')}</SelectItem>}
          {availablePages.map(page => <SelectItem key={page.pageId} value={page.pageId}>{page.title || page.url || t('browser.resource.notObserved')}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>}
    {error && <p role="alert" className="shrink-0 break-words px-3 py-2 typography-meta text-destructive">{error}</p>}
    {binding ? binding.pageId && resource ? <ConnectedBrowserPage key={`${host}:${bindingKey}`} resource={resource} binding={binding as BrowserPageBinding} onObservedPage={onObservedPage} />
      : <p role="status" className="p-3 typography-meta text-muted-foreground">{t(resource ? 'browser.resource.choosePage' : loading ? 'common.loading' : 'browser.resource.offline')}</p>
      : <><p className="shrink-0 border-b border-border/50 px-3 py-1 typography-micro text-muted-foreground">{t('browser.resource.separatePreviewHint')}</p><div className="relative min-h-0 flex-1">{preview}</div></>}
  </div>;
}
