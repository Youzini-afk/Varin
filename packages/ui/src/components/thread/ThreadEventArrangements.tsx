import React from 'react';
import { createScheduledTasksHttpAPI, getRuntimeEndpointGeneration, type ScheduledTask, type ThreadFollowupsAPI, type ThreadIdentity } from '@varin/application-client';
import type { Followup, FollowupArrangementPutParams, FollowupEventTiming } from '@varin/protocol';
import type { VarinEventSourceDescriptor, VarinEventSourceHost } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { arrangementTargetKey as targetKey, externalTargetId, useArrangementExternalTargets } from './arrangementTargets';
import { ArrangementSourceRoutes } from './ArrangementSourceRoutes';
import { EventSourceConditions } from './EventSourceConditions';
import { eventConditionsValid } from './eventConditionSchema';
import { formatSchedule } from '@/components/session/scheduleFormat';
import { followupStatus } from '@/lib/followupPresentation';

type Props = { api: ThreadFollowupsAPI; identity: ThreadIdentity; botId?: string | null; followups: Followup[];
  focusId?: string; focusToken?: number; createOpen?: boolean; onCreateOpenChange?(open: boolean): void; visibleArrangementIds?: Set<string>;
  pending: boolean; act(work: () => Promise<unknown>): Promise<void>; records(item: Followup): React.ReactNode };
const schedules = createScheduledTasksHttpAPI();
const sourceKey = (value: { extensionId: string; sourceId: string; host?: VarinEventSourceHost }) => JSON.stringify([value.extensionId, value.sourceId, ...(value.host ? [value.host.hostId, value.host.connectionId, value.host.endpointIdentity] : [])]);

async function openSourceSettings(source?: { extensionId: string; host?: VarinEventSourceHost } | null) {
  const ui = useUIStore.getState();
  if (source?.host) { ui.setSettingsPage('work-connections'); ui.setSettingsDialogOpen(true); return; }
  const { getSettingsPageRegistrations, varinSurfaceRuntime } = await import('@/lib/settings/surface-registry');
  const snapshot = varinSurfaceRuntime.getSnapshot();
  const owned = snapshot.visibleContributions.filter(item => item.owner.extensionId === source?.extensionId && item.descriptor.kind === 'settings-page')
    .sort((a, b) => Number(b.descriptor.data.primary === true) - Number(a.descriptor.data.primary === true));
  const pages = getSettingsPageRegistrations();
  const context = { isWeb: varinSurfaceRuntime.surface === 'web', isDesktop: varinSurfaceRuntime.surface === 'desktop', isMobile: varinSurfaceRuntime.surface === 'mobile', mcpInstalled: true };
  const page = owned.flatMap(item => pages.filter(page => page.contributionId === item.descriptor.id && (!page.meta.isAvailable || page.meta.isAvailable(context))))[0];
  ui.setSettingsPage(page?.meta.slug ?? 'extensions'); ui.setSettingsDialogOpen(true);
}

