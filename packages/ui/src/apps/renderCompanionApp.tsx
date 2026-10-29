import React from 'react';
import { createRoot } from 'react-dom/client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type RuntimeAPIs, type ThreadIdentity, type ThreadSnapshot, type ThreadSummary } from '@varin/application-client';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { readCompanionPackage, type CompanionPackage } from '@/components/companion/sequencePackage';
import { useCompanionWindow } from '@/components/companion/useCompanionWindow';
import { useCompanionPlayback } from '@/components/companion/useCompanionPlayback';
import { projectCompanionIntent, newlyAnsweredQuestion, type ObservationHealth } from '@/components/companion/presentation';
import { initializeLocale, I18nProvider, useI18n, type I18nKey } from '@/lib/i18n';
import catalog from '../../../../tools/desktop-companion-animation/coverage.json';

function CompanionApp({ apis }: { apis: RuntimeAPIs }) {
  const { t } = useI18n();
  const review = new URLSearchParams(window.location.search).get('review') === '1';
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [threadListUnavailable, setThreadListUnavailable] = React.useState(false);
  const [selected, setSelected] = React.useState<{ generation: number; identity: ThreadIdentity } | null>(null);
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const previousRun = React.useRef<{ id: string; state: string } | null>(null);
  const [liveCompletion, setLiveCompletion] = React.useState<string | null>(null);
  const pendingQuestions = React.useRef(new Set<string>());
  const [liveAnswer, setLiveAnswer] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<ObservationHealth>('unselected');
  const [connection, setConnection] = React.useState('No thread selected');
  const [error, setError] = React.useState('');
  const [asset, setAsset] = React.useState<CompanionPackage>();
  const [assetList, setAssetList] = React.useState<CompanionPackage[]>([]);
  const [imageLibrary, setImageLibrary] = React.useState<Record<string, ImageBitmap[]>>({});
  const imageCache = React.useRef<Record<string, ImageBitmap[]>>({});
  const atlasReader = React.useRef<((name: string) => Promise<ImageBitmap>) | null>(null);
  const loadingImages = React.useRef(new Map<string, object>());
  const decodedPages = React.useRef(new Map<string, { promise: Promise<ImageBitmap>; image?: ImageBitmap }>());
  const wantedImages = React.useRef(new Set<string>());
  const wantedAtlasFiles = React.useRef(new Set<string>());
  const [playing, setPlaying] = React.useState(false);
  const [manualReview, setManualReview] = React.useState(false);
  const [exposure, setExposure] = React.useState(0);
  const [presentation, setPresentation] = React.useState('C01');
  const [reviewRoute, setReviewRoute] = React.useState(false);
  const [controlsOpen, setControlsOpen] = React.useState(false);
  const [localAction, setLocalAction] = React.useState<'welcome' | 'tap-response' | null>(review ? null : 'welcome');
  const intent = projectCompanionIntent(snapshot, health);
  const visualIntent = review && reviewRoute ? { state: presentation, reason: 'Explicit presentation review, not Host facts' } : intent;
  // Shared neutral/attentive performances are visual fallbacks, not invented tool categories.
  const requestedAction = !reviewRoute && liveAnswer && health === 'current' && visualIntent.state !== 'C06' && visualIntent.state !== 'W02' && visualIntent.state !== 'W03' && !visualIntent.state?.startsWith('E') ? 'understood' : visualIntent.state === 'L07' || (!reviewRoute && visualIntent.state === 'C06' && liveCompletion !== snapshot?.activeRun?.id)
    ? 'idle-closed'
    : visualIntent.state === null ? (snapshot?.activeRun?.state === 'cancelled' ? 'idle-closed' : 'external-wait')
    : catalog.states.find(state => state.id === visualIntent.state)?.requires[0] ?? null;
  const hasActiveWork = (!!snapshot?.activeRun && !['completed', 'failed', 'cancelled'].includes(snapshot.activeRun.state))
    || (snapshot?.operations.some(operation => operation.phase !== 'terminal') ?? false)
    || Object.values(snapshot?.childActivity ?? {}).some(child => child.state !== 'preparation_failed')
    || (reviewRoute && /^(C0[2345]|T|W)/.test(presentation));
  const preferredAction = visualIntent.state === 'E05' ? 'disconnected' : visualIntent.state === 'T03' && requestedAction !== 'understood' ? 'execution-observe' : requestedAction;
  const visualAction = preferredAction && assetList.some(item => item.action === preferredAction && item.reviewStatus === 'accepted' && item.stage === 'motion-candidate' && item.geometryReference && item.entryPose && item.exitPose) ? preferredAction
    : hasActiveWork && !visualIntent.state?.startsWith('E') ? 'external-wait' : preferredAction;
  const localAllowed = !reviewRoute && !manualReview && !['W02','W03','E01','E02','E04','E05','E06'].includes(intent.state ?? '');
  const displayAction = localAction && localAllowed && assetList.some(item => item.action === localAction && item.reviewStatus === 'accepted') ? localAction : visualAction;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const beforeNativeLift = React.useRef<() => void>(() => {});
  const companionWindow = useCompanionWindow(canvas, review, () => beforeNativeLift.current());
  const displayedDrawing = React.useRef<{ packageId: string; exposure: number } | null>(null);
  const automatic = useCompanionPlayback(assetList, displayAction, playing || manualReview, Object.keys(imageLibrary), { phase: companionWindow.phase, displayed: () => displayedDrawing.current });
  React.useEffect(() => {
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'completion') setLiveCompletion(null);
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'understood') setLiveAnswer(null);
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === localAction) setLocalAction(null);
  }, [automatic.finished, automatic.packageId, assetList, localAction]);

  const seenTap = React.useRef(0);
  React.useEffect(() => {
    if (!companionWindow.tapRevision || seenTap.current === companionWindow.tapRevision) return;
    seenTap.current = companionWindow.tapRevision;
    const current = assetList.find(item => item.id === automatic.packageId);
    const posture = current?.exitPose?.startsWith('seated-open-') ? 'seated-open-' : current?.exitPose?.startsWith('seated-closed-') ? 'seated-closed-' : null;
    if (posture && assetList.some(item => item.action === 'tap-response' && item.reviewStatus === 'accepted' && item.entryPose?.startsWith(posture))) setLocalAction('tap-response');
  }, [companionWindow.tapRevision, assetList, automatic.packageId]);
  const pictures = asset ? imageLibrary[asset.id] ?? [] : [];
  const displayedExposure = !playing && !manualReview && automatic.packageId === asset?.id ? automatic.exposure : exposure;
  const loadGeneration = React.useRef(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setThreads([]); setSelected(null); setSnapshot(undefined); setConnection('No thread selected'); setHealth('unselected');
    if (apis.threads) void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(cause => { if (!abort.signal.aborted) setConnection(String(cause)); });
    return () => abort.abort();
  }, [apis.threads, generation]);
  React.useEffect(() => {
    if (!controlsOpen || !apis.threads) return;
    const abort = new AbortController();
    setThreadListUnavailable(false);
    void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(() => { if (!abort.signal.aborted) setThreadListUnavailable(true); });
    // Refresh discovery only. Selection and its read-only projection remain authoritative.
    return () => abort.abort();
  }, [controlsOpen, apis.threads, generation]);
  React.useEffect(() => {
    if (selected) setLocalAction(null);
    setSnapshot(undefined); previousRun.current = null; setLiveCompletion(null); pendingQuestions.current.clear(); setLiveAnswer(null);
    if (!apis.threads || !selected || selected.generation !== generation) { setConnection('No thread selected'); setHealth('unselected'); return; }
    let closed = false;
    setConnection('Synchronizing current Host snapshot'); setHealth('synchronizing');
    const projection = new ThreadProjection(apis.threads, selected.identity,
      value => { if (!closed) {
        const answered = newlyAnsweredQuestion(pendingQuestions.current, value);
        if (answered) setLiveAnswer(answered);
        pendingQuestions.current = new Set(value.operations.filter(operation => operation.executor === 'ask_user' && operation.phase !== 'terminal').map(operation => operation.id));
        const nextIntent = projectCompanionIntent(value, 'current');
        if (nextIntent.state === 'W02' || nextIntent.state === 'W03' || nextIntent.state?.startsWith('E')) setLiveAnswer(null);
        const nextRun = value.activeRun, previous = previousRun.current;
        if (nextRun && ['completed', 'failed', 'cancelled'].includes(nextRun.state)) setLiveAnswer(null);
        if (nextRun?.state === 'completed' && previous?.id === nextRun.id && !['completed','failed','cancelled'].includes(previous.state)) setLiveCompletion(nextRun.id);
        previousRun.current = nextRun ? { id: nextRun.id, state: nextRun.state } : null;
        setSnapshot(value); setHealth('current'); setConnection('Observing existing thread — read only'); } },
      cause => { if (!closed) { setHealth('unknown'); previousRun.current = null; setLiveCompletion(null); pendingQuestions.current.clear(); setLiveAnswer(null); setConnection(`Connection unknown: ${String(cause)}`); } },
      undefined, undefined, undefined, { contextInspection: false });
    projection.start();
    return () => { closed = true; projection.close(); };
  }, [apis.threads, selected, generation]);
  React.useEffect(() => () => {
    loadGeneration.current++;
    for (const page of decodedPages.current.values()) page.image?.close();
    decodedPages.current.clear();
  }, []);
  const installBundle = async (raw: unknown, readImage: (name: string) => Promise<ImageBitmap>, allowCandidates: boolean) => {
    ++loadGeneration.current;
    setPlaying(false); setError('');
    try {
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const nextPackages = Array.isArray(data.packages) ? data.packages.map(value => readCompanionPackage(value, allowCandidates)) : [readCompanionPackage(raw, allowCandidates)];
      if (!nextPackages.length || new Set(nextPackages.map(item => item.id)).size !== nextPackages.length) throw new Error('Empty bundle or duplicate sequence identity');
      for (const page of decodedPages.current.values()) page.image?.close();
      decodedPages.current.clear();
      imageCache.current = {}; loadingImages.current.clear(); atlasReader.current = readImage;
      setImageLibrary({}); setAssetList(nextPackages);
      setAsset(allowCandidates ? nextPackages[0] : undefined); setExposure(0);
    } catch (cause) { setError(String(cause)); }
  };
  // Decode only the displayed package and the controller's next bridge/target.
  // While decoding, the controller keeps the last valid drawing; Host facts update immediately.
  React.useEffect(() => {
    const wanted = new Set([asset?.id, automatic.packageId, automatic.neededPackageId].filter((id): id is string => !!id));
    for (const id of [...wanted]) {
      const parent = assetList.find(item => item.id === id);
      if (!parent || parent.gesture) continue;
      for (const frame of parent.frames) {
        const entry = frame.sha256 && assetList.find(item => item.reviewStatus === 'accepted' && item.gesture?.entrySourceSha256 === frame.sha256);
        if (entry) { wanted.add(entry.id); for (const next of entry.gesture!.grabNext.slice(0,2)) wanted.add(next); }
      }
    }
    wantedImages.current = wanted;
    // A package may return while its old page promises are still settling. Invalidate
    // the old job now so it cannot publish closed pages or delete its replacement.
    for (const id of loadingImages.current.keys()) if (!wanted.has(id)) loadingImages.current.delete(id);
    const wantedPages = new Set(assetList.filter(item => wanted.has(item.id)).flatMap(item => item.pages.map(page => page.file)));
    wantedAtlasFiles.current = wantedPages;
    for (const [file, page] of decodedPages.current) if (!wantedPages.has(file) && page.image) { page.image.close(); decodedPages.current.delete(file); }
    let evicted = false;
    for (const [id, images] of Object.entries(imageCache.current)) if (!wanted.has(id)) {
      delete imageCache.current[id]; evicted = true;
    }
    if (evicted) setImageLibrary({ ...imageCache.current });
    for (const id of wanted) {
      if (imageCache.current[id] || loadingImages.current.has(id)) continue;
      const sequence = assetList.find(item => item.id === id), reader = atlasReader.current;
      if (!sequence || !reader) continue;
      const revision = loadGeneration.current;
      const job = {};
      loadingImages.current.set(id, job);
      void (async () => {
        const isCurrent = () => revision === loadGeneration.current && loadingImages.current.get(id) === job;
        const images: ImageBitmap[] = [];
        try {
          for (const page of sequence.pages) {
            if (!isCurrent()) return;
            let cached = decodedPages.current.get(page.file);
            if (!cached) {
              const created: { promise: Promise<ImageBitmap>; image?: ImageBitmap } = { promise: reader(page.file) };
              created.promise = created.promise.then(image => {
                if (revision !== loadGeneration.current || !wantedAtlasFiles.current.has(page.file)) { image.close(); throw new Error('Superseded artwork load'); }
                created.image = image; return image;
              }).catch(cause => { if (decodedPages.current.get(page.file) === created) decodedPages.current.delete(page.file); throw cause; });
              decodedPages.current.set(page.file, created); cached = created;
            }
            const image = await cached.promise;
            if (!isCurrent()) return;
            images.push(image);
          }
          for (const frame of sequence.frames) {
            const image = images[frame.page]!;
            if (frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Atlas region exceeds actual image');
          }
          if (!isCurrent() || !wantedImages.current.has(id)) return;
          imageCache.current[id] = images; setImageLibrary({ ...imageCache.current });
        } catch (cause) { if (isCurrent() && wantedImages.current.has(id)) setError(String(cause)); }
        finally { if (isCurrent()) loadingImages.current.delete(id); }
      })();
    }
  }, [asset?.id, assetList, automatic.packageId, automatic.neededPackageId, imageLibrary]);
  const loadFiles = async (files: FileList | null) => {
    if (!review || !files) return;
    setManualReview(true);
    ++loadGeneration.current; // A manual selection supersedes an in-flight bundled fetch.
    try {
      const all = [...files], json = all.filter(file => file.name.endsWith('.json'));
      if (json.length !== 1) throw new Error('Select one bundle.json or sequence.json and its PNG atlas pages');
      await installBundle(JSON.parse(await json[0]!.text()), async name => {
        const candidates = all.filter(file => file.name === name);
        if (candidates.length !== 1) throw new Error(`Missing or ambiguous atlas: ${name}`);
        return createImageBitmap(candidates[0]!);
      }, true);
    } catch (cause) { setError(String(cause)); }
  };
  React.useEffect(() => {
    const abort = new AbortController();
    const initialGeneration = loadGeneration.current;
    const base = new URL('./companion-assets/', window.location.href);
    void fetch(new URL('bundle.json', base), { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Bundled companion artwork is unavailable');
      const raw: unknown = await response.json();
      if (!abort.signal.aborted && loadGeneration.current === initialGeneration) await installBundle(raw, async name => {
        // Decoder has already restricted each page to a basename; no arbitrary URLs/paths.
        const image = await fetch(new URL(encodeURIComponent(name), base), { signal: abort.signal });
        if (!image.ok) throw new Error(`Bundled atlas unavailable: ${name}`);
        return createImageBitmap(await image.blob());
      }, false);
    }).catch(cause => { if (!abort.signal.aborted && loadGeneration.current === initialGeneration) setError(String(cause)); });
    return () => { abort.abort(); loadGeneration.current++; };
  }, []);
  React.useEffect(() => {
    if (!playing && !manualReview && automatic.packageId) {
      const current = assetList.find(item => item.id === automatic.packageId);
      if (current && current.id !== asset?.id) setAsset(current);
    }
  }, [automatic.packageId, assetList, asset?.id, playing, manualReview]);
  const drawActualFrame = (sequence: CompanionPackage, images: ImageBitmap[], exposure: number) => {
    const node = canvas.current, context = node?.getContext('2d');
    if (!node || !context || images.length !== sequence.pages.length) return;
    [node.width, node.height] = sequence.canvas;
    const frame = sequence.frames[exposure] ?? sequence.frames[0]!;
    context.clearRect(0, 0, node.width, node.height);
    context.drawImage(images[frame.page]!, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
    displayedDrawing.current = { packageId: sequence.id, exposure };
    companionWindow.refreshHitMask();
  };
  // Swap to the predecoded same-exposure drawing before sending native movement,
  // rather than letting an embedded stool travel for a React/animation frame.
  beforeNativeLift.current = () => {
    const next = automatic.beginGrab(displayedDrawing.current);
    const sequence = next && assetList.find(item => item.id === next.packageId);
    const images = next && imageCache.current[next.packageId];
    if (sequence && images && next) { drawActualFrame(sequence, images, next.exposure); setAsset(sequence); setExposure(next.exposure); }
  };
  React.useEffect(() => {
    if (asset) drawActualFrame(asset, pictures, displayedExposure);
  }, [asset, pictures, displayedExposure, companionWindow.refreshHitMask]);
  const handledWorld = React.useRef(0);
  React.useEffect(() => {
    const event = automatic.worldEvent;
    if (!event || handledWorld.current === event.revision) return;
    if (event.phase !== 'clear') {
      const drawn = assetList.find(item => item.id === displayedDrawing.current?.packageId);
      if (!drawn?.gesture || drawn.gesture.embeddedStool) return;
    }
    handledWorld.current = event.revision; companionWindow.worldStool(event.phase);
  }, [automatic.worldEvent, asset?.id, assetList, displayedExposure, companionWindow.worldStool]);
  React.useEffect(() => {
    if (companionWindow.phase === 'landing' && !automatic.gestureActive) companionWindow.settle();
  }, [automatic.gestureActive, companionWindow.phase]);
  React.useEffect(() => {
    if (!playing || !asset) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches || document.hidden) { setPlaying(false); return; }
    let request = 0, start: number | undefined;
    const stop = () => { if (document.hidden || reduced.matches) setPlaying(false); };
    const draw = (now: number) => {
      start ??= now;
      const elapsed = now - start;
      const index = asset.frames.findIndex(frame => elapsed < frame.startMs + frame.durationMs);
      setExposure(index < 0 ? asset.frames.length - 1 : index);
      if (elapsed < asset.durationMs) request = requestAnimationFrame(draw); else setPlaying(false);
    };
    request = requestAnimationFrame(draw);
    document.addEventListener('visibilitychange', stop); reduced.addEventListener('change', stop);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', stop); reduced.removeEventListener('change', stop); };
  }, [playing, asset]);
  const identity = selected?.generation === generation ? selected.identity : null;
  const run = snapshot?.activeRun;
  const pending = snapshot?.operations.filter(operation => operation.phase !== 'terminal') ?? [];
  const unknownEffects = snapshot?.operations.filter(operation => operation.effect === 'unknown') ?? [];
  const statusKeys: Record<string, I18nKey> = { C01: 'companion.idle', C06: 'companion.completed', W02: 'companion.permission', W03: 'companion.question', E01: 'companion.failed', E02: 'companion.cancelling', E04: 'companion.unknown', E05: 'companion.sync', E06: 'companion.uncertain' };
  const shortStatus = health === 'unselected' ? t('companion.quiet') : t(statusKeys[intent.state ?? ''] ?? (run?.state === 'cancelled' ? 'companion.cancelled' : intent.state?.startsWith('W') ? 'companion.waiting' : 'companion.working'));
  const panel: React.CSSProperties = { background: '#20242bed', color: '#edf0f6', borderRadius: 10, padding: 10, font: '12px system-ui', margin: 5 };
  return <main style={{ width: '100%', position: 'relative', background: 'transparent', font: '12px system-ui' }}>
    {review ? <header style={{ ...panel, WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <strong>{review ? 'Varin companion · development review' : 'Varin'}</strong>
      <button style={{ float: 'right', WebkitAppRegion: 'no-drag' } as React.CSSProperties} disabled={!isElectronShell()}
        onClick={() => void invokeDesktop('desktop_close_current_window')}>Close</button>
    </header> : <button aria-label={t('companion.controls')} aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)} style={{ position: 'absolute', right: 6, top: 6, zIndex: 20, borderRadius: 20, background: '#20242bca', color: 'white', border: 0, padding: '6px 10px' }}>⋯</button>}
    <canvas ref={canvas} {...companionWindow.handlers} style={{ width: 'min(100%,360px)', height: 'auto', margin: 'auto', touchAction: 'none', display: asset ? 'block' : 'none' }} />
    {error && !review && <p role="alert" style={panel}>{error}</p>}
    {!asset && <p style={panel}>{assetList.length ? t('companion.loading') : t('companion.missing')}</p>}
    {!review && <p role="status" style={{ ...panel, textAlign: 'center', margin: '0 auto', width: 'fit-content', maxWidth: '90%' }}>{shortStatus}</p>}
    {(review || controlsOpen) && <section style={{ ...panel, ...(!review ? { position: 'absolute', top: 40, left: 4, right: 4, zIndex: 20, maxHeight: 90, overflow: 'auto' } as React.CSSProperties : {}) }}><button disabled={!isElectronShell()} onClick={() => void companionWindow.togglePinned()}>{companionWindow.pinned ? t('companion.unpin') : t('companion.pin')}</button><label><input type="checkbox" disabled={!isElectronShell()} checked={companionWindow.passthrough} onChange={event => companionWindow.setPassthrough(event.target.checked)} />{t('companion.passthrough')}</label>{review && <p>Local movement: {companionWindow.phase}. Movement artwork remains gated by accepted lift/landing assets.</p>}{companionWindow.notice && <p>{companionWindow.notice}</p>}{!review && <button disabled={!isElectronShell()} onClick={() => void invokeDesktop('desktop_set_companion', { enabled: false }).catch(cause => setError(String(cause)))}>{t('companion.close')}</button>}</section>}
    {review && <section style={panel} aria-label="Development presentation review">
      <label>Preview presentation (not Host state) <select value={presentation} onChange={event => { setPresentation(event.target.value); setReviewRoute(true); setManualReview(false); setPlaying(false); }}>
        {catalog.states.map(state => <option key={state.id} value={state.id}>{state.id} {state.label}</option>)}
      </select></label>
      <input type="file" multiple accept=".json,.png" aria-label="Select bundle or sequence JSON and PNG atlases" onChange={event => void loadFiles(event.target.files)} />
      {assetList.length > 1 && <select aria-label="Review an actual package in the bundle" value={asset?.id ?? ''} onChange={event => { setManualReview(true); setPlaying(false); setExposure(0); setAsset(assetList.find(item => item.id === event.target.value)); }}>{asset?.gesture && <option value={asset.id}>Pointer movement · internal drawing</option>}{assetList.filter(item => !item.gesture).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
      {asset && <><p>{asset.id} · {asset.stage ?? 'unstated stage'} · {asset.warning}</p>
        <button onClick={() => { setManualReview(true); setExposure(0); setPlaying(value => !value); }}>{playing ? 'Stop' : 'Replay authored timing'}</button>
        <button onClick={() => { setManualReview(true); setPlaying(false); setExposure(Math.min(asset.frames.length - 1, displayedExposure + 1)); }}>Next exposure</button>
        <span> {displayedExposure + 1}/{asset.frames.length} exposures</span><button onClick={() => { setPlaying(false); setManualReview(false); setReviewRoute(false); }}>Follow actual Host presentation</button></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    {(review || controlsOpen) && <section style={{ ...panel, ...(!review ? { position: 'absolute', top: 145, left: 4, right: 4, zIndex: 20, maxHeight: 'calc(100vh - 160px)', overflow: 'auto' } as React.CSSProperties : {}) }} aria-label="Actual Host facts">
      <strong>{review ? 'Actual Host facts — independent of review target' : t('companion.observe')}</strong>
      <select aria-label="Observe an existing thread branch" value={identity ? JSON.stringify(identity) : ''} onChange={event => {
        setSelected(event.target.value ? { generation, identity: JSON.parse(event.target.value) as ThreadIdentity } : null);
      }}><option value="">{t('companion.noThread')}</option>{threads.flatMap(thread => thread.branches.map(branch => {
        const value: ThreadIdentity = { runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id };
        return <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{thread.title || thread.thread_id} / {branch.branch_id}</option>;
      }))}</select>
      {threadListUnavailable && <p role="status">{t('companion.unavailable')}</p>}
      <p role="status">{review ? connection : health === 'current' ? t('companion.observing') : health === 'unknown' || connection.includes('Error') ? t('companion.unavailable') : t('companion.noThread')}</p>{review && automatic.blocker && <p>Artwork: {automatic.blocker}</p>}{review && <p>Host presentation: {intent.state ?? 'Unclassified execution'} · {intent.reason}</p>}
      {review && snapshot && <p>Run: {run?.state ?? 'No active run'} · cancellation requested: {String(run?.cancel_requested ?? false)} · nonterminal operations: {pending.length} · unknown effects: {unknownEffects.length}</p>}
      <button disabled={!identity || !isElectronShell()} onClick={() => { if (identity) void invokeDesktop('desktop_focus_main_window', identity); }}>{t('companion.openThread')}</button>
      {review && <small>Observation does not create a thread, mark it read, approve, cancel or restart work. Host intent is read-only. Candidate review remains separate; automatic playback requires accepted, compatible artwork.</small>}
    </section>}
  </main>;
}

export function renderCompanionApp(apis: RuntimeAPIs) {
  const root = document.getElementById('root');
  if (!root) throw new Error('Companion root not found');
  initializeLocale();
  createRoot(root).render(<I18nProvider><CompanionApp apis={apis} /></I18nProvider>);
}
