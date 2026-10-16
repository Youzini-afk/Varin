import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI, ThreadMemoryAPI } from '@varin/application-client';
import type { ThreadHistoryItem as HistoryItem } from '@varin/application-client';
import { ChatTimeline } from './ChatTimeline';
import { ConversationContext } from './ConversationContext';
import { HistoryPresentation, assistant } from './historyPresentation';
import { useTimelineViewStore } from './timelineViewStore';
import { threadHostKey, threadComposerKey } from '@/stores/useThreadStore';
import { ThreadContent } from '../thread/ThreadContent';
import { ThreadSkillMaterials } from '../thread/ThreadSkillMaterials';
import { ReviewTransferActions } from '../thread/ReviewTransferActions';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { ThreadMedia } from '../thread/ThreadMedia';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';

export function ConversationTimeline({ api, identity, snapshot, history, progress, cwd, working, readOnly, onQuote, onFork, onRecover, memory, header, footer }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot?: ThreadSnapshot; history: readonly HistoryItem[];
  progress: string; cwd: string; working: boolean; readOnly?: boolean; onQuote(text: string): void;
  onFork?(id: string): void; onRecover?(id: string): void; memory?: ThreadMemoryAPI;
  header?: React.ReactNode; footer?: React.ReactNode;
}) {
  const { t } = useI18n();
  const key = threadComposerKey(threadHostKey(), identity);
  const projector = React.useMemo(() => new HistoryPresentation(key), [key]);
  const view = React.useMemo(() => projector.project(history, snapshot), [history, snapshot, projector]);
  const head = history.at(-1)?.id ?? null;
  const liveAssistant = React.useMemo(() => progress ? assistant(`progress:${snapshot?.activeRun?.id ?? key}`, [{ type: 'text', text: progress }], snapshot?.modelSelection.active?.configuration ?? snapshot?.activeRun?.configuration, working) : undefined,
    [progress, working, snapshot?.modelSelection.active?.configuration, snapshot?.activeRun?.configuration, snapshot?.activeRun?.id, key]);
  const entering = React.useRef<string | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (!snapshot || entering.current === key) return;
    entering.current = key;
    useTimelineViewStore.getState().enter(key, head, working);
  }, [snapshot, key, head, working]);
  const nativeItems = React.useMemo(() => new Map(history.map(item => [item.id, item])), [history]);
  const renderExtras = React.useCallback((itemId: string) => {
    const item = nativeItems.get(itemId); if (!item) return null;
    const parts = historyParts(item.content, item.source);
    return <>
      <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId }} messageId={itemId} parts={parts.filter(part => part.kind === 'media')} />
      {parts.flatMap(part => part.kind !== 'output' ? [] : part.output.parts.flatMap((part, index) => part.kind === 'media'
        ? [<ThreadMedia key={index} api={api} identity={identity} holder={{ kind: 'history', itemId }} media={part.media} partIndex={index} />] : []))}
      <ThreadSkillMaterials content={item.content} />
      {!readOnly && <ReviewTransferActions identity={identity} item={item} />}
    </>;
  }, [nativeItems, api, identity, readOnly]);
  const alive = React.useRef(true);
  const currentIdentity = React.useRef(key);
  currentIdentity.current = key;
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [key]);
  const fileTarget = React.useCallback(async (callId: string, path: string) => {
    const host = getRuntimeEndpointGeneration();
    const entry = view.entries.find(entry => entry.type === 'message' && entry.message.role === 'assistant'
      && entry.message.content.some(part => part.type === 'toolCall' && part.id === callId));
    if (!entry) throw new Error(t('chat.files.no_source'));
    const target = await api.fileTarget({ ...identity, itemId: entry.id, path });
    if (!alive.current || currentIdentity.current !== key || host !== getRuntimeEndpointGeneration()) throw new DOMException('Conversation changed', 'AbortError');
    if (target.kind === 'unavailable') throw new Error(t(`chat.files.${target.reason}`));
    return target;
  }, [api, identity, key, t, view.entries]);
  const openFile = React.useCallback(async (callId: string, path: string, line?: number) => {
    const host = getRuntimeEndpointGeneration();
    try {
      const target = await fileTarget(callId, path);
      if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
      revealResourceInEditor({ workspaceId: target.workspaceId, workspaceRoot: target.root, resourceId: target.resourceId,
        thread: identity, toolCallId: callId, ...(line ? { line } : {}) });
    } catch (error) { if (alive.current && host === getRuntimeEndpointGeneration() && !(error instanceof DOMException && error.name === 'AbortError'))
      toast.error(error instanceof Error ? error.message : String(error)); }
  }, [fileTarget, identity]);
  const context = React.useMemo(() => ({ api, identity, head, quote: onQuote, openFile, fileTarget, memory, toolExecutions: view.toolExecutions, renderExtras }),
    [api, identity, head, onQuote, openFile, fileTarget, memory, view.toolExecutions, renderExtras]);
  return <ConversationContext.Provider value={context}><ChatTimeline key={key} sessionId={key} cwd={cwd}
    entries={view.entries} toolExecutions={view.toolExecutions} liveAssistant={liveAssistant} leafId={head}
    assistantWaiting={working ? {} : undefined} onFork={onFork ? entry => onFork(entry.id) : undefined}
    onRecover={onRecover ? entry => onRecover(entry.id) : undefined} header={header} footer={footer} />
  </ConversationContext.Provider>;
}
