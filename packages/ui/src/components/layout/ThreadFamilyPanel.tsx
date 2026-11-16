import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadCollaboration } from '@/components/thread/ThreadCollaboration';
import { useI18n } from '@/lib/i18n';
import type { ThreadIdentity } from '@varin/application-client';
export function ThreadFamilyPanel({ active = true, source, member, navigationKey, owner }: {
  active?: boolean; source?: ThreadIdentity; member?: ThreadIdentity; navigationKey?: number; owner?: ThreadIdentity | null;
}) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const selected = useThreadStore(state => state.selectedIdentity);
  const identity = owner === undefined ? selected : owner;
  if (!active) return null;
  const initialMember = identity && source?.threadId === identity.threadId && source.branchId === identity.branchId
    ? member : undefined;
  return identity && api?.family && api.messages && api.collaboration
    ? <ThreadCollaboration api={api} identity={identity} initialMember={initialMember} navigationKey={navigationKey} />
    : <p className="p-4 typography-meta text-muted-foreground">{t('collaboration.openConversation')}</p>;
}
