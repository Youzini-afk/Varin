import React from 'react';
import type { BotSummary, ThreadIdentity } from '@varin/application-client';
import type { BotMatter } from '@varin/protocol';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

export function BotFollowDialog({ identity, onClose }: { identity: ThreadIdentity; onClose(): void }) {
  const { bots } = useRuntimeAPIs(); const { t } = useI18n();
  const [profiles, setProfiles] = React.useState<BotSummary[]>([]), [selected, setSelected] = React.useState('');
  const [title, setTitle] = React.useState(''), [description, setDescription] = React.useState('');
  const [send, setSend] = React.useState(false), [memory, setMemory] = React.useState(false);
  const [prior, setPrior] = React.useState<BotMatter | null>(null), [loading, setLoading] = React.useState(true), [saving, setSaving] = React.useState(false), [error, setError] = React.useState('');
  const id = JSON.stringify([identity.threadId, identity.branchId]);
  const host = React.useRef(getRuntimeEndpointGeneration());
  React.useEffect(() => {
    if (!bots) return;
    const controller = new AbortController();
    void bots.primary(controller.signal).then(async primary => {
      const list = await bots.list(controller.signal);
      if (!controller.signal.aborted) { setProfiles(list.filter(bot => !bot.archived && !bot.deletion)); setSelected(primary.id); }
    }).catch(cause => { if (!controller.signal.aborted) { setError(String(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [bots]);
  React.useEffect(() => {
    if (!bots || !selected) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void bots.matters.list(selected, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      const row = rows.find(row => row.id === id) ?? null;
      const link = row?.threads.find(link => link.threadId === identity.threadId && link.branchId === identity.branchId);
      setPrior(row); setTitle(row?.title ?? t('bot.follow.defaultTitle')); setDescription(row?.description ?? '');
      setSend(link?.send ?? false); setMemory(link?.memory ?? false); setLoading(false);
    }).catch(cause => { if (!controller.signal.aborted) { setError(String(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [bots, id, identity.threadId, identity.branchId, selected, t]);
  const save = async () => {
    if (!bots || host.current !== getRuntimeEndpointGeneration()) { setError(t('bot.follow.hostChanged')); return; }
    setSaving(true); setError('');
    try {
      await bots.matters.update({ botId: selected, key: crypto.randomUUID(), expectedRevision: prior?.revision ?? 0,
        matter: { id, revision: prior?.revision ?? 0, title: title.trim(), description, archived: false,
          threads: [{ threadId: identity.threadId, branchId: identity.branchId, send, memory }] } });
      if (host.current === getRuntimeEndpointGeneration()) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent className="max-w-lg">
    <DialogHeader><DialogTitle>{t('bot.follow.title')}</DialogTitle><DialogDescription>{t('bot.follow.description')}</DialogDescription></DialogHeader>
    {profiles.length > 1 && <Select value={selected} onValueChange={setSelected} disabled={saving}><SelectTrigger aria-label={t('bot.follow.assistant')}><SelectValue /></SelectTrigger><SelectContent>{profiles.map(bot => <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>)}</SelectContent></Select>}
    <Input value={title} onChange={event => setTitle(event.target.value)} disabled={loading || saving} aria-label={t('bot.follow.name')} />
    <Textarea value={description} onChange={event => setDescription(event.target.value)} disabled={loading || saving} placeholder={t('bot.follow.context')} rows={3} />
    <label className="flex items-start gap-3 typography-body"><Checkbox checked={send} onChange={setSend} disabled={loading || saving} />{t('bot.follow.send')}</label>
    <label className="flex items-start gap-3 typography-body"><Checkbox checked={memory} onChange={setMemory} disabled={loading || saving} />{t('bot.follow.memory')}</label>
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    <DialogFooter><Button variant="ghost" onClick={onClose} disabled={saving}>{t('settings.common.actions.cancel')}</Button><Button onClick={() => { void save(); }} disabled={loading || saving || !title.trim()}>{t('bot.follow.save')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
