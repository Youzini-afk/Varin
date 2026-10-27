import React from 'react';
import { createScheduledTasksHttpAPI, getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ScheduledTask, ThreadModelInfo, ThreadSourceTargets } from '@varin/application-client';
import type { CalendarSource, SourceResourceOwner } from '@varin/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const schedules = createScheduledTasksHttpAPI();
const sourceOwnerKey = (owner: SourceResourceOwner) => owner.kind === 'local'
  ? 'local' : JSON.stringify([owner.connectionId, owner.endpointIdentity, owner.hostId]);
const changedHostMessage = 'Application Host changed. Close this editor and reopen it from the current project.';

/** Edits external definitions only. Preview/admission and every occurrence stay with the Host. */
export function CalendarTaskEditorDialog({ open, projectId, task, onOpenChange, onSave }: {
  open: boolean; projectId: string; task: ScheduledTask | null; onOpenChange(open: boolean): void; onSave(task: Partial<ScheduledTask>): Promise<void>;
}) {
  const { threads } = useRuntimeAPIs();
  const [name, setName] = React.useState(''), [instruction, setInstruction] = React.useState('');
  const [kind, setKind] = React.useState<ScheduledTask['schedule']['kind']>('daily');
  const [timezone, setTimezone] = React.useState('UTC'), [times, setTimes] = React.useState('09:00');
  const [date, setDate] = React.useState(''), [weekdays, setWeekdays] = React.useState('1'), [cron, setCron] = React.useState('0 9 * * *');
  const [enabled, setEnabled] = React.useState(false), [missed, setMissed] = React.useState<'skip' | 'coalesce_once'>('skip');
  const [target, setTarget] = React.useState<'new_work' | 'existing_work'>('new_work');
  const [threadId, setThreadId] = React.useState(''), [branchId, setBranchId] = React.useState('');
  const [sourceMode, setSourceMode] = React.useState<'fixed_branch' | 'materialized' | 'live_root'>('materialized');
  const [sourceKind, setSourceKind] = React.useState<CalendarSource['kind']>('project');
  // Only a persisted or resolved identity can be saved. Folder text is never a workspace ID.
  const [source, setSource] = React.useState<CalendarSource | null>({ kind: 'project' });
  const [resourceOwner, setResourceOwner] = React.useState<SourceResourceOwner | null>(null);
  const [path, setPath] = React.useState('');
  const [sourceTargets, setSourceTargets] = React.useState<ThreadSourceTargets>({ targets: [], unavailable: [] });
  const [directoryError, setDirectoryError] = React.useState(''), [sourceError, setSourceError] = React.useState('');
  const [loadingSources, setLoadingSources] = React.useState(false), [resolving, setResolving] = React.useState(false);
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]), [model, setModel] = React.useState(''), [thinking, setThinking] = React.useState('off');
  const [goal, setGoal] = React.useState(false), [budget, setBudget] = React.useState('');
  const [error, setError] = React.useState(''), [saving, setSaving] = React.useState(false);
  const creationKey = React.useRef<string | undefined>(undefined);
  const editorHostGeneration = React.useRef<number | null>(null);
  const editorGeneration = React.useRef(0);
  const resolutionGeneration = React.useRef(0);
  const resolveController = React.useRef<AbortController | null>(null);
  const retireResolution = React.useCallback(() => {
    resolutionGeneration.current += 1;
    resolveController.current?.abort();
    resolveController.current = null;
  }, []);
  const invalidateSource = () => {
    retireResolution(); setResolving(false); setSource(null); setSourceError('');
  };
  // Bind the whole editing session, not just each request, to its original Host.
  // A new RuntimeAPIs object must not requalify an old local workspace on another Host.
  React.useEffect(() => {
    editorHostGeneration.current = open ? getRuntimeEndpointGeneration() : null;
    return () => { editorHostGeneration.current = null; };
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const generation = ++editorGeneration.current;
    const host = editorHostGeneration.current;
    if (host === null || host !== getRuntimeEndpointGeneration()) {
      retireResolution(); setResolving(false); setSaving(false); setLoadingSources(false); setSourceTargets({ targets: [], unavailable: [] });
      setSource(null); setModels([]); setError(changedHostMessage);
      return;
    }
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && editorGeneration.current === generation && host === getRuntimeEndpointGeneration();
    retireResolution(); setResolving(false); setSourceError('');
    setSourceTargets({ targets: [], unavailable: [] }); setDirectoryError(''); setLoadingSources(true);
    creationKey.current = task?.id ?? `task:${crypto.randomUUID()}`;
    setName(task?.name ?? ''); setInstruction(task?.execution.prompt ?? ''); setKind(task?.schedule.kind ?? 'daily');
    setTimezone(task?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    setTimes(task?.schedule.times?.join(', ') ?? task?.schedule.time ?? '09:00'); setDate(task?.schedule.date ?? '');
    setWeekdays(task?.schedule.weekdays?.join(', ') ?? '1'); setCron(task?.schedule.cron ?? '0 9 * * *');
    setEnabled(task?.enabled ?? false); setMissed(task?.missedPolicy ?? (task?.schedule.kind === 'once' ? 'coalesce_once' : 'skip'));
    setTarget(task?.target?.kind ?? 'new_work'); setError(''); setSaving(false);
    const selection = task?.target;
    const selectedSource: CalendarSource = selection?.kind === 'new_work' ? selection.source : { kind: 'project' };
    setSourceKind(selectedSource.kind); setSource(selectedSource);
    setResourceOwner(selectedSource.kind === 'workspace' ? selectedSource.resourceOwner : null); setPath('');
    if (selection?.kind === 'new_work') {
      setModel(JSON.stringify([selection.model.providerId, selection.model.modelId])); setThinking(selection.model.thinkingLevel ?? 'off');
      setSourceMode(selection.sourceMode === 'native_workspace' ? 'live_root' : selection.sourceMode); setGoal(selection.goal !== null); setBudget(selection.goal?.budget ? String(selection.goal.budget.maxOutputTokens) : '');
    } else { setModel(''); setThinking('off'); setSourceMode('materialized'); setGoal(false); setBudget(''); }
    setThreadId(selection?.kind === 'existing_work' ? selection.threadId : ''); setBranchId(selection?.kind === 'existing_work' ? selection.branchId : '');
    setModels([]);
    void threads?.listModels().then(value => { if (isCurrent()) setModels(value); }, value => { if (isCurrent()) setError(value instanceof Error ? value.message : 'Model catalog unavailable'); });
    void schedules.listSources(projectId, controller.signal).then(value => {
      if (isCurrent()) setSourceTargets(value);
    }, value => {
      if (isCurrent()) setDirectoryError(value instanceof Error ? value.message : 'Source Hosts could not be loaded');
    }).finally(() => { if (isCurrent()) setLoadingSources(false); });
    return () => { controller.abort(); editorGeneration.current += 1; retireResolution(); };
  }, [open, projectId, task, threads, retireResolution]);
  const selectedHost = resourceOwner ? sourceTargets.targets.find(value => sourceOwnerKey(value.resourceOwner) === sourceOwnerKey(resourceOwner)) : undefined;
  const resolveSource = async () => {
    if (saving || resolving || !resourceOwner || !selectedHost || !path.trim()) return;
    const host = editorHostGeneration.current;
    if (host === null || host !== getRuntimeEndpointGeneration()) { invalidateSource(); setError(changedHostMessage); return; }
    invalidateSource();
    const controller = new AbortController();
    resolveController.current = controller;
    const generation = resolutionGeneration.current;
    const isCurrent = () => !controller.signal.aborted && resolutionGeneration.current === generation && host === getRuntimeEndpointGeneration();
    setResolving(true);
    try {
      const resolved = await schedules.resolveSource(projectId, { resourceOwner, path }, controller.signal);
      if (!isCurrent()) return;
      if (!resolved.workspaceId.trim() || sourceOwnerKey(resolved.resourceOwner) !== sourceOwnerKey(resourceOwner)) {
        throw new Error('The selected Host did not return the requested workspace identity');
      }
      setSource({ kind: 'workspace', resourceOwner: resolved.resourceOwner, workspaceId: resolved.workspaceId });
      setPath(resolved.path);
    } catch (value) {
      if (isCurrent()) setSourceError(value instanceof Error ? value.message : 'Workspace could not be resolved');
    } finally {
      if (isCurrent()) { resolveController.current = null; setResolving(false); }
    }
  };
  const save = async () => {
    if (saving) return;
    const host = editorHostGeneration.current;
    if (host === null || host !== getRuntimeEndpointGeneration()) { invalidateSource(); setError(changedHostMessage); return; }
    const generation = editorGeneration.current;
    const isCurrent = () => generation === editorGeneration.current && host === getRuntimeEndpointGeneration();
    setSaving(true); setError('');
    try {
      const selected = models.find(value => JSON.stringify([value.providerId, value.modelId]) === model);
      if (target === 'new_work' && !selected) throw new Error('Select an available registered model');
      if (target === 'new_work' && (!source || resolving)) throw new Error('Resolve the selected workspace before saving');
      if (!name.trim() || !instruction.trim()) throw new Error('Name and instruction are required');
      const maxOutputTokens = budget.trim() ? Number(budget) : null;
      if (goal && maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0)) throw new Error('Goal budget must be a non-negative output-token count');
      await onSave({ id: creationKey.current!, name, enabled, runtime: 'agent', execution: { prompt: instruction }, missedPolicy: missed,
        schedule: { kind, timezone, ...(kind === 'once' ? { date, time: times.trim() } : kind === 'cron' ? { cron } : { times: times.split(',').map(value => value.trim()), ...(kind === 'weekly' ? { weekdays: weekdays.split(',').map(value => Number(value.trim())) } : {}) }) },
        target: target === 'existing_work' ? { kind: 'existing_work', threadId, branchId } : { kind: 'new_work', source: source!, sourceMode,
          model: { providerId: selected!.providerId, modelId: selected!.modelId, thinkingLevel: thinking, ...(task?.target?.kind === 'new_work' && task.target.model.providerId === selected!.providerId && task.target.model.modelId === selected!.modelId && task.target.model.temperature !== undefined ? { temperature: task.target.model.temperature } : {}) },
          goal: goal ? { budget: maxOutputTokens === null ? null : { maxOutputTokens } } : null } });
      if (isCurrent()) onOpenChange(false);
    } catch (value) { if (isCurrent()) setError(value instanceof Error ? value.message : 'Calendar definition could not be saved'); }
    finally { if (isCurrent()) setSaving(false); }
  };
  const field = (label: string, value: string, change: (value: string) => void, type = 'text') => <label className="grid gap-1 text-sm">{label}<Input type={type} value={value} onChange={event => change(event.target.value)} /></label>;
  return <Dialog open={open} onOpenChange={value => { if (!saving) { if (!value) retireResolution(); onOpenChange(value); } }}><DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
    <DialogTitle>{task ? 'Edit Agent calendar' : 'Create Agent calendar'}</DialogTitle>
    <DialogDescription>Each occurrence uses its original Thread, Run and Goal. Pausing this definition holds undelivered scheduled work; stopping a Run does not disable future slots.</DialogDescription>
    {field('Name', name, setName)}
    <label className="grid gap-1 text-sm">Instruction<Textarea value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
    <label className="text-sm">Schedule <select aria-label="Calendar schedule" value={kind} onChange={event => { const value = event.target.value as typeof kind; setKind(value); setMissed(value === 'once' ? 'coalesce_once' : 'skip'); }}>
      {['once', 'daily', 'weekly', 'cron'].map(value => <option key={value}>{value}</option>)}
    </select></label>
    {field('IANA timezone', timezone, setTimezone)}
    {kind === 'cron' ? field('Cron expression', cron, setCron) : field(kind === 'once' ? 'Time (HH:mm)' : 'Times (HH:mm, separated by commas)', times, setTimes)}
    {kind === 'once' && field('Date', date, setDate, 'date')}
    {kind === 'weekly' && field('Weekdays (0 Sunday through 6 Saturday)', weekdays, setWeekdays)}
    <label className="text-sm">Missed slots <select aria-label="Missed calendar slots" value={missed} onChange={event => setMissed(event.target.value as typeof missed)}><option value="skip">Skip</option><option value="coalesce_once">Run latest missed slot once</option></select></label>
    <label className="text-sm">Target <select aria-label="Calendar target" value={target} onChange={event => { retireResolution(); setResolving(false); setSourceError(''); setTarget(event.target.value as typeof target); }}><option value="new_work">New work</option><option value="existing_work">Existing work</option></select></label>
    {target === 'existing_work' ? <>{field('Thread ID', threadId, setThreadId)}{field('Branch ID', branchId, setBranchId)}<p className="text-sm text-muted-foreground">Uses that work's actual model, source, permissions and Goal.</p></> : <>
      <label className="text-sm">Model <select aria-label="Calendar model" value={model} onChange={event => setModel(event.target.value)}><option value="">Select model</option>{models.map(value => <option key={JSON.stringify([value.providerId, value.modelId])} value={JSON.stringify([value.providerId, value.modelId])}>{value.providerId} / {value.name ?? value.modelId}</option>)}</select></label>
      {field('Thinking level', thinking, setThinking)}
      <label className="text-sm">Source <select aria-label="Calendar source" disabled={saving} value={sourceKind} onChange={event => {
        invalidateSource(); const kind = event.target.value as CalendarSource['kind']; setSourceKind(kind);
        setSource(kind === 'project' ? { kind: 'project' } : null); setResourceOwner(null); setPath('');
      }}><option value="project">Project folder</option><option value="workspace">Workspace on selected Host</option></select></label>
      {sourceKind === 'project' ? <p className="text-sm text-muted-foreground">Uses the project folder on this Application Host when each occurrence starts.</p> : <>
        <label className="grid gap-1 text-sm">Source Host
          <select aria-label="Calendar source Host" disabled={saving} value={resourceOwner ? sourceOwnerKey(resourceOwner) : ''} onChange={event => {
            const selected = sourceTargets.targets.find(value => sourceOwnerKey(value.resourceOwner) === event.target.value);
            if (!selected) return;
            invalidateSource(); setResourceOwner(selected.resourceOwner); setPath('');
          }}>
            <option value="" disabled>Select source Host</option>
            {resourceOwner && !selectedHost && <option value={sourceOwnerKey(resourceOwner)}>{resourceOwner.kind === 'local' ? 'This Host' : resourceOwner.hostId} ({loadingSources ? 'loading' : 'unavailable'})</option>}
            {sourceTargets.targets.map(value => <option key={sourceOwnerKey(value.resourceOwner)} value={sourceOwnerKey(value.resourceOwner)}>{value.label}</option>)}
          </select>
        </label>
        {resourceOwner?.kind === 'managed_host' && <p className="break-all text-xs text-muted-foreground">Host {resourceOwner.hostId} · connection {resourceOwner.connectionId} · endpoint {resourceOwner.endpointIdentity}</p>}
        {resourceOwner && !selectedHost && !loadingSources && <p className="text-sm text-muted-foreground">The selected Host is unavailable. Its saved identity is retained; choose another Host explicitly to replace it.</p>}
        <label className="grid gap-1 text-sm">Workspace folder on the selected Host<Input aria-label="Calendar workspace folder" disabled={saving || !resourceOwner} value={path} onChange={event => { invalidateSource(); setPath(event.target.value); }} /></label>
        <Button type="button" variant="outline" disabled={saving || resolving || !selectedHost || !path.trim()} onClick={() => void resolveSource()}>{resolving ? 'Resolving workspace…' : 'Resolve workspace'}</Button>
        {source?.kind === 'workspace' && <p aria-label="Calendar workspace identity" className="break-all text-sm">Selected workspace: {source.workspaceId}</p>}
        {!source && <p className="text-sm text-muted-foreground">Resolve a folder to select its workspace before saving.</p>}
        {sourceError && <p role="alert" className="text-sm text-destructive">{sourceError}</p>}
      </>}
      {loadingSources && <p className="text-sm text-muted-foreground">Loading source Hosts…</p>}
      {directoryError && <p role="alert" className="text-sm text-destructive">{directoryError} Project folder remains available.</p>}
      {sourceTargets.unavailable.map(value => <p key={value.connectionId} className="text-sm text-muted-foreground">{value.label}: {value.message}</p>)}
      <label className="text-sm">Workspace access <select aria-label="Calendar source mode" value={sourceMode} onChange={event => setSourceMode(event.target.value as typeof sourceMode)}><option value="fixed_branch">Read-only snapshot</option><option value="materialized">Isolated editable copy</option><option value="live_root">Live workspace directory</option></select></label>
      <label className="text-sm"><input type="checkbox" checked={goal} onChange={event => setGoal(event.target.checked)} /> Continuing Goal</label>
      {goal && field('Output-token budget (blank means no configured limit)', budget, setBudget, 'number')}
    </>}
    <label className="text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable scheduled fires</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={saving || (target === 'new_work' && (!source || resolving))} onClick={() => void save()}>{saving ? 'Saving…' : 'Save definition'}</Button>
  </DialogContent></Dialog>;
}
