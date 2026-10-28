import React from 'react';
import { createRoot } from 'react-dom/client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type RuntimeAPIs, type ThreadIdentity, type ThreadSnapshot, type ThreadSummary } from '@varin/application-client';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { readCompanionPackage, type CompanionPackage } from '@/components/companion/sequencePackage';
import { useCompanionWindow } from '@/components/companion/useCompanionWindow';
import { useCompanionPlayback } from '@/components/companion/useCompanionPlayback';
import { projectCompanionIntent, newlyAnsweredQuestion, type ObservationHealth } from '@/components/companion/presentation';
import catalog from '../../../../tools/desktop-companion-animation/coverage.json';

function CompanionApp({ apis }: { apis: RuntimeAPIs }) {
  const review = new URLSearchParams(window.location.search).get('review') === '1';
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
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
  const loadingImages = React.useRef(new Map<string, Promise<void>>());
  const [playing, setPlaying] = React.useState(false);
  const [manualReview, setManualReview] = React.useState(false);
  const [exposure, setExposure] = React.useState(0);
  const [presentation, setPresentation] = React.useState('C01');
  const [reviewRoute, setReviewRoute] = React.useState(false);
  const [controlsOpen, setControlsOpen] = React.useState(false);
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
  const automatic = useCompanionPlayback(assetList, visualAction, playing || manualReview, Object.keys(imageLibrary));
  React.useEffect(() => {
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'completion') setLiveCompletion(null);
    if (automatic.finished && assetList.find(item => item.id === automatic.packageId)?.action === 'understood') setLiveAnswer(null);
  }, [automatic.finished, automatic.packageId, assetList]);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const companionWindow = useCompanionWindow(canvas);
  const pictures = asset ? imageLibrary[asset.id] ?? [] : [];
  const loadGeneration = React.useRef(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setThreads([]); setSelected(null); setSnapshot(undefined); setConnection('No thread selected'); setHealth('unselected');
    if (apis.threads) void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(cause => { if (!abort.signal.aborted) setConnection(String(cause)); });
    return () => abort.abort();
  }, [apis.threads, generation]);
  React.useEffect(() => {
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
    for (const images of Object.values(imageCache.current)) for (const picture of images) picture.close();
  }, []);
  const installBundle = async (raw: unknown, readImage: (name: string) => Promise<ImageBitmap>, allowCandidates: boolean) => {
    ++loadGeneration.current;
    setPlaying(false); setError('');
    try {
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const nextPackages = Array.isArray(data.packages) ? data.packages.map(value => readCompanionPackage(value, allowCandidates)) : [readCompanionPackage(raw, allowCandidates)];
      if (!nextPackages.length || new Set(nextPackages.map(item => item.id)).size !== nextPackages.length) throw new Error('Empty bundle or duplicate sequence identity');
      for (const images of Object.values(imageCache.current)) for (const image of images) image.close();
      imageCache.current = {}; loadingImages.current.clear(); atlasReader.current = readImage;
      setImageLibrary({}); setAssetList(nextPackages);
      setAsset(allowCandidates ? nextPackages[0] : undefined); setExposure(0);
    } catch (cause) { setError(String(cause)); }
  };
  // Decode only the displayed package and the controller's next bridge/target.
  // While decoding, the controller keeps the last valid drawing; Host facts update immediately.
  React.useEffect(() => {
    const wanted = new Set([asset?.id, automatic.packageId, automatic.neededPackageId].filter((id): id is string => !!id));
    let evicted = false;
    for (const [id, images] of Object.entries(imageCache.current)) if (!wanted.has(id)) {
      images.forEach(image => image.close()); delete imageCache.current[id]; evicted = true;
    }
    if (evicted) setImageLibrary({ ...imageCache.current });
    for (const id of wanted) {
      if (imageCache.current[id] || loadingImages.current.has(id)) continue;
      const sequence = assetList.find(item => item.id === id), reader = atlasReader.current;
      if (!sequence || !reader) continue;
      const revision = loadGeneration.current;
      const job = (async () => {
        const images: ImageBitmap[] = [];
        try {
          for (const page of sequence.pages) images.push(await reader(page.file));
          for (const frame of sequence.frames) {
            const image = images[frame.page]!;
            if (frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Atlas region exceeds actual image');
          }
          if (revision !== loadGeneration.current) { images.forEach(image => image.close()); return; }
          imageCache.current[id] = images; setImageLibrary({ ...imageCache.current });
        } catch (cause) { images.forEach(image => image.close()); if (revision === loadGeneration.current) setError(String(cause)); }
        finally { if (revision === loadGeneration.current) loadingImages.current.delete(id); }
      })();
      loadingImages.current.set(id, job);
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
  React.useEffect(() => {
    if (!asset || pictures.length !== asset.pages.length) return;
    const node = canvas.current, context = node?.getContext('2d');
    if (!node || !context) return;
    [node.width, node.height] = asset.canvas;
    const shownExposure = !playing && !manualReview && automatic.packageId === asset.id ? automatic.exposure : exposure;
    const frame = asset.frames[shownExposure] ?? asset.frames[0]!;
    context.clearRect(0, 0, node.width, node.height);
    context.drawImage(pictures[frame.page]!, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
    companionWindow.refreshHitMask();
  }, [asset, pictures, exposure, playing, manualReview, automatic]);
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
  const panel: React.CSSProperties = { background: '#20242bed', color: '#edf0f6', borderRadius: 10, padding: 10, font: '12px system-ui', margin: 5 };
  return <main style={{ width: '100%', position: 'relative', background: 'transparent', font: '12px system-ui' }}>
    {review ? <header style={{ ...panel, WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <strong>{review ? 'Varin companion · development review' : 'Varin'}</strong>
      <button style={{ float: 'right', WebkitAppRegion: 'no-drag' } as React.CSSProperties} disabled={!isElectronShell()}
        onClick={() => void invokeDesktop('desktop_close_current_window')}>Close</button>
    </header> : <button aria-label="Companion controls" aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)} style={{ position: 'absolute', right: 6, top: 6, zIndex: 20, borderRadius: 20, background: '#20242bca', color: 'white', border: 0, padding: '6px 10px' }}>⋯</button>}
    <canvas ref={canvas} {...companionWindow.handlers} style={{ width: 'min(100%,360px)', height: 'auto', margin: 'auto', touchAction: 'none', display: asset ? 'block' : 'none' }} />
    {error && !review && <p role="alert" style={panel}>{error}</p>}
    {!asset && <p style={panel}>{assetList.length ? 'Loading companion artwork…' : 'No visually accepted artwork package installed.'}</p>}
    {!review && <p role="status" style={{ ...panel, textAlign: 'center', margin: '0 auto', width: 'fit-content', maxWidth: '90%' }}>{health === 'unselected' ? 'Quiet company · choose a conversation in ⋯' : intent.reason}</p>}
    {(review || controlsOpen) && <section style={panel}><button disabled={!isElectronShell()} onClick={() => void companionWindow.togglePinned()}>{companionWindow.pinned ? 'Unpin' : 'Keep on top'}</button><label><input type="checkbox" disabled={!isElectronShell()} checked={companionWindow.passthrough} onChange={event => companionWindow.setPassthrough(event.target.checked)} />Transparent pointer pass-through</label>{review && <p>Local movement: {companionWindow.phase}. Movement artwork remains gated by accepted lift/landing assets.</p>}{companionWindow.notice && <p>{companionWindow.notice}</p>}{!review && <button onClick={() => void invokeDesktop('desktop_close_current_window')}>Close companion</button>}</section>}
    {review && <section style={panel} aria-label="Development presentation review">
      <label>Preview presentation (not Host state) <select value={presentation} onChange={event => { setPresentation(event.target.value); setReviewRoute(true); setManualReview(false); setPlaying(false); }}>
        {catalog.states.map(state => <option key={state.id} value={state.id}>{state.id} {state.label}</option>)}
      </select></label>
      <input type="file" multiple accept=".json,.png" aria-label="Select bundle or sequence JSON and PNG atlases" onChange={event => void loadFiles(event.target.files)} />
      {assetList.length > 1 && <select aria-label="Review an actual package in the bundle" value={asset?.id ?? ''} onChange={event => { setManualReview(true); setPlaying(false); setExposure(0); setAsset(assetList.find(item => item.id === event.target.value)); }}>{assetList.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
      {asset && <><p>{asset.id} · {asset.stage ?? 'unstated stage'} · {asset.warning}</p>
        <button onClick={() => { setManualReview(true); setExposure(0); setPlaying(value => !value); }}>{playing ? 'Stop' : 'Replay authored timing'}</button>
        <button onClick={() => { setManualReview(true); setPlaying(false); setExposure(value => Math.min(asset.frames.length - 1, value + 1)); }}>Next exposure</button>
        <span> {exposure + 1}/{asset.frames.length} exposures</span><button onClick={() => { setPlaying(false); setManualReview(false); setReviewRoute(false); }}>Follow actual Host presentation</button></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    {(review || controlsOpen) && <section style={panel} aria-label="Actual Host facts">
      <strong>{review ? 'Actual Host facts — independent of review target' : 'Observe a conversation'}</strong>
      <select aria-label="Observe an existing thread branch" value={identity ? JSON.stringify(identity) : ''} onChange={event => {
        setSelected(event.target.value ? { generation, identity: JSON.parse(event.target.value) as ThreadIdentity } : null);
      }}><option value="">No thread selected</option>{threads.flatMap(thread => thread.branches.map(branch => {
        const value: ThreadIdentity = { runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id };
        return <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{thread.title || thread.thread_id} / {branch.branch_id}</option>;
      }))}</select>
      <p role="status">{connection}</p>{automatic.blocker && <p>Artwork: {automatic.blocker}</p>}<p>Host presentation: {intent.state ?? 'Unclassified execution'} · {intent.reason}</p>
      {review && snapshot && <p>Run: {run?.state ?? 'No active run'} · cancellation requested: {String(run?.cancel_requested ?? false)} · nonterminal operations: {pending.length} · unknown effects: {unknownEffects.length}</p>}
      <button disabled={!identity || !isElectronShell()} onClick={() => { if (identity) void invokeDesktop('desktop_focus_main_window', identity); }}>Open original conversation</button>
      {review && <small>Observation does not create a thread, mark it read, approve, cancel or restart work. Host intent is read-only. Candidate review remains separate; automatic playback requires accepted, compatible artwork.</small>}
    </section>}
  </main>;
}

export function renderCompanionApp(apis: RuntimeAPIs) {
  const root = document.getElementById('root');
  if (!root) throw new Error('Companion root not found');
  createRoot(root).render(<CompanionApp apis={apis} />);
}
