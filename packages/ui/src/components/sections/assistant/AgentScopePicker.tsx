import React from 'react';
import type { AgentMemoryScope } from '@varin/protocol';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Seg, Select } from '../shared/kit';

export function AgentScopePicker({ scope, onChange, disabled, compact }: {
  scope: AgentMemoryScope; onChange(scope: AgentMemoryScope): void; disabled?: boolean; compact?: boolean;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const projectId = useProjectsStore(state => state.activeProjectId);
  const summaries = useThreadStore(state => state.threads);
  const threadId = useThreadStore(state => state.selectedIdentity?.threadId);
  const threads = React.useMemo(() => summaries.filter(thread => !thread.bot_id).map(thread => ({ id: thread.thread_id, name: thread.title || thread.thread_id })), [summaries]);
  const projectOptions = projects.map(project => ({ id: project.id, name: project.label || project.path }));
  const project = projectOptions.find(project => project.id === (scope.kind === 'project' ? scope.id : projectId)) ?? projectOptions[0];
  const thread = threads.find(thread => thread.id === (scope.kind === 'thread' ? scope.id : threadId)) ?? threads[0];
  const changeKind = (kind: AgentMemoryScope['kind']) => {
    if (kind === 'global') onChange({ kind });
    else {
      const id = kind === 'project' ? project?.id : thread?.id;
      if (id) onChange({ kind, id });
    }
  };
  const alternatives = scope.kind === 'project' ? projectOptions : scope.kind === 'thread' ? threads : [];
  if (compact) return <div className="sk-hstack wrap">
    <Seg value={scope.kind} label={t('assistant.scope')} disabled={disabled} onChange={changeKind} options={[
      { value: 'global', label: t('assistant.scope.global') },
      { value: 'project', label: project ? <span className="max-w-[min(15rem,36vw)] truncate">{t('settings.promptx.projectNamed', { name: project.name })}</span> : t('assistant.scope.project'),
        title: project?.name, disabled: !project },
      { value: 'thread', label: thread?.id === threadId && thread ? t('settings.promptx.currentThread') : t('settings.promptx.conversation'), disabled: !thread },
    ]} />
    {scope.kind !== 'global' && alternatives.length > 1 && <Select value={scope.id} disabled={disabled}
      label={t(scope.kind === 'project' ? 'assistant.scope.project' : 'settings.promptx.conversation')}
      options={alternatives.map(entry => ({ value: entry.id, label: entry.name }))}
      onChange={id => { if (scope.id !== id) onChange({ kind: scope.kind, id }); }} />}
    <span className="sk-faint text-xs">{t(`settings.promptx.scope.${scope.kind}`)}</span>
  </div>;
  return <nav className="space-y-1" aria-label={t('assistant.scope')}>
    {(['global', 'project', 'thread'] as const).map(kind => <React.Fragment key={kind}>
      <button type="button" disabled={disabled || (kind === 'project' && !projects.length) || (kind === 'thread' && !threads.length)}
        aria-current={scope.kind === kind ? 'page' : undefined}
        onClick={() => changeKind(kind)}
        className={cn('w-full rounded-md px-3 py-2 text-left typography-ui-label transition-colors disabled:opacity-40',
          scope.kind === kind ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>
        {t(`assistant.scope.${kind}`)}
      </button>
      {scope.kind === kind && kind !== 'global' ? <select disabled={disabled} value={scope.kind === 'global' ? '' : scope.id}
        aria-label={t(`assistant.scope.${kind}`)} onChange={event => onChange({ kind, id: event.target.value })}
        className="mb-3 w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 typography-meta">
        {(kind === 'project' ? projectOptions
          : threads.map(thread => ({ id: thread.id, name: thread.name })))
          .map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select> : null}
    </React.Fragment>)}
  </nav>;
}
