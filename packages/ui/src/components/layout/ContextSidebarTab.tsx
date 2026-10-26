import type { ThreadIdentity } from '@varin/application-client';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { ContextInspector } from '@/components/context/ContextInspector';

export function ContextPanelContent({ active = true, identity: requestedIdentity, jobRunId, readOnly }: { active?: boolean; identity?: ThreadIdentity; jobRunId?: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const { identity, snapshot, error } = useSelectedThreadSnapshot(active, requestedIdentity);
  const api = useRuntimeAPIs().threads;
  const host = useThreadStore(state => state.hostKey);
  if (!identity) return <div className="p-6 typography-ui-label text-muted-foreground">{t('contextSidebar.empty.openSession')}</div>;
  if (!snapshot || !api) return <p role={error ? 'alert' : 'status'} className="p-4 typography-meta">{error || t('common.loading')}</p>;
  return <ContextInspector key={JSON.stringify([host, identity.threadId, identity.branchId])} {...{ api, identity, snapshot, active, error, jobRunId, readOnly }} />;
}
