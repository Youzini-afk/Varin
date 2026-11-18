import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type SettingsPayload, type ThreadSourceTargets, type WorkspaceLocation } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { resolveProjectSource } from '@/lib/projectSource';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { workspaceCopy } from './location-copy';

const ownerKey = (owner: SourceResourceOwner) => owner.kind === 'local' ? 'local' : JSON.stringify([owner.hostId, owner.connectionId, owner.endpointIdentity]);
const same = (a: WorkspaceLocation, b: WorkspaceLocation) => a.id === b.id && (
  a.kind === 'project' ? b.kind === 'project' && a.projectId === b.projectId
    : b.kind === 'folder' && ownerKey(a.resourceOwner) === ownerKey(b.resourceOwner)
      && a.workspaceId === b.workspaceId && a.path === b.path && a.name === b.name);
const selectClass = 'min-h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-foreground';
const labelClass = 'grid min-w-0 gap-1.5 typography-ui-label';
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
type Patch = Pick<SettingsPayload, 'workspaceLocations' | 'defaultWorkspaceLocationId'>;

type LocationControlsProps = {
  refreshRevision: number;
  renderRegisteredProjects(projects: SettingsPayload['projects'] | undefined, directory: ThreadSourceTargets | undefined): React.ReactNode;
};

export function WorkspaceLocationControls(props: LocationControlsProps) {
  const endpoint = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ServiceLocations key={endpoint} endpoint={endpoint} {...props} />;
}

