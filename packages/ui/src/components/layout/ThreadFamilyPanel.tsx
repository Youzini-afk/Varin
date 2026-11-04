import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadCollaboration } from '@/components/thread/ThreadCollaboration';
import { useI18n } from '@/lib/i18n';
import type { ThreadIdentity } from '@varin/application-client';
export function ThreadFamilyPanel({ active = true, source, member, navigationKey }: {
  active?: boolean; source?: ThreadIdentity; member?: ThreadIdentity; navigationKey?: number;
}) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  if (!active) return null;
  const initialMember = identity && source?.threadId === identity.threadId && source.branchId === identity.branchId
    ? member : undefined;
  return identity && api?.family && api.messages && api.collaboration
    ? <ThreadCollaboration api={api} identity={identity} initialMember={initialMember} navigationKey={navigationKey} />
    : <p className="p-4 typography-meta text-muted-foreground">{t('collaboration.openConversation')}</p>;
}
