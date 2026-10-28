import React from 'react';
import { createRoot } from 'react-dom/client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type RuntimeAPIs, type ThreadIdentity, type ThreadSnapshot, type ThreadSummary } from '@varin/application-client';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { readCompanionPackage, type CompanionPackage } from '@/components/companion/sequencePackage';
import { useCompanionWindow } from '@/components/companion/useCompanionWindow';
import { useCompanionPlayback } from '@/components/companion/useCompanionPlayback';
import { projectCompanionIntent, type ObservationHealth } from '@/components/companion/presentation';
import catalog from '../../../../tools/desktop-companion-animation/coverage.json';

function CompanionApp({ apis }: { apis: RuntimeAPIs }) {
  const review = new URLSearchParams(window.location.search).get('review') === '1';
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [selected, setSelected] = React.useState<{ generation: number; identity: ThreadIdentity } | null>(null);
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const previousRun = React.useRef<{ id: string; state: string } | null>(null);
  const [liveCompletion, setLiveCompletion] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<ObservationHealth>('unselected');
  const [connection, setConnection] = React.useState('No thread selected');
  const [error, setError] = React.useState('');
  const [asset, setAsset] = React.useState<CompanionPackage>();
  const [assetList, setAssetList] = React.useState<CompanionPackage[]>([]);
  const [imageLibrary, setImageLibrary] = React.useState<Record<string, ImageBitmap[]>>({});
  const [playing, setPlaying] = React.useState(false);
  const [exposure, setExposure] = React.useState(0);
  const [presentation, setPresentation] = React.useState('C01');
  const intent = projectCompanionIntent(snapshot, health);
  const automatic = useCompanionPlayback(assetList, (intent.state !== 'C06' || liveCompletion === snapshot?.activeRun?.id) ? catalog.states.find(state => state.id === intent.state)?.requires[0] ?? null : null, playing);
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
    setSnapshot(undefined); previousRun.current = null; setLiveCompletion(null);
    if (!apis.threads || !selected || selected.generation !== generation) { setConnection('No thread selected'); setHealth('unselected'); return; }
    let closed = false;
    setConnection('Synchronizing current Host snapshot'); setHealth('synchronizing');
    const projection = new ThreadProjection(apis.threads, selected.identity,
      value => { if (!closed) {
        const nextRun = value.activeRun, previous = previousRun.current;
        if (nextRun?.state === 'completed' && previous?.id === nextRun.id && !['completed','failed','cancelled'].includes(previous.state)) setLiveCompletion(nextRun.id);
        previousRun.current = nextRun ? { id: nextRun.id, state: nextRun.state } : null;
        setSnapshot(value); setHealth('current'); setConnection('Observing existing thread — read only'); } },
      cause => { if (!closed) { setHealth('unknown'); previousRun.current = null; setLiveCompletion(null); setConnection(`Connection unknown: ${String(cause)}`); } },
      undefined, undefined, undefined, { contextInspection: false });
    projection.start();
    return () => { closed = true; projection.close(); };
  }, [apis.threads, selected, generation]);
  React.useEffect(() => () => { for (const images of Object.values(imageLibrary)) for (const picture of images) picture.close(); }, [imageLibrary]);
  React.useEffect(() => () => { loadGeneration.current++; }, []);
  const installBundle = async (raw: unknown, readImage: (name: string) => Promise<ImageBitmap>, allowCandidates: boolean) => {
    const revision = ++loadGeneration.current;
    setPlaying(false); setError('');
    const loaded: ImageBitmap[] = [];
    try {
      const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const nextPackages = Array.isArray(data.packages) ? data.packages.map(value => readCompanionPackage(value, allowCandidates)) : [readCompanionPackage(raw, allowCandidates)];
      if (!nextPackages.length || new Set(nextPackages.map(item => item.id)).size !== nextPackages.length) throw new Error('Empty bundle or duplicate sequence identity');
      const library: Record<string, ImageBitmap[]> = {};
      for (const next of nextPackages) {
        const images: ImageBitmap[] = [];
        for (const page of next.pages) { const bitmap = await readImage(page.file); loaded.push(bitmap); images.push(bitmap); }
        for (const frame of next.frames) {
          const image = images[frame.page]!;
          if (frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Atlas region exceeds the actual image');
        }
        library[next.id] = images;
      }
      if (revision !== loadGeneration.current) { loaded.forEach(image => image.close()); return; }
      setAssetList(nextPackages); setAsset(nextPackages.find(item => item.entryPose === 'seated-open-neutral-keyboard') ?? nextPackages[0]); setImageLibrary(library); setExposure(0);
    } catch (cause) { loaded.forEach(image => image.close()); if (revision === loadGeneration.current) setError(String(cause)); }
  };
  const loadFiles = async (files: FileList | null) => {
    if (!review || !files) return;
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
    if (!playing && automatic.packageId) {
      const current = assetList.find(item => item.id === automatic.packageId);
      if (current && current.id !== asset?.id) setAsset(current);
    }
  }, [automatic.packageId, assetList, asset?.id, playing]);
  React.useEffect(() => {
    if (!asset || pictures.length !== asset.pages.length) return;
    const node = canvas.current, context = node?.getContext('2d');
    if (!node || !context) return;
    [node.width, node.height] = asset.canvas;
    const shownExposure = !playing && automatic.packageId === asset.id ? automatic.exposure : exposure;
    const frame = asset.frames[shownExposure] ?? asset.frames[0]!;
    context.clearRect(0, 0, node.width, node.height);
    context.drawImage(pictures[frame.page]!, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
    companionWindow.refreshHitMask();
  }, [asset, pictures, exposure, playing, automatic]);
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
  return <main style={{ width: '100%', background: 'transparent', font: '12px system-ui' }}>
    <header style={{ ...panel, WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <strong>{review ? 'Varin companion · development review' : 'Varin'}</strong>
      <button style={{ float: 'right', WebkitAppRegion: 'no-drag' } as React.CSSProperties} disabled={!isElectronShell()}
        onClick={() => void invokeDesktop('desktop_close_current_window')}>Close</button>
    </header>
    <canvas ref={canvas} {...companionWindow.handlers} style={{ width: 'min(100%,360px)', height: 'auto', margin: 'auto', touchAction: 'none', display: asset ? 'block' : 'none' }} />
    {error && !review && <p role="alert" style={panel}>{error}</p>}
    {!asset && <p style={panel}>No visually accepted artwork package installed. Candidate art requires explicit review-file selection.</p>}
    <section style={panel}><button disabled={!isElectronShell()} onClick={() => void companionWindow.togglePinned()}>{companionWindow.pinned ? 'Unpin' : 'Keep on top'}</button><label><input type="checkbox" disabled={!isElectronShell()} checked={companionWindow.passthrough} onChange={event => companionWindow.setPassthrough(event.target.checked)} />Transparent pointer pass-through</label>{review && <p>Local movement: {companionWindow.phase}. Movement artwork remains gated by accepted lift/landing assets.</p>}{companionWindow.notice && <p>{companionWindow.notice}</p>}</section>
    {review && <section style={panel} aria-label="Development presentation review">
      <label>Review target (not Host state) <select value={presentation} onChange={event => setPresentation(event.target.value)}>
        {catalog.states.map(state => <option key={state.id} value={state.id}>{state.id} {state.label}</option>)}
      </select></label>
      <input type="file" multiple accept=".json,.png" aria-label="Select bundle or sequence JSON and PNG atlases" onChange={event => void loadFiles(event.target.files)} />
      {assetList.length > 1 && <select aria-label="Review an actual package in the bundle" value={asset?.id ?? ''} onChange={event => { setPlaying(false); setExposure(0); setAsset(assetList.find(item => item.id === event.target.value)); }}>{assetList.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
      {asset && <><p>{asset.id} · {asset.stage ?? 'unstated stage'} · {asset.warning}</p>
        <button onClick={() => { setExposure(0); setPlaying(value => !value); }}>{playing ? 'Stop' : 'Replay authored timing'}</button>
        <button onClick={() => { setPlaying(false); setExposure(value => Math.min(asset.frames.length - 1, value + 1)); }}>Next exposure</button>
        <span> {exposure + 1}/{asset.frames.length} exposures</span></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    <section style={panel} aria-label="Actual Host facts">
      <strong>{review ? 'Actual Host facts — independent of review target' : 'Observe a conversation'}</strong>
      <select aria-label="Observe an existing thread branch" value={identity ? JSON.stringify(identity) : ''} onChange={event => {
        setSelected(event.target.value ? { generation, identity: JSON.parse(event.target.value) as ThreadIdentity } : null);
      }}><option value="">No thread selected</option>{threads.flatMap(thread => thread.branches.map(branch => {
        const value: ThreadIdentity = { runtime: 'agent', threadId: thread.thread_id, branchId: branch.branch_id };
        return <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{thread.title || thread.thread_id} / {branch.branch_id}</option>;
      }))}</select>
      <p role="status">{connection}</p>{automatic.blocker && <p>Artwork: {automatic.blocker}</p>}<p>Host presentation: {intent.state ?? 'Unclassified execution'} · {intent.reason}</p>
      {snapshot && <p>Run: {run?.state ?? 'No active run'} · cancellation requested: {String(run?.cancel_requested ?? false)} · nonterminal operations: {pending.length} · unknown effects: {unknownEffects.length}</p>}
      <button disabled={!identity || !isElectronShell()} onClick={() => { if (identity) void invokeDesktop('desktop_focus_main_window', identity); }}>Open original conversation</button>
      <small>Observation does not create a thread, mark it read, approve, cancel or restart work. Host intent is read-only. Candidate review remains separate; automatic playback requires accepted, compatible artwork.</small>
    </section>
  </main>;
}

export function renderCompanionApp(apis: RuntimeAPIs) {
  const root = document.getElementById('root');
  if (!root) throw new Error('Companion root not found');
  createRoot(root).render(<CompanionApp apis={apis} />);
}
