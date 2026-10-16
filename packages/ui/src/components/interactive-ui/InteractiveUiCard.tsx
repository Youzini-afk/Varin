import React from 'react';
import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, InteractiveUiError, type ThreadIdentity, type UiObservation, type UiSource, type UiSourceIdentity, type UiViewState, type UiSelection } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { invokeDesktop } from '@/lib/desktop';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { threadComposerKey, threadHostKey, useThreadStore } from '@/stores/useThreadStore';
import { addContentReference } from '@/lib/agent-editor/attachments';
import { useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from '@/components/conversation/types';
import { projectUiWork, releaseUiWork, restoreUiWork } from '@/lib/interactive-ui/work-projection';
import { uiFrameDocument, uiThemeCss } from '@/lib/interactive-ui/frame';
import { prepareUiFiles, createUiExport } from '@/lib/interactive-ui/modules';
import { getUiSession, moveUiSession, uiSession, subscribeUiSessions, uiSessionsRevision, type UiSession } from '@/lib/interactive-ui/sessions';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

export function InteractiveUiCard({ call, ownerCallId, execution, result, cwd, generating }: { call: ChatToolCall; ownerCallId?: string; execution?: ChatToolExecutionState; result?: ChatToolResultMessage; cwd: string; generating: boolean }) {
  const conversation = useOptionalConversationPresentation();
  const host = getRuntimeEndpointGeneration();
  const key = conversation ? `${threadComposerKey(threadHostKey(), conversation.identity)}:${ownerCallId ?? call.id}` : '';
  const session = conversation ? uiSession(key, conversation.identity, host) : undefined;
  if (session) session.sourceEntryId = conversation?.sourceEntry?.(ownerCallId ?? call.id);
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  React.useLayoutEffect(() => { if (session) projectUiWork(session, call, result?.details ?? execution?.result, generating || execution?.status === 'running', result?.isError ?? execution?.status === 'error'); }, [session, call, result, execution, generating]);
  React.useEffect(() => {
    if (!session) return;
    session.cardMounted = true;
    return () => { session.cardMounted = false; releaseUiWork(session); };
  }, [session]);
  if (!session?.display) return null;
  return <UiWorkView session={session} {...session.display} cwd={cwd} />;
}

function addReference(session: UiSession, selection: UiSelection) {
  if (session.host !== getRuntimeEndpointGeneration()) return;
  addContentReference(session.identity, { ref: selection.ref, title: selection.title, text: selection.text, image: selection.image,
    source: { kind: 'ui', thread: session.identity, itemId: session.sourceEntryId, snapshotRef: selection.snapshotRef, viewRef: selection.viewRef, revisionRef: selection.source.ref, previewCallId: selection.source.preview?.callId, region: selection.region } });
  const selected = useThreadStore.getState().selectedIdentity;
  if (selected?.threadId !== session.identity.threadId || selected.branchId !== session.identity.branchId) void useThreadStore.getState().selectThread(session.identity).catch(failure => toast.error(failure.message));
}
export function UiWorkView({ session, source, files, assets = {}, entry, title, cwd = '', committed, status = '', panel = false, onReturn }: {
  session: UiSession; source: UiSourceIdentity; files: Record<string, string>; entry: string; title: string; cwd?: string; committed: boolean; status?: string; panel?: boolean;
  assets?: UiSource['assets'];
  onReturn?(): void;
}) {
  const { t } = useI18n();
  const api = React.useMemo(() => createInteractiveUiHttpAPI(session.host), [session.host]);
  const iframe = React.useRef<HTMLIFrameElement>(null);
  const frameLoad = React.useRef({ channel: '', loaded: false });
  const [channel, setChannel] = React.useState(() => crypto.randomUUID());
  const frameDoc = React.useMemo(() => uiFrameDocument(channel), [channel]);
  const [ready, setReady] = React.useState(false), [code, setCode] = React.useState(false), [file, setFile] = React.useState(entry);
  const [viewInitialized, setViewInitialized] = React.useState(false);
  const [fullView, setFullView] = React.useState(false);
  const mobile = useUIStore(value => value.isMobile);
  const [height, setHeight] = React.useState(280), [error, setError] = React.useState('');
  const [connectionError, setConnectionError] = React.useState('');
  const [selectedText, setSelectedText] = React.useState<string>();
  const textObservation = React.useRef<UiObservation | undefined>(undefined);
  const [regionImage, setRegionImage] = React.useState<UiObservation>();
  const choosingRegion = React.useRef<UiObservation | undefined>(undefined); choosingRegion.current = regionImage;
  const [rectangle, setRectangle] = React.useState<{ x: number; y: number; width: number; height: number }>();
  const origin = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const actual = React.useRef({ source, files, entry, committed }); actual.current = { source, files, entry, committed };
  const state = React.useRef<UiViewState | undefined>(session.state);
  const lastExecution = React.useRef<{ ref?: string; committed: boolean }>({ committed: false });
  const registration = React.useRef<{ viewRef: string; token: string } | undefined>(undefined);
  const captures = React.useRef(new Map<string, { resolve(value: UiObservation): void; reject(reason: unknown): void }>());
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isMounted = React.useRef(true);
  const send = React.useCallback((message: object) => iframe.current?.contentWindow?.postMessage({ channel, ...message }, '*'), [channel]);
  const capture = React.useCallback(async (screen = false): Promise<UiObservation> => {
    if (!iframe.current || !ready) throw new Error(t('ui.content.notReady'));
    if (choosingRegion.current) {
      const { image, ...snapshot } = choosingRegion.current;
      return screen ? { ...snapshot, image } : snapshot;
    }
    const id = crypto.randomUUID();
    const observation = await new Promise<UiObservation>((resolve, reject) => { captures.current.set(id, { resolve, reject }); send({ type: 'capture', id }); });
    if (screen) {
      const rect = iframe.current!.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      for (let parent = iframe.current!.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      if (right <= left || bottom <= top) throw new Error(t('ui.content.notVisible'));
      const image = await invokeDesktop('desktop_capture_page_rect', { x: left, y: top, width: right - left, height: bottom - top }).catch(() => null);
      if (!image) {
        const rasterId = crypto.randomUUID();
        return new Promise<UiObservation>((resolve, reject) => { captures.current.set(rasterId, { resolve, reject }); send({ type: 'capture', id: rasterId, raster: true }); });
      }
      observation.stateCapturedAt = observation.capturedAt;
      observation.image = { mimeType: 'image/png', data: image.base64, method: 'screen', capturedAt: new Date().toISOString(), bounds: { x: left - rect.x, y: top - rect.y, width: right - left, height: bottom - top } };
    }
    return observation;
  }, [ready, send, t]);
  const visible = panel || session.placement === 'inline';
  React.useEffect(() => { if (!visible) { setReady(false); setViewInitialized(false); setChannel(crypto.randomUUID()); } }, [visible]);
  React.useEffect(() => {
    isMounted.current = true;
    const pendingCaptures = captures.current;
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.data?.channel !== channel) return;
      const message = event.data;
      if (message.type === 'ready') setReady(true);
      if (message.type === 'resize' || message.type === 'updated') setHeight(Math.max(160, message.height + 32));
      if (message.type === 'error') setError(t('ui.content.scriptFailed'));
      const observed = (): UiObservation => ({ ...message.source, viewRef: registration.current?.viewRef ?? session.viewRef ?? `ui-view:${crypto.randomUUID()}`,
        capturedAt: message.capturedAt, state: message.state, viewport: message.viewport, structure: message.structure, render: message.render,
        ...(message.context == null ? {} : { context: message.context }), ...(message.image ? { image: message.image } : {}), ...(message.textRange ? { textRange: message.textRange } : {}) });
      if (message.type === 'selection') { setSelectedText(message.text); textObservation.current = observed(); }
      if (message.type === 'capture-error') { captures.current.get(message.id)?.reject(new Error(message.error)); captures.current.delete(message.id); }
      if (message.type === 'state') {
        state.current = message.state; session.state = message.state;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => { const owner = registration.current;
          if (owner) void api.state(session.identity, owner.viewRef, owner.token, message.state).catch(() => {});
        }, 250);
      }
      if (message.type === 'capture') {
        const pending = captures.current.get(message.id); captures.current.delete(message.id);
        if (!message.source) pending?.reject(new Error(t('ui.content.notReady'))); else pending?.resolve(observed());
      }
    };
    window.addEventListener('message', receive);
    return () => { isMounted.current = false; window.removeEventListener('message', receive); clearTimeout(saveTimer.current);
      for (const pending of pendingCaptures.values()) pending.reject(new Error('页面已关闭')); pendingCaptures.clear(); };
  }, [channel, api, session, t]);
  React.useEffect(() => {
    if (!ready || committed && !viewInitialized || !visible) return;
    if (lastExecution.current.committed && (!committed || lastExecution.current.ref !== source.ref)) {
      lastExecution.current = { committed: false }; setReady(false); setViewInitialized(false); setChannel(crypto.randomUUID()); return;
    }
    lastExecution.current = { ref: source.ref, committed };
    let active = true;
    const frame = requestAnimationFrame(() => {
      void (committed ? prepareUiFiles(files, entry) : Promise.resolve(files)).then(prepared => {
        if (active) send({ type: 'update', files: prepared, assets, entry, committed, source, ...(state.current ? { state: state.current } : {}) });
      }).catch(failure => { if (active) setError(t('ui.content.parseFailed', { reason: failure.message })); });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [source, files, assets, entry, committed, ready, viewInitialized, send, visible, t]);
  React.useEffect(() => {
    if (!ready || !visible || code) return;
    const theme = () => {
      send({ type: 'theme', css: uiThemeCss() });
    };
    theme(); const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, [ready, send, visible, code]);
  React.useEffect(() => {
    if (!ready || !visible || code) return;
    const abort = new AbortController(); let owner: { viewRef: string; token: string } | undefined;
    void (async () => {
      while (!abort.signal.aborted) try {
      if (!session.viewRef) session.viewRef = sessionStorage.getItem(`varin.ui-view:${session.key}`) ?? `ui-view:${crypto.randomUUID()}`;
      owner = await api.attach(session.identity, actual.current.source, session.viewRef, abort.signal);
      if (abort.signal.aborted) return;
      registration.current = owner; session.viewRef = owner.viewRef;
      sessionStorage.setItem(`varin.ui-view:${session.key}`, owner.viewRef);
      if (!state.current && 'state' in owner && owner.state) state.current = owner.state as UiViewState;
      setViewInitialized(true);
      setConnectionError('');
      const selected = owner;
      if (state.current) await api.state(session.identity, selected.viewRef, selected.token, state.current);
      await api.observe(session.identity, selected.viewRef, selected.token, request => {
        void capture(request.view === 'screen').then(observation => api.reply(session.identity, selected.viewRef, selected.token, request.id, observation),
          failure => api.reply(session.identity, selected.viewRef, selected.token, request.id, undefined, failure instanceof Error ? failure.message : String(failure))).catch(() => {});
      }, abort.signal);
      } catch (failure) {
        if (abort.signal.aborted) return;
        if (isMounted.current) setConnectionError(failure instanceof Error ? failure.message : '视图连接已断开');
        if (failure instanceof InteractiveUiError && failure.status < 500) return;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 1_000); abort.signal.addEventListener('abort', finish, { once: true });
          if (abort.signal.aborted) finish();
        });
      }
    })();
    return () => { abort.abort(); registration.current = undefined; if (owner) void api.detach(session.identity, owner.viewRef, owner.token, state.current).catch(() => {}); };
  }, [ready, source.ref, source.preview?.callId, api, session, capture, visible, code]);
  const citeText = async () => {
    if (!selectedText) return;
    try { addReference(session, await api.select(session.identity, textObservation.current ?? await capture(), { text: selectedText })); setSelectedText(undefined); }
    catch (failure) { toast.error(String((failure as Error).message)); }
  };
  const startRegion = async () => { try { setRegionImage(await capture(true)); setRectangle(undefined); } catch (failure) { toast.error(String((failure as Error).message)); } };
  const regionPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bounds = regionImage!.image!.bounds ?? { x: 0, y: 0, width: regionImage!.viewport.width, height: regionImage!.viewport.height };
    return { x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, event.clientX - rect.x)),
      y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, event.clientY - rect.y)) };
  };
  const citeRegion = async () => {
    if (!regionImage?.image || !rectangle) return;
    try {
      const image = new Image(); image.src = `data:${regionImage.image.mimeType};base64,${regionImage.image.data}`; await image.decode();
      const canvas = document.createElement('canvas');
      const bounds = regionImage.image.bounds ?? { x: 0, y: 0, width: regionImage.viewport.width, height: regionImage.viewport.height };
      const sx = image.width / bounds.width, sy = image.height / bounds.height;
      canvas.width = Math.round(rectangle.width * sx); canvas.height = Math.round(rectangle.height * sy);
      canvas.getContext('2d')!.drawImage(image, (rectangle.x - bounds.x) * sx, (rectangle.y - bounds.y) * sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const observation = { ...regionImage, image: { ...regionImage.image, bounds: rectangle, data: canvas.toDataURL('image/png').split(',')[1]! } };
      addReference(session, await api.select(session.identity, observation, { region: rectangle })); setRegionImage(undefined);
    } catch (failure) { toast.error(String((failure as Error).message)); }
  };
  const discuss = async () => {
    try { const observation = await capture();
      addReference(session, await api.select(session.identity, observation, { text: JSON.stringify(observation.context ?? observation.state.data ?? observation.state.controls) }));
    } catch (failure) { toast.error(String((failure as Error).message)); }
  };
  const expand = () => {
    session.panelDirectory = cwd;
    moveUiSession(session, 'panel');
    if (!cwd || mobile) { setFullView(true); return; }
    useUIStore.getState().openContextPanelTab(cwd, { mode: 'ui', targetPath: session.key, thread: session.identity, contentRef: source.ref ?? source.preview?.baseRef, label: title, dedupeKey: session.key });
  };
  const returnInline = () => {
    setFullView(false); moveUiSession(session, 'inline');
    if (session.panelDirectory) {
      const store = useUIStore.getState(), directory = normalizeContextPanelDirectoryKey(session.panelDirectory);
      for (const tab of store.contextPanelByDirectory[directory]?.tabs ?? []) if (tab.mode === 'ui' && tab.targetPath === session.key) store.closeContextPanelTab(directory, tab.id);
    }
    onReturn?.();
  };
  React.useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRegionImage(undefined); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, []);
  return <section className={`my-3 overflow-hidden rounded-xl border border-border bg-card ${panel ? 'flex h-full min-h-0 flex-col' : ''}`} aria-label={title}>
    <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
      <Button size="sm" variant="ghost" onClick={() => setCode(!code)}>{t(code ? 'ui.content.preview' : 'ui.content.source')}</Button>
      {!panel && <Button size="icon" variant="ghost" aria-label={t('ui.content.expand')} onClick={expand}><Icon name="fullscreen" className="size-4" /></Button>}
      {panel && <Button size="sm" variant="ghost" onClick={returnInline}>{t('ui.content.return')}</Button>}
      <details className="relative"><summary className="cursor-pointer list-none px-2" aria-label={t('ui.content.more')}>⋯</summary>
        <div className="absolute right-0 z-20 flex w-36 flex-col rounded-lg border bg-popover p-1 shadow-lg">
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(files[file] ?? files[entry] ?? '')}>{t('ui.content.copy')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void downloadUi(files, assets, entry, title, state.current).catch(failure => toast.error(failure.message))}>{t('ui.content.download')}</Button>
          <Button size="sm" variant="ghost" onClick={() => { state.current = { data: null, controls: {}, scroll: { x: 0, y: 0 } }; session.state = state.current; setReady(false); setViewInitialized(false); setChannel(crypto.randomUUID()); }}>{t('ui.content.reset')}</Button>
        </div>
      </details>
    </header>
    {visible ? <>
      {code && <div className="min-h-0 flex-1 overflow-auto"><select aria-label="源码文件" value={file in files ? file : entry} onChange={event => setFile(event.target.value)} className="m-2 rounded border bg-background px-2 py-1 text-sm">{Object.keys(files).map(path => <option key={path}>{path}</option>)}</select><pre className="max-h-[65vh] overflow-auto px-4 pb-4 text-xs"><code>{files[file] ?? files[entry] ?? ''}</code></pre></div>}
      <div className={`relative min-h-0 ${panel ? 'flex-1' : ''} ${code ? 'hidden' : ''}`}>
        <iframe ref={iframe} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={frameDoc}
          onLoad={() => {
            if (frameLoad.current.channel !== channel) { frameLoad.current = { channel, loaded: true }; return; }
            setReady(false); setError(t('ui.content.navigated'));
            for (const pending of captures.current.values()) pending.reject(new Error(t('ui.content.navigated'))); captures.current.clear();
          }} className="block w-full border-0" style={{ height: panel ? '100%' : Math.min(height, Math.max(280, window.innerHeight * 0.65)) }} />
        {regionImage?.image && <div className="absolute inset-0 z-10 touch-none overflow-hidden bg-background" onPointerDown={event => { origin.current = regionPoint(event); setRectangle(undefined); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (!origin.current) return; const { x, y } = regionPoint(event); setRectangle({ x: Math.min(origin.current.x, x), y: Math.min(origin.current.y, y), width: Math.abs(x - origin.current.x), height: Math.abs(y - origin.current.y) }); }} onPointerUp={() => { origin.current = undefined; }} onPointerCancel={() => { origin.current = undefined; }}>
          <img src={`data:${regionImage.image.mimeType};base64,${regionImage.image.data}`} alt="选择要引用的区域" className="absolute" style={regionImage.image.bounds ? { left: regionImage.image.bounds.x, top: regionImage.image.bounds.y, width: regionImage.image.bounds.width, height: regionImage.image.bounds.height } : { width: '100%', height: '100%' }} draggable={false} />
          {rectangle && <div className="pointer-events-none absolute border-2 border-primary bg-primary/10" style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }} />}
        </div>}
      </div>
      {(error || connectionError || committed && !Object.hasOwn(files, entry)) && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">{error || connectionError || t('ui.content.missingEntry', { file: entry })}</p>}
      <footer className="flex flex-wrap items-center gap-1 border-t px-2 py-1">
        {regionImage ? <><Button size="sm" variant="ghost" disabled={!rectangle?.width || !rectangle.height} onClick={() => void citeRegion()}>{t('ui.content.citeRegion')}</Button><Button size="sm" variant="ghost" onClick={() => setRegionImage(undefined)}>{t('ui.content.cancel')}</Button></>
          : <><Button size="sm" variant="ghost" onClick={() => void startRegion()}>{t('ui.content.region')}</Button>{selectedText && <Button size="sm" variant="ghost" onClick={() => void citeText()}>{t('ui.content.citeText')}</Button>}<Button size="sm" variant="ghost" onClick={() => void discuss()}>{t('ui.content.discuss')}</Button></>}
      </footer>
    </> : <button className="w-full px-3 py-6 text-sm text-muted-foreground" onClick={returnInline}>{t('ui.content.expanded')}</button>}
    {fullView && <Dialog open onOpenChange={open => { if (!open) returnInline(); }}><DialogContent className="h-[94dvh] w-[96vw] max-w-none p-2">
      <DialogTitle className="sr-only">{title}</DialogTitle><UiWorkView session={session} source={source} files={files} assets={assets} entry={entry} title={title} committed={committed} status={status} panel onReturn={() => setFullView(false)} />
    </DialogContent></Dialog>}
  </section>;
}
async function downloadUi(files: Record<string, string>, assets: UiSource['assets'], entry: string, title: string, state?: UiViewState) {
  const html = await createUiExport(files, assets, entry, state, uiThemeCss());
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${title.replace(/[\\/:*?"<>|]/g, '-')}.html`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function InteractiveUiPanel({ sessionKey, identity, contentRef, directory, onReturn }: { sessionKey: string; identity?: ThreadIdentity; contentRef?: string; directory?: string; onReturn?(): void }) {
  const { t } = useI18n();
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  const session = getUiSession(sessionKey) ?? (identity ? uiSession(sessionKey, identity, getRuntimeEndpointGeneration()) : undefined);
  if (session && directory) session.panelDirectory = directory;
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (!session) return;
    moveUiSession(session, 'panel');
    return () => { moveUiSession(session, 'inline'); releaseUiWork(session); };
  }, [session]);
  React.useEffect(() => { if (session && !session.display && contentRef) void restoreUiWork(session, contentRef).catch(failure => setError(failure.message)); }, [session, contentRef]);
  if (error) return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  if (!session?.display || session.placement !== 'panel') return <div className="p-4 text-sm text-muted-foreground">{t('ui.content.empty')}</div>;
  return <UiWorkView session={session} {...session.display} panel onReturn={onReturn} />;
}
