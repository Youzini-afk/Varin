import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadFollowupsAPI, type ThreadIdentity } from '@varin/application-client';
import type { Followup, FollowupSourceRoute } from '@varin/protocol';
import { arrangementTargetKey as targetKey, useArrangementExternalTargets } from './arrangementTargets';
import { useThreadStore } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = { api: ThreadFollowupsAPI; identity: ThreadIdentity; item: Followup; pending: boolean; act(work: () => Promise<unknown>): Promise<void> };

/** Routing is explicit authorization. Reading the map never adopts a sender as the user. */
export function ArrangementSourceRoutes(props: Props) {
  return <SourceRoutes key={JSON.stringify([props.identity, props.item.id])} {...props} />;
}
function SourceRoutes({ api, identity, item, pending, act }: Props) {
  const { t } = useI18n();
  const threads = useThreadStore(state => state.threads);
  const [routes, setRoutes] = React.useState<FollowupSourceRoute[]>();
  const [readError, setReadError] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  const [objectId, setObjectId] = React.useState('');
  const [target, setTarget] = React.useState('');
  const external = useArrangementExternalTargets(target);
  const [anchor, setAnchor] = React.useState({ threadId: item.thread_id ?? identity.threadId, branchId: item.branch_id ?? identity.branchId });
  const [userInput, setUserInput] = React.useState(false);
  const [senderId, setSenderId] = React.useState('');
  const [basis, setBasis] = React.useState(item.revision);
  const started = React.useRef(false);
  const beginDraft = () => { if (!started.current) { setBasis(item.revision); started.current = true; } };
  const [error, setError] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const request = React.useRef<FollowupSourceRoute | null>(null);
  const busy = React.useRef(false);
  const live = React.useRef(true);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setReadError('');
    void api.sourceRoutes(identity, item.id, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRoutes(value);
    }, cause => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setReadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [api, identity, item.id, item.revision, refresh]);
  const botId = item.owner.kind === 'bot' ? item.owner.bot_id : null;
  const targets: Array<{ threadId: string; branchId: string; externalConversationId?: string | null; label: string; reason?: string }> = threads.filter(thread => !thread.deleted_at_ms && !thread.archived && (!thread.bot_id || thread.bot_id === botId || thread.parent_thread_id))
    .flatMap(thread => thread.branches.map(branch => ({ threadId: thread.thread_id, branchId: branch.branch_id,
      label: `${thread.title || thread.thread_id}${thread.branches.length > 1 ? ` · ${branch.branch_id}` : ''}` })));
  targets.push(...external.entries.map(entry => ({ ...anchor, externalConversationId: entry.id, label: entry.label, reason: entry.reason })));
  const selected = targets.find(value => targetKey(value) === target);
  const disabled = pending || saving || uncertain;
  const valid = objectId.trim().length > 0 && !!selected && !selected.reason && external.selectable && (!userInput || senderId.trim().length > 0);
  const save = async () => {
    if (busy.current || pending || (!request.current && !valid)) return;
    if (!request.current) request.current = { followupId: item.id, expectedRevision: basis, objectId,
      threadId: selected!.threadId, branchId: selected!.branchId, externalConversationId: selected!.externalConversationId ?? null, userInput, senderId: userInput ? senderId : null };
    busy.current = true; setSaving(true); setError(''); setSaved(false);
    const host = getRuntimeEndpointGeneration();
    try {
      await act(async () => {
        try {
          const updated = await api.putSourceRoute({ ...identity, route: request.current! });
          if (!live.current || host !== getRuntimeEndpointGeneration()) return;
          request.current = null; setUncertain(false); setBasis(updated.revision); setSaved(true); setRefresh(value => value + 1);
        } catch (cause) {
          if (!live.current || host !== getRuntimeEndpointGeneration()) return;
          const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : null;
          if (status !== null && [400, 401, 403, 404, 409, 422].includes(status)) { request.current = null; setUncertain(false); }
          else setUncertain(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    } finally { busy.current = false; if (live.current && host === getRuntimeEndpointGeneration()) setSaving(false); }
  };
  const remove = async (route: FollowupSourceRoute) => {
    if (busy.current || pending || uncertain) return;
    busy.current = true; setSaving(true); setError(''); setSaved(false);
    const host = getRuntimeEndpointGeneration();
    try {
      await act(async () => {
        try {
          await api.removeSourceRoute({ ...identity, followupId: item.id, expectedRevision: item.revision, objectId: route.objectId });
          if (live.current && host === getRuntimeEndpointGeneration()) setRefresh(value => value + 1);
        } catch (cause) {
          if (live.current && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    } finally { busy.current = false; if (live.current && host === getRuntimeEndpointGeneration()) setSaving(false); }
  };
  const source = item.trigger.kind === 'plugin_event' ? item.trigger.source : null;
  return <section aria-label={t('arrangements.routes.title')} className="space-y-2 rounded border p-3">
    <h4 className="font-medium">{t('arrangements.routes.title')}</h4>
    {readError && <p role="alert">{readError}</p>}
    {!routes && !readError && <p role="status">{t('common.loading')}</p>}
    {routes?.length === 0 && <p>{t('arrangements.routes.empty')}</p>}
    <ul>{routes?.map(route => <li key={JSON.stringify([route.objectId, route.senderId, route.userInput])}>
      {route.objectId} → {targets.find(value => targetKey(value) === targetKey(route))?.label ?? route.externalConversationId ?? `${route.threadId} · ${route.branchId}`}
      {route.userInput && <span> · {t('arrangements.routes.userInput')} · {route.senderId}</span>}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { setObjectId(route.objectId); setTarget(targetKey(route)); setAnchor({ threadId: route.threadId, branchId: route.branchId }); setUserInput(route.userInput); setSenderId(route.senderId ?? ''); setBasis(item.revision); started.current = true; setSaved(false); }}>{t('arrangements.routes.edit', { object: route.objectId })}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void remove(route)}>{t('arrangements.routes.remove', { object: route.objectId })}</Button>
    </li>)}</ul>
    <Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>{t('arrangements.routes.refresh')}</Button>
    <label className="block">{t('arrangements.routes.object')}<Input aria-label={t('arrangements.routes.object')} value={objectId} disabled={disabled} onChange={event => { beginDraft(); setObjectId(event.target.value); setSaved(false); }} /></label>
    <label className="block">{t('arrangements.routes.target')}<select aria-label={t('arrangements.routes.target')} value={target} disabled={disabled} onChange={event => { beginDraft(); setTarget(event.target.value); setSaved(false); }}>
      <option value="">{t('followups.selectConversation')}</option>
      {target && !selected && <option value={target} disabled>{t('arrangements.routes.targetUnavailable')}</option>}
      {targets.map(value => <option key={targetKey(value)} value={targetKey(value)} disabled={!!value.reason}>{value.label}{value.reason ? ` · ${value.reason}` : ''}</option>)}
    </select></label>
    {external.id && <div className="space-y-1">{external.loading && <p role="status">{t('common.loading')}</p>}{external.error && <p role="alert">{external.error}</p>}{external.note && <p>{external.note}</p>}<Button size="sm" variant="ghost" onClick={external.refresh}>{t('arrangements.externalRefresh')}</Button></div>}
    {external.directoryError && <p role="status">{external.directoryError}</p>}
    <label className="flex gap-2"><input type="checkbox" checked={userInput} disabled={disabled} onChange={event => { beginDraft(); setUserInput(event.target.checked); setSaved(false); }} />{t('arrangements.routes.userInput')}</label>
    {userInput && <>
      <p>{t('arrangements.routes.authorize', { account: source?.accountId ?? '', object: objectId })}</p>
      <label className="block">{t('arrangements.routes.sender')}<Input aria-label={t('arrangements.routes.sender')} value={senderId} disabled={disabled} onChange={event => { beginDraft(); setSenderId(event.target.value); setSaved(false); }} /></label>
    </>}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="status">{t('arrangements.uncertain')}</p>}
    {saved && <p role="status">{t('arrangements.routes.saved')}</p>}
    <Button size="sm" disabled={pending || saving || (!uncertain && !valid)} onClick={() => void save()}>{t(uncertain ? 'arrangements.retrySave' : 'arrangements.routes.save')}</Button>
  </section>;
}
