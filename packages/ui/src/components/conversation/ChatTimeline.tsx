import React from 'react';
import {
  LegendList,
  type LegendListRef,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from '@legendapp/list/react';
import type { ChatAssistantMessage } from './types';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useTimelineViewStore } from './timelineViewStore';
import { useConversationPresentation } from './ConversationContext';
import { useUIStore } from '@/stores/useUIStore';
import {
  DEFAULT_CHAT_TIMELINE_VIEW,
  getChatAnchoredTurnCorrection,
  getChatTimelineFollowOffset,
  isChatTimelineAtEnd,
  isChatTimelineEntryCurrent,
  CHAT_TIMELINE_ANCHOR_OFFSET_PX,
  CHAT_TIMELINE_EDGE_EPSILON_PX,
  shouldReleaseChatTimelineFollow,
  type ChatTimelineScrollIntent,
  type ChatTimelineScrollMode,
  type ChatTimelineViewportAnchor,
} from './chatTimelineScrollState';
import {
  projectChatTimeline,
  resolveChatTimelineItem,
  type ChatTimelineItem,
  type ChatTimelineRow,
  type ChatTimelineProjection,
} from './chatTimelineProjection';
import {
  ChatTimelineEntryList,
  ChatTurnUserMessage,
  type ChatTimelineProps,
} from './ChatTimelineEntries';
import {
  findChatAssistantWaitingTurnId,
  type ChatAssistantWaitingPresentation,
} from './chatAssistantWaiting';
import { ChatTurnAssistantChrome } from './ChatTurnAssistantChrome';
import { ChatContextMenu } from './ChatContextMenu';
import { ChatTurnNavigator, type ChatTurnNavigatorHandle } from './ChatTurnNavigator';
import { chatNavigationHasAssistant, chatNavigationMessageElement, chatNavigationRowElement, type ChatMessageNavigationTarget } from './chatMessageNavigation';
import { prefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface ChatTimelineItemViewProps extends Omit<
  ChatTimelineProps,
  'assistantWaiting' | 'entries' | 'liveAssistant' | 'liveUser' | 'toolExecutions'
> {
  assistantWaiting?: ChatAssistantWaitingPresentation;
  isMobile: boolean;
  item: ChatTimelineItem;
}

const toolCallIdsByItem = new WeakMap<ChatTimelineItem, readonly string[]>();

const toolCallIdsForItem = (item: ChatTimelineItem): readonly string[] => {
  const cached = toolCallIdsByItem.get(item);
  if (cached) return cached;
  const ids = new Set<string>();
  const collect = (message: ChatAssistantMessage): void => {
    for (const content of message.content) {
      if (content.type === 'toolCall') ids.add(content.id);
    }
  };
  if (item.kind === 'live-assistant') collect(item.message);
  else if (item.kind === 'entry') {
    if (item.entry.type === 'message' && item.entry.message.role === 'assistant') {
      collect(item.entry.message);
    }
  } else {
    for (const entry of item.turn.entries) {
      if (entry.type === 'message' && entry.message.role === 'assistant') collect(entry.message);
    }
    if (item.turn.liveAssistant) collect(item.turn.liveAssistant);
  }
  const result = [...ids];
  toolCallIdsByItem.set(item, result);
  return result;
};

const ChatTimelineItemView = React.memo(({
  assistantWaiting,
  cwd,
  forkBusyEntryId,
  hiddenThinkingLabel,
  isMobile,
  item,
  liveUserStatus,
  onFork,
  onOpenThread,
  onRecover,
  recoveryBusyEntryId,
  sessionId,
  threadBusyEntryId,
}: ChatTimelineItemViewProps) => {
  const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
  const toolCallIds = React.useMemo(() => toolCallIdsForItem(item), [item]);
  const presentation = useConversationPresentation();
  const outputDurationsMs = presentation.outputDurationsMs;
  const toolExecutions = React.useMemo(() => Object.fromEntries(toolCallIds.flatMap(id => {
    const execution = presentation.toolExecutions[id]; return execution ? [[id, execution]] : [];
  })), [presentation.toolExecutions, toolCallIds]);
  if (item.kind === 'live-assistant') {
    return (
      <div className="chat-message-column py-1.5" data-turn-entry={item.id}>
        <ChatTimelineEntryList
          cwd={cwd}
          entries={[]}
          forkBusyEntryId={forkBusyEntryId}
          hiddenThinkingLabel={hiddenThinkingLabel}
          liveAssistant={item.message}
          onFork={onFork}
          onOpenThread={onOpenThread}
          onRecover={onRecover}
          outputDurationsMs={outputDurationsMs}
          projectedResultByCallId={item.resultByCallId}
          recoveryBusyEntryId={recoveryBusyEntryId}
          sessionId={sessionId}
          threadBusyEntryId={threadBusyEntryId}
          toolExecutions={toolExecutions}
        />
      </div>
    );
  }

  if (item.kind === 'entry') {
    return (
      <div className="chat-message-column py-1.5" data-turn-entry={item.id}>
        <ChatTimelineEntryList
          cwd={cwd}
          entries={[item.entry]}
          forkBusyEntryId={forkBusyEntryId}
          hiddenThinkingLabel={hiddenThinkingLabel}
          onFork={onFork}
          onOpenThread={onOpenThread}
          onRecover={onRecover}
          outputDurationsMs={outputDurationsMs}
          projectedResultByCallId={item.resultByCallId}
          recoveryBusyEntryId={recoveryBusyEntryId}
          sessionId={sessionId}
          threadBusyEntryId={threadBusyEntryId}
          toolExecutions={toolExecutions}
        />
      </div>
    );
  }

  const { turn } = item;
  return (
    <div
      className="chat-message-column flex flex-col gap-3 py-1.5"
      data-turn-id={turn.id}
      data-turn-entry={turn.id}
    >
      <div className={cn(
        !isMobile && stickyUserHeader && 'conversation-user-message-sticky sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 backdrop-blur-sm',
      )}>
        <ChatTurnUserMessage
          cwd={cwd}
          entry={turn.userEntry}
          forkBusyEntryId={forkBusyEntryId}
          message={turn.user}
          onFork={onFork}
          onOpenThread={onOpenThread}
          onRecover={onRecover}
          recoveryBusyEntryId={recoveryBusyEntryId}
          status={turn.liveUser ? liveUserStatus : undefined}
          threadBusyEntryId={threadBusyEntryId}
        />
      </div>
      <ChatTurnAssistantChrome turn={turn} waiting={assistantWaiting} />
      <ChatTimelineEntryList
        cwd={cwd}
        entries={turn.entries}
        forkBusyEntryId={forkBusyEntryId}
        hiddenThinkingLabel={hiddenThinkingLabel}
        liveAssistant={turn.liveAssistant}
        onFork={onFork}
        onOpenThread={onOpenThread}
        onRecover={onRecover}
        outputDurationsMs={outputDurationsMs}
        projectedResultByCallId={item.turn.resultByCallId}
        recoveryBusyEntryId={recoveryBusyEntryId}
        sessionId={sessionId}
        threadBusyEntryId={threadBusyEntryId}
        toolExecutions={toolExecutions}
      />
    </div>
  );
});

const isInteractiveKeyTarget = (target: EventTarget | null): boolean => (
  target instanceof HTMLElement
  && target.closest('input, textarea, select, button, a, [contenteditable="true"]') !== null
);

// Tool previews own their bounded scroll area (including overscroll containment).
// Reading one must not cancel the outer conversation's automatic following.
const isToolPreviewScrollTarget = (target: EventTarget | null): boolean => {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const viewport = target.closest<HTMLElement>('[data-conversation-tool-scroll]');
  return Boolean(viewport && viewport.scrollHeight > viewport.clientHeight);
};

const CHAT_TIMELINE_SCROLL_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
]);

