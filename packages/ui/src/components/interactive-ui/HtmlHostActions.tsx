import React from 'react';
import { getRuntimeEndpointGeneration, type UiHostAction, type UiObservation } from '@varin/application-client';
import { composeUiResult, sendUiResult, beginUiComposeInsertion, type UiComposeInput } from '@/lib/interactive-ui/compose';
import { prepareHtmlResult } from '@/lib/interactive-ui/html-actions';
import { notifyUiSessions, subscribeUiSessions, uiSessionsRevision, type UiSession } from '@/lib/interactive-ui/sessions';
import { copyTextToClipboard } from '@/lib/clipboard';
import { beginContentReferenceInsertion } from '@/lib/agent-editor/attachments';
import { useI18n } from '@/lib/i18n';
import { useNativeObjectActions } from '@/lib/interactive-ui/native-object-actions';
import { InteractionDisclosure } from './InteractionDisclosure';

export function HtmlHostActions({ actions, session, capture }: { actions: readonly UiHostAction[]; session: UiSession; capture(): Promise<UiObservation> }) {
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  const pending = session.pendingHostActions ?? {};
  const presented = [...actions.map(action => pending[action.key]?.action ?? action), ...Object.values(pending).filter(item => !actions.some(action => action.key === item.action.key)).map(item => item.action)];
  return <div className="flex min-w-0 flex-wrap items-start gap-2 py-2">{presented.map(action => <HtmlHostAction key={action.key} action={action} session={session} capture={capture} />)}</div>;
}
function HtmlHostAction({ action, session, capture }: { action: UiHostAction; session: UiSession; capture(): Promise<UiObservation> }) {
  const { t } = useI18n(), native = useNativeObjectActions();
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [status, setStatus] = React.useState('');
  const frozen = session.pendingHostActions?.[action.key], running = React.useRef(false);
  const [completed, setCompleted] = React.useState('');
  const signature = JSON.stringify(action), previous = React.useRef(signature);
  React.useEffect(() => { if (previous.current !== signature && !frozen && !running.current) { setStatus(''); setError(''); } previous.current = signature; }, [signature, frozen]);
  const execute = async () => {
    if (running.current || completed === signature) return;
    running.current = true; setBusy(true); setError('');
    const insertion = action.type === 'reference' ? beginContentReferenceInsertion(session.identity) : undefined;
    const composeInsertion = action.type === 'compose' ? beginUiComposeInsertion(session.identity) : undefined;
    try {
      if (session.host !== getRuntimeEndpointGeneration()) throw new Error(t('ui.content.actionsUnavailable'));
      if (action.type === 'copy') { const result = await copyTextToClipboard(action.text!); if (!result.ok) throw new Error(result.error); setStatus('copied'); return; }
      if (action.type === 'open') { await native.open(action.ref!); return; }
      const input: UiComposeInput = frozen?.input ?? (action.ref
        ? { identity: session.identity, host: session.host, sourceKey: session.key, insertion: composeInsertion, text: action.text ?? action.label, reference: await native.reference(action.ref) }
        : await prepareHtmlResult(session, await capture(), action.text ?? action.label, action.includeContext, composeInsertion));
      if (session.host !== getRuntimeEndpointGeneration()) throw new Error(t('ui.content.actionsUnavailable'));
      input.sourceKey = `${session.key}:action:${action.key}`;
      if (action.type === 'send') {
        if (!frozen) { (session.pendingHostActions ??= {})[action.key] = { action: { ...action }, input }; notifyUiSessions(); }
        const result = await sendUiResult(input); setStatus(result.status); setCompleted(signature);
        delete session.pendingHostActions?.[action.key]; notifyUiSessions();
      } else if (action.type === 'reference') { if (input.reference) insertion!.add(input.reference); setStatus('filled'); }
      else { await composeUiResult(input); setStatus('filled'); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { composeInsertion?.dispose(); insertion?.dispose(); running.current = false; setBusy(false); }
  };
  return <div className="min-w-0 max-w-full space-y-1">
    {action.type === 'send' && <InteractionDisclosure title={t('ui.content.sendPreview')}><p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{frozen?.input.text ?? action.text}</p></InteractionDisclosure>}
    <button type="button" disabled={busy || completed === signature} onClick={() => void execute()}
      className="max-w-full whitespace-normal rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">{action.type === 'send' ? `${t('ui.fragment.send')} · ${action.label}` : action.label}</button>
    {action.type === 'compose' && !status && <p className="text-xs text-muted-foreground">{t('ui.content.draftHint')}</p>}
    {status && <p role="status" className="text-xs text-muted-foreground">{status === 'copied' ? t('ui.fragment.copied') : t(status === 'sent' ? 'ui.content.sent' : status === 'queued' ? 'ui.content.queued' : 'ui.content.filled')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
