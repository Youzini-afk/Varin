import React from 'react';
import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { Followup, Operation } from '@varin/protocol';
import { Button } from '@/components/ui/button';

const heldReason: Record<NonNullable<NonNullable<Followup['occurrence']>['hold_reason']>, string> = {
  control_paused: 'Follow-up paused',
  source_run_active: 'Waiting for the original run to finish',
  source_unsettled: 'Waiting for original work to settle',
  branch_active: 'Waiting for current work and queued input',
  context_scope_changed: 'Context scope changed; cancel and register from the intended work',
  preparation_failed: 'Preparation failed; resume to retry',
};

/** These controls authorize one new Run. They never resume a policy Pause or decide a trigger. */
export function ThreadFollowups({ api, identity, operations, followups, pending, act }: {
  api: ThreadFollowupsAPI;
  identity: ThreadIdentity;
  operations: Operation[];
  followups: Followup[];
  pending: boolean;
  act(work: () => Promise<unknown>): Promise<void>;
}) {
  const registrationKeys = React.useRef(new Map<string, string>());
  const current = followups.filter(item => item.state !== 'cancelled' && !item.occurrence?.receipt);
  const finished = followups.filter(item => item.state === 'cancelled' || item.occurrence?.receipt);
  const available = operations.filter(operation => operation.executor === 'process_spawn'
    && ((operation.call_completion?.kind === 'job_accepted' && operation.call_completion.operation_id === operation.id)
      || operation.external_receipt !== null)
    && !current.some(item => item.operation_id === operation.id)
    && !followups.some(item => item.operation_id === operation.id && item.occurrence?.receipt));
  if (!available.length && !followups.length) return null;
  const register = (operation: Operation) => {
    const previous = followups.filter(item => item.operation_id === operation.id).map(item => item.id).sort().join(',');
    const fingerprint = `${operation.id}:${previous}`;
    let key = registrationKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); registrationKeys.current.set(fingerprint, key); }
    const requestKey = key;
    return act(() => api.register({ ...identity, key: requestKey, runId: operation.run_id, operationId: operation.id }));
  };
  const control = (item: Followup, action: 'pause' | 'resume' | 'cancel') => act(() => api.control({
    ...identity, followupId: item.id, expectedRevision: item.revision, action,
  }));
  return <section className="mx-auto max-w-3xl space-y-2 text-sm" aria-label="Process follow-ups">
    {available.map(operation => <div key={operation.id} className="rounded border p-3">
      <p>Continue this work once after the process has stopped and the original run has finished.</p>
      <p className="text-xs text-muted-foreground">Uses the original model and workspace selection. Stopping the original run cancels pending follow-ups.</p>
      <div className="text-xs text-muted-foreground">Process operation · {operation.id}</div>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void register(operation)}>Continue once when process ends</Button>
    </div>)}
    {current.map(item => <div key={item.id} className="rounded border p-3" aria-label="Pending process follow-up">
      <p>One-time follow-up · {item.state}</p>
      <div className="text-xs text-muted-foreground">{item.operation_id}</div>
      <p>{item.occurrence?.hold_reason ? heldReason[item.occurrence.hold_reason]
        : item.wait.state === 'observed' ? 'Process stopped; preparing continuation' : 'Waiting for the original process to stop'}</p>
      {item.state === 'active' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'pause')}>Pause follow-up</Button>}
      {(item.state === 'paused' || item.occurrence?.hold_reason === 'preparation_failed')
        && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>Resume follow-up</Button>}
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'cancel')}>Cancel follow-up</Button>
    </div>)}
    {finished.length > 0 && <details>
      <summary>Past process follow-ups · {finished.length}</summary>
      {finished.map(item => <div key={item.id} className="py-1 text-xs text-muted-foreground">
        {item.operation_id} · {item.occurrence?.state ?? item.state}
        {item.occurrence?.receipt && <span> · continuation run {item.occurrence.receipt.run_id}</span>}
      </div>)}
    </details>}
  </section>;
}
