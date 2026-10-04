import React from 'react';
import type { AgentMemoryScope } from '@varin/protocol';
import { getRuntimeKey } from '@varin/application-client';
import { useBotSessionIndex, refreshBotSessionIndex, regularPiSessions } from '@/stores/useBotSessionIndex';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function AgentScopePicker({ scope, onChange, disabled }: {
  scope: AgentMemoryScope; onChange(scope: AgentMemoryScope): void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const projectId = useProjectsStore(state => state.activeProjectId);
  const summaries = usePiSessionStore(state => state.summaries);
  const botIndex = useBotSessionIndex();
  const runtimeKey = getRuntimeKey();
  React.useEffect(() => { void refreshBotSessionIndex(runtimeKey); }, [runtimeKey]);
  const sessions = React.useMemo(() => regularPiSessions(summaries, botIndex, runtimeKey), [summaries, botIndex, runtimeKey]);
  const sessionId = usePiSessionStore(state => state.currentSessionId);
  return <nav className="space-y-1" aria-label={t('assistant.scope')}>
    {(['global', 'project', 'session'] as const).map(kind => <React.Fragment key={kind}>
      <button type="button" disabled={disabled || (kind === 'project' && !projects.length) || (kind === 'session' && !sessions.length)}
        aria-current={scope.kind === kind ? 'page' : undefined}
        onClick={() => onChange(kind === 'global' ? { kind } : { kind, id: kind === 'project'
          ? projectId ?? projects[0]!.id : sessions.find(session => session.id === sessionId)?.id ?? sessions[0]!.id })}
        className={cn('w-full rounded-md px-3 py-2 text-left typography-ui-label transition-colors disabled:opacity-40',
          scope.kind === kind ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>
        {t(`assistant.scope.${kind}`)}
      </button>
      {scope.kind === kind && kind !== 'global' ? <select disabled={disabled} value={scope.kind === 'global' ? '' : scope.id}
        aria-label={t(`assistant.scope.${kind}`)} onChange={event => onChange({ kind, id: event.target.value })}
        className="mb-3 w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 typography-meta">
        {(kind === 'project' ? projects.map(project => ({ id: project.id, name: project.label || project.path }))
          : sessions.map(session => ({ id: session.id, name: session.name || session.firstMessage || session.cwd })))
          .map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select> : null}
    </React.Fragment>)}
  </nav>;
}
