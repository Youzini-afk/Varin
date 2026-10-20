import React from 'react';
import { AGENT_AVATAR_IDS, type AgentAvatarId } from '@varin/protocol';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function AgentAvatarPicker({ identity, value, disabled, onChange }: {
  identity: string; value: AgentAvatarId | ''; disabled: boolean; onChange(value: AgentAvatarId | ''): void;
}) {
  const { t } = useI18n();
  return <div className="space-y-3">
    <div className="flex items-center gap-3">
      <AgentAvatar identity={identity} avatar={value} size={48} />
      <div className="min-w-0"><p className="typography-ui-label">{t(value ? 'settings.agents.avatar.fixed' : 'settings.agents.avatar.automatic')}</p>
        <p className="typography-meta text-muted-foreground">{t('settings.agents.avatar.description')}</p></div>
    </div>
    <div role="group" aria-label={t('settings.agents.avatar.library')} className="grid w-full max-w-xs grid-cols-6 gap-1.5 rounded-xl bg-interactive-hover/40 p-2">
      {AGENT_AVATAR_IDS.map((avatar, index) => <button key={avatar} type="button" disabled={disabled}
        aria-label={t('settings.agents.avatar.option', { number: index + 1 })} aria-pressed={value === avatar}
        className={`flex aspect-square min-w-0 items-center justify-center rounded-lg transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${value === avatar ? 'bg-interactive-active ring-1 ring-primary' : ''}`}
        onClick={() => onChange(avatar)}><AgentAvatar identity={identity} avatar={avatar} size={34} /></button>)}
    </div>
    <Button type="button" variant="ghost" size="sm" disabled={disabled || !value} onClick={() => onChange('')}>{t('settings.agents.avatar.useAutomatic')}</Button>
  </div>;
}
