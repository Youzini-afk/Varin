import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { uiSession, subscribeUiSessions, uiSessionsRevision } from '@/lib/interactive-ui/sessions';
import { restoreUiWork } from '@/lib/interactive-ui/work-projection';
import { useI18n } from '@/lib/i18n';
import { UiEmbedAncestryContext } from '@/lib/interactive-ui/embed-ancestry';
import { UiRevisionLink } from './UiRevisionLink';
import { InlineUiSlot } from './InlineUiViews';
import { UiWorkView } from './InteractiveUiCard';
import { DeclarativeUiContent } from './DeclarativeUiContent';

export function EmbeddedUiContent({ refValue, sourceKey }: { refValue: string; sourceKey: string }) {
  const ancestors = React.useContext(UiEmbedAncestryContext), { t } = useI18n();
  if (ancestors.includes(refValue)) return <p role="status" className="break-words text-sm text-muted-foreground">{t('ui.content.cyclicEmbed')}: {refValue}</p>;
  return <ResolvedEmbeddedUiContent refValue={refValue} sourceKey={sourceKey} ancestors={ancestors} />;
}
function ResolvedEmbeddedUiContent({ refValue, sourceKey, ancestors }: { refValue: string; sourceKey: string; ancestors: readonly string[] }) {
  const conversation = useOptionalConversationPresentation(), { t } = useI18n();
  const placement = conversation?.uiEmbeds?.[sourceKey];
  const key = conversation ? `${threadComposerKey(threadHostKey(), conversation.identity)}:${placement?.sessionId ?? `embed:${sourceKey}:${refValue}`}` : '';
  const session = conversation ? uiSession(key, conversation.identity, getRuntimeEndpointGeneration()) : undefined;
  if (session) session.embedAncestors = ancestors;
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    if (!session) return;
    session.sourceEntryId = placement?.sourceEntryId;
    session.inlineTarget = placement?.primaryKey ?? sourceKey;
    session.inlineEntryId = placement?.sourceEntryId;
    let alive = true;
    if (!session.display || session.display.source.ref !== refValue && !session.display.source.preview) void restoreUiWork(session, refValue).catch(failure => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [session, refValue, sourceKey, placement?.sourceEntryId, placement?.primaryKey]);
  if (!session) return <p className="break-words text-sm">{refValue}</p>;
  if (error) return <div role="alert" className="text-sm text-destructive">{error}<button type="button" className="ml-2 underline" onClick={() => { setError(''); void restoreUiWork(session, refValue).catch(failure => setError(failure.message)); }}>{t('ui.fragment.retry')}</button></div>;
  if (conversation?.uiInlineViews) return <InlineUiSlot session={session} anchorKey={sourceKey} kind="embed" cwd={conversation.fileDirectory} />;
  if (!session.display) return <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  return <UiEmbedAncestryContext.Provider value={[...ancestors, refValue]}>
    {session.display.content ? <DeclarativeUiContent node={session.display.content} sourceKey={session.key} source={session.display.source} />
      : <UiWorkView session={session} {...session.display} cwd={conversation?.fileDirectory} />}
    <UiRevisionLink session={session} />
  </UiEmbedAncestryContext.Provider>;
}
