import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ThreadsAPI, ThreadFamilyAPI, ThreadFollowupsAPI, ThreadIdentity, ThreadResearchAPI } from '@varin/application-client';
import type { HostJobSource, FollowupPendingRegistration, Followup, FollowupOccurrence, FollowupOccurrencesResult, FollowupLeafEvidence, FollowupRegisterParams, FollowupRegistrationSource, FollowupSource, FollowupSourceState, FollowupView, MetricKind, ResourceMachineView, Operation, Run } from '@varin/protocol';
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
const metricNames: Record<MetricKind, string> = { cpu_percent: 'CPU usage', memory_mb: 'Memory used', gpu_percent: 'GPU usage', gpu_memory_mb: 'GPU memory used' };
const gpuMetric = (metric: MetricKind) => metric === 'gpu_percent' || metric === 'gpu_memory_mb';
const metricValue = (metric: MetricKind, value: number) => `${value} ${metric === 'memory_mb' || metric === 'gpu_memory_mb' ? 'MiB' : '%'}`;
function machineGpus(machine?: ResourceMachineView) {
  // UUID is the original device identity. Inventory and usage may each contain devices absent from the other.
  return [...new Map([...(machine?.capacity?.gpus ?? []), ...(machine?.usage?.gpus ?? [])]
    .filter(gpu => gpu.uuid).map(gpu => [gpu.uuid!, gpu])).values()];
}
function sourceLabel(source: FollowupSource) {
  if (source.kind === 'metric') return `When ${source.machine_id}${source.gpu_uuid ? ` · ${source.gpu_uuid}` : ''} ${metricNames[source.metric]} is ${source.predicate} ${metricValue(source.metric, source.threshold)}`;
  if (source.kind === 'log_literal') return `When original job ${source.operation_id} ${source.stream} matches ${source.literal_bytes} literal bytes from byte ${source.from_offset}`;
  if (source.kind === 'log_end') return `When original job ${source.operation_id} ${source.stream} ends`;
  if (source.kind === 'artifact') return `When original job ${source.operation_id} has an artifact fact${source.artifact_id ? ` for ID ${source.artifact_id}` : source.name ? ` named ${source.name}` : ' for any artifact'}`;
  if (source.kind === 'collection') return `When original job ${source.operation_id} collection finishes`;
  if (source.kind === 'job_stopped') return `After accepted job ${source.operation_id} actually stops`;
  if (source.kind === 'file') return `When ${source.path} ${source.condition === 'exists' ? 'exists' : source.condition === 'changed' ? 'changes' : 'is stable with managed writers stopped'}`;
  return source.kind === 'at' ? `At ${atLabel(source.at_ms)}` : `After process ${source.operation_id} actually stops`;
}
function triggerLabel(item: Followup) {
  if (item.trigger.kind === 'at' || item.trigger.kind === 'process_stopped' || item.trigger.kind === 'file' || item.trigger.kind === 'job_stopped' || item.trigger.kind === 'artifact' || item.trigger.kind === 'collection' || item.trigger.kind === 'log_literal' || item.trigger.kind === 'log_end' || item.trigger.kind === 'metric') return sourceLabel(item.trigger);
  if (item.trigger.kind === 'any') return 'When any condition is observed';
  if (item.trigger.kind === 'all') return 'When every condition is observed';
  return item.trigger.kind === 'run_completed' ? 'After the original run completes' : 'Continuing goal work';
}
function logStateLabel(state: FollowupSourceState): string {
  const log = state.log!;
  if (log.failure_code) return `Log observation unavailable · ${log.failure_code}`;
  if (log.ended) return state.observed?.evidence.kind === 'log_end' ? 'Stream ended'
    : state.observed ? 'Stream ended; no further matches' : 'Stream ended without a literal match';
  return `Observed through byte ${log.offset}`;
}
function metricStateLabel(state: FollowupSourceState, source: Extract<FollowupSource, { kind: 'metric' }>): string {
  const metric = state.metric!;
  const status = metric.status === 'available'
    ? `${metric.value === null ? 'Value unknown' : metricValue(source.metric, metric.value)} · ${metric.holding === true ? 'condition satisfied' : metric.holding === false ? 'condition not satisfied' : 'awaiting condition observation'}`
    : `Unknown (${metric.status})${metric.holding === true ? ' · previous satisfied condition retained; waiting for a known false observation before another crossing' : ''}`;
  return [status, metric.failure_code,
    metric.sample_revision === null ? null : `sample revision ${metric.sample_revision}`,
    metric.observed_at_ms === null ? null : `sampled ${atLabel(metric.observed_at_ms)}`,
    metric.gap ? 'observation gap; unavailable crossings are not reconstructed' : null,
  ].filter(Boolean).join(' · ');
}
function metricRecoveryHint(code: string | null): string {
  switch (code) {
    case 'sample_pending': return 'Waiting for the first sample.';
    case 'machine_sampling_unsupported': return 'This machine does not support metric sampling. Choose a local machine; remote sampling is not supported yet.';
    case 'machine_missing': return 'The original machine is missing. Refresh the machine directory and register from the intended machine.';
    case 'source_identity_changed': return 'The machine identity changed. Register a new follow-up for the intended machine.';
    case 'gpu_tool_missing': return 'The GPU probe is unavailable. Check nvidia-smi on the original machine, then retry observation.';
    case 'gpu_missing': case 'gpu_no_device': return 'The selected GPU is missing. Check its connection and UUID; register a new condition to select another device.';
    case 'gpu_error': case 'gpu_unavailable': return 'The GPU could not be sampled. Check the original machine GPU probe, then retry observation.';
    case 'dimension_missing': case 'sample_missing': return 'The selected metric has no value yet. Waiting for a usable sample; missing values are never zero.';
    case 'sample_stale': return 'Waiting for a fresh sample. Check the original machine connection.';
    default: return 'Check the original machine connection and metric availability, then retry observation. Missing or stale samples are unknown, never zero.';
  }
}
function isPastFollowup(item: Followup): boolean {
  return item.state === 'cancelled' || (item.exhausted && item.pending_occurrences === 0
    && !item.observation?.delivery_pending) || (item.repeat === 'once'
    && (item.occurrence?.delivery?.state === 'delivered' || item.occurrence?.state === 'cancelled'));
}
type MetricDraft = { machineId: string; metric: MetricKind; gpuUuid: string; predicate: 'above' | 'below'; threshold: string };
const emptyMetric = (): MetricDraft => ({ machineId: '', metric: 'cpu_percent', gpuUuid: '', predicate: 'above', threshold: '' });
type SourceDraft = MetricDraft & { kind: FollowupRegistrationSource['kind']; at: string; processId: string; jobId: string; path: string; condition: 'exists' | 'changed' | 'ready'; artifactSelector: 'any' | 'artifactId' | 'name'; artifactValue: string; stream: 'stdout' | 'stderr'; literal: string; fromOffset: string };
const emptySource = (): SourceDraft => ({ ...emptyMetric(), kind: 'at', at: '', processId: '', jobId: '', path: '', condition: 'exists', artifactSelector: 'any', artifactValue: '', stream: 'stdout', literal: '', fromOffset: '' });
// The original Job owner declares supported observations; the renderer owns no domain/version table.
const supportsJobSource = (job: HostJobSource, kind: string) => job.observationKinds.some(value => value === kind);
const usesJobs = (kind: FollowupRegisterParams['trigger']['kind']) => kind === 'job_stopped' || kind === 'artifact' || kind === 'collection' || kind === 'log_literal' || kind === 'log_end';
function sourceInput(draft: SourceDraft, processes: Operation[], jobs: HostJobSource[], machines: ResourceMachineView[]): FollowupRegistrationSource | null {
  if (draft.kind === 'metric') {
    const machine = machines.find(value => value.machineId === draft.machineId);
    const threshold = draft.threshold.trim() ? Number(draft.threshold) : NaN;
    if (!machine || !Number.isFinite(threshold) || (gpuMetric(draft.metric) && !machineGpus(machine).some(gpu => gpu.uuid === draft.gpuUuid))) return null;
    return { kind: 'metric', machineId: draft.machineId, metric: draft.metric, predicate: draft.predicate, threshold,
      ...(gpuMetric(draft.metric) ? { gpuUuid: draft.gpuUuid } : {}) };
  }
  if (draft.kind === 'log_literal' || draft.kind === 'log_end') {
    if (!jobs.some(job => supportsJobSource(job, draft.kind) && job.binding.operationId === draft.jobId)) return null;
    if (draft.kind === 'log_end') return { kind: 'log_end', operationId: draft.jobId, stream: draft.stream };
    const fromOffset = draft.fromOffset === '' ? 0 : Number(draft.fromOffset);
    if (!draft.literal.length || !/^\d*$/.test(draft.fromOffset) || !Number.isSafeInteger(fromOffset)) return null;
    return { kind: 'log_literal', operationId: draft.jobId, stream: draft.stream, literal: draft.literal,
      ...(draft.fromOffset === '' ? {} : { fromOffset }) };
  }
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
function SourceEditor({ value, onChange, processes, jobs, machines, disabled, repeating, label = 'Follow-up' }: {
  value: SourceDraft; onChange(value: SourceDraft): void; processes: Operation[]; jobs: HostJobSource[]; machines: ResourceMachineView[]; disabled: boolean; repeating: boolean; label?: string;
}) {
  if (value.kind === 'metric') {
    const machine = machines.find(machine => machine.machineId === value.machineId);
    const gpus = machineGpus(machine);
    return <>
      <label className="block">Machine<select aria-label={`${label} machine`} value={value.machineId} disabled={disabled}
        onChange={event => onChange({ ...value, machineId: event.target.value, gpuUuid: '' })}>
        <option value="">Select an original machine</option>{machines.map(machine => <option key={machine.machineId} value={machine.machineId}>
          {machine.label ?? machine.machineId} · {machine.machineId} · {machine.kind} · {machine.connection.status}
        </option>)}
      </select></label>
      <label className="block">Metric<select aria-label={`${label} metric`} value={value.metric} disabled={disabled}
        onChange={event => onChange({ ...value, metric: event.target.value as MetricKind, gpuUuid: '' })}>
        {Object.entries(metricNames).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}
      </select></label>
      {gpuMetric(value.metric) && <>
        <label className="block">GPU<select aria-label={`${label} GPU`} value={value.gpuUuid} disabled={disabled || !gpus.length}
          onChange={event => onChange({ ...value, gpuUuid: event.target.value })}>
          <option value="">Select a GPU by UUID</option>{gpus.map(gpu => <option key={gpu.uuid} value={gpu.uuid}>GPU {gpu.index}{gpu.name ? ` · ${gpu.name}` : ''} · {gpu.uuid}</option>)}
        </select></label>
        {machine && !gpus.length && <p role="alert">No stable GPU UUID is available for this machine. Refresh machines after its GPU inventory is available, or choose another metric.</p>}
      </>}
      <label className="block">Condition<select aria-label={`${label} metric predicate`} value={value.predicate} disabled={disabled}
        onChange={event => onChange({ ...value, predicate: event.target.value as MetricDraft['predicate'] })}>
        <option value="above">Strictly above</option><option value="below">Strictly below</option>
      </select></label>
      <label className="block">Threshold ({value.metric === 'memory_mb' || value.metric === 'gpu_memory_mb' ? 'MiB' : '%'})<Input aria-label={`${label} metric threshold`} value={value.threshold} disabled={disabled}
        onChange={event => onChange({ ...value, threshold: event.target.value })} inputMode="decimal" /></label>
      {value.threshold !== '' && (!value.threshold.trim() || !Number.isFinite(Number(value.threshold))) && <p role="alert">Enter a finite numeric threshold.</p>}
      <p className="text-xs text-muted-foreground">{repeating ? 'An initially satisfied condition triggers once, then each known false-to-true crossing triggers again. Unknown samples do not rearm it.' : 'Runs once when a fresh known sample satisfies the condition, including the initial observation.'} Equality does not satisfy a strict threshold.</p>
      <p className="text-xs text-muted-foreground">Background sampling continues without this panel. Offline or paused crossings may be missed; recovery checks the current sample. Remote metric sampling is not supported yet.</p>
    </>;
  }
  if (usesJobs(value.kind)) {
    const research = value.kind === 'artifact' || value.kind === 'collection';
    const candidates = jobs.filter(job => supportsJobSource(job, value.kind));
    return <><label className="block">Accepted {research ? 'research ' : ''}job<select aria-label={`${label} job`} value={value.jobId} disabled={disabled}
      onChange={event => onChange({ ...value, jobId: event.target.value })} className="ml-2 rounded border bg-background p-1">
      <option value="">Select an accepted {research ? 'research ' : ''}job in this task family</option>{candidates.map(job => <option key={job.binding.operationId} value={job.binding.operationId}>
        {job.binding.domain} · {job.binding.workspaceId} · {job.binding.subjectId} · {job.executorStopped ? 'executor stopped' : 'awaiting executor stop'} · {job.threadId}
      </option>)}</select></label>
      {(value.kind === 'log_literal' || value.kind === 'log_end') && <>
        <label className="block">Log stream<select aria-label={`${label} log stream`} value={value.stream} disabled={disabled}
          onChange={event => onChange({ ...value, stream: event.target.value as SourceDraft['stream'] })}>
          <option value="stdout">stdout</option><option value="stderr">stderr</option>
        </select></label>
        {value.kind === 'log_literal' ? <>
          <label className="block">Exact literal<Textarea aria-label={`${label} log literal`} value={value.literal} disabled={disabled}
            onChange={event => onChange({ ...value, literal: event.target.value })} rows={2} /></label>
          <label className="block">Start byte offset<Input aria-label={`${label} log offset`} value={value.fromOffset} disabled={disabled}
            onChange={event => onChange({ ...value, fromOffset: event.target.value })} inputMode="numeric" placeholder="0" /></label>
          {value.fromOffset !== '' && (!/^\d+$/.test(value.fromOffset) || !Number.isSafeInteger(Number(value.fromOffset))) && <p role="alert">Enter a non-negative whole byte offset.</p>}
          <p className="text-xs text-muted-foreground">Case-sensitive UTF-8 bytes, including spaces and line breaks. {repeating ? 'Runs for every match, including overlaps.' : 'Runs for the first match.'} Starts at byte 0 by default, including published history. An offset beyond the current end waits for future output.</p>
        </> : <p className="text-xs text-muted-foreground">Runs once when this stream ends, even if it is empty. Artifact collection may finish later.</p>}
      </>}
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
  const [retry, setRetry] = React.useState(0);
  const hasLiteral = item.trigger.kind === 'log_literal' || ((item.trigger.kind === 'any' || item.trigger.kind === 'all')
    && item.trigger.sources.some(source => source.kind === 'log_literal'));
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setView(undefined); setError(false);
    void api.get(identity, item.id, controller.signal).then(value => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      if (value.followup.id !== item.id || value.followup.thread_id !== identity.threadId || value.followup.branch_id !== identity.branchId
        || value.followup.generation !== item.generation) { setError(true); return; }
      setView(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(true); });
    return () => controller.abort();
  }, [api, identity, item.id, item.generation, open, retry]);
  if (!item.has_instruction && !hasLiteral) return null;
  const label = hasLiteral ? 'follow-up instruction and literal' : 'follow-up instruction';
  const trigger = view?.registration_trigger;
  const originalSources = trigger ? ('sources' in trigger ? trigger.sources : [trigger]) : [];
  return <div>
    <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? `Hide ${label}` : `Read ${label}`}</Button>
    {open && (error ? <p role="alert">The original follow-up could not be read. <Button variant="ghost" size="sm" onClick={() => setRetry(value => value + 1)}>Retry original follow-up details</Button></p> : view
      ? <div aria-label="Original follow-up details">
        {item.has_instruction && <pre className="whitespace-pre-wrap break-words text-sm">{view.instruction ?? 'No instruction stored'}</pre>}
        {hasLiteral && (originalSources.some(source => source.kind === 'log_literal') ? originalSources.map((source, index) => source.kind === 'log_literal' && <div key={index}>
          <p className="text-xs text-muted-foreground">Condition {index + 1} · {source.stream} · from byte {source.fromOffset ?? 0} · exact literal</p>
          <pre className="whitespace-pre-wrap break-words text-sm" aria-label={`Condition ${index + 1} original literal`}>{source.literal}</pre>
        </div>) : <p role="alert">The original log literal is unavailable.</p>)}
      </div> : <p>Reading original follow-up…</p>)}
  </div>;
}

