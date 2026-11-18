import React from 'react';
import { getRuntimeEndpointGeneration, registerRuntimeEndpointSwitchBlocker, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadPreparedSource, ThreadPrepareSource, ThreadSnapshot, ThreadsAPI, ThreadSourceTargets, ThreadResolvedSource } from '@varin/application-client';
import type { AgentInputContext, AgentInputSnapshotConsumer, LaunchSource, SourceResourceOwner } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentRegistry } from '@/lib/documents/registry';
import type { DraftSourceSelection } from '@/stores/useThreadDraftStore';

// A retry keeps the original snapshot and request identity, even if editors keep changing.
// The registry remains the only mutable text owner; this holds only its opaque snapshot lease.
type SourceRequest = {
  key: string;
  consumer: AgentInputSnapshotConsumer;
  input?: ThreadPrepareSource;
  workspace?: Promise<ThreadResolvedSource>;
  registry?: DocumentRegistry;
  capture?: Promise<AgentInputContext>;
  controller?: AbortController;
  releasing?: Promise<void>;
};

function releaseRequest(request: SourceRequest): Promise<void> {
  request.controller?.abort();
  request.releasing ??= (async () => {
    // A late capture must also be released when cancellation preceded its reply.
    const context = await request.capture?.catch(() => undefined);
    if (context) await request.registry?.releaseAgentInputContext(request.consumer, context);
  })();
  return request.releasing;
}

