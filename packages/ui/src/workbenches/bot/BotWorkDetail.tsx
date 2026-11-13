import { ConversationOrganizationDetails } from '@/components/conversation/ConversationOrganizationDetails';
import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ThreadPermission } from '@/components/thread/ThreadPermission';
import { ThreadQuestions } from '@/components/thread/ThreadQuestions';
import { ThreadContent } from '@/components/thread/ThreadContent';
import { ComposerSelectedFiles } from '@/components/thread/ComposerSelectedFiles';
import { composerFileSelections, removeComposerFile } from '@/components/chat/composer/submit/fileSelections';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { canRespondToQuestion } from '@/components/thread/threadOperations';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { deliverThreadInput } from '@/lib/agent-runtime/threadInputDelivery';
import { downloadComputerArtifact } from '@/lib/computers';
import { useI18n } from '@/lib/i18n';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadPendingInput } from '@/stores/useThreadDraftStore';
import { useBotPanel } from './botPanelModel';
import { useBotWorkspaceNavigation } from './botWorkspaceViews';
import { BotWorkStatusLabel } from './BotActivityPane';
import { runStatus, workKey } from './botPresentation';

/** A focused observation of the original work, including its original questions and permissions. */
export function BotWorkDetail({ identity, active, operationId, focusRevision }: { identity: ThreadIdentity; active: boolean; operationId?: string; focusRevision?: number }) {
  const { t } = useI18n();
  const model = useBotPanel(), navigation = useBotWorkspaceNavigation();
  const api = model.threads;
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const draftKey = threadComposerKey(threadHostKey(), identity);
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const item = model.workItems?.find(item => workKey(item.identity) === workKey(identity));
  const view = model.work.find(item => workKey(item.identity) === workKey(identity));
  const projection = React.useRef<ThreadProjection | undefined>(undefined);
  const focusedPermission = React.useRef<HTMLDivElement>(null);
  const requestPresent = snapshot?.operations.some(operation => operation.id === operationId) ?? false;
  React.useEffect(() => { if (active) focusedPermission.current?.scrollIntoView({ block: 'nearest' }); }, [active, operationId, focusRevision, requestPresent]);
  React.useEffect(() => {
    if (!active || !api) return;
    const owner = new ThreadProjection(api, identity, value => { setSnapshot(value); setError(undefined); }, cause => setError(String(cause)));
    projection.current = owner; owner.start();
    return () => { owner.close(); projection.current = undefined; };
  }, [api, identity, active]);
  const branch = snapshot?.thread.branches.find(branch => branch.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const source = snapshot?.launch?.selection.source;
  const status = runStatus(run);
  const name = view?.name || snapshot?.thread.title || item?.thread.title || identity.threadId;
  const apply = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await action(); await projection.current?.refresh(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const send = () => apply(async () => {
    if (!api || !run || !draft.text.trim() && !draft.selectedAttachments?.length && !draft.pendingInput) return;
    const attachments = composerFileSelections(draft.selectedAttachments, JSON.stringify([getRuntimeEndpointGeneration(), draftKey, source ?? draft.workspacePath]));
    const payload = { ...identity, key: crypto.randomUUID(), text: draft.text, ...(attachments.length ? { attachments } : {}) };
    const pending: ThreadPendingInput = draft.pendingInput ?? { editorText: draft.text, fingerprint: draft.text, status: 'sending',
      ...(snapshot?.delegatedExecutions?.length && !branch?.active_run_id
        ? { kind: 'continue', input: { ...payload, previousRunId: run.id, expectedHead: branch?.head ?? null } }
        : { kind: 'enqueue', input: { ...payload, mode: 'boundary' } }) };
    useThreadDraftStore.getState().patch(draftKey, { pendingInput: pending });
    await deliverThreadInput(api, pending, next => useThreadDraftStore.getState().patch(draftKey, { pendingInput: next }));
    const delivered = new Set(pending.input.attachments?.map(item => JSON.stringify(item)) ?? []);
    useThreadDraftStore.getState().patch(draftKey, current => ({ pendingInput: undefined, text: current.text === pending.editorText ? '' : current.text,
      selectedAttachments: current.selectedAttachments?.filter(item => !delivered.has(JSON.stringify(item.selection))) }));
    setSent(true);
  });
  const actions = snapshot?.operations.filter(operation => operation.phase !== 'terminal' || operation.run_id === run?.id) ?? [];
  const result = [...snapshot?.history ?? []].reverse().find(item => item.source === 'assistant' && ['text', 'output', 'media'].includes((item.content as { content?: { kind?: string } })?.content?.kind ?? ''));
  return <div className="bot-work-detail">
    <div className="bot-work-detail-scroll">
      <header><h2>{name}</h2><span className="bot-detail-state">{status ? <BotWorkStatusLabel status={status} /> : t(run?.state === 'completed' ? 'bot.workspace.roundEnded' : run?.state === 'failed' ? 'bot.workspace.failed' : run?.state === 'cancelled' ? 'bot.workspace.cancelled' : 'bot.workspace.idle')}</span></header>
      <ConversationOrganizationDetails reference={{ kind: 'native', id: identity.threadId }} active={active} />
      {view?.sessionThreadId && <button type="button" className="bot-text-link" onClick={() => {
        const session = model.sessions.find(session => session.identity.threadId === view.sessionThreadId); if (session) model.openSession(session.identity);
      }}>{t('bot.workspace.fromSession', { name: model.sessionTitle(view.sessionThreadId) })}</button>}
      {view?.task && <details className="bot-task-description"><summary>{t('bot.workspace.details')}</summary><p>{view.task}</p></details>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!snapshot && !error && <p role="status">{t('common.loading')}</p>}
      {api && snapshot && <section className="bot-detail-requests">
        {snapshot.operations.map(operation => <div key={operation.id} ref={operation.id === operationId ? focusedPermission : undefined}><ThreadPermission operation={operation}
          enabled={active && !busy && operation.run_id === run?.id && !run?.cancel_requested}
          onDecide={async (permissionId, decision) => { const result = await api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision }); void projection.current?.refresh(); return result; }} /></div>)}
        <ThreadQuestions revealKey={active ? (focusRevision ?? 0) + 1 : 0} revealOperationId={operationId} scopeKey={draftKey} operations={snapshot.operations} enabled={operation => active && canRespondToQuestion(operation, { run, launch: snapshot.launch })}
          onRead={operation => api.operation(operation.id)} onCancel={operation => api.cancelOperation(operation.id)}
          onAnswer={async (operation, answers) => { const result = await api.answerQuestion({ ...identity, operationId: operation.id, answers }); void projection.current?.refresh(); return result; }} />
      </section>}
      {result && api && <section className="bot-detail-result"><h3>{t('bot.workspace.latestReply')}</h3><ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: result.id }} parts={historyParts(result.content, result.source)} messageId={`work:${result.id}`} /></section>}
      {item?.artifacts?.length ? <section><h3>{t('bot.workspace.artifacts')}</h3>{item.artifacts.map(artifact => <button key={artifact.id} className="bot-detail-resource" type="button" onClick={() => void apply(() => downloadComputerArtifact(artifact))}>
        <Icon name="file-text" className="size-4" /><span>{artifact.relativePath}<small>{new Date(artifact.registeredAt).toLocaleString()} · {artifact.sha256.slice(0, 8)}</small></span><Icon name="download" className="size-4" />
      </button>)}</section> : null}
      {actions.length > 0 && <section><h3>{t('bot.workspace.activity')}</h3><div className="bot-detail-actions">{actions.slice(-8).map(operation => {
        const call = (operation.intent as { call?: { name?: string; arguments?: { path?: string; query?: string; command?: string } } })?.call;
        return <div key={operation.id}><Icon name={operation.phase === 'terminal' ? 'check' : 'time'} className="size-3.5" /><span>{call?.name ?? operation.executor}<small>{call?.arguments?.path ?? call?.arguments?.query ?? call?.arguments?.command}</small></span></div>;
      })}</div></section>}
      {(snapshot || item?.desktops?.length) && <section><h3>{t('bot.workspace.environment')}</h3>
        {source && <button type="button" className="bot-detail-resource" onClick={() => navigation?.files(source.resource_owner, name, identity)}><Icon name="folder" className="size-4" /><span>{t('organization.executionWorkspace')}<small>{source.mode === 'live_root' ? source.live_root?.canonicalRoot : t('bot.workspace.sourceFixed')}</small></span><Icon name="arrow-right-s" className="size-4" /></button>}
        {snapshot && !source && <p className="typography-meta text-muted-foreground">{t('organization.executionWorkspace')}: {t('harness.overview.chatOnly')}</p>}
        {item?.desktops?.map(desktop => <button type="button" key={desktop.id} className="bot-detail-resource" onClick={() => navigation?.computer(desktop)}><Icon name="computer" className="size-4" /><span>{desktop.label}<small>{desktop.status}</small></span><Icon name="arrow-right-s" className="size-4" /></button>)}
      </section>}
      <section><h3>{t('bot.workspace.team')}</h3><div className="bot-detail-person"><AgentAvatar identity={identity.threadId} avatar={view?.avatar} size={28} role="lead" /><span>{name}</span></div>
        {snapshot?.children?.map(child => <button type="button" key={child.operation_id} className="bot-detail-person" onClick={() => navigation?.open({ kind: 'work', key: workKey({ ...identity, threadId: child.child_thread_id, branchId: child.child_branch_id }), identity: { ...identity, threadId: child.child_thread_id, branchId: child.child_branch_id }, title: child.name ?? child.child_thread_id })}><AgentAvatar identity={child.child_thread_id} size={24} /><span>{child.name ?? child.child_thread_id}</span></button>)}
      </section>
    </div>
    <footer className="bot-detail-footer">
      <ComposerSelectedFiles files={draft.selectedAttachments} locked={busy || Boolean(draft.pendingInput)} onRemove={id => removeComposerFile(draftKey, id)} />
      {run && <form onSubmit={event => { event.preventDefault(); void send(); }}><Textarea rows={2} aria-label={t('bot.workspace.messageTo', { name })} placeholder={t('bot.workspace.messageTo', { name })} value={draft.text} disabled={busy || Boolean(draft.pendingInput)} onChange={event => { setSent(false); useThreadDraftStore.getState().patch(draftKey, { text: event.target.value }); }} /><Button type="submit" disabled={busy || !draft.text.trim() && !draft.selectedAttachments?.length && !draft.pendingInput} size="sm">{t(draft.pendingInput ? 'settings.harness.retry' : 'bot.workspace.send')}</Button></form>}
      {sent && <p role="status" className="typography-meta text-muted-foreground">{t('bot.workspace.sent')}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => model.openWork(identity, { tab: 'overview', id: workKey(identity) })}><Icon name="external-link" className="size-3.5" />{t('bot.workspace.openProcess')}</Button>
        {status && <Button size="sm" variant="ghost" disabled={busy || run?.cancel_requested} onClick={() => void apply(() => api!.collaboration ? api!.collaboration.cancelTree(identity) : api!.cancelRun(run!.id))}>{t(run?.cancel_requested ? 'bot.workspace.stopping' : 'bot.workspace.stopWork')}</Button>}
      </div>
    </footer>
  </div>;
}
