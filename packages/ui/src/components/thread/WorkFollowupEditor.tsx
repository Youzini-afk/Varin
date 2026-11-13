import React from 'react';
import type { ThreadFollowupsAPI, ThreadIdentity } from '@varin/application-client';
import type { Followup, FollowupView } from '@varin/protocol';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

const localTime = (at: number) => { const date = new Date(at); return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19); };

export function WorkFollowupEditor({ api, identity, item, saved, close }: {
  api: ThreadFollowupsAPI; identity: ThreadIdentity; item: Followup; saved(): Promise<void>; close(): void;
}) {
  const { t } = useI18n();
  const [original, setOriginal] = React.useState<FollowupView>();
  const [instruction, setInstruction] = React.useState('');
  const [at, setAt] = React.useState('');
  const [condition, setCondition] = React.useState<'exists' | 'changed' | 'ready'>('exists');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    void api.get(identity,item.id,controller.signal).then(view => {
      if (controller.signal.aborted) return;
      setOriginal(view); setInstruction(view.instruction ?? '');
      if (view.followup.trigger.kind === 'file') setCondition(view.followup.trigger.condition);
      if (view.followup.trigger.kind === 'at') {
        const date = new Date(view.followup.trigger.at_ms);
        setAt(localTime(date.getTime()));
      }
    }, cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  },[api,identity,item.id]);
  const save = async () => {
    if (!original || busy) return;
    setBusy(true); setError('');
    try {
      await api.update({ ...identity,followupId:item.id,expectedRevision:original.followup.revision,instruction,
        ...(original.followup.trigger.kind === 'at' && at !== localTime(original.followup.trigger.at_ms) ? {atMs:new Date(at).getTime()} : {}),
        ...(original.followup.trigger.kind === 'file' ? {fileCondition:condition} : {}) });
      await saved(); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 py-2">
    {!original && !error && <p role="status">{t('common.loading')}</p>}
    {original?.followup.trigger.kind === 'at' && <Input type="datetime-local" step={1} aria-label={t('followups.trigger.at')} value={at} disabled={busy} onChange={event => setAt(event.target.value)} />}
    {original?.followup.trigger.kind === 'file' && <label className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground break-all">{original.followup.trigger.path}</span>
      <select aria-label={t('followups.trigger.file')} value={condition} disabled={busy} onChange={event => setCondition(event.target.value as typeof condition)}>
        {(['exists','changed','ready'] as const).filter(value => original.followup.repeat !== 'each' || value === 'changed').map(value => <option key={value} value={value}>{t(`followups.file.${value}`)}</option>)}
      </select>
    </label>}
    {original && <label className="block space-y-1"><span>{t('followups.instructions')}</span><Textarea value={instruction} rows={3} disabled={busy} onChange={event => setInstruction(event.target.value)} /></label>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex gap-2"><Button size="sm" disabled={!original || busy || !instruction.trim() || original.followup.trigger.kind === 'at' && !Number.isFinite(new Date(at).getTime())} onClick={() => void save()}>{t('arrangements.save')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={close}>{t('arrangements.cancelEdit')}</Button></div>
  </div>;
}
