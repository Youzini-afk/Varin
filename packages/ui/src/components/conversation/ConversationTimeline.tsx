import React from 'react';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI, ThreadMemoryAPI } from '@varin/application-client';
import type { ThreadHistoryItem as HistoryItem } from '@varin/application-client';
import { ChatTimeline } from './ChatTimeline';
import type { ChatTimelineProps } from './ChatTimelineEntries';
import { ConversationContext, type UiCardProjection } from './ConversationContext';
import type { ChatToolCall, ChatUserMessage, ChatSessionSubmissionStatus } from './types';
import { getUiSession } from '@/lib/interactive-ui/sessions';
import { projectUiWork } from '@/lib/interactive-ui/work-projection';
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
import type { StreamingToolCall, StreamingTextPart, ToolExecutionProgress } from '@/lib/agent-runtime/thread-projection';

export function ConversationTimeline({ api, identity, snapshot, history, runUsage, historyReady, historyReset = 0, earlierHistory, navigation, progress, streamingTools = [], toolProgress = [], cwd, working, readOnly, onQuote, onFork, onRecover, onQuestion, memory, header, footer, liveUser, liveUserStatus, viewId }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot?: ThreadSnapshot; history: readonly HistoryItem[];
  runUsage?: readonly import('@varin/application-client').ThreadRunUsage[];
  historyReady?: boolean; historyReset?: number; earlierHistory?: ChatTimelineProps['earlierHistory'];
  navigation?: ChatTimelineProps['navigation'];
  progress: StreamingTextPart[]; cwd: string; working: boolean; readOnly?: boolean; onQuote(text: string): void;
  streamingTools?: StreamingToolCall[];
  toolProgress?: ToolExecutionProgress[];
  liveUser?: ChatUserMessage; liveUserStatus?: ChatSessionSubmissionStatus;
  onFork?(id: string): void; onRecover?(id: string): void; memory?: ThreadMemoryAPI;
  onQuestion?(operationId: string): void;
  header?: React.ReactNode; footer?: React.ReactNode;
  /** Independent viewport for an embedded conversation; content identity stays with its Thread. */
  viewId?: string;
}) {
  const { t } = useI18n();
  const key = threadComposerKey(threadHostKey(), identity);
  const timelineKey = viewId ? `${key}:${viewId}` : key;
  const projector = React.useMemo(() => new HistoryPresentation(key), [key]);
  const view = React.useMemo(() => projector.project(history, snapshot, runUsage, toolProgress), [history, snapshot, runUsage, toolProgress, projector]);
  const head = history.at(-1)?.id ?? null;
  const sourceView = React.useRef(view);
  React.useLayoutEffect(() => { sourceView.current = view; }, [view]);
  const sourceEntry = React.useCallback((callId: string) => {
    const view = sourceView.current;
    const visited = new Set<string>();
    let original = callId;
    while (!visited.has(original)) {
      visited.add(original);
      const entry = view.entries.find(entry => entry.type === 'message' && entry.message.role === 'assistant'
        && entry.message.content.some(part => part.type === 'toolCall' && part.id === original));
      if (entry) return entry.id;
      const parent = view.toolExecutions[original]?.parentToolCallId;
      if (!parent) return;
      original = parent;
    }
  }, []);
  const uiCards = React.useMemo(() => {
    const cards: Record<string, UiCardProjection> = {}, calls = new Map<string, ChatToolCall>();
    const firstByWork = new Map<string, string>();
    const admit = (call: ChatToolCall, work: string, result?: UiCardProjection['result']) => {
      const first = firstByWork.get(work) ?? call.id; firstByWork.set(work, first);
      cards[first] = { call, result, compact: false };
      if (first !== call.id) cards[call.id] = { call, result, compact: true };
    };
    for (const entry of view.entries) {
      if (entry.type !== 'message') continue;
      if (entry.message.role === 'user') firstByWork.clear();
      if (entry.message.role === 'assistant') for (const part of entry.message.content) if (part.type === 'toolCall' && part.name === 'render_ui') {
        calls.set(part.id, part);
        cards[part.id] ??= { call: part, compact: false };
        const args = part.arguments as { ref?: string } | null;
        if (args?.ref && firstByWork.has(args.ref.split('@')[0]!)) admit(part, args.ref.split('@')[0]!);
      }
      if (entry.message.role === 'toolResult') {
        const output = entry.message.details as { kind?: string; workRef?: string } | undefined;
        const call = calls.get(entry.message.toolCallId);
        if (call) {
          const original = call.arguments as { ref?: string } | null;
          const work = output?.kind === 'ui' ? output.workRef : original?.ref?.split('@')[0];
          if (work) admit(call, work, entry.message); else cards[call.id] = { call, result: entry.message, compact: false };
        }
      }
    }
    for (const call of streamingTools) if (call.name === 'render_ui') {
      const projected: ChatToolCall = { type: 'toolCall', id: call.id, name: call.name, arguments: {}, rawArguments: call.rawArguments, sequence: call.sequence, interrupted: call.interrupted };
      if (call.reference && firstByWork.has(call.reference.split('@')[0]!)) admit(projected, call.reference.split('@')[0]!);
      else cards[call.id] = { call: projected, compact: false };
    }
    return cards;
  }, [view.entries, streamingTools]);
  React.useLayoutEffect(() => {
    for (const [ownerCallId, projected] of Object.entries(uiCards)) {
      if (projected.compact) continue;
      const session = getUiSession(`${key}:${ownerCallId}`);
      if (!session || session.placement !== 'panel') continue;
      const execution = view.toolExecutions[projected.call.id];
      projectUiWork(session, projected.call, projected.result?.details ?? execution?.result,
        projected.call.rawArguments !== undefined && !projected.call.interrupted || execution?.status === 'running', projected.result?.isError ?? execution?.status === 'error');
    }
  }, [uiCards, key, view.toolExecutions]);
  const liveAssistant = React.useMemo(() => progress.length || streamingTools.length ? { ...assistant(`progress:${snapshot?.activeRun?.id ?? key}`, [
    ...progress.filter(part => part.type !== 'retry'),
    ...streamingTools.filter(call => call.name).map(call => ({ type: 'toolCall' as const, id: call.id, name: call.name,
      arguments: call.arguments ?? {}, gateway: call.gateway, rawArguments: call.rawArguments, sequence: call.sequence, interrupted: call.interrupted, order: call.order })),
  ].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)), snapshot?.modelSelection.active?.configuration ?? snapshot?.activeRun?.configuration, working || progress.length > 0), runId: snapshot?.activeRun?.id } : undefined,
    [progress, streamingTools, working, snapshot?.modelSelection.active?.configuration, snapshot?.activeRun?.configuration, snapshot?.activeRun?.id, key]);
  const entering = React.useRef<string | undefined>(undefined);
  React.useLayoutEffect(() => {
    const entryKey = `${timelineKey}:${historyReset}`;
    if (!snapshot && !historyReady || entering.current === entryKey) return;
    const preserveReading = entering.current === undefined && Boolean(historyReady);
    entering.current = entryKey;
    useTimelineViewStore.getState().enter(timelineKey, head, working, preserveReading);
  }, [snapshot, historyReady, historyReset, timelineKey, head, working]);
  const nativeItems = React.useMemo(() => new Map(history.map(item => [item.id, item])), [history]);
  const renderExtras = React.useCallback((itemId: string, options?: { hideImages?: boolean }) => {
    const item = nativeItems.get(itemId); if (!item) return null;
    const parts = historyParts(item.content, item.source);
    return <>
      <ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId }} messageId={itemId} parts={parts.filter(part => part.kind === 'media' && !(options?.hideImages && part.media.media_type.startsWith('image/')))} />
      {parts.flatMap(part => part.kind !== 'output' ? [] : part.output.parts.flatMap((part, index) => part.kind === 'media' && !(options?.hideImages && part.media.media_type.startsWith('image/'))
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
    const itemId = sourceEntry(callId);
    if (!itemId) throw new Error(t('chat.files.no_source'));
    const target = await api.fileTarget({ ...identity, itemId, path });
    if (!alive.current || currentIdentity.current !== key || host !== getRuntimeEndpointGeneration()) throw new DOMException('Conversation changed', 'AbortError');
    if (target.kind === 'unavailable') throw new Error(t(`chat.files.${target.reason}`));
    return target;
  }, [api, identity, key, t, sourceEntry]);
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
  const context = React.useMemo(() => ({ api, identity, head, readOnly, quote: onQuote, revealQuestion: onQuestion, openFile, fileTarget, memory, followups: snapshot?.followups, toolExecutions: view.toolExecutions, uiCards, sourceEntry, renderExtras }),
    [api, identity, head, readOnly, onQuote, onQuestion, openFile, fileTarget, memory, snapshot?.followups, view.toolExecutions, uiCards, sourceEntry, renderExtras]);
  return <ConversationContext.Provider value={context}><ChatTimeline key={`${timelineKey}:${historyReset}`} sessionId={timelineKey} cwd={cwd} earlierHistory={earlierHistory} navigation={navigation}
    entries={view.entries} toolExecutions={view.toolExecutions} liveAssistant={liveAssistant} liveUser={liveUser} liveUserStatus={liveUserStatus} leafId={head}
    activeRunId={working ? snapshot?.activeRun?.id : undefined}
    assistantWaiting={working ? { retry: progress.find(part => part.type === 'retry') } : undefined} onFork={onFork ? entry => onFork(entry.id) : undefined}
    onRecover={onRecover ? entry => onRecover(entry.id) : undefined} header={header} footer={footer} />
  </ConversationContext.Provider>;
}