export function ThreadSourcePicker({ api, identity, initialPath, active, launch, prepared, onPrepared, onPreparingChange, onUseChatOnly, onUseDefault, onSaveDefault, chatOnly, branchDefaultSource, draftSelection, onDraftSelection }: {
  api: Pick<ThreadsAPI, 'prepareSource' | 'sources'>;
  identity: ThreadIdentity | null;
  draftSelection?: DraftSourceSelection;
  onDraftSelection?(value: DraftSourceSelection): void;
  initialPath?: string;
  active: boolean;
  launch: ThreadSnapshot['launch'];
  prepared: ThreadPreparedSource | null;
  onPrepared(value: ThreadPreparedSource | null): void;
  onPreparingChange(value: boolean): void;
  onUseChatOnly?(): void;
  onUseDefault?(): void;
  chatOnly?: boolean;
  /** null is an explicit chat-only default; undefined means that no override exists. */
  branchDefaultSource?: LaunchSource | null;
  /** Optional for a Host with branch CAS. Preparation alone never changes a branch. */
  onSaveDefault?(source: ThreadPreparedSource['source'] | null): Promise<void>;
}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [targets, setTargets] = React.useState<ThreadSourceTargets>({ targets: [], unavailable: [] });
  const [resourceOwner, setResourceOwner] = React.useState<SourceResourceOwner>(draftSelection?.resourceOwner ?? { kind: 'local' });
  const [directoryError, setDirectoryError] = React.useState<string>();
  const [path, setPath] = React.useState(draftSelection?.path ?? initialPath ?? '');
  const [mode, setMode] = React.useState<ThreadPrepareSource['mode']>(draftSelection?.mode ?? (identity ? 'fixed_branch' : 'live_root'));
  const [locator, setLocator] = React.useState<Pick<DraftSourceSelection, 'selection' | 'expectedWorkspaceId' | 'locationLabel'> | undefined>(draftSelection);
  const [contentMode, setContentMode] = React.useState<'saved-files' | 'surface-drafts'>(draftSelection?.contentMode ?? 'saved-files');
  const [scopes, setScopes] = React.useState(draftSelection?.captureScopes.join('\n') ?? '');
  const [preparing, setPreparing] = React.useState(false);
  const [savingDefault, setSavingDefault] = React.useState(false);
  const switching = React.useRef(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const request = React.useRef<SourceRequest | undefined>(undefined);
  const callbacks = React.useRef({ onPrepared, onPreparingChange, initialPath });
  callbacks.current = { onPrepared, onPreparingChange, initialPath };
  const retire = React.useCallback(() => {
    generation.current += 1;
    const previous = request.current;
    request.current = undefined;
    return previous ? releaseRequest(previous) : Promise.resolve();
  }, []);
  React.useEffect(() => {
    setPreparing(false); setError(undefined);
    callbacks.current.onPreparingChange(false);
    return () => { void retire().catch(() => { /* The original Host may already be disconnected. */ }); };
  }, [api, host, identity, retire]);
  React.useEffect(() => {
    const controller = new AbortController();
    setTargets({ targets: [], unavailable: [] }); setDirectoryError(undefined);
    void api.sources.list(identity, controller.signal).then(value => {
      if (!controller.signal.aborted) setTargets(value);
    }, error => { if (!controller.signal.aborted) setDirectoryError(error instanceof Error ? error.message : 'Source Hosts could not be loaded'); });
    return () => controller.abort();
  }, [api, host, identity]);
  React.useEffect(() => registerRuntimeEndpointSwitchBlocker(async () => {
    // Release on the original Host before the endpoint changes, including a late capture reply.
    const releasing = retire();
    setPreparing(false); callbacks.current.onPreparingChange(false);
    await releasing;
  }), [retire]);
  const invalidate = () => {
    const releasing = retire();
    const current = generation.current;
    setPreparing(false); setError(undefined); onPreparingChange(false); onPrepared(null);
    void releasing.catch(() => {
      if (generation.current === current) setError('The draft snapshot could not be released on its original Host.');
    });
  };
  const select = (next: Partial<DraftSourceSelection>, keepRegistration = false) => {
    invalidate();
    const binding = keepRegistration ? locator : undefined;
    const nextMode = next.mode ?? (mode === 'native_workspace' && !keepRegistration ? 'live_root' : mode);
    const value: DraftSourceSelection = { path, resourceOwner, contentMode, captureScopes: scopes.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
      ...binding, ...next, mode: nextMode };
    if (nextMode === 'live_root' || nextMode === 'native_workspace') { value.contentMode = 'saved-files'; value.captureScopes = []; }
    setPath(value.path); setResourceOwner(value.resourceOwner); setMode(value.mode); setContentMode(value.contentMode);
    setScopes(value.captureScopes.join('\n'));
    setLocator({ selection: value.selection, expectedWorkspaceId: value.expectedWorkspaceId, locationLabel: value.locationLabel });
    if (!identity) onDraftSelection?.(value);
  };
  const prepare = async () => {
    if (!identity || active || request.current?.controller) return;
    const current = generation.current;
    const pending: SourceRequest = request.current ?? {
      key: crypto.randomUUID(), consumer: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId },
    };
    request.current = pending;
    const controller = new AbortController();
    pending.controller = controller;
    const isCurrent = () => current === generation.current && request.current === pending && !controller.signal.aborted;
    setPreparing(true); onPreparingChange(true); setError(undefined);
    try {
      if (!pending.input) {
        if (!pending.workspace) {
          pending.workspace = locator?.selection?.mode === 'native_workspace'
            ? Promise.resolve({ resourceOwner, path, workspaceId: locator.selection.workspaceId })
            : api.sources.resolve(identity, { resourceOwner, path }, controller.signal);
        }
        const resolved = await pending.workspace;
        const { workspaceId } = resolved;
        if (!isCurrent()) return;
        if (locator?.expectedWorkspaceId && locator.expectedWorkspaceId !== workspaceId) throw new Error('The saved workspace registration changed. Select the folder again.');
        let content: ThreadPrepareSource['content'] = { mode: 'saved-files' };
        if (mode !== 'live_root' && contentMode === 'surface-drafts') {
          if (resolved.resourceOwner.kind !== 'local') throw new Error('This window’s drafts cannot be captured on another Host. Select saved files.');
          if (!pending.capture) {
            const registry = getDocumentRegistry();
            pending.registry = registry;
            pending.capture = registry.captureAgentInputContext(pending.consumer, workspaceId);
          }
          const context = await pending.capture;
          if (!isCurrent()) return;
          if (context.source === 'surface' && context.snapshot.status !== 'ready') {
            throw new Error('Editor drafts could not be captured. Capture drafts again to start a new request.');
          }
          content = { mode: 'surface-drafts', context };
        }
        pending.input = { ...identity, key: pending.key, resourceOwner: resolved.resourceOwner, workspaceId, mode, content, ...(locator?.selection ? { selection: locator.selection } : {}),
          captureScopes: mode === 'live_root' ? [] : scopes.split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
      }
      if (!isCurrent()) return;
      const result = await api.prepareSource(pending.input, controller.signal);
      if (!isCurrent()) return;
      onPrepared(result);
      pending.controller = undefined;
      request.current = undefined;
      // Preparation has pinned immutable bytes; the temporary editor snapshot can now go.
      await releaseRequest(pending);
    } catch (value) {
      if (current === generation.current) setError(value instanceof Error ? value.message : 'Workspace preparation failed');
    } finally {
      pending.controller = undefined;
      if (current === generation.current) { setPreparing(false); onPreparingChange(false); }
    }
  };
  const saveDefault = async (source: ThreadPreparedSource['source'] | null) => {
    if (!onSaveDefault || active || preparing || switching.current) return;
    const current = generation.current;
    switching.current = true; setSavingDefault(true); setError(undefined);
    try { await onSaveDefault(source); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : 'Branch default could not be saved'); }
    finally { switching.current = false; setSavingDefault(false); }
  };
  const source = launch?.selection.source;
  const displaySource = branchDefaultSource === undefined ? source : branchDefaultSource;
  const displayedMode = prepared ? 'Prepared for next run' : chatOnly ? 'Chat only' : displaySource
    ? displaySource.mode === 'native_workspace' ? 'Versioned workspace' : displaySource.mode === 'live_root' ? 'Live workspace'
      : displaySource.mode === 'materialized' ? 'Isolated editable copy' : 'Read-only snapshot'
    : branchDefaultSource === null || launch ? 'Chat only' : 'Default';
  const isNativeProject = locator?.selection?.mode === 'native_workspace';
  const provenance = prepared?.provenance;
  const targetKey = (owner: SourceResourceOwner) => owner.kind === 'local' ? 'local' : JSON.stringify([owner.connectionId, owner.endpointIdentity, owner.hostId]);
  const ownerLabel = (owner: SourceResourceOwner) => targets.targets.find(target => targetKey(target.resourceOwner) === targetKey(owner))?.label
    ?? (owner.kind === 'local' ? 'Agent service' : targets.unavailable.find(row => row.connectionId === owner.connectionId)?.label ?? 'Unavailable Host');
  const locations = targets.workspace?.locations ?? [];
  const startup = locations.find(row => row.id === targets.workspace?.defaultId);
  return <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Workspace · {displayedMode}</summary>
    <div className="space-y-2 py-2">
      {branchDefaultSource !== undefined && <p>Saved for the next run: {branchDefaultSource ? `${ownerLabel(branchDefaultSource.resource_owner)} · ${branchDefaultSource.live_root?.canonicalRoot ?? branchDefaultSource.workspace_id}` : 'Chat only'}.</p>}
      {source && <p>{branchDefaultSource === undefined ? 'Current source' : 'Last run’s source'}: {ownerLabel(source.resource_owner)} · workspace {source.workspace_id}{source.mode !== 'live_root'&&source.mode!=='native_workspace' && ` · revision ${source.revision}`}.{branchDefaultSource === undefined && ` ${source.mode === 'live_root' ? 'Following runs use this same live workspace. Edits change its actual files.' : source.mode === 'materialized' ? 'Following runs keep this working copy.' : source.mode === 'native_workspace' ? 'Following runs use the same registered project view.' : 'Following runs read the same fixed snapshot.'}`}</p>}
      {!source && !launch && branchDefaultSource === undefined && targets.workspace && <p>Default for new conversations: {startup
        ? 'unavailable' in startup ? startup.unavailable : `${ownerLabel(startup.resourceOwner)} · ${startup.path}`
        : targets.workspace.defaultId ? 'Saved location unavailable' : `${ownerLabel({ kind: 'local' })} · ${targets.workspace.servicePath}`}</p>}
      {locations.length > 0 && <label className="block">Saved work locations
        <select aria-label="Saved work locations" disabled={active} value="" onChange={event => {
          const row = locations.find(candidate => candidate.id === event.target.value);
          if (!row || 'unavailable' in row) return;
          select({ path: row.path, resourceOwner: row.resourceOwner, mode: row.selection?.mode ?? 'live_root',
            expectedWorkspaceId: row.workspaceId, selection: row.selection, locationLabel: `${ownerLabel(row.resourceOwner)} · ${row.name}`, contentMode: 'saved-files', captureScopes: [] });
        }}>
          <option value="">Choose a saved location</option>
          {locations.map(row => <option key={row.id} value={row.id}
            disabled={'unavailable' in row || !targets.targets.some(target => targetKey(target.resourceOwner) === targetKey(row.resourceOwner))}>
            {row.name} · {'unavailable' in row ? row.unavailable : `${ownerLabel(row.resourceOwner)} · ${row.path}`}
          </option>)}
        </select>
      </label>}
      <label className="block">Source Host
        <select aria-label="Source Host" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" disabled={active || !targets.targets.length}
          value={targetKey(resourceOwner)} onChange={event => {
            const target = targets.targets.find(target => targetKey(target.resourceOwner) === event.target.value);
            if (!target) return;
            select({ resourceOwner: target.resourceOwner, path: '', contentMode: 'saved-files' });
          }}>
          {!targets.targets.length && <option value="local">This Host</option>}
          {targets.targets.map(target => <option key={targetKey(target.resourceOwner)} value={targetKey(target.resourceOwner)}>{target.label}</option>)}
        </select>
      </label>
      {resourceOwner.kind === 'managed_host' && <p>The folder and source tools run on {ownerLabel(resourceOwner)}. This conversation stays on its current Host.</p>}
      {directoryError && <p role="alert">{directoryError}</p>}
      {targets.unavailable.map(target => <p key={target.connectionId}>{target.label}: {target.message}</p>)}
      <label className="block">Workspace folder
        <Input aria-label="Workspace folder" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
          disabled={active} value={path} onChange={event => { select({ path: event.target.value }); }} />
      </label>
      {resourceOwner.kind === 'local' && draftSelection?.resourceOwner.kind !== 'managed_host' && initialPath && <Button type="button" variant="ghost" size="sm" disabled={active} onClick={() => { select({ path: initialPath }); }}>Use current workspace folder</Button>}
      <select aria-label="Workspace access" className="w-full rounded border bg-background px-2 py-1 text-sm" disabled={active}
        value={mode} onChange={event => { select({ mode: event.target.value as typeof mode }, true); }}>
        {isNativeProject && <option value="native_workspace">Versioned project workspace</option>}
        <option value="fixed_branch">Read-only file snapshot: read, list and search</option>
        <option value="materialized">Isolated editable copy and commands</option>
        {!isNativeProject && <option value="live_root">Live workspace: files, commands and code structure</option>}
      </select>
      {mode === 'native_workspace' ? <p>Uses the original registered project view.</p> : mode === 'live_root' ? <p>Uses saved files directly, without capturing a snapshot. External file and dependency changes remain live; unsaved editor changes are not included. Edits change the selected workspace immediately. Commands can have external effects; this is not a security sandbox.</p> : <>
        <label className="block">Snapshot content
          <select aria-label="Snapshot content" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" disabled={active}
            value={contentMode} onChange={event => { select({ contentMode: event.target.value as typeof contentMode }, true); }}>
            <option value="saved-files">Saved files only</option>
            <option value="surface-drafts" disabled={resourceOwner.kind !== 'local'}>Saved files with this window's editor drafts</option>
          </select>
        </label>
        <p>{contentMode === 'saved-files' ? 'Unsaved editor changes are not included.' : 'Captures drafts only in the selected workspace. Editors and saved files stay unchanged. Later editor changes do not alter the captured request.'}</p>
        <label className="block">Additional capture paths, one per line
          <Textarea aria-label="Additional capture paths" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" rows={2}
            disabled={active} value={scopes} onChange={event => { invalidate(); setScopes(event.target.value);
            if (!identity) onDraftSelection?.({ path, resourceOwner, mode, contentMode, ...locator, captureScopes: event.target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }); }} />
        </label>
        <p>The default workspace inventory is always captured. Additional paths include ignored files or folders; they do not narrow the snapshot. Leave blank to use the default inventory.</p>
      </>}
      {mode === 'materialized' && <p>File edits start in a separate working copy. Commands can have external effects; this is not a security sandbox. Changes are not copied back automatically.</p>}
      {active && <p>Workspace selection applies to a new run. Wait for the current run to finish before preparing another source.</p>}
      {identity && <Button type="button" variant="outline" size="sm" disabled={active || preparing || !path.trim() || !targets.targets.some(target => targetKey(target.resourceOwner) === targetKey(resourceOwner))} onClick={() => void prepare()}>{preparing ? 'Preparing workspace' : 'Prepare workspace'}</Button>}
      {!identity && onUseDefault && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => { invalidate(); setLocator(undefined); setPath(''); setResourceOwner({ kind: 'local' }); setMode('live_root'); setContentMode('saved-files'); setScopes(''); onUseDefault(); }}>Use service default</Button>}
      {onUseChatOnly && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => { invalidate(); setLocator(undefined); setPath(''); onUseChatOnly(); }}>Chat only</Button>}
      {onSaveDefault && identity && <div className="flex flex-wrap gap-2">
        {prepared?.source.mode === 'live_root' && <Button type="button" variant="outline" size="sm" disabled={active || preparing || savingDefault}
          onClick={() => void saveDefault(prepared.source)}>Save prepared location as branch default</Button>}
        <Button type="button" variant="ghost" size="sm" disabled={active || preparing || savingDefault}
          onClick={() => void saveDefault(null)}>Save chat only as branch default</Button>
      </div>}
      {request.current && <Button type="button" variant="ghost" size="sm" onClick={invalidate}>{preparing ? 'Cancel preparation' : 'Discard captured request'}</Button>}
      {error && contentMode === 'surface-drafts' && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => { invalidate(); void prepare(); }}>Capture drafts again</Button>}
      {prepared && <div aria-label="Prepared workspace">
        <p>{ownerLabel(prepared.source.resourceOwner)} · {prepared.path} · {prepared.source.mode==='native_workspace'?'Versioned files and commands':prepared.source.mode === 'live_root' ? 'Live files and commands' : prepared.source.mode === 'materialized' ? 'Editable copy and commands' : 'Read-only'} · ready for the next send</p>
        <p>Available source tools: {prepared.source.tools.length ? prepared.source.tools.join(', ') : 'None'}</p>
        {prepared.source.mode !== 'live_root'&&prepared.source.mode!=='native_workspace' && <p>Fixed revision: {prepared.source.revision}</p>}
        {provenance && <div aria-label="Capture provenance">
          <p>Consistency: {provenance.consistency}</p>
          {'root' in provenance ? <><p>Fixed root: {provenance.root}</p>
            {provenance.consistency === 'refreshed-root' && provenance.conflicts.length > 0 && <p>Conflicts: {provenance.conflicts.join(', ')}</p>}</> : <>
            <p>Content: {provenance.contentMode}</p>
            <p>Additional capture paths: {provenance.captureScopes.length ? provenance.captureScopes.join(', ') : 'Default inventory only'}</p>
            <p>Omitted draft paths: {provenance.omittedDraftPaths.length ? provenance.omittedDraftPaths.join(', ') : 'None'}</p>
          </>}
        </div>}
        <Button type="button" variant="ghost" size="sm" disabled={preparing} onClick={() => { invalidate(); if (!source) onUseChatOnly?.(); }}>{source ? 'Keep current workspace' : 'Remove prepared workspace'}</Button>
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </details>;
}
