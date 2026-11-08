import React from 'react';
import { createScheduledTasksHttpAPI, getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ScheduledTask, ThreadModelInfo, ThreadSourceTargets } from '@varin/application-client';
import type { CalendarSource, SourceResourceOwner } from '@varin/protocol';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';

const schedules = createScheduledTasksHttpAPI();
const sourceOwnerKey = (owner: SourceResourceOwner) => owner.kind === 'local'
  ? 'local' : JSON.stringify([owner.connectionId, owner.endpointIdentity, owner.hostId]);

/** Edits external definitions only. Preview/admission and every occurrence stay with the Host. */
export function CalendarTaskEditorDialog({ open, projectId, task, initialTarget, onOpenChange, onSave }: {
  initialTarget?: import('@varin/application-client').ThreadIdentity | undefined;
  open: boolean; projectId: string; task: ScheduledTask | null; onOpenChange(open: boolean): void; onSave(task: Partial<ScheduledTask>): Promise<void>;
}) {
  const { threads } = useRuntimeAPIs();
  const { t } = useI18n();
  // Translating async failures must not restart the editing session or discard its draft.
  const effectText = React.useEffectEvent(t);
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
      setSource(null); setModels([]); setError(effectText('calendar.error.hostChanged'));
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
    setTarget(task?.target?.kind ?? (initialTarget ? 'existing_work' : 'new_work')); setError(''); setSaving(false);
    const selection = task?.target;
    const selectedSource: CalendarSource = selection?.kind === 'new_work' ? selection.source : { kind: 'project' };
    setSourceKind(selectedSource.kind); setSource(selectedSource);
    setResourceOwner(selectedSource.kind === 'workspace' ? selectedSource.resourceOwner : null); setPath('');
    if (selection?.kind === 'new_work') {
      setModel(JSON.stringify([selection.model.providerId, selection.model.modelId])); setThinking(selection.model.thinkingLevel ?? 'off');
      setSourceMode(selection.sourceMode === 'native_workspace' ? 'live_root' : selection.sourceMode); setGoal(selection.goal !== null); setBudget(selection.goal?.budget ? String(selection.goal.budget.maxOutputTokens) : '');
    } else { setModel(''); setThinking('off'); setSourceMode('materialized'); setGoal(false); setBudget(''); }
    setThreadId(selection?.kind === 'existing_work' ? selection.threadId : initialTarget?.threadId ?? ''); setBranchId(selection?.kind === 'existing_work' ? selection.branchId : initialTarget?.branchId ?? '');
    setModels([]);
    void threads?.listModels().then(value => { if (isCurrent()) setModels(value); }, value => { if (isCurrent()) setError(value instanceof Error ? value.message : effectText('calendar.error.models')); });
    void schedules.listSources(projectId, controller.signal).then(value => {
      if (isCurrent()) setSourceTargets(value);
    }, value => {
      if (isCurrent()) setDirectoryError(value instanceof Error ? value.message : effectText('calendar.error.hosts'));
    }).finally(() => { if (isCurrent()) setLoadingSources(false); });
    return () => { controller.abort(); editorGeneration.current += 1; retireResolution(); };
  }, [open, projectId, task, threads, retireResolution, initialTarget?.threadId, initialTarget?.branchId]);
  const selectedHost = resourceOwner ? sourceTargets.targets.find(value => sourceOwnerKey(value.resourceOwner) === sourceOwnerKey(resourceOwner)) : undefined;
  const resolveSource = async () => {
    if (saving || resolving || !resourceOwner || !selectedHost || !path.trim()) return;
    const host = editorHostGeneration.current;
    if (host === null || host !== getRuntimeEndpointGeneration()) { invalidateSource(); setError(t('calendar.error.hostChanged')); return; }
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
        throw new Error(t('calendar.error.workspaceIdentity'));
      }
      setSource({ kind: 'workspace', resourceOwner: resolved.resourceOwner, workspaceId: resolved.workspaceId });
      setPath(resolved.path);
    } catch (value) {
      if (isCurrent()) setSourceError(value instanceof Error ? value.message : t('calendar.error.workspace'));
    } finally {
      if (isCurrent()) { resolveController.current = null; setResolving(false); }
    }
  };
  const save = async () => {
    if (saving) return;
    const host = editorHostGeneration.current;
    if (host === null || host !== getRuntimeEndpointGeneration()) { invalidateSource(); setError(t('calendar.error.hostChanged')); return; }
    const generation = editorGeneration.current;
    const isCurrent = () => generation === editorGeneration.current && host === getRuntimeEndpointGeneration();
    setSaving(true); setError('');
    try {
      const selected = models.find(value => JSON.stringify([value.providerId, value.modelId]) === model);
      if (target === 'new_work' && !selected) throw new Error(t('calendar.error.modelRequired'));
      if (target === 'new_work' && (!source || resolving)) throw new Error(t('calendar.error.sourceRequired'));
      if (!name.trim() || !instruction.trim()) throw new Error(t('calendar.error.fieldsRequired'));
      const maxOutputTokens = budget.trim() ? Number(budget) : null;
      if (goal && maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0)) throw new Error(t('calendar.error.budget'));
      await onSave({ id: creationKey.current!, name, enabled, runtime: 'agent', execution: { prompt: instruction }, missedPolicy: missed,
        schedule: { kind, timezone, ...(kind === 'once' ? { date, time: times.trim() } : kind === 'cron' ? { cron } : { times: times.split(',').map(value => value.trim()), ...(kind === 'weekly' ? { weekdays: weekdays.split(',').map(value => Number(value.trim())) } : {}) }) },
        target: target === 'existing_work' ? { kind: 'existing_work', threadId, branchId } : { kind: 'new_work', source: source!, sourceMode,
          model: { providerId: selected!.providerId, modelId: selected!.modelId, thinkingLevel: thinking, ...(task?.target?.kind === 'new_work' && task.target.model.providerId === selected!.providerId && task.target.model.modelId === selected!.modelId && task.target.model.temperature !== undefined ? { temperature: task.target.model.temperature } : {}) },
          goal: goal ? { budget: maxOutputTokens === null ? null : { maxOutputTokens } } : null } });
      if (isCurrent()) onOpenChange(false);
    } catch (value) { if (isCurrent()) setError(value instanceof Error ? value.message : t('calendar.error.save')); }
    finally { if (isCurrent()) setSaving(false); }
  };
  const field = (label: string, value: string, change: (value: string) => void, type = 'text') => <label className="grid gap-1 text-sm">{label}<Input type={type} value={value} onChange={event => change(event.target.value)} /></label>;
  return <Dialog open={open} onOpenChange={value => { if (!saving) { if (!value) retireResolution(); onOpenChange(value); } }}><DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
    <DialogTitle>{t(task ? 'calendar.edit' : 'calendar.create')}</DialogTitle>
    <DialogDescription>{t('calendar.description')}</DialogDescription>
    {field(t('calendar.name'), name, setName)}
    <label className="grid gap-1 text-sm">{t('calendar.instruction')}<Textarea value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
    <label className="text-sm">{t('calendar.schedule')} <select aria-label={t('calendar.scheduleLabel')} value={kind} onChange={event => { const value = event.target.value as typeof kind; setKind(value); setMissed(value === 'once' ? 'coalesce_once' : 'skip'); }}>
      {(['once', 'daily', 'weekly', 'cron'] as const).map(value => <option key={value} value={value}>{t(`calendar.schedule.${value}`)}</option>)}
    </select></label>
    {field(t('calendar.timezone'), timezone, setTimezone)}
    {kind === 'cron' ? field(t('calendar.cron'), cron, setCron) : field(t(kind === 'once' ? 'calendar.time' : 'calendar.times'), times, setTimes)}
    {kind === 'once' && field(t('calendar.date'), date, setDate, 'date')}
    {kind === 'weekly' && field(t('calendar.weekdays'), weekdays, setWeekdays)}
    <label className="text-sm">{t('calendar.missed')} <select aria-label={t('calendar.missedLabel')} value={missed} onChange={event => setMissed(event.target.value as typeof missed)}><option value="skip">{t('calendar.missed.skip')}</option><option value="coalesce_once">{t('calendar.missed.once')}</option></select></label>
    <label className="text-sm">{t('calendar.target')} <select aria-label={t('calendar.targetLabel')} value={target} onChange={event => { retireResolution(); setResolving(false); setSourceError(''); setTarget(event.target.value as typeof target); }}><option value="new_work">{t('calendar.target.new')}</option><option value="existing_work">{t('calendar.target.existing')}</option></select></label>
    {target === 'existing_work' ? <>{field(t('calendar.threadId'), threadId, setThreadId)}{field(t('calendar.branchId'), branchId, setBranchId)}<p className="text-sm text-muted-foreground">{t('calendar.existingHint')}</p></> : <>
      <label className="text-sm">{t('calendar.model')} <select aria-label={t('calendar.modelLabel')} value={model} onChange={event => setModel(event.target.value)}><option value="">{t('calendar.selectModel')}</option>{models.map(value => <option key={JSON.stringify([value.providerId, value.modelId])} value={JSON.stringify([value.providerId, value.modelId])}>{value.providerId} / {value.name ?? value.modelId}</option>)}</select></label>
      {field(t('calendar.thinking'), thinking, setThinking)}
      <label className="text-sm">{t('calendar.source')} <select aria-label={t('calendar.sourceLabel')} disabled={saving} value={sourceKind} onChange={event => {
        invalidateSource(); const kind = event.target.value as CalendarSource['kind']; setSourceKind(kind);
        setSource(kind === 'project' ? { kind: 'project' } : null); setResourceOwner(null); setPath('');
      }}><option value="project">{t('calendar.source.project')}</option><option value="workspace">{t('calendar.source.workspace')}</option></select></label>
      {sourceKind === 'project' ? <p className="text-sm text-muted-foreground">{t('calendar.projectHint')}</p> : <>
        <label className="grid gap-1 text-sm">{t('calendar.sourceHost')}
          <select aria-label={t('calendar.sourceHostLabel')} disabled={saving} value={resourceOwner ? sourceOwnerKey(resourceOwner) : ''} onChange={event => {
            const selected = sourceTargets.targets.find(value => sourceOwnerKey(value.resourceOwner) === event.target.value);
            if (!selected) return;
            invalidateSource(); setResourceOwner(selected.resourceOwner); setPath('');
          }}>
            <option value="" disabled>{t('calendar.selectHost')}</option>
            {resourceOwner && !selectedHost && <option value={sourceOwnerKey(resourceOwner)}>{resourceOwner.kind === 'local' ? t('calendar.thisHost') : resourceOwner.hostId} ({t(loadingSources ? 'calendar.loading' : 'calendar.unavailable')})</option>}
            {sourceTargets.targets.map(value => <option key={sourceOwnerKey(value.resourceOwner)} value={sourceOwnerKey(value.resourceOwner)}>{value.label}</option>)}
          </select>
        </label>
        {resourceOwner?.kind === 'managed_host' && <p className="break-all text-xs text-muted-foreground">{t('calendar.hostIdentity', { host: resourceOwner.hostId, connection: resourceOwner.connectionId, endpoint: resourceOwner.endpointIdentity })}</p>}
        {resourceOwner && !selectedHost && !loadingSources && <p className="text-sm text-muted-foreground">{t('calendar.hostUnavailable')}</p>}
        <label className="grid gap-1 text-sm">{t('calendar.folder')}<Input aria-label={t('calendar.folderLabel')} disabled={saving || !resourceOwner} value={path} onChange={event => { invalidateSource(); setPath(event.target.value); }} /></label>
        <Button type="button" variant="outline" disabled={saving || resolving || !selectedHost || !path.trim()} onClick={() => void resolveSource()}>{t(resolving ? 'calendar.resolving' : 'calendar.resolve')}</Button>
        {source?.kind === 'workspace' && <p aria-label={t('calendar.workspaceIdentityLabel')} className="break-all text-sm">{t('calendar.workspaceIdentity', { workspace: source.workspaceId })}</p>}
        {!source && <p className="text-sm text-muted-foreground">{t('calendar.resolveHint')}</p>}
        {sourceError && <p role="alert" className="text-sm text-destructive">{sourceError}</p>}
      </>}
      {loadingSources && <p className="text-sm text-muted-foreground">{t('calendar.loadingHosts')}</p>}
      {directoryError && <p role="alert" className="text-sm text-destructive">{directoryError} {t('calendar.projectAvailable')}</p>}
      {sourceTargets.unavailable.map(value => <p key={value.connectionId} className="text-sm text-muted-foreground">{value.label}: {value.message}</p>)}
      <label className="text-sm">{t('calendar.access')} <select aria-label={t('calendar.accessLabel')} value={sourceMode} onChange={event => setSourceMode(event.target.value as typeof sourceMode)}><option value="fixed_branch">{t('calendar.access.readOnly')}</option><option value="materialized">{t('calendar.access.isolated')}</option><option value="live_root">{t('calendar.access.live')}</option></select></label>
      <label className="text-sm"><input type="checkbox" checked={goal} onChange={event => setGoal(event.target.checked)} /> {t('calendar.goal')}</label>
      {goal && field(t('calendar.budget'), budget, setBudget, 'number')}
    </>}
    <label className="text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> {t('calendar.enabled')}</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={saving || (target === 'new_work' && (!source || resolving))} onClick={() => void save()}>{t(saving ? 'calendar.saving' : 'calendar.save')}</Button>
  </DialogContent></Dialog>;
}
