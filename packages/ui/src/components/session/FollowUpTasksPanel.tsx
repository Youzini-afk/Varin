import React from 'react';
import type { Followup } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type ThreadIdentity } from '@varin/application-client';
import { useThreadStore } from '@/stores/useThreadStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSelectedThreadSnapshot } from '@/hooks/useSelectedThreadSnapshot';
import { ThreadFollowups } from '@/components/thread/ThreadFollowups';
import { TaskSearch } from './TaskListPrimitives';
import { useI18n } from '@/lib/i18n';
import { useBotNavigation } from '@/lib/bots';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';

type Props = { createOpen?: boolean; onCreateOpenChange?(open: boolean): void; focus?: { identity: ThreadIdentity; followupId?: string; token: number } };
/** Browsing another scope does not navigate the workbench or retarget any arrangement. */
export function FollowUpTasksPanel(props: Props) {
  const host = useThreadStore(state => state.hostKey);
  return <FollowUpTasksContent key={host} {...props} />;
}
function FollowUpTasksContent({ createOpen, onCreateOpenChange, focus }: Props) {
  const { t } = useI18n();
  const api = useRuntimeAPIs().threads;
  const threads = useThreadStore(state => state.threads);
  const selected = useThreadStore(state => state.selectedIdentity);
  const botEntry = useBotNavigation(state => state.entry);
  const botWorkbench = useWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
  const [chosen, setChosen] = React.useState<ThreadIdentity>();
  const initial = chosen ?? focus?.identity ?? (botWorkbench ? botEntry ?? selected : selected) ?? undefined;
  const { identity, snapshot, error, refresh } = useSelectedThreadSnapshot(true, initial);
  const [pending, setPending] = React.useState(false);
  const [actionError, setActionError] = React.useState('');
  const [scope, setScope] = React.useState<'conversation' | 'bot'>(focus ? 'bot' : 'conversation');
  const [query, setQuery] = React.useState('');
  const [arrangements, setArrangements] = React.useState<{ botId: string; values: Followup[] }>();
  const [arrangementError, setArrangementError] = React.useState('');
  const [retry, setRetry] = React.useState(0);
  const botId = snapshot?.thread.bot_id;
  const owner = JSON.stringify([identity?.threadId, identity?.branchId]);
  const currentOwner = React.useRef(owner); currentOwner.current = owner;
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { if (focus) { setChosen(undefined); setScope('bot'); setQuery(''); } }, [focus]);
  React.useEffect(() => {
    if (!identity || !botId || !api) return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setArrangementError('');
    void api.followups.arrangements(identity, botId, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setArrangements({ botId, values: value });
    }, cause => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setArrangementError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [api, identity, botId, snapshot?.followups, retry]);
  const act = async (work: () => Promise<unknown>) => {
    const host = getRuntimeEndpointGeneration();
    const current = () => mounted.current && owner === currentOwner.current && host === getRuntimeEndpointGeneration();
    setPending(true); setActionError('');
    try { await work(); if (!current()) return; await refresh(); if (identity && botId && api) { const values = await api.followups.arrangements(identity, botId); if (current()) setArrangements({ botId, values }); } }
    catch (failure) { if (current()) setActionError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (current()) setPending(false); }
  };
  const choices = threads.filter(thread => !thread.deleted_at_ms);
  const selectedKnown = choices.some(thread => thread.thread_id === identity?.threadId);
  const rows = [...new Map([...(snapshot?.followups ?? []), ...(arrangements && arrangements.botId === botId ? arrangements.values : [])].map(item => [item.id, item])).values()];
  const visibleArrangementIds = new Set(rows.filter(item => (scope === 'bot' || item.thread_id === identity?.threadId && item.branch_id === identity?.branchId)
    && (!query.trim() || [item.name, item.id, item.trigger.kind === 'plugin_event' ? JSON.stringify(item.trigger.source) : item.trigger.kind].some(value => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))).map(item => item.id));
  return <section className="space-y-3">
    <label>{t('followups.conversation')} <select aria-label={t('followups.conversation')} className="min-w-0 max-w-full rounded-md border bg-background p-1.5" value={identity ? JSON.stringify([identity.threadId, identity.branchId]) : ''}
      onChange={event => { const [threadId, branchId] = JSON.parse(event.target.value) as [string, string]; setChosen({ runtime: 'agent', threadId, branchId }); setScope('conversation'); setActionError(''); setPending(false); }}>
      <option value="" disabled>{t('followups.selectConversation')}</option>
      {!selectedKnown && identity && <option value={JSON.stringify([identity.threadId, identity.branchId])}>{snapshot?.thread.title || identity.threadId}</option>}
      {choices.flatMap(thread => thread.branches.map(branch => <option key={JSON.stringify([thread.thread_id, branch.branch_id])} value={JSON.stringify([thread.thread_id, branch.branch_id])}>{thread.title || thread.thread_id}{thread.branches.length > 1 ? ` · ${branch.branch_id}` : ''}</option>))}
    </select></label>
    {botId && <div className="flex gap-2"><button type="button" aria-pressed={scope === 'conversation'} onClick={() => setScope('conversation')}>{t('arrangements.scopeConversation')}</button>
      <button type="button" aria-pressed={scope === 'bot'} onClick={() => setScope('bot')}>{t('arrangements.scopeBot')}</button></div>}
    <TaskSearch value={query} onChange={setQuery} label={t('arrangements.search')} />
    {createOpen && snapshot && !botId && !snapshot.activeRun && !snapshot.thread.branches.find(branch => branch.branch_id === identity?.branchId)?.latest_run && <p role="status">{t('followups.needsRun')}</p>}
    {(error || actionError || arrangementError) && <p role="alert">{error || actionError || arrangementError}<button type="button" onClick={() => { void refresh(); setRetry(value => value + 1); }}>{t('arrangements.retry')}</button></p>}
    {query.trim() && !visibleArrangementIds.size && <p>{t('arrangements.noMatches')}</p>}
    {identity && snapshot && api && <ThreadFollowups createOpen={createOpen} onCreateOpenChange={onCreateOpenChange} key={owner} api={api.followups} botId={botId} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={identity}
      focusId={focus?.followupId} focusToken={focus?.token} visibleArrangementIds={visibleArrangementIds}
      run={snapshot.activeRun ?? snapshot.thread.branches.find(branch => branch.branch_id === identity.branchId)?.latest_run ?? undefined}
      operations={snapshot.operations} followups={rows} pending={pending} act={act} cancelObservation={async operationId => { await api.cancelOperation(operationId); }} />}
  </section>;
}