/** Durable facts are projected here. Drafts and expansion never own receiving or execution. */
export function ThreadEventArrangements(props: Props) {
  const host = useThreadStore(state => state.hostKey);
  const { runtime, threadId, branchId } = props.identity;
  const identity = React.useMemo<ThreadIdentity>(() => ({ runtime, threadId, branchId }), [runtime, threadId, branchId]);
  return <EventArrangements key={JSON.stringify([host, getRuntimeEndpointGeneration(), threadId, branchId])} {...props} identity={identity} />;
}
function EventArrangements({ api, identity, botId, followups, pending, act, records, focusId, focusToken, createOpen, onCreateOpenChange, visibleArrangementIds }: Props) {
  const { t } = useI18n();
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState(false);
  const [creationKey, setCreationKey] = React.useState(0);
  const resetCreation = React.useRef(false);
  const openCreation = React.useCallback((open: boolean) => {
    if (open) {
      setCreated(true);
      if (resetCreation.current) { resetCreation.current = false; setCreationKey(value => value + 1); }
    }
    setCreating(open);
  }, []);
  React.useEffect(() => { if (createOpen && botId) { openCreation(true); onCreateOpenChange?.(false); } }, [createOpen, botId, onCreateOpenChange, openCreation]);
  const hasEvents = followups.some(item => item.trigger.kind === 'plugin_event');
  const [directory, setDirectory] = React.useState<VarinEventSourceDescriptor[]>([]);
  React.useEffect(() => { if (!botId && !hasEvents) return; const controller = new AbortController(); const host = getRuntimeEndpointGeneration();
    void api.eventSources(identity, controller.signal).then(values => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setDirectory(values); }, () => {});
    return () => controller.abort();
  }, [api, identity, botId, hasEvents]);
  const items = followups.filter(item => item.trigger.kind === 'plugin_event');
  return <section className="space-y-3" aria-label={t('arrangements.title')}>
    {botId && <Collapsible open={creating} onOpenChange={openCreation}>
    <CollapsibleTrigger asChild className="w-auto"><Button size="sm" variant="outline">
      <Icon name="add" className="mr-1 size-3.5" />{t(creating ? 'arrangements.cancelEdit' : 'arrangements.create')}
    </Button></CollapsibleTrigger>
    <CollapsibleContent keepMounted>{created && <div className="pt-3"><ArrangementEditor key={creationKey} api={api} identity={identity} botId={botId} pending={pending}
      act={act} onSaved={() => { resetCreation.current = true; setCreating(false); }} /></div>}</CollapsibleContent>
    </Collapsible>}
    {items.map(item => <div key={item.id} hidden={visibleArrangementIds ? !visibleArrangementIds.has(item.id) : undefined}><ArrangementRow api={api} identity={identity}
      focusId={focusId} focusToken={focusToken} descriptor={item.trigger.kind === 'plugin_event' ? directory.find(source => sourceKey(source) === sourceKey(item.trigger.kind === 'plugin_event' ? item.trigger.source : { extensionId: '', sourceId: '' })) : undefined} item={item} pending={pending} act={act} records={records} /></div>)}
  </section>;
}