function ServiceLocations({ endpoint, refreshRevision, renderRegisteredProjects }: LocationControlsProps & { endpoint: number }) {
  const { settings, threads } = useRuntimeAPIs();
  const { locale } = useI18n();
  const c = workspaceCopy(locale);
  const [snapshot, show] = React.useState<SettingsPayload>();
  const [directory, setDirectory] = React.useState<ThreadSourceTargets>();
  const [status, setStatus] = React.useState<'saved' | 'saving' | null>(null);
  React.useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setStatus(null), 1800);
    return () => clearTimeout(timer);
  }, [status]);
  const [error, setError] = React.useState('');
  const [sourceError, setSourceError] = React.useState('');
  const [form, setForm] = React.useState<'folder' | 'project' | null>(null);
  const [name, setName] = React.useState(''), [path, setPath] = React.useState('');
  const [owner, setOwner] = React.useState(''), [projectId, setProjectId] = React.useState('');
  const mounted = React.useRef(false), busy = React.useRef(false), serial = React.useRef(0);
  const registration = React.useRef<AbortController | null>(null);
  const active = React.useCallback(() => mounted.current && getRuntimeEndpointGeneration() === endpoint, [endpoint]);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; registration.current?.abort(); };
  }, []);
  React.useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (busy.current) return;
      const request = ++serial.current;
      try {
        const { settings: value } = await settings.load();
        if (!stopped && active() && request === serial.current) { show(value); setError(''); }
      } catch (e) { if (!stopped && active() && request === serial.current) setError(reason(e)); }
    };
    void load();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'settings-changed' && event.owner === 'app') void load();
    });
    return () => { stopped = true; unsubscribe(); };
  }, [settings, active, refreshRevision]);
  React.useEffect(() => {
    const abort = new AbortController();
    setSourceError(''); setDirectory(undefined);
    if (threads) void threads.sources.list(null, abort.signal).then(
      value => { if (!abort.signal.aborted && active()) setDirectory(value); },
      failure => { if (!abort.signal.aborted && active()) setSourceError(reason(failure)); },
    );
    else setSourceError(c.discovery);
    return () => abort.abort();
  }, [threads, refreshRevision, active, c.discovery]);

  const places = snapshot?.workspaceLocations ?? [], projects = snapshot?.projects ?? [];
  const availableProjects = projects.filter(p => !places.some(v => v.kind === 'project' && v.projectId === p.id));
  const targets = directory?.targets ?? [];
  const target = targets.find(t => ownerKey(t.resourceOwner) === owner);
  const selectedDefault = snapshot?.defaultWorkspaceLocationId ?? '';
  let serviceName = '';
  try { const address = new URL(getRuntimeApiBaseUrl() || window.location.href, window.location.href);
    if (address.protocol === 'https:' || address.protocol === 'http:') serviceName = address.host;
  } catch { /* No network address during native startup. */ }
  const deviceName = (binding: SourceResourceOwner) => {
    if (binding.kind === 'local') return serviceName || c.local;
    const remote = targets.find(t => ownerKey(t.resourceOwner) === ownerKey(binding));
    if (remote) return remote.label;
    const unavailable = directory?.unavailable.find(t => t.connectionId === binding.connectionId);
    return unavailable ? unavailable.label + ' · ' + c.offline : c.offline;
  };
  const label = (place: WorkspaceLocation) => {
    const p = place.kind === 'project' ? projects.find(p => p.id === place.projectId) : undefined;
    const binding = place.kind === 'folder' ? place.resourceOwner : p?.source?.resourceOwner ?? { kind: 'local' } as const;
    const device = deviceName(binding);
    return { title: place.kind === 'folder' ? place.name : p?.label || p?.path || c.missingProject,
      device, path: place.kind === 'folder' ? place.path : p?.path, missing: place.kind === 'project' && !p };
  };
  const reset = () => { setForm(null); setPath(''); setName(''); setOwner(''); setProjectId(''); };
  // Settings.save is the existing Host patch owner (not a CAS). Re-read before editing
  // a shared list; only write fields affected by this action, and never retarget a late response.
  const commit = async (change: (fresh: SettingsPayload) => Patch, prepare?: (signal: AbortSignal) => Promise<void>) => {
    if (!active() || busy.current || !snapshot) return false;
    busy.current = true; ++serial.current; setStatus('saving'); setError('');
    const operation = new AbortController(); registration.current = operation;
    try {
      if (prepare) await prepare(operation.signal);
      if (!active()) return false;
      const { settings: fresh } = await settings.load();
      if (!active()) return false;
      show(fresh);
      const patch = change(fresh);
      if (!active()) return false;
      const saved = await settings.save(patch);
      if (!active()) return false;
      show(saved);
      const savedPlaces = saved.workspaceLocations;
      if ((patch.defaultWorkspaceLocationId !== undefined && (saved.defaultWorkspaceLocationId ?? null) !== patch.defaultWorkspaceLocationId)
        || (patch.workspaceLocations && (patch.workspaceLocations.length !== savedPlaces?.length
          || !patch.workspaceLocations.every((item, index) => same(savedPlaces[index]!, item))))) throw new Error(c.notSaved);
      setStatus('saved'); return true;
    } catch (e) { if (active()) { setError(reason(e)); setStatus(null); } return false; }
    finally { busy.current = false; registration.current = null; }
  };
  const add = async () => {
    if (!form) return false;
    // Resolve an explicit folder at its *own* Documents service. Resolving does not
    // grant trust, create a project/thread, or change the current branch or navigation.
    const id = crypto.randomUUID();
    let resolved: Awaited<ReturnType<typeof resolveProjectSource>> | undefined;
    const ok = await commit(fresh => {
      const locations = fresh.workspaceLocations ?? [];
      let place: WorkspaceLocation;
      if (form === 'folder' && target && resolved && name.trim()) {
        const folder = resolved;
        if (ownerKey(folder.resourceOwner) !== ownerKey(target.resourceOwner)) throw new Error(c.stale);
        if (locations.some(p => p.kind === 'folder' && ownerKey(p.resourceOwner) === ownerKey(folder.resourceOwner) && p.workspaceId === folder.workspaceId)) throw new Error(c.duplicate);
        place = { kind: 'folder', id, name: name.trim(), ...resolved };
      } else if (form === 'project' && fresh.projects?.some(p => p.id === projectId)) {
        if (locations.some(p => p.kind === 'project' && p.projectId === projectId)) throw new Error(c.duplicate);
        place = { kind: 'project', id, projectId };
      } else throw new Error(c.stale);
      return { workspaceLocations: [...locations, place] };
    }, form === 'folder' ? async signal => {
      if (!target || !path.trim() || !name.trim()) throw new Error(c.stale);
      resolved = await resolveProjectSource(target.resourceOwner, path.trim(), signal);
    } : undefined);
    if (ok) reset();
    return ok;
  };
  const remove = (place: WorkspaceLocation) => commit(fresh => {
    const current = fresh.workspaceLocations ?? [];
    if (!current.some(p => same(p, place))) throw new Error(c.stale);
    return { workspaceLocations: current.filter(p => p.id !== place.id), ...(fresh.defaultWorkspaceLocationId === place.id ? { defaultWorkspaceLocationId: null } : {}) };
  });
  const setDefault = (id: string) => commit(fresh => {
    const previous = places.find(p => p.id === id);
    if ((fresh.defaultWorkspaceLocationId ?? '') !== selectedDefault || (id && (!previous || !fresh.workspaceLocations?.some(place => same(place, previous))
      || (previous.kind === 'project' && !fresh.projects?.some(p => p.id === previous.projectId))))) throw new Error(c.stale);
    return { defaultWorkspaceLocationId: id || null };
  });
  const saving = status === 'saving', disabled = saving || !snapshot;
  const formReady = form === 'folder' ? Boolean(target && path.trim() && name.trim()) : availableProjects.some(p => p.id === projectId);
  return <>
    {!snapshot && !error && <p role="status">{c.loading}</p>}
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    {status && <p role="status" className="typography-meta text-muted-foreground">{saving ? c.saving : c.done}</p>}
    {snapshot && <>
      <SettingsSection title={c.start} description={c.startHint}>
        <select aria-label={c.start} className={selectClass} value={selectedDefault} disabled={disabled || !!form} onChange={e => void setDefault(e.currentTarget.value)}>
          <option value="">{c.fallback}</option>
          {places.map(p => { const view = label(p); return <option key={p.id} value={p.id} disabled={view.missing}>{view.device} · {view.title}</option>; })}
        </select>
      </SettingsSection>
      <SettingsSection title={c.saved} description={c.removeHint}>
        {places.length === 0 && <p className="typography-meta text-muted-foreground">{c.empty}</p>}
        <ul className="divide-y divide-border/50">
          {places.map(p => { const view = label(p); return <li key={p.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0"><div className="break-words typography-ui-label">{view.title}</div>
              <div className="break-all typography-meta text-muted-foreground">{p.kind === 'project' ? c.project : c.folder} · {view.device}{view.path && <> · {view.path}</>}</div></div>
            <Button type="button" variant="ghost" size="sm" disabled={disabled || !!form} aria-label={c.remove + ': ' + view.title} onClick={() => void remove(p)}>{c.remove}</Button>
          </li>; })}
        </ul>
        {!form ? <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setForm('folder'); setOwner(targets.length === 1 ? ownerKey(targets[0]!.resourceOwner) : ''); }}>{c.addFolder}</Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled || !availableProjects.length} onClick={() => setForm('project')}>{c.addProject}</Button></div>
          : <div className="grid gap-3 rounded-lg border border-border/60 p-4">
            <h3 className="typography-ui-label">{form === 'folder' ? c.addFolder : c.addProject}</h3>
            {form === 'folder' ? <>
              <label className={labelClass}>{c.device}<select className={selectClass} value={owner} disabled={disabled} onChange={e => setOwner(e.target.value)}>
                <option value="">{c.choose}</option>{targets.map(t => <option key={ownerKey(t.resourceOwner)} value={ownerKey(t.resourceOwner)}>{t.resourceOwner.kind === 'local' ? deviceName(t.resourceOwner) : t.label}</option>)}</select></label>
              {directory && !targets.length && <p>{c.noDevices}</p>}
              <label className={labelClass}>{c.path}<Input disabled={disabled} value={path} onChange={e => setPath(e.target.value)} /></label>
              <label className={labelClass}>{c.name}<Input disabled={disabled} value={name} onChange={e => setName(e.target.value)} /></label>
            </> : <label className={labelClass}>{c.project}<select className={selectClass} value={projectId} disabled={disabled} onChange={e => setProjectId(e.target.value)}>
              <option value="">{c.choose}</option>{availableProjects.map(p => <option key={p.id} value={p.id}>{p.label || p.path} · {deviceName(p.source?.resourceOwner ?? { kind: 'local' })} · {p.path}</option>)}</select></label>}
            <SettingsActionBar placement="inline" dirty saving={saving} saveDisabled={!formReady} onSave={add} onCancel={reset} saveLabel={c.add} />
          </div>}
        {sourceError && <p className="typography-meta text-destructive" role="status">{sourceError}</p>}
        {directory?.unavailable.map(t => <p key={t.connectionId} className="typography-meta text-muted-foreground">{t.label}: {t.message}</p>)}
      </SettingsSection>
      {renderRegisteredProjects(snapshot.projects ?? [], directory)}
    </>}
  </>;
}
