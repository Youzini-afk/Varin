import React from 'react';
import type { ScheduledTask, ThreadIdentity } from '@varin/application-client';
import { createScheduledTasksHttpAPI } from '@varin/application-client';
import type { CalendarOccurrence } from '@varin/protocol';
import { Button } from '@/components/ui/button';
const schedules = createScheduledTasksHttpAPI();
export function CalendarTaskStatus({ projectId, task, onChanged, onOpenWork }: {
  projectId: string; task: ScheduledTask; onChanged(): Promise<void>; onOpenWork(identity: ThreadIdentity): void;
}) {
  const [pending, setPending] = React.useState(false), [error, setError] = React.useState('');
  const projection = task.calendar;
  if (!projection) return <p role="status">Calendar projection unavailable</p>;
  const { definition, occurrences } = projection;
  const action = async (work: () => Promise<unknown>) => { setPending(true); setError(''); try { await work(); await onChanged(); } catch (value) { setError(value instanceof Error ? value.message : 'Calendar control failed'); } finally { setPending(false); } };
  const isEnded = (value: CalendarOccurrence) => ['completed', 'failed', 'cancelled'].includes(value.state);
  const row = (value: CalendarOccurrence) => <div key={value.id} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
    <span>{value.reason.kind === 'scheduled' ? new Date(value.reason.at_ms).toLocaleString() : 'Run now'} · {value.state}</span>
    {value.hold_reason && <span>Held: {value.hold_reason}</span>}
    {value.failure_code && <span role="status">{value.failure_code}</span>}
    <Button size="sm" variant="outline" onClick={() => onOpenWork({ runtime: 'agent', threadId: value.thread_id, branchId: value.branch_id })}>View work</Button>
    {!isEnded(value) && value.state !== 'delivered' && <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(() => schedules.controlOccurrence(projectId, task.id, value.id, value.revision, 'cancel'))}>Cancel occurrence</Button>}
    {value.failure_code && !isEnded(value) && <Button size="sm" variant="outline" disabled={pending} onClick={() => void action(() => schedules.controlOccurrence(projectId, task.id, value.id, value.revision, 'retry'))}>Retry preparation</Button>}
  </div>;
  return <section aria-label="Calendar execution" className="mt-3 grid gap-2">
    <p className="text-sm">Agent · {definition.synchronized ? definition.calculation_pending ? 'Calculating next slot' : definition.next_at_ms === null ? 'No pending slot' : `Next: ${new Date(definition.next_at_ms).toLocaleString()}` : 'Waiting for asset synchronization'}</p>
    {definition.once_acceptance && <p className="text-sm">Once slot already accepted by {definition.once_acceptance.owner}. Automatic execution will not be repeated. Receipt: {definition.once_acceptance.acceptanceId}</p>}
    {definition.activation_hold && <p className="text-sm">Held: {definition.activation_hold}</p>}
    {definition.calculation_failure && <p role="status" className="text-sm">{definition.calculation_failure} <Button size="sm" disabled={pending} onClick={() => void action(() => schedules.retryCalculation(projectId, task.id, definition.revision))}>Retry calculation</Button></p>}
    {occurrences.filter(value => !isEnded(value)).map(row)}
    {occurrences.some(isEnded) && <details><summary className="text-sm">Finished occurrences</summary><div className="grid gap-2">{occurrences.filter(isEnded).map(row)}</div></details>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
