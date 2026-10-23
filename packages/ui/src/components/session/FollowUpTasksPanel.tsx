import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { ThreadFollowups } from '@/components/thread/ThreadFollowups';
import { useI18n } from '@/lib/i18n';

/** Follow-ups retain their original native branch and source Run. */
export function FollowUpTasksPanel({ createOpen, onCreateOpenChange }: { createOpen?: boolean; onCreateOpenChange?(open: boolean): void }) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const threads = useThreadStore(state => state.threads);
  const { identity, snapshot, error } = useSelectedThreadSnapshot();
  const [pending, setPending] = React.useState(false);
  const [actionError, setActionError] = React.useState('');
  const act = async (work: () => Promise<unknown>) => { setPending(true); setActionError(''); try { await work(); } catch (failure) { setActionError(failure instanceof Error ? failure.message : String(failure)); } finally { setPending(false); } };
  return <section className="space-y-3">
    <label>{t('followups.conversation')} <select className="min-w-0 max-w-full rounded-md border bg-background p-1.5" value={identity?.threadId ?? ''} onChange={event => void act(() => useThreadStore.getState().selectThread({ threadId: event.target.value }))}>
      <option value="" disabled>{t('followups.selectConversation')}</option>{threads.filter(thread => !thread.bot_id && !thread.deleted_at_ms).map(thread => <option key={thread.thread_id} value={thread.thread_id}>{thread.title || thread.thread_id}</option>)}
    </select></label>
    {createOpen && snapshot && !snapshot.activeRun && !snapshot.thread.branches.find(branch => branch.branch_id === identity?.branchId)?.latest_run && <p role="status">{t('followups.needsRun')}</p>}
    {(error || actionError) && <p role="alert">{error || actionError}</p>}
    {identity && snapshot && api && <ThreadFollowups createOpen={createOpen} onCreateOpenChange={onCreateOpenChange} key={`${identity.threadId}:${identity.branchId}`} api={api.followups} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={identity}
      run={snapshot.activeRun ?? snapshot.thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run ?? undefined}
      operations={snapshot.operations} followups={snapshot.followups} pending={pending} act={act} cancelObservation={async operationId => { await api.cancelOperation(operationId); }} />}
  </section>;
}
