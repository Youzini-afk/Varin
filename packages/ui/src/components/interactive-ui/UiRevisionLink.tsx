import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { UiSession } from '@/lib/interactive-ui/sessions';
import { latestUiRevision } from '@/lib/interactive-ui/latest-revision';
import { UiEmbedAncestryContext } from '@/lib/interactive-ui/embed-ancestry';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { UiWorkView } from './InteractiveUiCard';
import { DeclarativeUiContent } from './DeclarativeUiContent';
import { ConversationContext, useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';

export function UiRevisionLink({ session }: { session: UiSession }) {
  const { t } = useI18n();
  const conversation = useOptionalConversationPresentation();
  const dialogConversation = React.useMemo(() => conversation ? { ...conversation, uiInlineViews: false } : null, [conversation]);
  const [latest, setLatest] = React.useState<UiSession>(), [busy, setBusy] = React.useState(false), [status, setStatus] = React.useState('');
  const running = React.useRef(false), alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const show = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setStatus('');
    try { const result = await latestUiRevision(session); if (alive.current) { setLatest(result); if (!result) setStatus(t('ui.content.alreadyLatest')); } }
    catch (error) { if (alive.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  if (!session.display?.committed || !session.display.source.ref) return null;
  const display = latest?.display;
  return <div className="pb-2 text-xs text-muted-foreground">
    <button type="button" className="underline underline-offset-4 disabled:opacity-50" onClick={() => void show()} disabled={busy}>{t('ui.content.latest')}</button>
    {status && <p role="status">{status}</p>}
    {latest && display && <Dialog open onOpenChange={open => { if (!open) setLatest(undefined); }}><DialogContent className="h-[94dvh] w-[96vw] max-w-none overflow-auto p-4">
      <DialogTitle>{display.title} · {display.source.ref}</DialogTitle>
      <ConversationContext.Provider value={dialogConversation}><UiEmbedAncestryContext.Provider value={[display.source.ref!]}>
        {display.content ? <DeclarativeUiContent node={display.content} sourceKey={latest.key} session={latest} source={display.source} />
          : <UiWorkView session={latest} {...display} panel onReturn={() => setLatest(undefined)} />}
      </UiEmbedAncestryContext.Provider></ConversationContext.Provider>
    </DialogContent></Dialog>}
  </div>;
}
