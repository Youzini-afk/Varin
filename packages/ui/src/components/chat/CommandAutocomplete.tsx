import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { commandMatchesSearch } from './commandAutocompleteItems';
import { useComposerResources, type ComposerSkill } from './useComposerResources';
import { ComposerMenu, type ComposerMenuHandle, type ComposerMenuItem } from './composer/ComposerMenu';
import type { ThreadDraftSkillOptions, ThreadIdentity, ThreadSource, ThreadsAPI } from '@varin/application-client';
import type { IconName } from '@/components/icon/icons';

export interface CommandInfo {
  id: string; name: string; source: 'extension' | 'varin' | 'prompt' | 'skill' | 'unknown' | 'backend';
  sourceLabel?: string; label?: string; description?: string; searchAliases?: string[]; group?: string; icon?: IconName;
  isSkill?: boolean; skill?: ComposerSkill; disabled?: string; value?: string; next?: boolean;
}
export type CommandAutocompleteHandle = ComposerMenuHandle;
export const CommandAutocomplete = React.forwardRef<CommandAutocompleteHandle, {
  additionalCommands?: readonly CommandInfo[]; cwd?: string | null; sessionId?: string | null;
  api?: ThreadsAPI; identity?: ThreadIdentity; source?: ThreadSource; pendingSource?: ThreadDraftSkillOptions['source']; native?: boolean;
  searchQuery: string; onCommandSelect(command: CommandInfo, mode: 'confirm' | 'complete'): void; onClose(): void;
  menuId?: string; onActive?(id?: string): void; children?: React.ReactNode; title?: string; onBack?(): void;
}>(({ additionalCommands = [], cwd, sessionId, api, identity, source, pendingSource, native = true, searchQuery, onCommandSelect, onClose, menuId = 'composer-commands', onActive, children, title, onBack }, ref) => {
  const { t } = useI18n();
  const resources = useComposerResources({ cwd, sessionId, api, identity, source, pendingSource, enabled: native });
  const catalog = React.useMemo<CommandInfo[]>(() => [...additionalCommands, ...resources.skills.map(skill => ({
    id: `skill:${skill.resourceId}`, name: skill.invocation, label: skill.name, source: 'skill' as const, isSkill: true, skill,
    description: skill.description, searchAliases: [skill.name], group: t('composer.group.skills'),
  }))], [additionalCommands, resources.skills, t]);
  const commands = React.useMemo(() => {
    const query = searchQuery.replace(/^skill:/, '').trim();
    const filtered = catalog.filter(item => !query || commandMatchesSearch({ ...item, searchAliases: [...item.searchAliases ?? [], item.label ?? ''] }, query));
    const groups = [...new Set(catalog.map(item => item.group ?? t('composer.group.conversation')))];
    return filtered.sort((a, b) => groups.indexOf(a.group ?? t('composer.group.conversation')) - groups.indexOf(b.group ?? t('composer.group.conversation'))
      || Number(b.name.toLowerCase().startsWith(query.toLowerCase())) - Number(a.name.toLowerCase().startsWith(query.toLowerCase())));
  }, [catalog, searchQuery, t]);
  const items: ComposerMenuItem[] = commands.map(command => ({ id: command.id, group: command.group ?? t('composer.group.conversation'),
    label: command.label ?? `/${command.name}`, description: command.description, disabled: command.disabled, value: command.value, next: command.next,
    icon: <Icon name={command.isSkill ? 'sparkling' : command.icon ?? 'command'} className="size-4" />,
    source: command.skill ? `${t(command.skill.scope === 'project' ? 'composer.source.project' : command.skill.scope === 'extension' ? 'composer.source.extension' : 'composer.source.user')}${command.skill.sourceLabel ? ` · ${command.skill.sourceLabel}` : ''}` : command.source === 'extension' ? command.sourceLabel ?? t('composer.source.extension') : command.source === 'backend' ? t('composer.group.backend') : undefined,
  }));
  return <ComposerMenu ref={ref} id={menuId} items={items} query={searchQuery} scope={sessionId ?? cwd ?? ''}
    onChoose={(id, mode) => { const command = commands.find(item => item.id === id); if (command) onCommandSelect(command, mode); }}
    onClose={onClose} onActive={onActive} title={title} onBack={onBack}
    status={<>{resources.loading && <p role="status" className="px-2 py-1 typography-micro text-muted-foreground">{t('composer.menu.loading')}</p>}
      {resources.error && <p role="alert" className="px-2 py-2 typography-meta text-destructive">{resources.error} <button type="button" onClick={resources.refresh}>{t('composer.menu.retry')}</button></p>}
      {!commands.length && !resources.loading && <p className="px-2 py-3 typography-meta text-muted-foreground">{t('chat.commandAutocomplete.empty')}</p>}</>}>
    {children}
  </ComposerMenu>;
});
