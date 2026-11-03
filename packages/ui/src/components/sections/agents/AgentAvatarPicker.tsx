import React from 'react';
import { AGENT_AVATAR_IDS, type AgentAvatarId } from '@varin/protocol';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';

export function AgentAvatarPicker({ identity, value, disabled, onChange }: {
  identity: string; value: AgentAvatarId | ''; disabled: boolean; onChange(value: AgentAvatarId | ''): void;
}) {
  const { t } = useI18n();
  return <SettingsDisclosure key={identity} className="max-w-md [&]:border-t-0 [&>summary]:rounded-md [&>summary]:py-1 [&>summary]:focus-visible:outline-none [&>summary]:focus-visible:ring-2 [&>summary]:focus-visible:ring-primary [&>.settings-disclosure-body]:pb-0 [&>.settings-disclosure-body]:pl-0"
    title={<span className="flex items-center gap-3">
      <AgentAvatar identity={identity} avatar={value} size={32} />
      <span className="typography-ui-label">{t(value ? 'settings.agents.avatar.fixed' : 'settings.agents.avatar.automatic')}</span>
    </span>}>
    <div className="space-y-3 pt-3">
      <p className="typography-meta text-muted-foreground">{t('settings.agents.avatar.description')}</p>
      <div role="group" aria-label={t('settings.agents.avatar.library')} className="grid w-full max-w-md grid-cols-6 gap-1.5 rounded-xl bg-interactive-hover/40 p-2 sm:grid-cols-8">
        {AGENT_AVATAR_IDS.map((avatar, index) => <button key={avatar} type="button" disabled={disabled}
          aria-label={t('settings.agents.avatar.option', { number: index + 1 })} aria-pressed={value === avatar}
          className={`flex aspect-square min-w-0 items-center justify-center rounded-lg transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${value === avatar ? 'bg-interactive-active ring-1 ring-primary' : ''}`}
          onClick={() => onChange(avatar)}><AgentAvatar identity={identity} avatar={avatar} size={34} /></button>)}
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || !value} onClick={() => onChange('')}>{t('settings.agents.avatar.useAutomatic')}</Button>
    </div>
  </SettingsDisclosure>;
}
