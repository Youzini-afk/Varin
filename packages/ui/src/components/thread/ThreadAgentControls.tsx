import React from 'react';
import type { ThreadAgentChoice, ThreadModel } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAgentProfiles } from '@/components/sections/agents/useAgentProfiles';
import { agentProfileLabels } from '@/components/sections/agents/agent-profile-presentation';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/** Composer selections describe the next Run; live execution keeps its admitted profile. */
export function ThreadAgentControls({ value, model, disabled, pending, onChange }: {
  value: ThreadAgentChoice; disabled: boolean; pending?: boolean;
  model?: ThreadModel;
  onChange(value: ThreadAgentChoice, model?: ThreadModel): void;
}) {
  const { t } = useI18n();
  const { snapshot, state, refresh } = useAgentProfiles();
  const selected = snapshot?.profiles.find(profile => profile.id === value.profileId);
  const profiles = snapshot?.profiles.filter(profile => profile.effective.enabled
    && (!profile.effective.workFocus.length || profile.effective.workFocus.includes(value.workFocus))) ?? [];
  const label = selected ? agentProfileLabels(selected, t).name : value.profileId ? t('chat.modelControls.selectAgent') : 'Agent';
  const buttonClass = 'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40';
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className={buttonClass} aria-label={`${t('chat.modelControls.selectAgent')}: ${label}`} title={label}>
        <Icon name="robot" className="size-3.5 shrink-0" /><span className="max-w-28 truncate">{label}</span><Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
      </button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="w-64" portalToBody>
      <DropdownMenuItem onSelect={() => onChange({ ...value, profileId: null })}><Icon name="robot" className="size-4" /><span className="flex-1">Agent</span>{!value.profileId && <Icon name="check" className="size-3.5" />}</DropdownMenuItem>
      {profiles.map(profile => {
        const labels = agentProfileLabels(profile, t);
        return <DropdownMenuItem key={profile.id} disabled={profile.tools.source === 'unconfigured'} className="items-start gap-2" onSelect={() => {
          const effective = profile.effective;
          const baseModel = effective.model ?? model;
          onChange({ ...value, profileId: profile.id }, baseModel ? { ...baseModel, ...effective.modelSettings } : undefined);
        }}><Icon name="robot" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate">{labels.name}</span>{labels.description && <span className="mt-0.5 block text-xs text-muted-foreground">{labels.description}</span>}</span>{value.profileId === profile.id && <Icon name="check" className="size-3.5 shrink-0" />}</DropdownMenuItem>;
      })}
      {state.loading && !snapshot && <p className="px-2 py-1.5 typography-meta text-muted-foreground">{t('common.loading')}</p>}
      {state.error && <DropdownMenuItem onSelect={() => void refresh(true)}><Icon name="refresh" className="size-4" />{t('chat.messages.retry')}</DropdownMenuItem>}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { const ui = useUIStore.getState(); ui.setSettingsPage('agents'); ui.setSettingsDialogOpen(true); }}><Icon name="settings-3" className="size-4" />{t('chat.children.configureProfiles')}</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className={buttonClass} aria-label={`${t('workFocus.label')}: ${t(`workFocus.${value.workFocus}`)}`} title={pending ? t('workFocus.nextTurn') : t(`workFocus.${value.workFocus}Description`)}>
        <Icon name={value.workFocus === 'research' ? 'workspace-research' : 'workspace-general'} className="size-3.5 shrink-0" /><span className="whitespace-nowrap">{t(`workFocus.${value.workFocus}`)}</span><Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
      </button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="w-64" portalToBody>
      {(['code', 'research'] as const).map(workFocus => <DropdownMenuItem key={workFocus} className="items-start gap-2" onSelect={() => onChange({ profileId: selected?.effective.workFocus.length && !selected.effective.workFocus.includes(workFocus) ? null : value.profileId, workFocus })}>
        <Icon name={workFocus === 'research' ? 'workspace-research' : 'workspace-general'} className="mt-0.5 size-4 shrink-0" /><span className="flex-1"><span className="block">{t(`workFocus.${workFocus}`)}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`workFocus.${workFocus}Description`)}</span></span>{value.workFocus === workFocus && <Icon name="check" className="size-3.5 shrink-0" />}
      </DropdownMenuItem>)}
      {pending && <p className="border-t border-border/50 px-2 py-2 typography-micro text-muted-foreground">{t('workFocus.nextTurn')}</p>}
    </DropdownMenuContent></DropdownMenu>
  </>;
}
