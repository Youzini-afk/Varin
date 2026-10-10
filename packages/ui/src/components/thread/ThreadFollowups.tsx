import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { Followup, FollowupRegisterParams, FollowupView, Operation, Run } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const heldReason: Record<NonNullable<NonNullable<Followup['occurrence']>['hold_reason']>, string> = {
  control_paused: 'Follow-up paused', source_run_active: 'Waiting for the original run to finish',
  source_unsettled: 'Waiting for original work and its writers to settle', branch_active: 'Waiting for current work and queued input',
  context_scope_changed: 'Context scope changed; register from the intended work', preparation_failed: 'Preparation failed; resume to retry',
  goal_paused: 'The goal is paused', goal_budget: 'The goal output budget is exhausted', goal_blocked: 'The goal is blocked',
  goal_ended: 'The goal has ended', goal_superseded: 'Newer goal work replaced this source',
  manual_pause: 'Current work is manually paused', question: 'Waiting for a user answer', preparing: 'Preparing execution',
};
function atLabel(at: number) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? `Unix time ${at} ms` : `${date.toLocaleString()} · ${date.toISOString()}`;
}
function triggerLabel(item: Followup) {
  if (item.trigger.kind === 'at') return `At ${atLabel(item.trigger.at_ms)}`;
  if (item.trigger.kind === 'process_stopped') return `After process ${item.trigger.operation_id} actually stops`;
  return item.trigger.kind === 'run_completed' ? 'After the original run completes' : 'Continuing goal work';
}
function FollowupInstruction({ api, identity, item }: { api: ThreadFollowupsAPI; identity: ThreadIdentity; item: Followup }) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<FollowupView>();
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setView(undefined); setError(false);
    void api.get(identity, item.id, controller.signal).then(value => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      if (value.followup.id !== item.id || value.followup.thread_id !== identity.threadId || value.followup.branch_id !== identity.branchId) { setError(true); return; }
      setView(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, item.id, open]);
  if (!item.has_instruction) return null;
  return <div>
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide follow-up instruction' : 'Read follow-up instruction'}</Button>
    {open && (error ? <p role="alert">The original instruction could not be read.</p> : view
      ? <pre className="whitespace-pre-wrap break-words text-sm">{view.instruction ?? 'No instruction stored'}</pre> : <p>Reading original instruction…</p>)}
  </div>;
}

