import React from 'react';
import { createModelConnectionsHttpAPI, defaultConversationModel, getRuntimeEndpointGeneration, type BotSummary, type BotSession, type ThreadIdentity, type ThreadModel } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useBotNavigation, openBotConversation } from '@/lib/bots';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { threadComposerKey, threadHostKey, useThreadStore } from '@/stores/useThreadStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadPendingInput } from '@/stores/useThreadDraftStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { deliverThreadInput } from '@/lib/agent-runtime/threadInputDelivery';

/** An explicit user message to a selected Bot conversation. The source remains a reference. */
export function BotHandoffDialog({ identity, onClose, embedded = false }: { identity: ThreadIdentity; onClose(): void; embedded?: boolean }) {
  const { bots, threads } = useRuntimeAPIs(), { t } = useI18n();
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const key = `${threadComposerKey(threadHostKey(), identity)}:bot-handoff`;
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const saved = draft.composerWorkflow?.botHandoff;
  const patch = (handoff: NonNullable<typeof saved> | undefined) => useThreadDraftStore.getState().patch(key, { composerWorkflow: { botHandoff: handoff } });
  const [profiles, setProfiles] = React.useState<BotSummary[]>([]);
  const [botId, setBotId] = React.useState(saved?.botId ?? '');
  const [sessions, setSessions] = React.useState<BotSession[]>([]);
  const [sessionId, setSessionId] = React.useState(saved?.target?.threadId ?? '');
  const [loading, setLoading] = React.useState(true), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  const [reload, retryLoad] = React.useReducer(value => value + 1, 0);
  const alive = React.useRef(true), sending = React.useRef(false);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && host === getRuntimeEndpointGeneration();
  const locked = busy || Boolean(saved?.pending || saved?.receipt);
  const title = useThreadStore(state => state.threads.find(thread => thread.thread_id === identity.threadId)?.title)
    || t('bot.handoff.source');

  React.useEffect(() => {
    if (!bots || host !== getRuntimeEndpointGeneration()) return;
    const controller = new AbortController();
    void bots.list(controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      const available = rows.filter(bot => !bot.archived && !bot.deletion);
      setProfiles(available);
      setBotId(previous => previous || available.find(bot => bot.id === useBotNavigation.getState().botId)?.id || available[0]?.id || '');
      if (!available.length) setLoading(false);
    }).catch(cause => { if (!controller.signal.aborted) { setError(String(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [bots, host, reload]);
  React.useEffect(() => {
    if (!bots || !botId || host !== getRuntimeEndpointGeneration()) return;
    const controller = new AbortController(); setLoading(true); setError(''); setSessions([]);
    void bots.sessions.list(botId, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      const available = rows.filter(session => !session.thread.archived);
      setSessions(available);
      setSessionId(previous => available.some(session => session.identity.threadId === previous) ? previous : '');
      setLoading(false);
    }).catch(cause => { if (!controller.signal.aborted) { setError(String(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [bots, botId, host, reload]);

  const openTarget = async (selectedBot: string, target: ThreadIdentity) => {
    await selectActiveWorkbenchProfile(VARIN_WORKBENCH_BOT_PROFILE_ID, undefined, { enableShell: true });
    if (host !== getRuntimeEndpointGeneration()) return;
    await openBotConversation(selectedBot, target);
    useThreadDraftStore.getState().patch(key, { text: '', composerWorkflow: undefined });
    onClose();
  };
  const send = async () => {
    if (!bots || !threads || !current() || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      if (saved?.receipt && saved.target) { await openTarget(saved.botId, saved.target); return; }
      let attempt = saved;
      if (!attempt?.pending) {
        const session = sessions.find(session => session.identity.threadId === sessionId);
        const bot = profiles.find(bot => bot.id === botId);
        if (!session || !bot || !draft.text.trim()) return;
        const target = session.identity;
        const snapshot = await threads.snapshot(target);
        if (!current()) return;
        const branch = snapshot.thread.branches.find(branch => branch.branch_id === target.branchId);
        if (snapshot.thread.bot_id !== bot.id || !branch) throw new Error(t('bot.handoff.targetChanged'));
        const label = `@${title}`, text = `${draft.text}\n\n${label}`;
        const payload = { ...target, key: crypto.randomUUID(), text,
          references: [{ kind: 'thread' as const, threadId: identity.threadId, branchId: identity.branchId, start: text.length - label.length, end: text.length }] };
        let pending: ThreadPendingInput;
        if (branch.active_run_id) {
          pending = { kind: 'enqueue', input: { ...payload, mode: useMessageQueueStore.getState().botFollowUpBehavior === 'queue' ? 'next_run' : 'boundary' }, editorText: draft.text, fingerprint: payload.key, status: 'sending' };
        } else {
          const targetDraft = useThreadDraftStore.getState().drafts[threadComposerKey(threadHostKey(), target)];
          const configuration = snapshot.modelSelection.desired?.configuration ?? branch.latest_run?.configuration;
          const previous = configuration as { providerId?: string; catalogModelId?: string; model?: string; thinkingLevel?: ThreadModel['thinkingLevel'] } | undefined;
          let model = targetDraft?.model ?? bot.model ?? (previous?.providerId && previous.model
            ? { providerId: previous.providerId, modelId: previous.catalogModelId ?? previous.model, thinkingLevel: previous.thinkingLevel } : undefined);
          if (!model) {
            const models = await threads.listModels();
            const source = useThreadDraftStore.getState().drafts[threadComposerKey(threadHostKey(), identity)]?.model;
            const defaults = source ? { defaultProvider: source.providerId, defaultModel: source.modelId, defaultThinkingLevel: source.thinkingLevel }
              : (await createModelConnectionsHttpAPI(host).readSettings()).global;
            model = defaultConversationModel(defaults, models) ?? undefined;
          }
          if (!model) throw new Error(t('bot.handoff.modelRequired'));
          pending = { kind: 'submit', input: { ...payload, expectedHead: branch.head, model }, editorText: draft.text, fingerprint: payload.key, status: 'sending' };
        }
        if (!current()) return;
        attempt = { botId, target, pending }; patch(attempt);
      }
      const original = attempt;
      await deliverThreadInput(threads, original.pending!, pending => patch({ ...original, pending }));
      patch({ ...original, pending: undefined, receipt: true });
      if (current()) await openTarget(original.botId, original.target!);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; if (current()) setBusy(false); }
  };
  const content = <>
    {!embedded && <DialogHeader><DialogTitle>{t('bot.handoff.title')}</DialogTitle><DialogDescription>{t('bot.handoff.description')}</DialogDescription></DialogHeader>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 typography-ui-label"><span>{t('bot.handoff.bot')}</span>
        <Select value={botId} disabled={locked || !profiles.length} onValueChange={value => { setBotId(value); setSessionId(''); patch({ botId: value }); }}>
          <SelectTrigger aria-label={t('bot.handoff.bot')} className="w-full"><SelectValue placeholder={t('bot.handoff.noBots')} /></SelectTrigger>
          <SelectContent>{profiles.map(bot => <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1 typography-ui-label"><span>{t('bot.handoff.session')}</span>
        <Select value={sessionId} disabled={loading || locked || !sessions.length} onValueChange={value => { setSessionId(value); patch({ botId, target: sessions.find(session => session.identity.threadId === value)?.identity }); }}>
          <SelectTrigger aria-label={t('bot.handoff.session')} className="w-full"><SelectValue placeholder={t(loading ? 'common.loading' : 'bot.handoff.chooseSession')} /></SelectTrigger>
          <SelectContent>{sessions.map(session => <SelectItem key={session.identity.threadId} value={session.identity.threadId}>{session.thread.title || profiles.find(bot => bot.id === botId)?.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
    {!loading && botId && !sessions.length && !error && <p className="typography-meta text-muted-foreground">{t('bot.handoff.noSessions')}</p>}
    <Textarea aria-label={t('bot.handoff.message')} placeholder={t('bot.handoff.message')} value={draft.text} disabled={locked} onChange={event => useThreadDraftStore.getState().patch(key, { text: event.target.value })} rows={4} />
    <p className="typography-meta text-muted-foreground">{t('bot.handoff.reference')} <span className="text-foreground">{title}</span></p>
    {error && <p role="alert" className="typography-meta text-destructive">{error}</p>}
    {saved?.pending?.status === 'unknown' && <p role="status" className="typography-meta text-muted-foreground">{t('chat.send.unconfirmed')}</p>}
    {saved?.receipt && <p role="status" className="typography-meta">{t('bot.handoff.sent')}</p>}
    <DialogFooter>
      {!embedded && <Button type="button" variant="ghost" onClick={onClose}>{t('settings.common.actions.cancel')}</Button>}
      {error && !saved?.pending && !saved?.receipt && <Button type="button" variant="ghost" disabled={busy} onClick={retryLoad}>{t('composer.menu.retry')}</Button>}
      <Button type="button" onClick={() => void send()} disabled={busy || !saved?.pending && !saved?.receipt && (loading || !sessionId || !draft.text.trim())}>{t(saved?.receipt ? 'bot.handoff.open' : saved?.pending ? 'composer.menu.retry' : 'bot.handoff.send')}</Button>
    </DialogFooter>
  </>;
  return embedded ? <div className="space-y-3">{content}</div> : <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-xl">{content}</DialogContent></Dialog>;
}
