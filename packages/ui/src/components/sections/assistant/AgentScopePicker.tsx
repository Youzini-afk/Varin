import React from 'react';
import type { AgentMemoryScope } from '@varin/protocol';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function AgentScopePicker({ scope, onChange, disabled }: {
  scope: AgentMemoryScope; onChange(scope: AgentMemoryScope): void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const projectId = useProjectsStore(state => state.activeProjectId);
  const summaries = useThreadStore(state => state.threads);
  const threadId = useThreadStore(state => state.selectedIdentity?.threadId);
  const threads = React.useMemo(() => summaries.filter(thread => !thread.bot_id).map(thread => ({ id: thread.thread_id, name: thread.title || thread.thread_id })), [summaries]);
  return <nav className="space-y-1" aria-label={t('assistant.scope')}>
    {(['global', 'project', 'thread'] as const).map(kind => <React.Fragment key={kind}>
      <button type="button" disabled={disabled || (kind === 'project' && !projects.length) || (kind === 'thread' && !threads.length)}
        aria-current={scope.kind === kind ? 'page' : undefined}
        onClick={() => onChange(kind === 'global' ? { kind } : { kind, id: kind === 'project'
          ? projectId ?? projects[0]!.id : threads.find(thread => thread.id === threadId)?.id ?? threads[0]!.id })}
        className={cn('w-full rounded-md px-3 py-2 text-left typography-ui-label transition-colors disabled:opacity-40',
          scope.kind === kind ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>
        {t(`assistant.scope.${kind}`)}
      </button>
      {scope.kind === kind && kind !== 'global' ? <select disabled={disabled} value={scope.kind === 'global' ? '' : scope.id}
        aria-label={t(`assistant.scope.${kind}`)} onChange={event => onChange({ kind, id: event.target.value })}
        className="mb-3 w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 typography-meta">
        {(kind === 'project' ? projects.map(project => ({ id: project.id, name: project.label || project.path }))
          : threads.map(thread => ({ id: thread.id, name: thread.name })))
          .map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select> : null}
    </React.Fragment>)}
  </nav>;
}
