import React from 'react';
import { getRuntimeEndpointGeneration, registerRuntimeEndpointSwitchBlocker, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadPreparedSource, ThreadPrepareSource, ThreadSnapshot, ThreadsAPI, ThreadSourceTargets, ThreadResolvedSource } from '@varin/application-client';
import type { AgentInputContext, AgentInputSnapshotConsumer, SourceResourceOwner } from '@varin/protocol';
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

export function ThreadSourcePicker({ api, identity, initialPath, active, launch, prepared, onPrepared, onPreparingChange, onUseChatOnly, draftSelection, onDraftSelection }: {
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
}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [targets, setTargets] = React.useState<ThreadSourceTargets>({ targets: [], unavailable: [] });
  const [resourceOwner, setResourceOwner] = React.useState<SourceResourceOwner>(draftSelection?.resourceOwner ?? { kind: 'local' });
  const [directoryError, setDirectoryError] = React.useState<string>();
  const [path, setPath] = React.useState(draftSelection?.path ?? initialPath ?? '');
  const [mode, setMode] = React.useState<'fixed_branch' | 'materialized' | 'live_root'>(draftSelection?.mode ?? (identity ? 'fixed_branch' : 'live_root'));
  const [contentMode, setContentMode] = React.useState<'saved-files' | 'surface-drafts'>(draftSelection?.contentMode ?? 'saved-files');
  const [scopes, setScopes] = React.useState(draftSelection?.captureScopes.join('\n') ?? '');
  const [preparing, setPreparing] = React.useState(false);
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
    setPreparing(false); setError(undefined); if (identity) setPath(callbacks.current.initialPath ?? '');
    callbacks.current.onPreparingChange(false);
    return () => { void retire().catch(() => { /* The original Host may already be disconnected. */ }); };
  }, [api, host, identity, retire]);
  React.useEffect(() => {
    const controller = new AbortController();
    setTargets({ targets: [], unavailable: [] }); setDirectoryError(undefined); if (identity) setResourceOwner({ kind: 'local' });
    void api.sources.list(identity, controller.signal).then(value => {
      if (!controller.signal.aborted) setTargets(value);
    }, error => { if (!controller.signal.aborted) setDirectoryError(error instanceof Error ? error.message : 'Source Hosts could not be loaded'); });
    return () => controller.abort();
  }, [api, host, identity]);
  React.useEffect(() => {
    if (!identity) onDraftSelection?.({ path, resourceOwner, mode, contentMode,
      captureScopes: mode === 'live_root' ? [] : scopes.split(/\r?\n/).map(value => value.trim()).filter(Boolean) });
  }, [identity, path, resourceOwner, mode, contentMode, scopes, onDraftSelection]);
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
          pending.workspace = api.sources.resolve(identity, { resourceOwner, path }, controller.signal);
        }
        const resolved = await pending.workspace;
        const { workspaceId } = resolved;
        if (!isCurrent()) return;
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
        pending.input = { ...identity, key: pending.key, resourceOwner: resolved.resourceOwner, workspaceId, mode, content,
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
  const source = launch?.selection.source;
  const provenance = prepared?.provenance;
  const targetKey = (owner: SourceResourceOwner) => owner.kind === 'local' ? 'local' : JSON.stringify([owner.connectionId, owner.endpointIdentity, owner.hostId]);
  const ownerLabel = (owner: SourceResourceOwner) => targets.targets.find(target => targetKey(target.resourceOwner) === targetKey(owner))?.label
    ?? (owner.kind === 'local' ? 'This Host' : owner.hostId);
  return <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Workspace · {prepared ? 'Prepared for next run' : source ? source.mode === 'live_root' ? 'Live workspace' : source.mode === 'materialized' ? 'Isolated editable copy' : 'Read-only snapshot' : 'Chat only'}</summary>
    <div className="space-y-2 py-2">
      {source && <p>Current source: {ownerLabel(source.resource_owner)} · workspace {source.workspace_id}{source.mode !== 'live_root' && ` · revision ${source.revision}`}. {source.mode === 'live_root' ? 'Following runs use this same live workspace. Edits change its actual files.' : source.mode === 'materialized' ? 'Following runs keep this working copy.' : 'Following runs read the same fixed snapshot.'}</p>}
      <label className="block">Source Host
        <select aria-label="Source Host" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" disabled={active || !targets.targets.length}
          value={targetKey(resourceOwner)} onChange={event => {
            const target = targets.targets.find(target => targetKey(target.resourceOwner) === event.target.value);
            if (!target) return;
            invalidate(); setResourceOwner(target.resourceOwner); setPath(target.resourceOwner.kind === 'local' ? initialPath ?? '' : '');
            if (target.resourceOwner.kind === 'managed_host') setContentMode('saved-files');
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
          disabled={active} value={path} onChange={event => { invalidate(); setPath(event.target.value); }} />
      </label>
      {resourceOwner.kind === 'local' && initialPath && <Button type="button" variant="ghost" size="sm" disabled={active} onClick={() => { invalidate(); setPath(initialPath); }}>Use current workspace folder</Button>}
      <select aria-label="Workspace access" className="w-full rounded border bg-background px-2 py-1 text-sm" disabled={active}
        value={mode} onChange={event => { invalidate(); setMode(event.target.value as typeof mode); if (event.target.value === 'live_root') setContentMode('saved-files'); }}>
        <option value="fixed_branch">Read-only file snapshot: read, list and search</option>
        <option value="materialized">Isolated editable copy and commands</option>
        <option value="live_root">Live workspace: files, commands and language tools</option>
      </select>
      {mode === 'live_root' ? <p>Uses saved files directly, without capturing a snapshot. External file and dependency changes remain live; unsaved editor changes are not included. Edits change the selected workspace immediately. Commands can have external effects; this is not a security sandbox.</p> : <>
        <label className="block">Snapshot content
          <select aria-label="Snapshot content" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" disabled={active}
            value={contentMode} onChange={event => { invalidate(); setContentMode(event.target.value as typeof contentMode); }}>
            <option value="saved-files">Saved files only</option>
            <option value="surface-drafts" disabled={resourceOwner.kind !== 'local'}>Saved files with this window's editor drafts</option>
          </select>
        </label>
        <p>{contentMode === 'saved-files' ? 'Unsaved editor changes are not included.' : 'Captures drafts only in the selected workspace. Editors and saved files stay unchanged. Later editor changes do not alter the captured request.'}</p>
        <label className="block">Additional capture paths, one per line
          <Textarea aria-label="Additional capture paths" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm" rows={2}
            disabled={active} value={scopes} onChange={event => { invalidate(); setScopes(event.target.value); }} />
        </label>
        <p>The default workspace inventory is always captured. Additional paths include ignored files or folders; they do not narrow the snapshot. Leave blank to use the default inventory.</p>
      </>}
      {mode === 'materialized' && <p>File edits start in a separate working copy. Commands can have external effects; this is not a security sandbox. Changes are not copied back automatically.</p>}
      {active && <p>Workspace selection applies to a new run. Wait for the current run to finish before preparing another source.</p>}
      {identity && <Button type="button" variant="outline" size="sm" disabled={active || preparing || !path.trim() || !targets.targets.some(target => targetKey(target.resourceOwner) === targetKey(resourceOwner))} onClick={() => void prepare()}>{preparing ? 'Preparing workspace' : 'Prepare workspace'}</Button>}
      {!source && onUseChatOnly && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => { invalidate(); setPath(''); onUseChatOnly(); }}>Chat only</Button>}
      {request.current && <Button type="button" variant="ghost" size="sm" onClick={invalidate}>{preparing ? 'Cancel preparation' : 'Discard captured request'}</Button>}
      {error && contentMode === 'surface-drafts' && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => { invalidate(); void prepare(); }}>Capture drafts again</Button>}
      {prepared && <div aria-label="Prepared workspace">
        <p>{ownerLabel(prepared.source.resourceOwner)} · {prepared.path} · {prepared.source.mode === 'live_root' ? 'Live files and commands' : prepared.source.mode === 'materialized' ? 'Editable copy and commands' : 'Read-only'} · ready for the next send</p>
        <p>Available source tools: {prepared.source.tools.length ? prepared.source.tools.join(', ') : 'None'}</p>
        {prepared.source.mode !== 'live_root' && <p>Fixed revision: {prepared.source.revision}</p>}
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
