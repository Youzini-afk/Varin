import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ThreadFamilyAPI, ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { HostJobSource, FollowupPendingRegistration, Followup, FollowupOccurrence, FollowupOccurrencesResult, FollowupLeafEvidence, FollowupRegisterParams, FollowupRegistrationSource, FollowupSource, FollowupView, Operation, Run } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ThreadRunHistory } from './ThreadFamily';
import { ThreadFollowupOccurrenceDetails } from './ThreadFollowupOccurrenceDetails';

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
function sourceLabel(source: FollowupSource) {
  if (source.kind === 'artifact') return `When original job ${source.operation_id} has an artifact fact${source.artifact_id ? ` for ID ${source.artifact_id}` : source.name ? ` named ${source.name}` : ' for any artifact'}`;
  if (source.kind === 'collection') return `When original job ${source.operation_id} collection finishes`;
  if (source.kind === 'job_stopped') return `After accepted job ${source.operation_id} actually stops`;
  if (source.kind === 'file') return `When ${source.path} ${source.condition === 'exists' ? 'exists' : source.condition === 'changed' ? 'changes' : 'is stable with managed writers stopped'}`;
  return source.kind === 'at' ? `At ${atLabel(source.at_ms)}` : `After process ${source.operation_id} actually stops`;
}
function triggerLabel(item: Followup) {
  if (item.trigger.kind === 'at' || item.trigger.kind === 'process_stopped' || item.trigger.kind === 'file' || item.trigger.kind === 'job_stopped' || item.trigger.kind === 'artifact' || item.trigger.kind === 'collection') return sourceLabel(item.trigger);
  if (item.trigger.kind === 'any') return 'When any condition is observed';
  if (item.trigger.kind === 'all') return 'When every condition is observed';
  return item.trigger.kind === 'run_completed' ? 'After the original run completes' : 'Continuing goal work';
}
function isPastFollowup(item: Followup): boolean {
  return item.state === 'cancelled' || (item.repeat === 'once'
    && (item.occurrence?.delivery?.state === 'delivered' || item.occurrence?.state === 'cancelled'));
}
type SourceDraft = { kind: FollowupRegistrationSource['kind']; at: string; processId: string; jobId: string; path: string; condition: 'exists' | 'changed' | 'ready'; artifactSelector: 'any' | 'artifactId' | 'name'; artifactValue: string };
const emptySource = (): SourceDraft => ({ kind: 'at', at: '', processId: '', jobId: '', path: '', condition: 'exists', artifactSelector: 'any', artifactValue: '' });
// The original Job owner declares supported observations; the renderer owns no domain/version table.
const supportsJobSource = (job: HostJobSource, kind: string) => job.observationKinds.some(value => value === kind);
const usesJobs = (kind: FollowupRegisterParams['trigger']['kind']) => kind === 'job_stopped' || kind === 'artifact' || kind === 'collection';
function sourceInput(draft: SourceDraft, processes: Operation[], jobs: HostJobSource[]): FollowupRegistrationSource | null {
  if (draft.kind === 'artifact' || draft.kind === 'collection') {
    if (!jobs.some(job => supportsJobSource(job, draft.kind) && job.binding.operationId === draft.jobId)) return null;
    if (draft.kind === 'collection') return { kind: 'collection', operationId: draft.jobId };
    if (draft.artifactSelector !== 'any' && !draft.artifactValue.trim()) return null;
    return { kind: 'artifact', operationId: draft.jobId, ...(draft.artifactSelector === 'any' ? {} : { [draft.artifactSelector]: draft.artifactValue }) };
  }
  if (draft.kind === 'job_stopped') return jobs.some(job => supportsJobSource(job, draft.kind) && job.binding.operationId === draft.jobId) ? { kind: 'job_stopped', operationId: draft.jobId } : null;
  if (draft.kind === 'file') return draft.path.length ? { kind: 'file', path: draft.path, condition: draft.condition } : null;
  if (draft.kind === 'process_stopped') return processes.some(value => value.id === draft.processId)
    ? { kind: 'process_stopped', operationId: draft.processId } : null;
  const atMs = draft.at ? new Date(draft.at).getTime() : NaN;
  return Number.isSafeInteger(atMs) && atMs >= 0 ? { kind: 'at', atMs } : null;
}
function SourceEditor({ value, onChange, processes, jobs, disabled, repeating, label = 'Follow-up' }: {
  value: SourceDraft; onChange(value: SourceDraft): void; processes: Operation[]; jobs: HostJobSource[]; disabled: boolean; repeating: boolean; label?: string;
}) {
  if (value.kind === 'job_stopped' || value.kind === 'artifact' || value.kind === 'collection') {
    const research = value.kind !== 'job_stopped';
    const candidates = jobs.filter(job => supportsJobSource(job, value.kind));
    return <><label className="block">Accepted {research ? 'research ' : ''}job<select aria-label={`${label} job`} value={value.jobId} disabled={disabled}
      onChange={event => onChange({ ...value, jobId: event.target.value })} className="ml-2 rounded border bg-background p-1">
      <option value="">Select an accepted {research ? 'research ' : ''}job in this task family</option>{candidates.map(job => <option key={job.binding.operationId} value={job.binding.operationId}>
        {job.binding.domain} · {job.binding.workspaceId} · {job.binding.subjectId} · {job.executorStopped ? 'executor stopped' : 'awaiting executor stop'} · {job.threadId}
      </option>)}</select></label>
      {value.kind === 'job_stopped' && <p className="text-xs text-muted-foreground">Runs after the job stops. Collection may finish later.</p>}
      {value.kind === 'artifact' && <>
        <label className="block">Artifact selector<select aria-label={`${label} artifact selector`} value={value.artifactSelector} disabled={disabled}
          onChange={event => onChange({ ...value, artifactSelector: event.target.value as SourceDraft['artifactSelector'], artifactValue: '' })}>
          <option value="any">Any artifact</option><option value="artifactId">Exact artifact ID</option><option value="name">Exact artifact name</option>
        </select></label>
        {value.artifactSelector !== 'any' && <label className="block">{value.artifactSelector === 'artifactId' ? 'Artifact ID' : 'Artifact name'}<Input aria-label={`${label} artifact value`} value={value.artifactValue}
          disabled={disabled} onChange={event => onChange({ ...value, artifactValue: event.target.value })} /></label>}
        <p className="text-xs text-muted-foreground">{repeating ? 'Runs for each matching artifact update.' : 'Runs for the first matching artifact record.'} Includes failed or expired records.</p>
      </>}
      {value.kind === 'collection' && <p className="text-xs text-muted-foreground">Runs when collection finishes, including failed or empty results.</p>}
    </>;
  }
  const atMs = value.at ? new Date(value.at).getTime() : NaN;
  if (value.kind === 'file') return <><label className="block">Original source path<Input aria-label={`${label} file path`} value={value.path}
    disabled={disabled} onChange={event => onChange({ ...value, path: event.target.value })} placeholder="results/output.json" /></label>
    <label>File condition<select aria-label={`${label} file condition`} value={value.condition} disabled={disabled}
      onChange={event => onChange({ ...value, condition: event.target.value as SourceDraft['condition'] })}>
      <option value="exists">Exists</option><option value="changed">{repeating ? 'Each observed change' : 'Changed since registration'}</option><option value="ready">Stable, managed writers stopped</option>
    </select></label><p className="text-xs text-muted-foreground">Uses this run's source. A fixed revision cannot change; Ready waits for Varin-managed writes to stop.</p></>;
  return value.kind === 'at' ? <><label className="block">Time ({Intl.DateTimeFormat().resolvedOptions().timeZone})<Input aria-label={`${label} time`} type="datetime-local" step="1" value={value.at}
    disabled={disabled} onChange={event => onChange({ ...value, at: event.target.value })} /></label>
    {Number.isFinite(atMs) && <p className="text-xs text-muted-foreground">{atLabel(atMs)}. A past time becomes due once.</p>}</>
    : <label className="block">Original process<select aria-label={`${label} process`} value={value.processId} disabled={disabled}
      onChange={event => onChange({ ...value, processId: event.target.value })} className="ml-2 rounded border bg-background p-1">
      <option value="">Select an accepted long-lived process</option>{processes.map(process => <option key={process.id} value={process.id}>{process.id}</option>)}
    </select></label>;
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

function evidenceLabel(evidence: FollowupLeafEvidence): string {
  if (evidence.kind === 'file') return `${evidence.path} · ${evidence.proof} · ${evidence.state.kind}${evidence.state.kind === 'regular-file' ? ` · ${evidence.state.objectHash}` : ''}${evidence.position ? ` · watch ${evidence.position.generation}:${evidence.position.sequence}` : ''}${evidence.gap ? ' · observation gap' : ''}`;
  if (evidence.kind === 'artifact') {
    const fact = evidence.fact;
    const detail = 'artifact_id' in fact ? `${fact.artifact_id} · record revision ${fact.record_revision}`
      : `completion revision ${fact.completion_revision} · ${fact.outcome}${fact.outcome === 'failed' ? ' · collection failed; source file absence is unproven' : ''}`;
    return `${evidence.binding.subjectId} · ${fact.kind} · ${detail}${evidence.gap ? ' · observation gap' : ''}`;
  }
  if (evidence.kind === 'collection') return `${evidence.binding.subjectId} · collection ${evidence.outcome} · completion revision ${evidence.completion_revision} · ${evidence.counts.available} available, ${evidence.counts.failed} failed, ${evidence.counts.expired} expired, ${evidence.counts.pending} pending${evidence.outcome === 'done' && Object.values(evidence.counts).every(count => count === 0) ? ' · empty collection' : ''}${evidence.gap ? ' · observation gap' : ''}`;
  if (evidence.kind === 'at') return `Time observed ${atLabel(evidence.observed_at_ms)}`;
  if (evidence.kind === 'job_stopped') return `${evidence.binding.domain} · ${evidence.binding.subjectId} · ${evidence.outcome} · effect ${evidence.effect} · receipt ${evidence.receipt_identity}`;
  return `Process stop · receipt ${evidence.receipt_identity} · epoch ${evidence.receipt_epoch}`;
}
function OccurrenceView({ occurrence, family, identity, api, followupId }: { api: ThreadFollowupsAPI; followupId: string; occurrence: FollowupOccurrence; family?: ThreadFamilyAPI; identity: ThreadIdentity }) {
  const [readingRun, setReadingRun] = React.useState(false);
  const delivery = occurrence.delivery;
  const evidence = occurrence.evidence;
  return <div className="space-y-1" aria-label="Follow-up occurrence">
    <p>{occurrence.hold_reason ? heldReason[occurrence.hold_reason] : `Occurrence ${occurrence.state}`}</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Delivery details</summary>
    <p className="break-all">{occurrence.id} · accepted at {occurrence.accepted_cursor} · source event {occurrence.trigger_cursor}</p>
    <p className="break-all text-xs text-muted-foreground">{'sources' in evidence
      ? evidence.sources.map(source => `Condition ${source.source_index + 1} · accepted ${source.accepted_cursor} · ${evidenceLabel(source.evidence)}`).join('; ')
      : evidence.kind === 'run_completed' || evidence.kind === 'goal_requested' ? `Original Run revision ${evidence.run_revision}` : evidenceLabel(evidence)}</p>
    {delivery ? <p className="break-all text-xs text-muted-foreground">Input {delivery.input_id} · {delivery.state} · activation {delivery.activation_state}
      {delivery.run_id && ` · run ${delivery.run_id}`}{delivery.execution_id && ` · child execution ${delivery.execution_id}`}
      {delivery.delivered_cursor !== null && ` · delivered at ${delivery.delivered_cursor}`}{delivery.failure_code && ` · ${delivery.failure_code}`}</p>
      : <p className="text-xs text-muted-foreground">No input bound</p>}
    </details>
    <ThreadFollowupOccurrenceDetails api={api} identity={identity} followupId={followupId} occurrence={occurrence} />
    {family && delivery?.run_id && <>
      <Button size="sm" variant="ghost" aria-expanded={readingRun} onClick={() => setReadingRun(value => !value)}>{readingRun ? 'Hide occurrence Run' : 'Read occurrence Run'}</Button>
      {readingRun && <ThreadRunHistory api={family} identity={identity} runId={delivery.run_id} />}
    </>}
  </div>;
}
function FollowupOccurrences({ api, family, identity, item }: { api: ThreadFollowupsAPI; family?: ThreadFamilyAPI; identity: ThreadIdentity; item: Followup }) {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<{ after?: number; previous: (number | undefined)[]; revision: number }>({ previous: [], revision: 0 });
  const [page, setPage] = React.useState<FollowupOccurrencesResult>();
  const [error, setError] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration();
    setLoading(true); setPage(undefined); setError(false);
    void api.occurrences(identity, item.id, request.after, controller.signal).then(result => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setPage(result); setLoading(false);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, [api, identity, item.id, request, open]);
  return <div className="space-y-2">
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide occurrence history' : 'Read occurrence history'}</Button>
    {open && <div aria-label="Follow-up occurrence history" className="space-y-2 border-t pt-2">
      <p className="text-xs text-muted-foreground">Oldest first.</p>
      {loading && <p role="status">Reading occurrence history…</p>}
      {error && <p role="alert">Occurrence history could not be read.</p>}
      {page && <>
        <p className="text-xs text-muted-foreground">This is a saved page. Refresh to read current delivery states.</p>
        {page.occurrences.length === 0 && <p>No occurrences in this page.</p>}
        {page.occurrences.map(occurrence => <div key={occurrence.id} className="rounded border p-2"><OccurrenceView occurrence={occurrence} identity={identity} family={family} api={api} followupId={item.id} /></div>)}
        {page.nextCursor !== null && <Button size="sm" variant="outline" disabled={loading} onClick={() => setRequest(value => ({ after: page.nextCursor!, previous: [...value.previous, value.after], revision: value.revision + 1 }))}>Next occurrence page</Button>}
      </>}
      {request.previous.length > 0 && <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRequest(value => ({ after: value.previous.at(-1), previous: value.previous.slice(0, -1), revision: value.revision + 1 }))}>Previous occurrence page</Button>}
      <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRequest(value => ({ ...value, revision: value.revision + 1 }))}>{error ? 'Retry occurrence page' : 'Refresh occurrence page'}</Button>
    </div>}
  </div>;
}

