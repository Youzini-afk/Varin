import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { openReviewThread, resumeAutoReviewRun, stopAutoReviewRun } from '@/lib/reviewFlow';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { reviewLinkKey } from '@/stores/useReviewFlowStore';
import { useThreadStore } from '@/stores/useThreadStore';

export function AutoReviewBanner({ identity }: { identity: ThreadIdentity }) {
  const host = useThreadStore(state => state.hostKey);
  const run = useAutoReviewStore(state => state.runs[reviewLinkKey(host, identity)]);
  const [error, setError] = React.useState<string>();
  if (!run) return null;
  const running = run.status === 'running';
  const status = run.status === 'completed' ? 'Review completed' : running
    ? run.phase === 'handoff' ? 'Preparing review handoff' : run.phase === 'implementation' ? 'Waiting for implementation' : 'Waiting for review'
    : run.status === 'stopped' ? 'Review forwarding stopped' : 'Review needs attention';
  return <section aria-label="Review workflow" className="space-y-2 rounded border p-3 text-sm">
    <p role="status">{status}</p>
    {(error || run.error) && <p role="alert">{error ?? run.error}</p>}
    {run.command?.status === 'unknown' && <p>Delivery is unconfirmed. Retry keeps the original command; do not start another request.</p>}
    {run.command?.receipt && <p className="text-xs text-muted-foreground">Accepted run: {run.command.receipt.run_id}</p>}
    <div className="flex gap-2">
      {run.review && <Button type="button" variant="secondary" size="sm" onClick={() => openReviewThread({ hostKey: run.hostKey, original: run.original, review: run.review!, directory: run.directory })}>Open review</Button>}
      {running && <Button type="button" variant="secondary" size="sm" onClick={() => stopAutoReviewRun(run.key)}>Stop forwarding</Button>}
      {(run.status === 'paused' || run.status === 'stopped' && (run.command?.status === 'unknown' || !run.review)) && <>
        <Button type="button" variant="secondary" size="sm" onClick={() => { setError(undefined); void resumeAutoReviewRun(run.key).catch(error => setError(error instanceof Error ? error.message : 'Review unavailable')); }}>Retry original step</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => stopAutoReviewRun(run.key)}>Stop forwarding</Button>
      </>}
    </div>
  </section>;
}
