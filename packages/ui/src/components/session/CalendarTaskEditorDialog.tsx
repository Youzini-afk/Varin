import React from 'react';
import type { ScheduledTask, ThreadModelInfo } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** Edits external definitions only. Preview/admission and every occurrence stay with the Host. */
export function CalendarTaskEditorDialog({ open, task, onOpenChange, onSave }: {
  open: boolean; task: ScheduledTask | null; onOpenChange(open: boolean): void; onSave(task: Partial<ScheduledTask>): Promise<void>;
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
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]), [model, setModel] = React.useState(''), [thinking, setThinking] = React.useState('off');
  const [goal, setGoal] = React.useState(false), [budget, setBudget] = React.useState('');
  const [error, setError] = React.useState(''), [saving, setSaving] = React.useState(false);
  const creationKey = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!open) return;
    creationKey.current = task?.id ?? `task:${crypto.randomUUID()}`;
    setName(task?.name ?? ''); setInstruction(task?.execution.prompt ?? ''); setKind(task?.schedule.kind ?? 'daily');
    setTimezone(task?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
    setTimes(task?.schedule.times?.join(', ') ?? task?.schedule.time ?? '09:00'); setDate(task?.schedule.date ?? '');
    setWeekdays(task?.schedule.weekdays?.join(', ') ?? '1'); setCron(task?.schedule.cron ?? '0 9 * * *');
    setEnabled(task?.enabled ?? false); setMissed(task?.missedPolicy ?? (task?.schedule.kind === 'once' ? 'coalesce_once' : 'skip'));
    setTarget(task?.target?.kind ?? 'new_work'); setError(''); setSaving(false);
    const selection = task?.target;
    if (selection?.kind === 'new_work') {
      setModel(JSON.stringify([selection.model.providerId, selection.model.modelId])); setThinking(selection.model.thinkingLevel ?? 'off');
      setSourceMode(selection.sourceMode); setGoal(selection.goal !== null); setBudget(selection.goal?.budget ? String(selection.goal.budget.maxOutputTokens) : '');
    } else { setModel(''); setThinking('off'); setSourceMode('materialized'); setGoal(false); setBudget(''); }
    setThreadId(selection?.kind === 'existing_work' ? selection.threadId : ''); setBranchId(selection?.kind === 'existing_work' ? selection.branchId : '');
    let active = true;
    void threads?.listModels().then(value => { if (active) setModels(value); }, value => { if (active) setError(value instanceof Error ? value.message : 'Model catalog unavailable'); });
    return () => { active = false; };
  }, [open, task, threads]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const selected = models.find(value => JSON.stringify([value.providerId, value.modelId]) === model);
      if (target === 'new_work' && !selected) throw new Error('Select an available registered model');
      if (!name.trim() || !instruction.trim()) throw new Error('Name and instruction are required');
      const maxOutputTokens = budget.trim() ? Number(budget) : null;
      if (goal && maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 0)) throw new Error('Goal budget must be a non-negative output-token count');
      await onSave({ id: creationKey.current!, name, enabled, runtime: 'agent', execution: { prompt: instruction }, missedPolicy: missed,
        schedule: { kind, timezone, ...(kind === 'once' ? { date, time: times.trim() } : kind === 'cron' ? { cron } : { times: times.split(',').map(value => value.trim()), ...(kind === 'weekly' ? { weekdays: weekdays.split(',').map(value => Number(value.trim())) } : {}) }) },
        target: target === 'existing_work' ? { kind: 'existing_work', threadId, branchId } : { kind: 'new_work', sourceMode,
          model: { providerId: selected!.providerId, modelId: selected!.modelId, thinkingLevel: thinking, ...(task?.target?.kind === 'new_work' && task.target.model.providerId === selected!.providerId && task.target.model.modelId === selected!.modelId && task.target.model.temperature !== undefined ? { temperature: task.target.model.temperature } : {}) },
          goal: goal ? { budget: maxOutputTokens === null ? null : { maxOutputTokens } } : null } });
      onOpenChange(false);
    } catch (value) { setError(value instanceof Error ? value.message : 'Calendar definition could not be saved'); }
    finally { setSaving(false); }
  };
  const field = (label: string, value: string, change: (value: string) => void, type = 'text') => <label className="grid gap-1 text-sm">{label}<Input type={type} value={value} onChange={event => change(event.target.value)} /></label>;
  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}><DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
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
    <label className="text-sm">Target <select aria-label="Calendar target" value={target} onChange={event => setTarget(event.target.value as typeof target)}><option value="new_work">New work</option><option value="existing_work">Existing work</option></select></label>
    {target === 'existing_work' ? <>{field('Thread ID', threadId, setThreadId)}{field('Branch ID', branchId, setBranchId)}<p className="text-sm text-muted-foreground">Uses that work's actual model, source, permissions and Goal.</p></> : <>
      <label className="text-sm">Model <select aria-label="Calendar model" value={model} onChange={event => setModel(event.target.value)}><option value="">Select model</option>{models.map(value => <option key={JSON.stringify([value.providerId, value.modelId])} value={JSON.stringify([value.providerId, value.modelId])}>{value.providerId} / {value.name ?? value.modelId}</option>)}</select></label>
      {field('Thinking level', thinking, setThinking)}
      <label className="text-sm">Project source <select aria-label="Calendar source" value={sourceMode} onChange={event => setSourceMode(event.target.value as typeof sourceMode)}><option value="fixed_branch">Read-only snapshot</option><option value="materialized">Isolated editable copy</option><option value="live_root">Live project directory</option></select></label>
      <label className="text-sm"><input type="checkbox" checked={goal} onChange={event => setGoal(event.target.checked)} /> Continuing Goal</label>
      {goal && field('Output-token budget (blank means no configured limit)', budget, setBudget, 'number')}
    </>}
    <label className="text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable scheduled fires</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save definition'}</Button>
  </DialogContent></Dialog>;
}