function ArrangementRow({ api, identity, item, pending, act, records, focusId, focusToken, descriptor }: Omit<Props, 'followups' | 'botId'> & { item: Followup; descriptor?: VarinEventSourceDescriptor }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(focusId === item.id);
  React.useEffect(() => { if (focusId === item.id) setOpen(true); }, [focusId, focusToken, item.id]);
  const [editing, setEditing] = React.useState(false);
  const [routesOpen, setRoutesOpen] = React.useState(false);
  const [routesVisited, setRoutesVisited] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const [instruction, setInstruction] = React.useState<string>();
  const [basis, setBasis] = React.useState<Followup>();
  const [editKey, setEditKey] = React.useState(0);
  const refreshEdit = React.useRef(false);
  const [error, setError] = React.useState('');
  const [reading, setReading] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const live = React.useRef(true);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const source = item.trigger.kind === 'plugin_event' ? item.trigger.source : null;
  const botId = item.owner.kind === 'bot' ? item.owner.bot_id : null;
  const beginEdit = async () => {
    if (instruction !== undefined && !refreshEdit.current) { setEditing(true); return; }
    setError(''); setReading(true); setSaved(false);
    const host = getRuntimeEndpointGeneration();
    try {
      const original = await api.get(identity, item.id);
      if (!live.current || host !== getRuntimeEndpointGeneration()) return;
      refreshEdit.current = false; setEditKey(value => value + 1);
      setInstruction(original.instruction ?? ''); setBasis(original.followup); setEditing(true);
    } catch (cause) { if (live.current && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (live.current && host === getRuntimeEndpointGeneration()) setReading(false); }
  };
  const status = item.source_status;
  return <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border/60">
    <CollapsibleTrigger className="gap-2 p-3">
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{item.name ?? source?.sourceId ?? item.id}</span>
        <span className="block truncate text-xs text-muted-foreground">{descriptor?.displayName ?? source?.sourceId} · {descriptor?.connections.find(value => value.connectionId === source?.connectionId && value.accountId === source?.accountId)?.displayName ?? source?.connectionId}{source?.host ? ` · ${source.host.hostId}` : ''} · {followupStatus(item, t)}{item.pending_events > 0 ? ` · ${t('arrangements.pending', { count: item.pending_events })}` : ''}{item.next_delivery_at_ms !== null ? ` · ${t('arrangements.next', { time: new Date(item.next_delivery_at_ms).toLocaleString() })}` : ''}</span>
      </span><Icon name={open ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5 shrink-0" />
    </CollapsibleTrigger>
    <CollapsibleContent keepMounted><div className="space-y-3 px-3 pb-3">
      {item.pending_events > 0 && <p>{t('arrangements.pending', { count: item.pending_events })}</p>}
      {item.next_delivery_at_ms !== null && <p>{t('arrangements.next', { time: new Date(item.next_delivery_at_ms).toLocaleString() })}</p>}
      {!status ? <p className="text-muted-foreground">{t('arrangements.unknownHealth')}</p>
        : status.code ? <p role="status">{t('arrangements.unavailable', { code: status.code })}{status.message ? ` · ${status.message}` : ''}</p> : null}
      {status?.coverage?.fromMs != null && <p>{t('arrangements.coverage', { time: new Date(status.coverage.fromMs).toLocaleString() })}</p>}
      {error && <p role="alert">{error}</p>}{saved && <p role="status">{t('arrangements.saved')}</p>}
      <div className="flex flex-wrap gap-1">
        {botId && item.state !== 'cancelled' && <Button size="sm" variant="ghost" disabled={pending || reading} onClick={() => editing ? setEditing(false) : void beginEdit()}>{t(editing ? 'arrangements.cancelEdit' : 'arrangements.edit')}</Button>}
        {item.state !== 'cancelled' && <>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act(() => api.control({ ...identity, followupId: item.id, expectedRevision: item.revision, action: item.state === 'paused' ? 'resume' : 'pause' }))}>{t(item.state === 'paused' ? 'arrangements.resume' : 'arrangements.pause')}</Button>
          <Button size="sm" variant="ghost" disabled={pending || item.state === 'paused'} onClick={() => void act(() => api.backlog({ ...identity, followupId: item.id, expectedRevision: item.revision, action: 'process_now' }))}>{t('arrangements.processNow')}</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDiscarding(true)}>{t('arrangements.discard')}</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act(() => api.control({ ...identity, followupId: item.id, expectedRevision: item.revision, action: 'cancel' }))}>{t('arrangements.cancel')}</Button>
        </>}
      </div>
      {discarding && <div role="group" aria-label={t('arrangements.discard')} className="space-y-2 rounded border p-2">
        <p>{t('arrangements.discardQuestion')}</p>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void act(async () => { await api.backlog({ ...identity, followupId: item.id, expectedRevision: item.revision, action: 'discard' }); setDiscarding(false); })}>{t('arrangements.confirmDiscard')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDiscarding(false)}>{t('arrangements.keep')}</Button>
      </div>}
      {botId && <Collapsible open={editing}><CollapsibleContent keepMounted>{instruction !== undefined && <ArrangementEditor key={editKey} api={api} identity={identity} botId={botId}
        original={basis ?? item} instruction={instruction} pending={pending} act={act} onSaved={() => { refreshEdit.current = true; setEditing(false); setSaved(true); }} />}</CollapsibleContent></Collapsible>}
      {botId && <Collapsible open={routesOpen} onOpenChange={value => { setRoutesOpen(value); setRoutesVisited(true); }}>
        <CollapsibleTrigger>{t('arrangements.routes.title')}</CollapsibleTrigger><CollapsibleContent keepMounted>{routesVisited && <ArrangementSourceRoutes api={api} identity={identity} item={item} pending={pending} act={act} />}</CollapsibleContent>
      </Collapsible>}
      <details><summary className="cursor-pointer">{t('arrangements.records')}</summary>{records(item)}</details>
    </div></CollapsibleContent>
  </Collapsible>;
}

