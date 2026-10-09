import type { ThreadIdentity } from '@varin/application-client';
import type { ContextPersonalization, AgentMemoryScope } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { AgentMemoryPage } from '@/components/sections/assistant/AgentMemoryPage';

/** UI projection only; the existing settings editor and Host owner perform every CAS. */
export function ThreadMemory({ identity, basis }: { identity: ThreadIdentity; basis: ContextPersonalization }) {
  const { t } = useI18n();
  if (basis.mode !== 'agent' || basis.sessionId !== identity.threadId) return null;
  const scopes: Array<{ scope: AgentMemoryScope; label: string }> = [
    { scope: { kind: 'global' }, label: t('assistant.scope.global') },
    ...(basis.projectId ? [{ scope: { kind: 'project' as const, id: basis.projectId }, label: t('assistant.scope.project') }] : []),
    { scope: { kind: 'session', id: identity.threadId }, label: t('assistant.scope.session') },
  ];
  return <details className="mx-auto max-h-80 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-sm">
    <summary className="cursor-pointer">{t('assistant.memory.title')}</summary>
    <div className="py-3"><AgentMemoryPage embedded initialScope={{ kind: 'session', id: identity.threadId }} scopes={scopes} /></div>
  </details>;
}
