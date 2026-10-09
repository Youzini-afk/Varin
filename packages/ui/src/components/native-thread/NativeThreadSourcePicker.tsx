import React from 'react';
import type { NativeThreadIdentity, NativeThreadPreparedSource, NativeThreadSnapshot, NativeThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';

export function NativeThreadSourcePicker({ api, identity, initialPath, active, launch, prepared, onPrepared, onPreparingChange }: {
  api: NativeThreadsAPI;
  identity: NativeThreadIdentity;
  initialPath?: string;
  active: boolean;
  launch: NativeThreadSnapshot['launch'];
  prepared: NativeThreadPreparedSource | null;
  onPrepared(value: NativeThreadPreparedSource | null): void;
  onPreparingChange(value: boolean): void;
}) {
  const [path, setPath] = React.useState(initialPath ?? '');
  const [mode, setMode] = React.useState<'fixed_branch' | 'materialized' | 'live_root'>('fixed_branch');
  const [preparing, setPreparing] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const inFlight = React.useRef(false);
  const request = React.useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const callbacks = React.useRef({ onPrepared, onPreparingChange, initialPath });
  callbacks.current = { onPrepared, onPreparingChange, initialPath };
  React.useEffect(() => {
    generation.current += 1; inFlight.current = false; request.current = undefined;
    setPreparing(false); setError(undefined); setPath(callbacks.current.initialPath ?? '');
    callbacks.current.onPrepared(null); callbacks.current.onPreparingChange(false);
    return () => { generation.current += 1; };
  }, [api, identity.threadId, identity.branchId]);
  const prepare = async () => {
    if (inFlight.current) return;
    const current = generation.current;
    const fingerprint = JSON.stringify([identity.threadId, identity.branchId, path, mode]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    inFlight.current = true; setPreparing(true); onPreparingChange(true); setError(undefined);
    try {
      const result = await api.prepareSource({ ...identity, key: request.current.key, path, mode });
      if (current === generation.current) { onPrepared(result); request.current = undefined; }
    } catch (value) {
      if (current === generation.current) setError(value instanceof Error ? value.message : 'Workspace preparation failed');
    } finally {
      if (current === generation.current) { inFlight.current = false; setPreparing(false); onPreparingChange(false); }
    }
  };
  const source = launch?.selection.source;
  return <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
    <summary className="cursor-pointer">Workspace · {prepared ? 'Prepared for next run' : source ? source.mode === 'live_root' ? 'Live workspace' : source.mode === 'materialized' ? 'Isolated editable copy' : 'Read-only snapshot' : 'Chat only'}</summary>
    <div className="space-y-2 py-2">
      {source && <p>Current source: workspace {source.workspace_id}{source.mode !== 'live_root' && ` · revision ${source.revision}`}. {source.mode === 'live_root' ? 'Following runs use this same live workspace. Edits change its actual files.' : source.mode === 'materialized' ? 'Following runs keep this working copy.' : 'Following runs read the same fixed snapshot.'}</p>}
      <label className="block">Workspace folder
        <input aria-label="Native workspace folder" className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
          disabled={active || preparing} value={path} onChange={event => setPath(event.target.value)} />
      </label>
      {initialPath && <Button type="button" variant="ghost" size="sm" disabled={active || preparing} onClick={() => setPath(initialPath)}>Use current workspace folder</Button>}
      <select aria-label="Native workspace access" className="w-full rounded border bg-background px-2 py-1 text-sm" disabled={active || preparing}
        value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="fixed_branch">Read-only file snapshot: read, list and search</option>
        <option value="materialized">Isolated editable copy and commands</option>
        <option value="live_root">Live workspace: files, commands and language tools</option>
      </select>
      {mode === 'live_root' ? <p>Uses saved files directly, without capturing a snapshot. External file and dependency changes remain live; unsaved editor changes are not included. Edits change the selected workspace immediately. Commands can have external effects; this is not a security sandbox.</p> : <p>Captures saved files using the workspace inventory. Unsaved editor changes are not included.</p>}
      {mode === 'materialized' && <p>File edits start in a separate working copy. Commands can have external effects; this is not a security sandbox. Changes are not copied back automatically.</p>}
      {active && <p>Workspace selection applies to a new run. Wait for the current run to finish before preparing another source.</p>}
      <Button type="button" variant="outline" size="sm" disabled={active || preparing || !path.trim()} onClick={() => void prepare()}>{preparing ? 'Preparing workspace' : 'Prepare workspace'}</Button>
      {prepared && <div aria-label="Prepared native workspace">
        <p>{prepared.path} · {prepared.source.mode === 'live_root' ? 'Live files and commands' : prepared.source.mode === 'materialized' ? 'Editable copy and commands' : 'Read-only'} · ready for the next send</p>
        <Button type="button" variant="ghost" size="sm" disabled={preparing} onClick={() => onPrepared(null)}>{source ? 'Keep current workspace' : 'Remove prepared workspace'}</Button>
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </details>;
}
