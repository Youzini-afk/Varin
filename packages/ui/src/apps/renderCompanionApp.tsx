import React from 'react';
import { createRoot } from 'react-dom/client';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type RuntimeAPIs, type ThreadIdentity, type ThreadSnapshot, type ThreadSummary } from '@varin/application-client';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { readCompanionPackage, type CompanionPackage } from '@/components/companion/sequencePackage';
import { useCompanionPlayback } from '@/components/companion/useCompanionPlayback';
import { projectCompanionIntent, type ObservationHealth } from '@/components/companion/presentation';
import catalog from '../../../../tools/desktop-companion-animation/coverage.json';

function CompanionApp({ apis }: { apis: RuntimeAPIs }) {
  const review = new URLSearchParams(window.location.search).get('review') === '1';
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [threads, setThreads] = React.useState<ThreadSummary[]>([]);
  const [selected, setSelected] = React.useState<{ generation: number; identity: ThreadIdentity } | null>(null);
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [health, setHealth] = React.useState<ObservationHealth>('unselected');
  const [connection, setConnection] = React.useState('No thread selected');
  const [error, setError] = React.useState('');
  const [asset, setAsset] = React.useState<CompanionPackage>();
  const [pictures, setPictures] = React.useState<ImageBitmap[]>([]);
  const [playing, setPlaying] = React.useState(false);
  const [exposure, setExposure] = React.useState(0);
  const [presentation, setPresentation] = React.useState('C01');
  const intent = projectCompanionIntent(snapshot, health);
  const assetList = React.useMemo(() => asset ? [asset] : [], [asset]);
  const automatic = useCompanionPlayback(assetList, catalog.states.find(state => state.id === intent.state)?.requires[0] ?? null, playing);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const loadGeneration = React.useRef(0);
  React.useEffect(() => {
    const abort = new AbortController();
    setThreads([]); setSelected(null); setSnapshot(undefined); setConnection('No thread selected'); setHealth('unselected');
    if (apis.threads) void apis.threads.list(undefined, abort.signal).then(rows => { if (!abort.signal.aborted) setThreads(rows); })
      .catch(cause => { if (!abort.signal.aborted) setConnection(String(cause)); });
    return () => abort.abort();
  }, [apis.threads, generation]);
  React.useEffect(() => {
    setSnapshot(undefined);
    if (!apis.threads || !selected || selected.generation !== generation) { setConnection('No thread selected'); setHealth('unselected'); return; }
    let closed = false;
    setConnection('Synchronizing current Host snapshot'); setHealth('synchronizing');
    const projection = new ThreadProjection(apis.threads, selected.identity,
      value => { if (!closed) { setSnapshot(value); setHealth('current'); setConnection('Observing existing thread — read only'); } },
      cause => { if (!closed) { setHealth('unknown'); setConnection(`Connection unknown: ${String(cause)}`); } },
      undefined, undefined, undefined, { contextInspection: false });
    projection.start();
    return () => { closed = true; projection.close(); };
  }, [apis.threads, selected, generation]);
  React.useEffect(() => () => { for (const picture of pictures) picture.close(); }, [pictures]);
  React.useEffect(() => () => { loadGeneration.current++; }, []);
  const loadFiles = async (files: FileList | null) => {
    if (!review || !files) return;
    const revision = ++loadGeneration.current;
    setPlaying(false); setError('');
    const loaded: ImageBitmap[] = [];
    try {
      const all = [...files], json = all.filter(file => file.name.endsWith('.json'));
      if (json.length !== 1) throw new Error('Select one sequence.json and its PNG atlas pages');
      const next = readCompanionPackage(JSON.parse(await json[0]!.text()), true);
      for (const page of next.pages) {
        const candidates = all.filter(file => file.name === page.file);
        if (candidates.length !== 1) throw new Error(`Missing or ambiguous atlas: ${page.file}`);
        loaded.push(await createImageBitmap(candidates[0]!));
      }
      for (const frame of next.frames) {
        const image = loaded[frame.page]!;
        if (frame.rect[0] + frame.rect[2] > image.width || frame.rect[1] + frame.rect[3] > image.height) throw new Error('Atlas region exceeds the actual image');
      }
      if (revision !== loadGeneration.current) { loaded.forEach(image => image.close()); return; }
      setAsset(next); setPictures(loaded); setExposure(0);
    } catch (cause) { loaded.forEach(image => image.close()); if (revision === loadGeneration.current) setError(String(cause)); }
  };
  React.useEffect(() => {
    if (!asset || pictures.length !== asset.pages.length) return;
    const node = canvas.current, context = node?.getContext('2d');
    if (!node || !context) return;
    [node.width, node.height] = asset.canvas;
    const shownExposure = !playing && automatic.packageId === asset.id ? automatic.exposure : exposure;
    const frame = asset.frames[shownExposure] ?? asset.frames[0]!;
    context.clearRect(0, 0, node.width, node.height);
    context.drawImage(pictures[frame.page]!, ...frame.rect, ...frame.offset, frame.rect[2], frame.rect[3]);
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
      <strong>Varin companion · development review</strong>
      <button style={{ float: 'right', WebkitAppRegion: 'no-drag' } as React.CSSProperties} disabled={!isElectronShell()}
        onClick={() => void invokeDesktop('desktop_close_current_window')}>Close</button>
    </header>
    <canvas ref={canvas} style={{ width: '100%', maxHeight: 360, objectFit: 'contain', display: asset ? 'block' : 'none' }} />
    {!asset && <p style={panel}>No visually accepted artwork package installed. Candidate art requires explicit review-file selection.</p>}
    {review && <section style={panel} aria-label="Development presentation review">
      <label>Review target (not Host state) <select value={presentation} onChange={event => setPresentation(event.target.value)}>
        {catalog.states.map(state => <option key={state.id} value={state.id}>{state.id} {state.label}</option>)}
      </select></label>
      <input type="file" multiple accept=".json,.png" aria-label="Select sequence JSON and PNG atlases" onChange={event => void loadFiles(event.target.files)} />
      {asset && <><p>{asset.id} · {asset.stage ?? 'unstated stage'} · {asset.warning}</p>
        <button onClick={() => { setExposure(0); setPlaying(value => !value); }}>{playing ? 'Stop' : 'Replay authored timing'}</button>
        <button onClick={() => { setPlaying(false); setExposure(value => Math.min(asset.frames.length - 1, value + 1)); }}>Next exposure</button>
        <span> {exposure + 1}/{asset.frames.length} exposures</span></>}
      {error && <p role="alert">{error}</p>}
    </section>}
    <section style={panel} aria-label="Actual Host facts">
      <strong>Actual Host facts — independent of review target</strong>
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
