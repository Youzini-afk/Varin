import React from 'react';
import type { BotGroup, BotSummary } from '@varin/application-client';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { BotOrganizationController } from './useBotOrganization';

export type BotOrganizationDialogState = { kind: 'create' } | { kind: 'rename'; group: BotGroup } | { kind: 'remove'; group: BotGroup } | { kind: 'move'; bot: BotSummary };
export function BotOrganizationDialog({ value: requested, onClose, organization }: { value: BotOrganizationDialogState | null; onClose(): void; organization: BotOrganizationController }) {
  const { t } = useI18n();
  const last = React.useRef(requested); if (requested) last.current = requested;
  const value = requested ?? last.current;
  const [name, setName] = React.useState(''), [groupId, setGroupId] = React.useState(''), [beforeId, setBeforeId] = React.useState('');
  const createId = React.useRef('');
  const groups = React.useRef(organization.value.groups); groups.current = organization.value.groups;
  React.useEffect(() => {
    if (!requested) return;
    setName(value?.kind === 'rename' ? value.group.name : ''); setBeforeId(''); createId.current = crypto.randomUUID();
    setGroupId(value?.kind === 'move' ? groups.current.find(group => group.botIds.includes(value.bot.id))?.id ?? '' : '');
  }, [requested, value]); // Keep the same content throughout the closing animation.
  const title = value?.kind === 'rename' ? 'bot.groups.rename' : value?.kind === 'remove' ? 'bot.groups.remove' : value?.kind === 'move' ? 'bot.groups.move' : 'bot.groups.create';
  const targets = organization.sections.find(section => (section.group?.id ?? '') === groupId)?.bots.filter(bot => value?.kind !== 'move' || bot.id !== value.bot.id) ?? [];
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!value) return;
    const success = await organization.change(value.kind === 'create' ? { kind: 'create', id: createId.current, name }
      : value.kind === 'rename' ? { kind: 'rename', id: value.group.id, name }
        : value.kind === 'remove' ? { kind: 'remove', id: value.group.id }
          : { kind: 'move-bot', botId: value.bot.id, groupId: groupId || null, beforeId: beforeId || null });
    if (success) onClose();
  };
  return <Dialog open={!!requested} onOpenChange={open => { if (!open && !organization.pending) onClose(); }}>
    <DialogContent className="max-w-sm gap-5">
      <DialogHeader><DialogTitle>{t(title)}</DialogTitle>
        <DialogDescription>{value?.kind === 'remove' ? t('bot.groups.removeHint', { name: value.group.name }) : value?.kind === 'move' ? value.bot.name : t('bot.groups.nameHint')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={event => { void submit(event); }} className="space-y-5">
        {value?.kind === 'create' || value?.kind === 'rename' ? <Input autoFocus aria-label={t('bot.groups.name')} placeholder={t('bot.groups.name')} value={name} onChange={event => setName(event.target.value)} disabled={organization.pending} /> : null}
        {value?.kind === 'move' ? <div className="space-y-4">
          <label className="flex flex-col gap-2 typography-meta">{t('bot.groups.destination')}
            <select autoFocus className="bot-group-select" value={groupId} disabled={organization.pending} onChange={event => { setGroupId(event.target.value); setBeforeId(''); }}>
              <option value="">{t('bot.groups.ungrouped')}</option>
              {organization.value.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-2 typography-meta">{t('bot.groups.position')}
            <select className="bot-group-select" value={beforeId} disabled={organization.pending} onChange={event => setBeforeId(event.target.value)}>
              <option value="">{t('bot.groups.atEnd')}</option>
              {targets.map(bot => <option key={bot.id} value={bot.id}>{t('bot.groups.before', { name: bot.name })}</option>)}
            </select>
          </label>
        </div> : null}
        {organization.error && <p role="alert" className="typography-meta text-destructive">{organization.error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={organization.pending} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
          <Button type="submit" variant={value?.kind === 'remove' ? 'destructive' : 'default'} disabled={organization.pending || !organization.ready || ((value?.kind === 'create' || value?.kind === 'rename') && !name.trim())}>
            {t(organization.pending ? 'bot.groups.saving' : value?.kind === 'remove' ? 'bot.groups.remove' : value?.kind === 'move' ? 'bot.groups.moveAction' : 'settings.bots.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