function evidenceLabel(evidence: FollowupLeafEvidence): string {
  if (evidence.kind === 'metric') {
    const fact = evidence.fact;
    return [fact.identity.machine_id, fact.gpu_uuid,
      `${metricNames[fact.metric]} ${metricValue(fact.metric, fact.value)}`,
      `${fact.predicate} ${metricValue(fact.metric, fact.threshold)}`,
      `sample revision ${fact.sample_revision}`, `machine revision ${fact.machine_revision}`, `sampled ${atLabel(fact.observed_at_ms)}`,
      `Host ${fact.identity.host_id}`, fact.identity.kind,
      fact.identity.backend ? `backend ${fact.identity.backend}` : null,
      fact.identity.target_host_id ? `target Host ${fact.identity.target_host_id}` : null,
      fact.gap ? 'observation gap; unavailable crossings are not reconstructed' : null,
    ].filter(Boolean).join(' · ');
  }
  if (evidence.kind === 'log_literal') return `${evidence.binding.subjectId} · ${evidence.stream} literal match · bytes ${evidence.start_offset}–${evidence.end_offset} (end exclusive) · ${evidence.published_bytes} published bytes · job revision ${evidence.job_revision}`;
  if (evidence.kind === 'log_end') return `${evidence.binding.subjectId} · ${evidence.stream} ended · ${evidence.published_bytes} published bytes · attempt revision ${evidence.attempt_revision}${evidence.job_revision === null ? '' : ` · job revision ${evidence.job_revision}`}`;
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
function OccurrenceView({ occurrence, family, mediaRead, identity, api, followupId }: { api: ThreadFollowupsAPI; followupId: string; occurrence: FollowupOccurrence; family?: ThreadFamilyAPI; mediaRead: ThreadsAPI['mediaRead']; identity: ThreadIdentity }) {
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
      {readingRun && <ThreadRunHistory api={family} mediaRead={mediaRead} identity={identity} runId={delivery.run_id} />}
    </>}
  </div>;
}
function FollowupOccurrences({ api, family, mediaRead, identity, item }: { api: ThreadFollowupsAPI; family?: ThreadFamilyAPI; mediaRead: ThreadsAPI['mediaRead']; identity: ThreadIdentity; item: Followup }) {
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
        {page.occurrences.map(occurrence => <div key={occurrence.id} className="rounded border p-2"><OccurrenceView occurrence={occurrence} identity={identity} family={family} mediaRead={mediaRead} api={api} followupId={item.id} /></div>)}
        {page.nextCursor !== null && <Button size="sm" variant="outline" disabled={loading} onClick={() => setRequest(value => ({ after: page.nextCursor!, previous: [...value.previous, value.after], revision: value.revision + 1 }))}>Next occurrence page</Button>}
      </>}
      {request.previous.length > 0 && <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRequest(value => ({ after: value.previous.at(-1), previous: value.previous.slice(0, -1), revision: value.revision + 1 }))}>Previous occurrence page</Button>}
      <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRequest(value => ({ ...value, revision: value.revision + 1 }))}>{error ? 'Retry occurrence page' : 'Refresh occurrence page'}</Button>
    </div>}
  </div>;
}

