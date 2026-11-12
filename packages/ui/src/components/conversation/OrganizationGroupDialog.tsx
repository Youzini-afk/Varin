import React from 'react';
import type { ConversationOrganizationContainer } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ORGANIZATION_ICONS, ORGANIZATION_COLORS, organizationIcon } from './organizationAppearance';

export type OrganizationGroupEditor = { id: string; container?: ConversationOrganizationContainer; parentId: string | null; name: string; icon: string; color: string };
export function OrganizationGroupDialog({ value, onChange, location, pending, onSubmit }: {
  value: OrganizationGroupEditor | null; onChange(value: OrganizationGroupEditor | null): void; location: string; pending: boolean; onSubmit(): void;
}) {
  const { t } = useI18n();
  const previous = React.useRef({ value, location }); if (value) previous.current = { value, location };
  const shown = value ?? previous.current.value;
  const shownLocation = value ? location : previous.current.location;
  const composing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return <Dialog open={!!value} onOpenChange={(open, details) => { if (!open && !pending && !('isComposing' in details.event && details.event.isComposing)) onChange(null); }}>
    <DialogContent className="max-w-[360px] gap-5 p-5" onKeyDown={event => { if (composing(event) && (event.key === 'Enter' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); } }}>
      <DialogHeader className="text-left"><DialogTitle className="text-[15px] font-medium">{t(shown?.container ? 'organization.editGroup' : 'organization.newGroupMenu')}</DialogTitle><DialogDescription className="typography-meta">{shownLocation}</DialogDescription></DialogHeader>
      {shown && <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (shown.name.trim() && !pending) onSubmit(); }}>
        <Input autoFocus aria-label={t('organization.groupName')} placeholder={t('organization.groupName')} disabled={pending} value={shown.name} onChange={event => onChange({ ...shown, name: event.target.value })} onKeyDown={event => { if (composing(event)) { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } } else if (event.key === 'Escape' && !pending) onChange(null); }} />
        <div><span className="mb-2 block typography-micro text-muted-foreground">{t('organization.groupIcon')}</span><div className="grid grid-cols-9 gap-1">{ORGANIZATION_ICONS.map(icon => <button key={icon} type="button" aria-label={t(`organization.icon.${icon}`)} title={t(`organization.icon.${icon}`)} aria-pressed={shown.icon === icon} disabled={pending} className={cn('flex h-8 w-full items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover', shown.icon === icon && 'bg-interactive-selection text-foreground')} onClick={() => onChange({ ...shown, icon })}><Icon name={icon} className="size-4" style={{ color: shown.color || undefined }} /></button>)}</div></div>
        <div><span className="mb-2 block typography-micro text-muted-foreground">{t('organization.groupColor')}</span><div className="flex gap-2">{ORGANIZATION_COLORS.map((color, index) => <button key={color} type="button" aria-label={color ? t('organization.colorOption', { number: index }) : t('organization.theme')} aria-pressed={shown.color === color} disabled={pending} className={cn('flex size-7 items-center justify-center rounded-full', shown.color === color && 'ring-1 ring-border ring-offset-2 ring-offset-background')} onClick={() => onChange({ ...shown, color })}><span className="flex size-4 items-center justify-center rounded-full" style={{ backgroundColor: color || 'var(--muted-foreground)' }}>{shown.color === color && <Icon name={index === 0 ? organizationIcon(shown.icon) : 'check'} className="size-3 text-background" />}</span></button>)}</div></div>
        <DialogFooter className="flex-row"><Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => onChange(null)}>{t('organization.cancel')}</Button><Button type="submit" size="sm" disabled={pending || !shown.name.trim()}>{t('organization.save')}</Button></DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>;
}
