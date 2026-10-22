import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadCollaboration } from '@/components/thread/ThreadCollaboration';
import { useI18n } from '@/lib/i18n';
import type { ThreadIdentity } from '@varin/application-client';
export function ThreadFamilyPanel({ active = true, identity: originalIdentity, member, navigationKey }: {
  active?: boolean; identity?: ThreadIdentity; member?: ThreadIdentity; navigationKey?: number;
}) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const selected = useThreadStore(state => state.selectedIdentity);
  const identity = originalIdentity ?? selected;
  if (!active) return null;
  return identity && api?.family && api.messages && api.collaboration ? <ThreadCollaboration api={api} identity={identity} initialMember={member} navigationKey={navigationKey} /> : <p className="p-4 typography-meta text-muted-foreground">{t('collaboration.openConversation')}</p>;
}