/** Source refresh changes choices, never the draft or its original revision. */
function ArrangementEditor({ api, identity, botId, original, instruction = '', pending, act, onSaved }: {
  api: ThreadFollowupsAPI; identity: ThreadIdentity; botId: string; original?: Followup; instruction?: string;
  pending: boolean; act(work: () => Promise<unknown>): Promise<void>; onSaved(): void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = React.useState<VarinEventSourceDescriptor[]>();
  const [sourceError, setSourceError] = React.useState(false);
  const [refresh, setRefresh] = React.useState(0);
  const threads = useThreadStore(state => state.threads);
  const trigger = original?.trigger.kind === 'plugin_event' ? original.trigger : null;
  const [basis, setBasis] = React.useState(original);
  const [conflict, setConflict] = React.useState(false);
  const [key] = React.useState(() => original?.id ?? crypto.randomUUID());
  const [name, setName] = React.useState(original?.name ?? '');
  const [intent, setIntent] = React.useState(instruction);
  const [selectedSource, setSelectedSource] = React.useState(trigger ? sourceKey(trigger.source) : '');
  const [connectionId, setConnectionId] = React.useState(trigger?.source.connectionId ?? '');
  const [accountId, setAccountId] = React.useState(trigger?.source.accountId ?? '');
  const [filter, setFilter] = React.useState<Record<string, unknown>>(() => trigger?.filter && typeof trigger.filter === 'object' && !Array.isArray(trigger.filter) ? trigger.filter as Record<string, unknown> : {});
  const [filterValid, setFilterValid] = React.useState(true);
  const [calendars, setCalendars] = React.useState<ScheduledTask[]>();
  const [calendarError, setCalendarError] = React.useState(false);
  const [timing, setTiming] = React.useState<FollowupEventTiming['kind']>(original?.timing.kind ?? 'immediate');
  const [windowSeconds, setWindowSeconds] = React.useState(original?.timing.kind === 'batch' ? String(original.timing.windowMs / 1000) : '');
  const [calendarId, setCalendarId] = React.useState(original?.timing.kind === 'scheduled' ? original.timing.calendarId : '');
  const [runEmpty, setRunEmpty] = React.useState(original?.timing.kind === 'scheduled' && original.timing.runEmpty);
  const [repeat, setRepeat] = React.useState(original?.repeat ?? 'each');
  const [target, setTarget] = React.useState(targetKey(original ? { threadId: original.thread_id, branchId: original.branch_id, externalConversationId: original.external_conversation_id } : identity));
  const [firstContact, setFirstContact] = React.useState(original?.first_contact === 'create_bot_session' && !original.external_conversation_id);
  const external = useArrangementExternalTargets(target);
  const [anchor] = React.useState(() => original ? { threadId: original.thread_id, branchId: original.branch_id } : { threadId: identity.threadId, branchId: identity.branchId });
  const [error, setError] = React.useState('');
  const [uncertain, setUncertain] = React.useState(false);
  const request = React.useRef<FollowupArrangementPutParams | null>(null);
  const saving = React.useRef(false);
  const [savingLocal, setSavingLocal] = React.useState(false);
  const live = React.useRef(true);
  React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration();
    setSourceError(false);
    void api.eventSources(identity, controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setSources(value);
    }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setSourceError(true); });
    return () => controller.abort();
  }, [api, identity, refresh]);
  React.useEffect(() => {
    if (timing !== 'scheduled') return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setCalendarError(false);
    void schedules.list(`bot:${botId}`, controller.signal).then(value => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setCalendars(value); }, () => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setCalendarError(true); });
    return () => controller.abort();
  }, [botId, timing, refresh]);
  const source = sources?.find(value => sourceKey(value) === selectedSource);
  const connection = source?.connections.find(value => value.connectionId === connectionId && value.accountId === accountId);
  const targets = new Map<string, { threadId: string; branchId: string; externalConversationId?: string | null; label: string; reason?: string }>();
  for (const thread of threads.filter(value => !value.deleted_at_ms && !value.archived && (!value.bot_id || value.bot_id === botId || value.parent_thread_id))) {
    for (const branch of thread.branches) {
      const value = { threadId: thread.thread_id, branchId: branch.branch_id };
      targets.set(targetKey(value), { ...value, label: `${thread.title || thread.thread_id}${thread.branches.length > 1 ? ` · ${branch.branch_id}` : ''}` });
    }
  }
  // The current explicitly selected identity remains a choice even before catalog discovery finishes.
  if (!targets.has(targetKey(identity))) targets.set(targetKey(identity), { ...identity, label: identity.threadId });
  for (const entry of external.entries) targets.set(targetKey({ ...anchor, externalConversationId: entry.id }), { ...anchor, externalConversationId: entry.id, label: entry.label, reason: entry.reason });
  const selectedTarget = targets.get(target);
  const parsedFilter = source && filterValid && eventConditionsValid(source.filterSchema, filter) ? filter : null;
  const availableCalendars = (calendars ?? []).filter(task => task.calendar && task.enabled && !task.calendar.definition.deleted && task.target.kind === 'existing_work' && targetKey(task.target) === targetKey({ threadId: selectedTarget?.threadId ?? anchor.threadId, branchId: selectedTarget?.branchId ?? anchor.branchId }));
  const targetMissing = !targets.has(target);
  const ms = Number(windowSeconds) * 1000;
  const valid = !!name.trim() && !!intent.trim() && !!source?.available && !!connection?.available && !!accountId && !!parsedFilter && targets.has(target) && external.selectable && !selectedTarget?.reason
    && (timing !== 'batch' || windowSeconds.trim() !== '' && Number.isSafeInteger(ms) && ms > 0)
    && (timing !== 'scheduled' || availableCalendars.some(task => task.calendar!.definition.id === calendarId));
  const disabled = pending || savingLocal || uncertain;
  const save = async () => {
    if (saving.current) return;
    setError('');
    if (!request.current) {
      if (!valid || !source || !parsedFilter) return;
      const selectedTarget = targets.get(target)!;
      request.current = { key, ...(basis ? { expectedRevision: basis.revision } : {}), botId,
        threadId: selectedTarget.threadId, branchId: selectedTarget.branchId, externalConversationId: selectedTarget.externalConversationId ?? null,
        firstContact: !selectedTarget.externalConversationId && firstContact ? 'create_bot_session' : null, name: name.trim(), instruction: intent,
        source: { ...(source.host ? { host: source.host } : {}), extensionId: source.extensionId, sourceId: source.sourceId, connectionId, accountId }, filter: parsedFilter,
        timing: timing === 'batch' ? { kind: timing, windowMs: ms } : timing === 'scheduled' ? { kind: timing, calendarId, runEmpty } : { kind: timing }, repeat };
    }
    saving.current = true; setSavingLocal(true);
    const host = getRuntimeEndpointGeneration();
    await act(async () => {
      try { await api.putArrangement({ ...identity, arrangement: request.current! }); if (live.current && host === getRuntimeEndpointGeneration()) onSaved(); }
      catch (cause) {
        if (!live.current || host !== getRuntimeEndpointGeneration()) return;
        const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : null;
        if (status !== null && [400, 401, 403, 404, 409, 422].includes(status)) { request.current = null; setUncertain(false); setConflict(status === 409); }
        else setUncertain(true);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally { saving.current = false; if (live.current && host === getRuntimeEndpointGeneration()) setSavingLocal(false); }
    });
  };
  return <div className="space-y-3 rounded-lg border p-3" aria-label={t('arrangements.edit')}>
    <label className="block">{t('arrangements.name')}<Input aria-label={t('arrangements.name')} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
    <label className="block">{t('arrangements.source')}<select aria-label={t('arrangements.source')} className="block max-w-full" value={selectedSource} disabled={disabled} onChange={event => { setSelectedSource(event.target.value); setConnectionId(''); setAccountId(''); setFilter({}); setFilterValid(true); }}>
      <option value="">{t('arrangements.selectSource')}</option>
      {selectedSource && !source && <option value={selectedSource}>{trigger?.source.sourceId ?? selectedSource}</option>}
      {sources?.map(value => <option key={sourceKey(value)} value={sourceKey(value)} disabled={!value.available}>{value.displayName} · {value.extensionId}{value.host ? ` · ${value.host.hostId}` : ''}{value.code ? ` · ${value.code}` : ''}</option>)}
    </select></label>
    {sourceError ? <p role="alert">{t('arrangements.sourceError')}</p> : sources?.length === 0 ? <p>{t('arrangements.noSources')}</p> : !sources ? <p role="status">{t('common.loading')}</p> : null}
    <div className="flex gap-1"><Button size="sm" variant="ghost" disabled={pending} onClick={() => setRefresh(value => value + 1)}>{t('arrangements.reload')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void openSourceSettings(source ?? trigger?.source).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{t('arrangements.configuration')}</Button></div>
    {source && <>
      <label className="block">{t('arrangements.connection')}<select aria-label={t('arrangements.connection')} className="block max-w-full" value={connection ? JSON.stringify([connectionId, accountId]) : ''} disabled={disabled}
        onChange={event => { const [connection, account] = event.target.value ? JSON.parse(event.target.value) as [string, string] : ['', '']; setConnectionId(connection); setAccountId(account); }}>
        <option value="">{t('arrangements.selectConnection')}</option>{source.connections.map(value => <option key={JSON.stringify([value.connectionId, value.accountId])}
          value={JSON.stringify([value.connectionId, value.accountId])} disabled={!value.available || !value.accountId}>{value.displayName}{value.code ? ` · ${value.code}` : ''}</option>)}
      </select></label>
      {connectionId && !connection && <p role="status">{t('arrangements.accountChanged')}</p>}
      {source.recovery === 'realtime' && <p className="text-muted-foreground">{t('arrangements.realtime')}</p>}
      {source.description && <p className="text-muted-foreground">{source.description}</p>}
      <EventSourceConditions key={selectedSource} schema={source.filterSchema} value={filter} disabled={disabled} onChange={setFilter} onValidityChange={setFilterValid} />
    </>}
    <label className="block">{t('arrangements.instruction')}<Textarea aria-label={t('arrangements.instruction')} value={intent} disabled={disabled} onChange={event => setIntent(event.target.value)} rows={3} /></label>
    <label className="block">{t('arrangements.target')}<select aria-label={t('arrangements.target')} className="block max-w-full" value={target} disabled={disabled} onChange={event => { setTarget(event.target.value); if (externalTargetId(event.target.value)) setFirstContact(false); }}>
      {targetMissing && <option value={target} disabled>{t('arrangements.targetMissing')}</option>}
      {[...targets].map(([key, value]) => <option key={key} value={key} disabled={!!value.reason}>{value.label}{value.reason ? ` · ${value.reason}` : ''}</option>)}
    </select></label>
    {external.id && <div className="space-y-1">{external.loading && <p role="status">{t('common.loading')}</p>}{external.error && <p role="alert">{external.error}</p>}{external.note && <p className="text-muted-foreground">{external.note}</p>}<Button size="sm" variant="ghost" onClick={external.refresh}>{t('arrangements.externalRefresh')}</Button></div>}
    {external.directoryError && <p role="status">{external.directoryError}</p>}
    {!external.id && <div className="space-y-1"><label className="flex gap-2"><input type="checkbox" aria-label={t('arrangements.firstContact')} checked={firstContact} disabled={disabled} onChange={event => setFirstContact(event.target.checked)} />{t('arrangements.firstContact')}</label>
      <p className="text-xs text-muted-foreground">{t('arrangements.firstContactDescription')}</p></div>}
    <label className="block">{t('arrangements.timing')}<select aria-label={t('arrangements.timing')} className="block" value={timing} disabled={disabled} onChange={event => setTiming(event.target.value as FollowupEventTiming['kind'])}>
      {(['immediate', 'batch', 'scheduled', 'passive'] as const).map(value => <option key={value} value={value}>{t(`arrangements.${value}`)}</option>)}
    </select></label>
    {timing === 'batch' && <label className="block">{t('arrangements.window')}<Input aria-label={t('arrangements.window')} value={windowSeconds} disabled={disabled} inputMode="decimal" onChange={event => setWindowSeconds(event.target.value)} /></label>}
    {timing === 'scheduled' && <><label className="block">{t('arrangements.calendar')}<select aria-label={t('arrangements.calendar')} value={calendarId} disabled={disabled} onChange={event => setCalendarId(event.target.value)}>
      <option value="">{t('arrangements.selectCalendar')}</option>
      {calendarId && !availableCalendars.some(task => task.calendar!.definition.id === calendarId) && <option value={calendarId} disabled>{t('arrangements.calendarMissing')}</option>}
      {availableCalendars.map(task => <option key={task.id} value={task.calendar!.definition.id}>{task.name} · {formatSchedule(task, t)}</option>)}
    </select></label>{calendarError ? <p role="alert">{t('arrangements.calendarError')}</p> : calendars && !availableCalendars.length ? <p>{t('arrangements.noCalendars')}</p> : null}
      <label className="flex gap-2"><input type="checkbox" aria-label={t('arrangements.runEmpty')} checked={runEmpty} disabled={disabled} onChange={event => setRunEmpty(event.target.checked)} />{t('arrangements.runEmpty')}</label></>}
    <label className="block">{t('followups.repetition')}<select className="block" value={repeat} disabled={disabled} onChange={event => setRepeat(event.target.value as 'once' | 'each')}>
      <option value="each">{t('arrangements.each')}</option><option value="once">{t('arrangements.once')}</option>
    </select></label>
    {error && <p role="alert">{error}</p>}{conflict && <Button size="sm" variant="outline" disabled={disabled} onClick={() => { const host = getRuntimeEndpointGeneration(); void api.get(identity, key).then(value => { if (live.current && host === getRuntimeEndpointGeneration()) { setBasis(value.followup); setConflict(false); setError(''); } }, cause => { if (live.current && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause)); }); }}>{t('arrangements.refreshRevision')}</Button>}{uncertain && <p role="status">{t('arrangements.uncertain')}</p>}
    <Button size="sm" disabled={pending || savingLocal || conflict || !uncertain && !valid} onClick={() => void save()}>{t(uncertain ? 'arrangements.retrySave' : 'arrangements.save')}</Button>
    <p className="text-xs text-muted-foreground">{t('arrangements.newEvents')}</p>
  </div>;
}