/** Original definitions and delivery facts; no client timer or execution queue. */
export function ThreadFollowups({ api, identity, run, operations, followups, pending, act, cancelObservation }: {
  api: ThreadFollowupsAPI; identity: ThreadIdentity; run?: Run; operations: Operation[]; followups: Followup[];
  pending: boolean; act(work: () => Promise<unknown>): Promise<void>; cancelObservation(operationId: string): Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [kind, setKind] = React.useState<'at' | 'process_stopped'>('at');
  const [at, setAt] = React.useState(''); const [processId, setProcessId] = React.useState('');
  const [instruction, setInstruction] = React.useState(''); const [uncertain, setUncertain] = React.useState(false);
  const intent = React.useRef<FollowupRegisterParams | null>(null);
  const live = React.useRef(false); const host = React.useRef(getRuntimeEndpointGeneration());
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && host.current === getRuntimeEndpointGeneration();
  const independent = followups.filter(item => item.actor.kind !== 'goal');
  const processes = operations.filter(operation => operation.executor === 'process_spawn' && operation.execution_owner?.kind === 'kernel'
    && ['thread', 'environment'].includes(operation.lifetime) && operation.call_completion?.kind === 'job_accepted');
  const process = processes.find(operation => operation.id === processId);
  const atMs = at ? new Date(at).getTime() : NaN;
  const valid = instruction.trim().length > 0 && (kind === 'at' ? Boolean(run) && Number.isSafeInteger(atMs) && atMs >= 0 : Boolean(process));
  const register = () => {
    if (!intent.current) {
      if (!valid) return;
      intent.current = { key: crypto.randomUUID(), runId: kind === 'at' ? run!.id : process!.run_id,
        trigger: kind === 'at' ? { kind: 'at', atMs } : { kind: 'process_stopped', operationId: process!.id }, instruction };
    }
    const original = intent.current;
    return act(async () => {
      try {
        await api.register({ ...identity, ...original });
        if (current()) { intent.current = null; setUncertain(false); setInstruction(''); setAt(''); setEditing(false); }
      } catch (error) { if (current()) setUncertain(true); throw error; }
    });
  };
  const control = (item: Followup, action: 'pause' | 'resume' | 'cancel') => act(() => api.control({
    ...identity, followupId: item.id, expectedRevision: item.revision, action,
  }));
  if (!run && independent.length === 0) return null;
  return <section className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm" aria-label="One-time follow-ups">
    <div className="flex items-center gap-2"><span>One-time follow-ups</span>{run && <Button variant="ghost" size="sm" aria-expanded={editing}
      onClick={() => setEditing(value => !value)}>{editing ? 'Hide follow-up form' : 'Schedule a follow-up'}</Button>}</div>
    {editing && <div className="space-y-2">
      <p>Deliver this instruction at the next legal boundary, or start a new run here when idle. Current pauses, questions, permissions and goal limits still apply.</p>
      <label className="block">Trigger<select aria-label="Follow-up trigger" value={kind} disabled={pending || uncertain}
        onChange={event => setKind(event.target.value as typeof kind)} className="ml-2 rounded border bg-background p-1">
        <option value="at">At a specific time</option><option value="process_stopped">After a process stops</option>
      </select></label>
      {kind === 'at' ? <><label className="block">Time ({Intl.DateTimeFormat().resolvedOptions().timeZone})<Input aria-label="Follow-up time" type="datetime-local" step="1" value={at}
        disabled={pending || uncertain} onChange={event => setAt(event.target.value)} /></label>
        {Number.isFinite(atMs) && <p className="text-xs text-muted-foreground">{atLabel(atMs)}. A past time becomes due once.</p>}</>
        : <label className="block">Original process<select aria-label="Follow-up process" value={processId} disabled={pending || uncertain}
          onChange={event => setProcessId(event.target.value)} className="ml-2 rounded border bg-background p-1">
          <option value="">Select an accepted long-lived process</option>{processes.map(value => <option key={value.id} value={value.id}>{value.id}</option>)}
        </select></label>}
      <label className="block">Instruction<Textarea aria-label="Follow-up instruction" value={instruction} disabled={pending || uncertain}
        onChange={event => setInstruction(event.target.value)} rows={3} /></label>
      {uncertain && <p role="status">Acceptance is unconfirmed. Retry keeps the original time, instruction, source and key. Leaving this draft does not cancel an accepted follow-up.</p>}
      <Button variant="outline" size="sm" disabled={pending || (!uncertain && !valid)} onClick={() => void register()}>{uncertain ? 'Retry original follow-up' : 'Register one-time follow-up'}</Button>
      {uncertain && <Button variant="ghost" size="sm" disabled={pending} onClick={() => { intent.current = null; setUncertain(false); }}>Leave uncertain follow-up draft</Button>}
    </div>}
    {independent.map(item => {
      const delivery = item.occurrence?.delivery;
      const consumed = delivery?.state === 'delivered';
      const ended = consumed || item.state === 'cancelled' || item.occurrence?.state === 'cancelled';
      return <div key={item.id} className="space-y-1 rounded border p-3" aria-label={ended ? 'Past follow-up' : 'Pending follow-up'}>
        <p>{triggerLabel(item)}</p>
        <p className="text-xs text-muted-foreground">{item.id} · registered by {item.actor.kind === 'agent' ? `Agent in ${item.actor.run_id}` : 'User'} · {item.state}</p>
        <p>{item.occurrence?.hold_reason ? heldReason[item.occurrence.hold_reason] : item.occurrence ? `Occurrence ${item.occurrence.state}` : 'Waiting for the original trigger'}</p>
        {delivery && <p className="break-all text-xs text-muted-foreground">Input {delivery.input_id} · {delivery.state} · activation {delivery.activation_state}
          {delivery.run_id && ` · run ${delivery.run_id}`}{delivery.execution_id && ` · execution ${delivery.execution_id}`}
          {delivery.delivered_cursor !== null && ` · delivered at ${delivery.delivered_cursor}`}{delivery.failure_code && ` · ${delivery.failure_code}`}</p>}
        <FollowupInstruction api={api} identity={identity} item={item} />
        {!ended && <>
          {item.state === 'active' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'pause')}>Pause follow-up</Button>}
          {(item.state === 'paused' || item.occurrence?.hold_reason === 'preparation_failed') && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>Resume follow-up</Button>}
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'cancel')}>Cancel follow-up</Button>
        </>}
        {item.observation && <div className="text-xs text-muted-foreground">Original Agent observation · {item.observation.state} · {item.observation.delivered ? 'result delivered' : 'result not delivered'}
          {item.observation.state === 'waiting' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void cancelObservation(item.observation!.operation_id)}>End follow-up observation</Button>}
        </div>}
      </div>;
    })}
  </section>;
}
