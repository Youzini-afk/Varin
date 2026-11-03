import React from 'react';
import type { ModelConnectionsSnapshot } from '@varin/application-client';

type Change = (current: ModelConnectionsSnapshot) => Promise<ModelConnectionsSnapshot>;

/** All writers share one authoritative revision, including connection drafts and model edits. */
export function useModelConnectionWrites(read: () => Promise<ModelConnectionsSnapshot>) {
  const [snapshot, setSnapshot] = React.useState<ModelConnectionsSnapshot | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reset, setReset] = React.useState(0);
  const current = React.useRef<ModelConnectionsSnapshot | null>(null);
  const alive = React.useRef(true);
  const queue = React.useRef<{ change: Change; project?: (value: ModelConnectionsSnapshot) => ModelConnectionsSnapshot; resolve(ok: boolean): void }[]>([]);
  const reading = React.useRef(0);
  const draining = React.useRef(false);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const accept = React.useCallback((value: ModelConnectionsSnapshot) => {
    current.current = value;
    if (alive.current) setSnapshot(queue.current.reduce((result, job) => job.project?.(result) ?? result, value));
  }, []);
  const refresh = React.useCallback(async () => {
    const generation = ++reading.current;
    try {
      const value = await read();
      if (alive.current && reading.current === generation && !queue.current.length) accept(value);
    } catch (cause) { if (alive.current && reading.current === generation) setError(String(cause)); }
  }, [accept, read]);
  const enqueue = React.useCallback((change: Change, project?: (value: ModelConnectionsSnapshot) => ModelConnectionsSnapshot) => new Promise<boolean>(resolve => {
    queue.current.push({ change, project, resolve });
    if (current.current) accept(current.current);
    if (draining.current) return;
    draining.current = true;
    ++reading.current;
    setSaving(true); setError(null);
    void (async () => {
      while (queue.current.length) {
        const job = queue.current[0]!;
        try {
          const value = await job.change(current.current ?? await read());
          queue.current.shift(); accept(value); job.resolve(true);
        } catch (cause) {
          // A failed optimistic operation must never be replayed against an unknown revision.
          const failed = queue.current.splice(0);
          try { accept(await read()); } catch { if (current.current) accept(current.current); }
          if (alive.current) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setReset(value => value + 1);
          }
          failed.forEach(entry => entry.resolve(false));
        }
      }
      draining.current = false;
      if (alive.current) setSaving(false);
    })();
  }), [accept, read]);
  return { snapshot, saving, error, setError, reset, refresh, enqueue };
}