/** Original definitions and delivery facts; no client timer or execution queue. */
export function ThreadFollowups({ api, family, identity, run, operations, followups, pending, act, cancelObservation }: {
  api: ThreadFollowupsAPI; family?: ThreadFamilyAPI; identity: ThreadIdentity; run?: Run; operations: Operation[]; followups: Followup[];
  pending: boolean; act(work: () => Promise<unknown>): Promise<void>; cancelObservation(operationId: string): Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [showPast, setShowPast] = React.useState(false);
  const [kind, setKind] = React.useState<FollowupRegisterParams['trigger']['kind']>('at');
  const [repeat, setRepeat] = React.useState<'once' | 'each'>('once');
  const [at, setAt] = React.useState(''); const [processId, setProcessId] = React.useState(''); const [jobId, setJobId] = React.useState('');
  const [artifactSelector, setArtifactSelector] = React.useState<SourceDraft['artifactSelector']>('any');
  const [artifactValue, setArtifactValue] = React.useState('');
  const [filePath, setFilePath] = React.useState(''); const [fileCondition, setFileCondition] = React.useState<SourceDraft['condition']>('exists');
  const [conditions, setConditions] = React.useState<SourceDraft[]>([emptySource(), { ...emptySource(), kind: 'process_stopped' }]);
  const [instruction, setInstruction] = React.useState(''); const [uncertain, setUncertain] = React.useState(false);
  const [registrations, setRegistrations] = React.useState<FollowupPendingRegistration[]>([]);
  const [registrationError, setRegistrationError] = React.useState(false);
  const [jobCandidates, setJobCandidates] = React.useState<{ runId: string; values: HostJobSource[] }>();
  const [jobError, setJobError] = React.useState(false); const [jobRetry, setJobRetry] = React.useState(0);
  const runId = run?.id;
  const needsJobs = usesJobs(kind) || ((kind === 'any' || kind === 'all') && conditions.some(value => usesJobs(value.kind)));
  React.useEffect(() => {
    if (!editing || !needsJobs || !runId) return;
    const controller = new AbortController(); const selectedHost = getRuntimeEndpointGeneration();
    setJobError(false); setJobCandidates(undefined);
    void api.jobSources(identity, runId, controller.signal).then(values => {
      if (!controller.signal.aborted && selectedHost === getRuntimeEndpointGeneration()) setJobCandidates({ runId, values });
    }, () => { if (!controller.signal.aborted && selectedHost === getRuntimeEndpointGeneration()) setJobError(true); });
    return () => controller.abort();
  }, [api, identity, runId, editing, needsJobs, operations, jobRetry]);
  const jobs = jobCandidates && jobCandidates.runId === runId ? jobCandidates.values : [];
  React.useEffect(() => {
    const controller = new AbortController(); const selectedHost = getRuntimeEndpointGeneration();
    setRegistrationError(false);
    void api.pendingRegistrations(identity, controller.signal).then(items => {
      if (controller.signal.aborted || selectedHost !== getRuntimeEndpointGeneration()) return;
      if (items.some(item => item.threadId !== identity.threadId || item.branchId !== identity.branchId)) { setRegistrationError(true); return; }
      setRegistrations(items);
    }, () => { if (!controller.signal.aborted && selectedHost === getRuntimeEndpointGeneration()) setRegistrationError(true); });
    return () => controller.abort();
  }, [api, identity, followups, uncertain]);
  const intent = React.useRef<FollowupRegisterParams | null>(null);
  const live = React.useRef(false); const host = React.useRef(getRuntimeEndpointGeneration());
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && host.current === getRuntimeEndpointGeneration();
  const independent = followups.filter(item => item.actor.kind !== 'goal');
  const pastCount = independent.filter(isPastFollowup).length;
  const processes = operations.filter(operation => operation.executor === 'process_spawn' && operation.execution_owner?.kind === 'kernel'
    && ['thread', 'environment'].includes(operation.lifetime) && operation.call_completion?.kind === 'job_accepted');
  const process = processes.find(operation => operation.id === processId);
  const composite = kind === 'any' || kind === 'all';
  const selected = composite ? conditions.map(value => sourceInput(value, processes, jobs)) : [sourceInput({ kind, at, processId, jobId, path: filePath, condition: fileCondition, artifactSelector, artifactValue }, processes, jobs)];
  const repeatable = (value: FollowupRegistrationSource | null) => value?.kind === 'artifact' || value?.kind === 'collection' || (value?.kind === 'file' && value.condition === 'changed');
  const repeatValid = repeat === 'once' || (kind === 'any' ? selected.some(repeatable) : selected.every(repeatable));
  const valid = repeatValid && instruction.trim().length > 0 && selected.every(value => value !== null) && (composite || kind !== 'process_stopped' ? Boolean(run) : Boolean(process));
  const register = () => {
    if (!intent.current) {
      if (!valid) return;
      intent.current = { key: crypto.randomUUID(), runId: composite || kind !== 'process_stopped' ? run!.id : process!.run_id,
        trigger: composite ? { kind, sources: selected as FollowupRegistrationSource[] } : selected[0]!, repeat, instruction };
    }
    const original = intent.current;
    return act(async () => {
      try {
        await api.register({ ...identity, ...original });
        if (current()) { intent.current = null; setUncertain(false); setInstruction(''); setAt(''); setRepeat('once'); setFilePath(''); setArtifactSelector('any'); setArtifactValue(''); setConditions([emptySource(), { ...emptySource(), kind: 'process_stopped' }]); setEditing(false); }
      } catch (error) { if (current()) setUncertain(true); throw error; }
    });
  };
  const control = (item: Followup, action: 'pause' | 'resume' | 'cancel') => act(() => api.control({
    ...identity, followupId: item.id, expectedRevision: item.revision, action,
  }));
  const discardRegistration = (item: FollowupPendingRegistration) => act(async () => {
    await api.cancelRegistration({ ...identity, key: item.id, runId: item.sourceRunId });
    if (current()) {
      setRegistrations(items => items.filter(value => value.id !== item.id));
      if (intent.current?.key === item.id) { intent.current = null; setUncertain(false); }
    }
  });
  if (!run && independent.length === 0 && registrations.length === 0 && !registrationError) return null;
  return <section className="mx-auto max-w-3xl space-y-2 rounded border p-3 text-sm" aria-label="Follow-ups">
    <div className="flex items-center gap-2"><span>Follow-ups</span>{run && <Button variant="ghost" size="sm" aria-expanded={editing}
      onClick={() => setEditing(value => !value)}>{editing ? 'Hide follow-up form' : 'Schedule a follow-up'}</Button>}</div>
    {editing && <div className="space-y-2">
      <p>Continue this conversation when the condition is met. Pauses, unanswered questions and goal limits remain in effect.</p>
      <label className="block">Repetition<select aria-label="Follow-up repetition" value={repeat} disabled={pending || uncertain}
        onChange={event => setRepeat(event.target.value as typeof repeat)} className="ml-2 rounded border bg-background p-1">
        <option value="once">Once</option><option value="each">Each observed change</option>
      </select></label>
      {repeat === 'each' && <p>Repeats for observed changes until cancelled. Changes while observation is unavailable may be missed.</p>}
      <label className="block">Trigger<select aria-label="Follow-up trigger" value={kind} disabled={pending || uncertain}
        onChange={event => setKind(event.target.value as typeof kind)} className="ml-2 rounded border bg-background p-1">
        <option value="at">At a specific time</option><option value="process_stopped">After a process stops</option><option value="job_stopped">After an accepted job stops</option><option value="artifact">When an original research artifact is observed</option><option value="collection">After original research collection finishes</option><option value="file">When a file condition is met</option>
        <option value="any">Any condition</option><option value="all">Every condition</option>
      </select></label>
      {composite ? <div className="space-y-2">
        <p>{repeat === 'once' ? 'Runs once when the selected conditions are met.'
          : kind === 'any' ? 'Runs for each observed change. Time and stop conditions trigger once.'
          : 'Runs after every condition has a new observation.'}</p>
        {conditions.map((value, index) => <fieldset key={index} className="space-y-1 rounded border p-2">
          <legend>Condition {index + 1}</legend>
          <select aria-label={`Condition ${index + 1} kind`} value={value.kind} disabled={pending || uncertain}
            onChange={event => setConditions(values => values.map((item, i) => i === index ? { ...item, kind: event.target.value as SourceDraft['kind'] } : item))}>
            <option value="at">At a specific time</option><option value="process_stopped">After a process stops</option><option value="job_stopped">After an accepted job stops</option><option value="artifact">When an original research artifact is observed</option><option value="collection">After original research collection finishes</option><option value="file">When a file condition is met</option>
          </select>
          <SourceEditor value={value} onChange={next => setConditions(values => values.map((item, i) => i === index ? next : item))}
            processes={processes} jobs={jobs} disabled={pending || uncertain} repeating={repeat === 'each'} label={`Condition ${index + 1}`} />
          <Button variant="ghost" size="sm" disabled={pending || uncertain || conditions.length === 1}
            onClick={() => setConditions(values => values.filter((_, i) => i !== index))}>Remove condition {index + 1}</Button>
        </fieldset>)}
        <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setConditions(values => [...values, emptySource()])}>Add condition</Button>
      </div> : <SourceEditor value={{ kind, at, processId, jobId, path: filePath, condition: fileCondition, artifactSelector, artifactValue }} onChange={value => { setAt(value.at); setProcessId(value.processId); setJobId(value.jobId); setFilePath(value.path); setFileCondition(value.condition); setArtifactSelector(value.artifactSelector); setArtifactValue(value.artifactValue); }} processes={processes} jobs={jobs} disabled={pending || uncertain} repeating={repeat === 'each'} />}
      {!repeatValid && <p role="alert">{kind === 'any' ? 'Repeated Any requires at least one file-change, artifact or collection condition.' : kind === 'all' ? 'Repeated All requires every condition to be a file-change, artifact or collection condition.' : 'Repetition requires a file-change, artifact or collection condition.'}</p>}
      {needsJobs && !jobCandidates && !jobError && <p role="status">Reading accepted jobs…</p>}
      {needsJobs && jobError && <p role="alert">Accepted jobs could not be read. <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setJobRetry(value => value + 1)}>Retry accepted jobs</Button></p>}
      <label className="block">Instruction<Textarea aria-label="Follow-up instruction" value={instruction} disabled={pending || uncertain}
        onChange={event => setInstruction(event.target.value)} rows={3} /></label>
      {uncertain && <p role="status">Acceptance is unconfirmed. Retry resends the same request. Leaving this draft does not cancel an accepted follow-up.</p>}
      <Button variant="outline" size="sm" disabled={pending || (!uncertain && !valid)} onClick={() => void register()}>{uncertain ? 'Retry original follow-up' : repeat === 'each' ? 'Register repeating follow-up' : 'Register one-time follow-up'}</Button>
      {uncertain && <Button variant="ghost" size="sm" disabled={pending} onClick={() => { intent.current = null; setUncertain(false); }}>Leave uncertain follow-up draft</Button>}
    </div>}
    {registrationError && <p role="alert">Pending file registrations could not be read. Retained source resources may still need cancellation.</p>}
    {registrations.map(item => <div key={item.id} className="space-y-1 rounded border p-3" aria-label="Unconfirmed file registration">
      <p>File resources were accepted, but this follow-up has not been registered.</p>
      <p className="break-all text-xs text-muted-foreground">{item.id} · original run {item.sourceRunId} · {item.paths.join(', ')}</p>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => void discardRegistration(item)}>Cancel unconfirmed registration</Button>
    </div>)}
    {pastCount > 0 && <Button variant="ghost" size="sm" aria-expanded={showPast} onClick={() => setShowPast(value => !value)}>
      {showPast ? 'Hide past follow-ups' : `Past follow-ups (${pastCount})`}
    </Button>}
    {independent.filter(item => showPast || !isPastFollowup(item)).map(item => {
      const ended = isPastFollowup(item);
      return <div key={item.id} className="space-y-1 rounded border p-3" aria-label={ended ? 'Past follow-up' : 'Pending follow-up'}>
        <p>{triggerLabel(item)}</p>
        <p>{item.repeat === 'each' ? item.state === 'cancelled' ? 'Repeating authorization cancelled' : item.state === 'paused' ? 'Repeating authorization paused' : 'Continuing to observe changes' : 'One-time instruction'} · {item.pending_occurrences} undelivered {item.pending_occurrences === 1 ? 'occurrence' : 'occurrences'}</p>
        {item.occurrence ? <div aria-label="Latest follow-up occurrence"><p className="text-xs text-muted-foreground">Latest occurrence</p><OccurrenceView key={item.occurrence.id} occurrence={item.occurrence} identity={identity} family={family} api={api} followupId={item.id} /></div> : <p>Waiting for the original trigger</p>}
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Condition details</summary>
        {(item.trigger.kind === 'any' || item.trigger.kind === 'all') && <ul className="space-y-1 text-xs text-muted-foreground">
          {item.trigger.sources.map((source, index) => {
            const state = item.sources.find(state => state.source_index === index);
            const observed = state?.observed;
            return <li key={index}>Condition {index + 1}: {sourceLabel(source)} · {observed ? `observed at event ${observed.trigger_cursor} · accepted ${observed.accepted_cursor} · consumed through ${state!.consumed_cursor}` : 'waiting'}</li>;
          })}
        </ul>}
        <p className="text-xs text-muted-foreground">{item.id} · registered by {item.actor.kind === 'agent' ? `Agent in ${item.actor.run_id}` : 'User'} · {item.state}</p>
        </details>
        {item.sources.filter(source => source.file !== null).map(source => {
          const file = source.file!;
          return <p key={source.source_index} className="text-xs text-muted-foreground">File condition {source.source_index + 1}: {file.current?.kind ?? 'awaiting original baseline'}
            {file.immutable && ' · fixed immutable source'}{file.gap && ' · observation gap; unavailable changes are not reconstructed'}
            {file.failure_code && ` · ${file.failure_code}`}{file.released && ' · observer released'}</p>;
        })}
        <FollowupInstruction api={api} identity={identity} item={item} />
        <FollowupOccurrences api={api} family={family} identity={identity} item={item} />
        {!ended && <>
          {item.repeat === 'each' && <p className="text-xs text-muted-foreground">Cancel stops future and pending deliveries. Existing results and the observed job remain available.</p>}
          {item.state === 'active' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'pause')}>Pause follow-up</Button>}
          {item.state === 'paused' ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>Resume follow-up</Button>
            : (item.repeat === 'each' || item.occurrence?.hold_reason === 'preparation_failed') && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>{item.repeat === 'each' ? 'Retry undelivered occurrences' : 'Resume follow-up'}</Button>}
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'cancel')}>Cancel follow-up</Button>
        </>}
        {item.observation && <div className="text-xs text-muted-foreground">Original Agent observation · {item.observation.state} · {item.observation.delivered ? 'result delivered' : 'result not delivered'}{item.repeat === 'each' && ' · observes only the first occurrence; ending this observation does not withdraw repeating authorization'}
          {item.observation.state === 'waiting' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void cancelObservation(item.observation!.operation_id)}>End follow-up observation</Button>}
        </div>}
      </div>;
    })}
  </section>;
}
