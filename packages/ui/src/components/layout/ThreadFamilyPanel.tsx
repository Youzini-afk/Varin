import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { ThreadCollaboration } from '@/components/thread/ThreadCollaboration';
import { useI18n } from '@/lib/i18n';
export function ThreadFamilyPanel({ active = true }: { active?: boolean }) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  if (!active) return null;
  return identity && api?.family && api.messages && api.collaboration ? <ThreadCollaboration api={api} identity={identity} /> : <p className="p-4 typography-meta text-muted-foreground">{t('collaboration.openConversation')}</p>;
}