/** Original definitions and delivery facts; no client timer or execution queue. */
export function ThreadFollowups({ api, family, mediaRead, research, identity, run, operations, followups, pending, act, cancelObservation }: {
  api: ThreadFollowupsAPI; family?: ThreadFamilyAPI; mediaRead: ThreadsAPI['mediaRead']; research?: ThreadResearchAPI; identity: ThreadIdentity; run?: Run; operations: Operation[]; followups: Followup[];
  pending: boolean; act(work: () => Promise<unknown>): Promise<void>; cancelObservation(operationId: string): Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [showPast, setShowPast] = React.useState(false);
  const [kind, setKind] = React.useState<FollowupRegisterParams['trigger']['kind']>('at');
  const [repeat, setRepeat] = React.useState<'once' | 'each'>('once');
  const [at, setAt] = React.useState(''); const [processId, setProcessId] = React.useState(''); const [jobId, setJobId] = React.useState('');
  const [artifactSelector, setArtifactSelector] = React.useState<SourceDraft['artifactSelector']>('any');
  const [artifactValue, setArtifactValue] = React.useState('');
  const [stream, setStream] = React.useState<SourceDraft['stream']>('stdout');
  const [literal, setLiteral] = React.useState(''); const [fromOffset, setFromOffset] = React.useState('');
  const [metric, setMetric] = React.useState<MetricDraft>(emptyMetric);
  const [filePath, setFilePath] = React.useState(''); const [fileCondition, setFileCondition] = React.useState<SourceDraft['condition']>('exists');
  const [conditions, setConditions] = React.useState<SourceDraft[]>([emptySource(), { ...emptySource(), kind: 'process_stopped' }]);
  const [instruction, setInstruction] = React.useState(''); const [uncertain, setUncertain] = React.useState(false);
  const [registrations, setRegistrations] = React.useState<FollowupPendingRegistration[]>([]);
  const [registrationError, setRegistrationError] = React.useState(false);
  const [jobCandidates, setJobCandidates] = React.useState<{ runId: string; values: HostJobSource[] }>();
  const [jobError, setJobError] = React.useState(false); const [jobRetry, setJobRetry] = React.useState(0);
  const [machineCandidates, setMachineCandidates] = React.useState<{ runId: string; values: ResourceMachineView[] }>();
  const [machineError, setMachineError] = React.useState(false); const [machineRetry, setMachineRetry] = React.useState(0);
  const runId = run?.id;
  const needsJobs = usesJobs(kind) || ((kind === 'any' || kind === 'all') && conditions.some(value => usesJobs(value.kind)));
  const needsMachines = kind === 'metric' || ((kind === 'any' || kind === 'all') && conditions.some(value => value.kind === 'metric'));
  React.useEffect(() => {
    if (!editing || !needsMachines || !runId || !research || uncertain) return;
    const controller = new AbortController(); const selectedHost = getRuntimeEndpointGeneration();
    setMachineError(false); setMachineCandidates(undefined);
    void research.resources({ ...identity, sourceRunId: runId }, controller.signal).then(result => {
      if (!controller.signal.aborted && selectedHost === getRuntimeEndpointGeneration()) setMachineCandidates({ runId, values: result.machines });
    }, () => { if (!controller.signal.aborted && selectedHost === getRuntimeEndpointGeneration()) setMachineError(true); });
    return () => controller.abort();
  }, [research, identity, runId, editing, needsMachines, machineRetry, uncertain]);
  const machines = machineCandidates && (machineCandidates.runId === runId || uncertain) ? machineCandidates.values : [];
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
  const selected = composite ? conditions.map(value => sourceInput(value, processes, jobs, machines)) : [sourceInput({ ...metric, kind, at, processId, jobId, path: filePath, condition: fileCondition, artifactSelector, artifactValue, stream, literal, fromOffset }, processes, jobs, machines)];
  const repeatable = (value: FollowupRegistrationSource | null) => value?.kind === 'metric' || value?.kind === 'log_literal' || value?.kind === 'artifact' || value?.kind === 'collection' || (value?.kind === 'file' && value.condition === 'changed');
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
        if (current()) { intent.current = null; setUncertain(false); setInstruction(''); setAt(''); setRepeat('once'); setFilePath(''); setArtifactSelector('any'); setArtifactValue(''); setStream('stdout'); setLiteral(''); setFromOffset(''); setMetric(emptyMetric()); setConditions([emptySource(), { ...emptySource(), kind: 'process_stopped' }]); setEditing(false); }
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
      {repeat === 'each' && <p>Repeats for accepted observations until cancelled or the conditions end. Changes while observation is unavailable may be missed.</p>}
      <label className="block">Trigger<select aria-label="Follow-up trigger" value={kind} disabled={pending || uncertain}
        onChange={event => setKind(event.target.value as typeof kind)} className="ml-2 rounded border bg-background p-1">
        <option value="at">At a specific time</option><option value="process_stopped">After a process stops</option><option value="job_stopped">After an accepted job stops</option><option value="artifact">When an original research artifact is observed</option><option value="collection">After original research collection finishes</option><option value="log_literal">When a log literal matches</option><option value="log_end">When a log stream ends</option><option value="file">When a file condition is met</option>
        <option value="metric">When a machine metric crosses a threshold</option>
        <option value="any">Any condition</option><option value="all">Every condition</option>
      </select></label>
      {composite ? <div className="space-y-2">
        <p>{repeat === 'once' ? 'Runs once when the selected conditions are met.'
          : kind === 'any' ? 'Runs for each observed change. Time, stop and log-end conditions trigger once.'
          : 'Runs after every condition has a new observation.'}</p>
        {conditions.map((value, index) => <fieldset key={index} className="space-y-1 rounded border p-2">
          <legend>Condition {index + 1}</legend>
          <select aria-label={`Condition ${index + 1} kind`} value={value.kind} disabled={pending || uncertain}
            onChange={event => setConditions(values => values.map((item, i) => i === index ? { ...item, kind: event.target.value as SourceDraft['kind'] } : item))}>
            <option value="at">At a specific time</option><option value="process_stopped">After a process stops</option><option value="job_stopped">After an accepted job stops</option><option value="artifact">When an original research artifact is observed</option><option value="collection">After original research collection finishes</option><option value="log_literal">When a log literal matches</option><option value="log_end">When a log stream ends</option><option value="file">When a file condition is met</option>
            <option value="metric">When a machine metric crosses a threshold</option>
          </select>
          <SourceEditor value={value} onChange={next => setConditions(values => values.map((item, i) => i === index ? next : item))}
            processes={processes} jobs={jobs} machines={machines} disabled={pending || uncertain} repeating={repeat === 'each'} label={`Condition ${index + 1}`} />
          <Button variant="ghost" size="sm" disabled={pending || uncertain || conditions.length === 1}
            onClick={() => setConditions(values => values.filter((_, i) => i !== index))}>Remove condition {index + 1}</Button>
        </fieldset>)}
        <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setConditions(values => [...values, emptySource()])}>Add condition</Button>
      </div> : <SourceEditor value={{ ...metric, kind, at, processId, jobId, path: filePath, condition: fileCondition, artifactSelector, artifactValue, stream, literal, fromOffset }} onChange={value => { setAt(value.at); setProcessId(value.processId); setJobId(value.jobId); setFilePath(value.path); setFileCondition(value.condition); setArtifactSelector(value.artifactSelector); setArtifactValue(value.artifactValue); setStream(value.stream); setLiteral(value.literal); setFromOffset(value.fromOffset); setMetric({ machineId: value.machineId, metric: value.metric, gpuUuid: value.gpuUuid, predicate: value.predicate, threshold: value.threshold }); }} processes={processes} jobs={jobs} machines={machines} disabled={pending || uncertain} repeating={repeat === 'each'} />}
      {!repeatValid && <p role="alert">{kind === 'any' ? 'Repeated Any requires at least one metric, file-change, artifact, collection or log-literal condition.' : kind === 'all' ? 'Repeated All requires every condition to be a metric, file-change, artifact, collection or log-literal condition.' : 'Repetition requires a metric, file-change, artifact, collection or log-literal condition.'}</p>}
      {needsJobs && !jobCandidates && !jobError && <p role="status">Reading accepted jobs…</p>}
      {needsJobs && jobError && <p role="alert">Accepted jobs could not be read. <Button variant="ghost" size="sm" disabled={pending || uncertain} onClick={() => setJobRetry(value => value + 1)}>Retry accepted jobs</Button></p>}
      {needsMachines && !research && <p role="alert">The machine directory is unavailable on this Host. Connect to a Host with research resources to choose a machine.</p>}
      {needsMachines && research && !uncertain && <>
        {!machineCandidates && !machineError && <p role="status">Reading original machines…</p>}
        {machineError && <p role="alert">Original machines could not be read. Check the Host connection and retry.</p>}
        {machineCandidates?.runId === runId && !machines.length && <p>No machines are listed by this Host.</p>}
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setMachineRetry(value => value + 1)}>{machineError ? 'Retry machines' : 'Refresh machines'}</Button>
      </>}
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
      const logFailed = item.sources.some(source => source.log?.failure_code);
      const metricFailed = item.sources.some(source => source.metric?.failure_code && source.metric.failure_code !== 'sample_pending');
      const originalSources = item.trigger.kind === 'any' || item.trigger.kind === 'all' ? item.trigger.sources : [item.trigger];
      return <div key={item.id} className="space-y-1 rounded border p-3" aria-label={ended ? 'Past follow-up' : 'Pending follow-up'}>
        <p>{triggerLabel(item)}</p>
        <p>{item.repeat === 'each' ? item.state === 'cancelled' ? 'Repeating authorization cancelled' : item.state === 'paused' ? 'Repeating authorization paused' : item.exhausted ? 'Log observation ended' : 'Continuing to observe changes' : 'One-time instruction'} · {item.pending_occurrences} undelivered {item.pending_occurrences === 1 ? 'occurrence' : 'occurrences'}</p>
        {item.occurrence ? <div aria-label="Latest follow-up occurrence"><p className="text-xs text-muted-foreground">Latest occurrence</p><OccurrenceView key={item.occurrence.id} occurrence={item.occurrence} identity={identity} family={family} mediaRead={mediaRead} api={api} followupId={item.id} /></div> : <p>{item.exhausted ? 'Log ended without satisfying the condition' : 'Waiting for the original trigger'}</p>}
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Condition details</summary>
        {(item.trigger.kind === 'any' || item.trigger.kind === 'all') && <ul className="space-y-1 text-xs text-muted-foreground">
          {item.trigger.sources.map((source, index) => {
            const state = item.sources.find(state => state.source_index === index);
            const observed = state?.observed;
            return <li key={index}>Condition {index + 1}: {sourceLabel(source)} · {state?.metric && source.kind === 'metric' ? metricStateLabel(state, source) : state?.log ? logStateLabel(state) : observed ? `observed at event ${observed.trigger_cursor} · accepted ${observed.accepted_cursor} · consumed through ${state!.consumed_cursor}` : 'waiting'}</li>;
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
        {item.sources.filter(source => source.log !== null).map(source => <p key={source.source_index} className="text-xs text-muted-foreground" aria-label={`Log condition ${source.source_index + 1}`}>
          Log condition {source.source_index + 1}: {logStateLabel(source)}
        </p>)}
        {item.sources.map(state => {
          const source = originalSources[state.source_index];
          if (!state.metric || source?.kind !== 'metric') return null;
          return <div key={state.source_index} className="text-xs text-muted-foreground" aria-label={`Metric condition ${state.source_index + 1}`}>
            <p>Metric condition {state.source_index + 1}: {metricStateLabel(state, source)}</p>
            {state.metric.status !== 'available' && <p>{metricRecoveryHint(state.metric.failure_code)}</p>}
          </div>;
        })}
        <FollowupInstruction api={api} identity={identity} item={item} />
        <FollowupOccurrences api={api} family={family} mediaRead={mediaRead} identity={identity} item={item} />
        {!ended && <>
          {item.repeat === 'each' && <p className="text-xs text-muted-foreground">Cancel stops future and pending deliveries. Existing results and observed work remain available.</p>}
          {item.state === 'active' && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'pause')}>Pause follow-up</Button>}
          {item.state === 'paused' ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>Resume follow-up</Button>
            : (metricFailed || logFailed || item.repeat === 'each' || item.occurrence?.hold_reason === 'preparation_failed') && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'resume')}>{metricFailed ? 'Retry metric observation' : logFailed ? 'Retry log observation' : item.repeat === 'each' ? 'Retry undelivered occurrences' : 'Resume follow-up'}</Button>}
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void control(item, 'cancel')}>Cancel follow-up</Button>
        </>}
        {item.observation && <div className="text-xs text-muted-foreground">Original Agent observation · {item.observation.state === 'exhausted' ? 'ended without triggering' : item.observation.state} · {item.observation.delivered ? 'result delivered' : item.observation.delivery_pending ? 'result awaiting delivery' : 'no result pending delivery'}{item.repeat === 'each' && ' · observes only the first occurrence; ending this observation does not withdraw repeating authorization'}
          {item.observation.state === 'waiting' && item.observation.delivery_pending && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void cancelObservation(item.observation!.operation_id)}>End follow-up observation</Button>}
        </div>}
      </div>;
    })}
  </section>;
}