const chatTimelineKeyIntent = (key: string, shiftKey: boolean): ChatTimelineScrollIntent => (
  key === 'ArrowUp' || key === 'PageUp' || key === 'Home' || (key === ' ' && shiftKey)
    ? 'away-from-end'
    : 'toward-end'
);

export const ChatTimeline: React.FC<ChatTimelineProps> = (props) => {
  const { t } = useI18n();
  const promptNavigatorEnabled = useUIStore(state => state.promptNavigatorEnabled);
  const sortedMessages = useUIStore(state => state.chatRenderMode === 'sorted');
  const isMobile = useUIStore((state) => state.isMobile);
  const onScrollContainerChange = props.onScrollContainerChange;
  const listRef = React.useRef<LegendListRef>(null);
  const turnNavigatorRef = React.useRef<ChatTurnNavigatorHandle>(null);
  const endSpaceRef = React.useRef<HTMLDivElement>(null);
  const projectionRef = React.useRef<ChatTimelineProjection | undefined>(undefined);
  const projectionSessionRef = React.useRef(props.sessionId);
  if (projectionSessionRef.current !== props.sessionId) {
    projectionSessionRef.current = props.sessionId;
    projectionRef.current = undefined;
  }
  const projection = React.useMemo(() => projectChatTimeline(
    props.entries,
    props.liveAssistant,
    props.liveUser,
    projectionRef.current,
  ), [props.entries, props.liveAssistant, props.liveUser]);
  projectionRef.current = projection;
  const liveNavigationItem = projection.liveItem?.item;
  const liveNavigationSources = promptNavigatorEnabled && liveNavigationItem && liveNavigationItem.kind !== 'entry' ? {
    rowId: liveNavigationItem.id,
    hasAssistant: chatNavigationHasAssistant([], liveNavigationItem.kind === 'turn' ? liveNavigationItem.turn.liveAssistant : liveNavigationItem.message, sortedMessages),
  } : undefined;
  const readNavigatorItem = React.useCallback((index: number) => {
    const current = projectionRef.current;
    const row = current?.items[index];
    return current && row ? resolveChatTimelineItem(row, current.liveItem) : undefined;
  }, []);
  const assistantWaitingTurnId = React.useMemo(() => findChatAssistantWaitingTurnId(
    projection.items,
    props.assistantWaiting !== undefined,
    projection.liveItem,
  ), [projection.items, projection.liveItem, props.assistantWaiting]);

  const timelineView = useTimelineViewStore(useShallow((state) => (
    state.views[props.sessionId] ?? DEFAULT_CHAT_TIMELINE_VIEW
  )));
  const cancelTimelineAutomation = useTimelineViewStore((state) => state.cancelTimelineAutomation);
  const completeTimelineReturn = useTimelineViewStore((state) => state.completeTimelineReturn);
  const requestTimelineReturn = useTimelineViewStore((state) => state.requestTimelineReturn);
  const saveTimelineCheckpoint = useTimelineViewStore((state) => state.saveTimelineCheckpoint);
  const modeRef = React.useRef<ChatTimelineScrollMode>(timelineView.scrollMode);
  const generationRef = React.useRef(timelineView.generation);
  const entryEpochRef = React.useRef(timelineView.entry.epoch);
  const newTurnRef = React.useRef(timelineView.newTurn);
  modeRef.current = timelineView.scrollMode;
  generationRef.current = timelineView.generation;
  entryEpochRef.current = timelineView.entry.epoch;
  newTurnRef.current = timelineView.newTurn;

  const entryTarget = timelineView.entry.target;
  const entryTargetIndex = React.useMemo(() => entryTarget.kind === 'turn'
    ? projection.items.findIndex((item) => item.id === entryTarget.itemId)
    : -1, [entryTarget, projection.items]);
  const initialScrollAtEnd = entryTarget.kind === 'end' || entryTargetIndex < 0;
  const firstVisibleIndexRef = React.useRef(-1);
  const viewportRef = React.useRef<ChatTimelineViewportAnchor | undefined>(timelineView.viewport);
  const observedLeafIdRef = React.useRef<string | null | undefined>(timelineView.observedLeafId);
  const atEndRef = React.useRef(initialScrollAtEnd);
  const listLoadedRef = React.useRef(false);
  const appliedEntryRef = React.useRef<{ sessionId: string; epoch: number } | null>(null);
  const viewportFrameRef = React.useRef<number | null>(null);
  const anchorCorrectionFrameRef = React.useRef<number | null>(null);
  const followEndFrameRef = React.useRef<number | null>(null);
  const positionedAnchorRef = React.useRef<string | null>(null);
  const touchYRef = React.useRef<number | null>(null);
  const manualOwnershipClaimedRef = React.useRef(false);
  const navigationRequestRef = React.useRef<symbol | null>(null);
  const navigationFrameRef = React.useRef<number | null>(null);
  if (timelineView.scrollMode !== 'free-scrolling') {
    manualOwnershipClaimedRef.current = false;
  }

  const captureViewport = React.useCallback(() => {
    const list = listRef.current;
    const index = firstVisibleIndexRef.current;
    if (!list || index < 0) return;
    const state = list.getState();
    const item = state.data[index] as ChatTimelineRow | undefined;
    if (!item) return;
    const position = state.positionAtIndex(index);
    if (!Number.isFinite(position) || !Number.isFinite(state.scroll)) return;
    viewportRef.current = {
      itemId: item.id,
      mode: modeRef.current === 'following-end' ? 'following-end' : 'free-scrolling',
      offset: position - state.scroll,
    };
  }, []);

  const updateNavigationPosition = React.useCallback(() => {
    if (!turnNavigatorRef.current) return;
    const index = firstVisibleIndexRef.current;
    const row = projectionRef.current?.items[index];
    if (!row) return;
    let role: ChatMessageNavigationTarget['role'] | undefined = row.kind === 'turn' ? 'user'
      : row.kind === 'live-assistant' ? 'assistant'
        : row.entry.type === 'message' && (row.entry.message.role === 'user' || row.entry.message.role === 'assistant') ? row.entry.message.role : undefined;
    const viewport = listRef.current?.getScrollableNode();
    const element = viewport && chatNavigationRowElement(viewport, row.id);
    if (element && viewport) {
      const readingLine = viewport.getBoundingClientRect().top + CHAT_TIMELINE_ANCHOR_OFFSET_PX;
      for (const message of element.querySelectorAll<HTMLElement>('[data-conversation-message-role]')) {
        if (message.getBoundingClientRect().top > readingLine) break;
        if (message.dataset.conversationMessageRole === 'user' || message.dataset.conversationMessageRole === 'assistant') role = message.dataset.conversationMessageRole;
      }
    }
    turnNavigatorRef.current?.setVisibleIndex(index, role);
  }, []);
  const scheduleViewportCapture = React.useCallback(() => {
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      captureViewport();
      updateNavigationPosition();
    });
  }, [captureViewport, updateNavigationPosition]);

  React.useEffect(() => {
    if (atEndRef.current && props.leafId !== undefined) {
      observedLeafIdRef.current = props.leafId;
    }
  }, [props.leafId]);

  React.useEffect(() => () => {
    onScrollContainerChange?.(null);
    if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
    if (anchorCorrectionFrameRef.current !== null) cancelAnimationFrame(anchorCorrectionFrameRef.current);
    if (followEndFrameRef.current !== null) cancelAnimationFrame(followEndFrameRef.current);
    if (navigationFrameRef.current !== null) cancelAnimationFrame(navigationFrameRef.current);
    navigationRequestRef.current = null;
    captureViewport();
    if (observedLeafIdRef.current !== undefined) {
      saveTimelineCheckpoint(
        props.sessionId,
        entryEpochRef.current,
        observedLeafIdRef.current,
        viewportRef.current,
      );
    }
  }, [captureViewport, onScrollContainerChange, props.sessionId, saveTimelineCheckpoint]);

  const followContentEnd = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const state = list.getState();
    const offset = getChatTimelineFollowOffset(
      state.contentLength,
      state.scroll,
      state.scrollLength,
      endSpaceRef.current?.getBoundingClientRect().height ?? 0,
    );
    if (offset - state.scroll > CHAT_TIMELINE_EDGE_EPSILON_PX) {
      void list.scrollToOffset({ animated: false, offset });
    }
  }, []);

  const scrollToContentEnd = React.useCallback((animated: boolean) => (
    listRef.current?.scrollToEnd({
      animated,
      viewOffset: endSpaceRef.current?.getBoundingClientRect().height ?? 0,
    })
  ), []);

  const scheduleFollowEnd = React.useCallback(() => {
    if (followEndFrameRef.current !== null) return;
    followEndFrameRef.current = requestAnimationFrame(() => {
      followEndFrameRef.current = null;
      if (!listLoadedRef.current) return;
      const current = useTimelineViewStore.getState().views[props.sessionId];
      if (current?.scrollMode !== 'following-end') return;
      followContentEnd();
    });
  }, [followContentEnd, props.sessionId]);

  React.useLayoutEffect(() => {
    if (!listLoadedRef.current) return;
    scheduleFollowEnd();
  }, [projection.items, props.entries, props.liveAssistant, props.liveUser, props.toolExecutions, scheduleFollowEnd]);

  const applyEntryIntent = React.useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const current = useTimelineViewStore.getState().views[props.sessionId];
    const entryWasApplied = appliedEntryRef.current?.sessionId === props.sessionId;
    if (
      !current
      || current.entry.epoch !== timelineView.entry.epoch
      || !isChatTimelineEntryCurrent(current)
      || (entryWasApplied && appliedEntryRef.current?.epoch === current.entry.epoch)
    ) return;
    if (
      entryWasApplied
      && current.scrollMode === 'free-scrolling'
    ) return;
    appliedEntryRef.current = { sessionId: props.sessionId, epoch: current.entry.epoch };
    const target = current.entry.target;
    if (target.kind === 'end') {
      atEndRef.current = true;
      observedLeafIdRef.current = props.leafId;
      followContentEnd();
      return;
    }
    const index = projection.items.findIndex((item) => item.id === target.itemId);
    if (index < 0) {
      atEndRef.current = true;
      observedLeafIdRef.current = props.leafId;
      const token = requestTimelineReturn(props.sessionId);
      void Promise.resolve(scrollToContentEnd(false))
        .then(() => completeTimelineReturn(props.sessionId, token));
      return;
    }
    atEndRef.current = false;
    void list.scrollToIndex({
      animated: false,
      index,
      viewOffset: target.offset,
      viewPosition: 0,
    });
  }, [
    completeTimelineReturn,
    followContentEnd,
    projection.items,
    props.leafId,
    props.sessionId,
    requestTimelineReturn,
    scrollToContentEnd,
    timelineView.entry.epoch,
  ]);

  React.useEffect(() => {
    if (listLoadedRef.current) applyEntryIntent();
  }, [applyEntryIntent, timelineView.entry.epoch]);

  const takeManualOwnership = React.useCallback(() => {
    const current = useTimelineViewStore.getState().views[props.sessionId];
    if (
      manualOwnershipClaimedRef.current
      &&
      current?.scrollMode === 'free-scrolling'
      && current.pendingReturnToken === undefined
    ) return;
    manualOwnershipClaimedRef.current = true;
    modeRef.current = 'free-scrolling';
    generationRef.current += 1;
    cancelTimelineAutomation(props.sessionId);
  }, [cancelTimelineAutomation, props.sessionId]);

  const anchoredTurnId = timelineView.newTurn?.turnId;
  const anchorIndex = React.useMemo(() => anchoredTurnId
    ? projection.items.findIndex((item) => item.id === anchoredTurnId)
    : -1, [anchoredTurnId, projection.items]);

  const correctAnchoredTurn = React.useCallback(() => {
    if (anchorCorrectionFrameRef.current !== null) return;
    const expectedGeneration = timelineView.generation;
    const expectedTurnId = timelineView.newTurn?.turnId;
    anchorCorrectionFrameRef.current = requestAnimationFrame(() => {
      anchorCorrectionFrameRef.current = null;
      if (
        modeRef.current !== 'anchoring-new-turn'
        || generationRef.current !== expectedGeneration
        || newTurnRef.current?.turnId !== expectedTurnId
      ) return;
      const list = listRef.current;
      if (!list || anchorIndex < 0) return;
      const correction = getChatAnchoredTurnCorrection(list.getState(), anchorIndex);
      if (!correction || correction.delta <= 1) return;
      void list.scrollToOffset({ animated: true, offset: correction.targetScroll });
    });
  }, [anchorIndex, timelineView.generation, timelineView.newTurn?.turnId]);

  const anchoredEndSpace = React.useMemo(() => {
    const anchor = timelineView.newTurn;
    if (
      timelineView.scrollMode !== 'anchoring-new-turn'
      || !anchor
      || anchor.generation !== timelineView.generation
      || anchorIndex < 0
    ) return undefined;
    return {
      anchorIndex,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET_PX,
      onReady: () => {
        const current = useTimelineViewStore.getState().views[props.sessionId];
        if (
          current?.scrollMode !== 'anchoring-new-turn'
          || current.generation !== anchor.generation
          || current.newTurn?.turnId !== anchor.turnId
        ) return;
        const positionedKey = `${anchor.generation}:${anchor.turnId}`;
        if (positionedAnchorRef.current === positionedKey) return;
        positionedAnchorRef.current = positionedKey;
        atEndRef.current = true;
        observedLeafIdRef.current = props.leafId;
        void listRef.current?.scrollToIndex({
          animated: false,
          index: anchorIndex,
          viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET_PX,
          viewPosition: 0,
        });
      },
      onSizeChanged: correctAnchoredTurn,
    };
  }, [
    anchorIndex,
    correctAnchoredTurn,
    props.leafId,
    props.sessionId,
    timelineView.generation,
    timelineView.newTurn,
    timelineView.scrollMode,
  ]);

  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atEndRef.current = isChatTimelineAtEnd(
      contentSize.height,
      contentOffset.y,
      layoutMeasurement.height,
      endSpaceRef.current?.getBoundingClientRect().height ?? 0,
    );
    if (atEndRef.current && props.leafId !== undefined) {
      observedLeafIdRef.current = props.leafId;
    }
    if (atEndRef.current) {
      const current = useTimelineViewStore.getState().views[props.sessionId];
      if (current?.scrollMode === 'free-scrolling' && current.pendingReturnToken === undefined) {
        const token = requestTimelineReturn(props.sessionId);
        if (token > 0) completeTimelineReturn(props.sessionId, token);
      }
    }
    scheduleViewportCapture();
  }, [completeTimelineReturn, props.leafId, props.sessionId, requestTimelineReturn, scheduleViewportCapture]);

  const handleReturnToLatest = React.useCallback(() => {
    const token = requestTimelineReturn(props.sessionId);
    if (token <= 0) return;
    void Promise.resolve(scrollToContentEnd(true))
      .then(() => completeTimelineReturn(props.sessionId, token));
  }, [completeTimelineReturn, props.sessionId, requestTimelineReturn, scrollToContentEnd]);

  const extraData = React.useMemo(() => ({
    liveItem: projection.liveItem,
    assistantWaiting: props.assistantWaiting,
    assistantWaitingTurnId,
    forkBusyEntryId: props.forkBusyEntryId,
    hiddenThinkingLabel: props.hiddenThinkingLabel,
    isMobile,
    liveUserStatus: props.liveUserStatus,
    onFork: props.onFork,
    onOpenThread: props.onOpenThread,
    onRecover: props.onRecover,
    recoveryBusyEntryId: props.recoveryBusyEntryId,
    threadBusyEntryId: props.threadBusyEntryId,
  }), [
    projection.liveItem,
    props.assistantWaiting,
    assistantWaitingTurnId,
    props.forkBusyEntryId,
    props.hiddenThinkingLabel,
    isMobile,
    props.liveUserStatus,
    props.onFork,
    props.onOpenThread,
    props.onRecover,
    props.recoveryBusyEntryId,
    props.threadBusyEntryId,
  ]);
  const renderItem = React.useCallback(({ item: row }: { item: ChatTimelineRow }) => {
    const item = resolveChatTimelineItem(row, projection.liveItem);
    if (!item) return null;
    return (
    <ChatTimelineItemView
      {...(item.id === assistantWaitingTurnId && props.assistantWaiting
        ? { assistantWaiting: props.assistantWaiting }
        : {})}
      cwd={props.cwd}
      forkBusyEntryId={props.forkBusyEntryId}
      hiddenThinkingLabel={props.hiddenThinkingLabel}
      isMobile={isMobile}
      item={item}
      liveUserStatus={props.liveUserStatus}
      onFork={props.onFork}
      onOpenThread={props.onOpenThread}
      onRecover={props.onRecover}
      recoveryBusyEntryId={props.recoveryBusyEntryId}
      sessionId={props.sessionId}
      threadBusyEntryId={props.threadBusyEntryId}
    />
    );
  }, [
    projection.liveItem,
    props.assistantWaiting,
    assistantWaitingTurnId,
    props.cwd,
    props.forkBusyEntryId,
    props.hiddenThinkingLabel,
    isMobile,
    props.liveUserStatus,
    props.onFork,
    props.onOpenThread,
    props.onRecover,
    props.recoveryBusyEntryId,
    props.sessionId,
    props.threadBusyEntryId,
  ]);
  const endBreathingSpace = React.useMemo(() => (
    <>
      {props.compactionStatus ? (
        <div className="chat-message-column py-1.5">
          <div className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 typography-meta">
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground" onClick={props.onOpenCompaction}>
              <Icon name={props.compactionStatus === 'failed' ? 'error-warning'
                : props.compactionStatus === 'ready' ? 'check' : 'loader-4'}
                className={cn('size-3.5 shrink-0', (props.compactionStatus === 'requested' || props.compactionStatus === 'running' || props.compactionStatus === 'retrying' || props.compactionStatus === 'applying') && 'animate-spin')} />
              {props.compactionStatus === 'failed' ? t('chat.compaction.failed')
                : props.compactionStatus === 'ready' ? t('chat.compaction.ready')
                : props.compactionStatus === 'applying' ? t('chat.compaction.applying')
                : props.compactionStatus === 'retrying' ? t('chat.compaction.retrying') : t('chat.compaction.inProgress')}
              <span className="ml-auto text-primary">{t('chat.compaction.process')}</span>
            </button>
            {props.compactionStatus === 'ready' && props.onApplyCompaction ? <button type="button"
              className="shrink-0 rounded px-2 py-1 text-primary hover:bg-interactive-hover"
              onClick={props.onApplyCompaction}>{t('chat.compaction.applyNow')}</button> : null}
          </div>
        </div>
      ) : null}
      {props.footer}
      <div
        ref={endSpaceRef}
        aria-hidden="true"
        className={isMobile
          ? 'h-[clamp(7rem,24dvh,13rem)]'
          : 'h-[clamp(14rem,42dvh,30rem)]'}
        data-conversation-timeline-end-space="true"
      />
    </>
  ), [isMobile, props.compactionStatus, props.onApplyCompaction, props.onOpenCompaction, props.footer, t]);

  const releaseAutomationForIntent = React.useCallback((intent: ChatTimelineScrollIntent) => {
    if (!shouldReleaseChatTimelineFollow(modeRef.current, atEndRef.current, intent)) return;
    takeManualOwnership();
  }, [takeManualOwnership]);

  const selectMessage = React.useCallback(async (target: ChatMessageNavigationTarget) => {
    takeManualOwnership();
    const request = Symbol();
    navigationRequestRef.current = request;
    if (navigationFrameRef.current !== null) cancelAnimationFrame(navigationFrameRef.current);
    navigationFrameRef.current = null;
    const list = listRef.current;
    if (!list) return;
    const revealMessage = (): boolean => {
      if (navigationRequestRef.current !== request || list !== listRef.current
        || projectionSessionRef.current !== props.sessionId) return true;
      const viewport = list.getScrollableNode();
      const message = viewport && chatNavigationMessageElement(viewport, target);
      if (!viewport || !message) return false;
      const offset = list.getState().scroll + message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - CHAT_TIMELINE_ANCHOR_OFFSET_PX;
      void list.scrollToOffset({ offset, animated: !prefersReducedMotion() });
      return true;
    };
    if (target.role === 'assistant' && revealMessage()) return;
    await list.scrollToIndex({ index: target.index, viewPosition: 0, animated: target.role === 'user' && !prefersReducedMotion() });
    if (target.role === 'assistant' && navigationRequestRef.current === request && list === listRef.current) {
      navigationFrameRef.current = requestAnimationFrame(() => { navigationFrameRef.current = null; revealMessage(); });
    }
  }, [props.sessionId, takeManualOwnership]);

  return (
    <ChatContextMenu key={props.sessionId} {...props} projection={projection}
      onRevealEntry={async (entryId) => {
        const source = props.entries.find((entry) => entry.id === entryId);
        const toolCallId = source?.type === 'message' && source.message.role === 'toolResult' ? source.message.toolCallId : undefined;
        const index = projection.items.findIndex((row) => {
          const item = resolveChatTimelineItem(row, projection.liveItem);
          if (!item) return false;
          return item.kind === 'entry' ? item.entry.id === entryId
            : item.kind === 'turn' && (item.turn.userEntry?.id === entryId || item.turn.entries.some((entry) => entry.id === entryId)
              || (toolCallId !== undefined && item.turn.resultByCallId.has(toolCallId)));
        });
        if (index < 0) throw new Error(t('chat.context.sourceUnavailable'));
        takeManualOwnership();
        const list = listRef.current;
        const generation = generationRef.current;
        await list?.scrollToIndex({ index, viewPosition: 0, animated: false });
        if (!list || list !== listRef.current || generation !== generationRef.current
          || projectionSessionRef.current !== props.sessionId) return;
        const container = list.getScrollableNode();
        const selector = toolCallId ? `[data-conversation-source-id="${CSS.escape(`tool-result:${toolCallId}`)}"]`
          : `[data-conversation-entry-id="${CSS.escape(entryId)}"]`;
        const sourceElement = container?.querySelector<HTMLElement>(selector);
        // A quoted tool result can be inside closed disclosures. Open only its
        // ancestors before measuring, so its owning call remains the target.
        for (let parent = sourceElement?.parentElement; parent && parent !== container; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        const element = toolCallId ? sourceElement?.firstElementChild : sourceElement;
        if (!container || !element) return;
        const sticky = element.closest('[data-turn-id]')?.querySelector(':scope > .sticky');
        const inset = sticky && !sticky.contains(element) ? sticky.getBoundingClientRect().height : 0;
        await list.scrollToOffset({ animated: false, offset: Math.max(0,
          list.getState().scroll + element.getBoundingClientRect().top - container.getBoundingClientRect().top - inset - CHAT_TIMELINE_ANCHOR_OFFSET_PX) });
      }}>
    <div className="conversation-timeline-surface relative flex min-h-0 flex-1">
      {promptNavigatorEnabled ? <ChatTurnNavigator ref={turnNavigatorRef} items={projection.items}
        sorted={sortedMessages} liveSources={liveNavigationSources}
        initialIndex={initialScrollAtEnd ? projection.items.length - 1 : entryTargetIndex}
        readItem={readNavigatorItem} onSelect={selectMessage} /> : null}
      <LegendList
        ref={listRef}
        anchoredEndSpace={anchoredEndSpace}
        className="overlay-scrollbar-target overlay-scrollbar-container min-h-0 min-w-0 flex-1 overscroll-contain"
        contentContainerClassName="py-5"
        data={projection.items}
        dataKey={props.sessionId}
        extraData={extraData}
        getItemType={(item) => item.kind}
        initialScrollIndex={initialScrollAtEnd ? (projection.items.length ? {
          index: projection.items.length - 1,
          viewPosition: 1,
        } : undefined) : {
          index: entryTargetIndex,
          viewOffset: timelineView.entry.target.kind === 'turn'
            ? timelineView.entry.target.offset
            : 0,
          viewPosition: 0,
        }}
        itemsAreEqual={(previous, item) => previous === item}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<>{props.header}</>}
        ListFooterComponent={endBreathingSpace}
        maintainScrollAtEnd={false}
        maintainVisibleContentPosition={timelineView.scrollMode === 'following-end'
          ? false
          : { data: true, size: true }}
        onFirstVisibleItemChanged={({ index }) => {
          firstVisibleIndexRef.current = index;
          updateNavigationPosition();
          captureViewport();
        }}
        onItemSizeChanged={({ itemKey }) => {
          if (itemKey === timelineView.newTurn?.turnId) correctAnchoredTurn();
          if (modeRef.current === 'following-end') scheduleFollowEnd();
        }}
        onLayout={scheduleFollowEnd}
        onMetricsChange={scheduleFollowEnd}
        onKeyDownCapture={(event) => {
          if (isToolPreviewScrollTarget(event.target)) return;
          if (CHAT_TIMELINE_SCROLL_KEYS.has(event.key) && !isInteractiveKeyTarget(event.target)) {
            releaseAutomationForIntent(chatTimelineKeyIntent(event.key, event.shiftKey));
          }
        }}
        onLoad={() => {
          listLoadedRef.current = true;
          onScrollContainerChange?.(listRef.current?.getScrollableNode() ?? null);
          applyEntryIntent();
          updateNavigationPosition();
        }}
        onScroll={handleScroll}
        onTouchMoveCapture={(event) => {
          if (isToolPreviewScrollTarget(event.target)) return;
          const y = event.touches[0]?.clientY ?? null;
          const previous = touchYRef.current;
          touchYRef.current = y;
          if (y !== null && previous !== null && Math.abs(y - previous) > 0.5) {
            releaseAutomationForIntent(y > previous ? 'away-from-end' : 'toward-end');
          }
        }}
        onTouchStartCapture={(event) => {
          touchYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onWheelCapture={(event) => {
          if (isToolPreviewScrollTarget(event.target)) return;
          if (!event.ctrlKey && event.deltaY !== 0) {
            releaseAutomationForIntent(event.deltaY < 0 ? 'away-from-end' : 'toward-end');
          }
        }}
        recycleItems={false}
        renderItem={renderItem}
        data-conversation-timeline="true"
        tabIndex={0}
      />
      {timelineView.scrollMode === 'free-scrolling' ? (
        <button
          type="button"
          onClick={handleReturnToLatest}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/70 bg-background/95 px-3 py-1.5 typography-meta text-foreground shadow-lg backdrop-blur hover:bg-interactive-hover"
          aria-label={t('chat.scrollToBottom.aria')}
          title={t('chat.scrollToBottom.aria')}
        >
          <Icon name="arrow-down" className="size-3.5" />
          {t('chat.scrollToBottom.aria')}
        </button>
      ) : null}
    </div>
    </ChatContextMenu>
  );
};
