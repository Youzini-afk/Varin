import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  LegendList,
  type LegendListRef,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from '@legendapp/list/react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useTimelineViewStore } from './timelineViewStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  DEFAULT_CHAT_TIMELINE_VIEW,
  getChatAnchoredTurnCorrection,
  getChatTimelineFollowOffset,
  getChatTimelineEndOffset,
  isChatTimelineAtEnd,
  isChatTimelineEntryCurrent,
  CHAT_TIMELINE_ANCHOR_OFFSET_PX,
  CHAT_TIMELINE_EDGE_EPSILON_PX,
  CHAT_TIMELINE_SCROLL_INTENT_EVENT,
  shouldReleaseChatTimelineFollow,
  type ChatTimelineScrollIntent,
  type ChatTimelineScrollMode,
  type ChatTimelineViewportAnchor,
} from './chatTimelineScrollState';
import {
  projectChatTimeline,
  type ChatTimelineProjection,
} from './chatTimelineProjection';
import {
  ChatToolDisclosureScope,
  type ChatTimelineProps,
} from './ChatTimelineEntries';
import {
  findChatAssistantWaitingTurnId,
} from './chatAssistantWaiting';
import { ChatTimelineBlockView } from './ChatTimelineBlockView';
import { projectChatTimelineBlocks, blockGroupDialogue, type ChatTimelineBlock, type ChatTimelineBlocks, type ChatTimelineBlockAliases } from './chatTimelineBlocks';
import { dialogueContains } from './chatDialogueProjection';
import { timelinePresentationCache } from './timelinePresentationCache';
import { ToolTargetScope } from './ToolTargetScope';
import { ChatContextMenu } from './ChatContextMenu';
import { ChatTurnNavigator, type ChatTurnNavigatorHandle } from './ChatTurnNavigator';
import { readChatRunNavigationText } from './chatMessageNavigation';
import type { ThreadHistoryRun } from '@varin/application-client';
import { toast } from '@/components/ui';
import { currentMotionLevel, prefersReducedMotion, useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { SpringDriver, omegaSpring, tokenSpring } from '@/lib/motion/spring';
import { springTransition, transitionFor, TWEENS } from '@/lib/motion/tokens';
import { useWorkbenchMatchRenderers } from '@/lib/extensions/workbench-registry';
import type { ChatSessionEntry } from './types';
import { ConversationPreviewContext } from './ConversationContext';

/** Following is a critically damped spring on the scroll position. */
const FOLLOW_SPRING = omegaSpring(14);
/** Anchoring a sent turn and returning to the latest cross the timeline. */
const TRAVEL_SPRING = tokenSpring('travel');
/** "Back to latest" skips a long history and travels only the last stretch. */
const RETURN_TRAVEL_VIEWPORTS = 1.25;
/** Distance from the end at which a return hands the spring to following. */
const RETURN_HANDOVER_PX = 48;
const RETURN_PILL_ENTER = springTransition('snap');

/** Who owns the scroll spring; a motion stops as soon as its owner is stale. */
type TimelineScrollMotion =
  | { kind: 'follow' }
  /** A sent turn travelling to the top; `key` identifies the anchored turn. */
  | { kind: 'anchor'; generation: number; key: string; index: number }
  | { kind: 'return'; token: number };

const sameScrollMotion = (left: TimelineScrollMotion, right: TimelineScrollMotion): boolean => (
  left.kind === right.kind
  && (left.kind !== 'anchor' || right.kind !== 'anchor' || left.generation === right.generation)
  && (left.kind !== 'return' || right.kind !== 'return' || left.token === right.token)
);

const isScrollMotionCurrent = (sessionId: string, motion: TimelineScrollMotion): boolean => {
  const view = useTimelineViewStore.getState().views[sessionId] ?? DEFAULT_CHAT_TIMELINE_VIEW;
  if (motion.kind === 'follow') return view.scrollMode === 'following-end';
  if (motion.kind === 'anchor') return view.scrollMode === 'anchoring-new-turn' && view.generation === motion.generation;
  return view.pendingReturnToken === motion.token;
};

const timelineScroller = (list: LegendListRef | null): HTMLElement | null => {
  const node = list?.getScrollableNode() as HTMLElement | null | undefined;
  return node && typeof node.scrollTop === 'number' ? node : null;
};

const maxScrollTop = (node: HTMLElement): number => Math.max(0, node.scrollHeight - node.clientHeight);

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
  const renderMode = useUIStore(state => state.chatRenderMode);
  const sortedMessages = renderMode === 'sorted';
  const dialogueMessages = renderMode === 'dialogue';
  const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
  const activityRenderMode = useUIStore(state => state.activityRenderMode);
  const showThinking = useUIStore(state => state.showReasoningTraces);
  const isMobile = useUIStore((state) => state.isMobile);
  const onScrollContainerChange = props.onScrollContainerChange;
  const listRef = React.useRef<LegendListRef>(null);
  const scrollbarDraggingRef = React.useRef(false);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
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
  const navigationRef = React.useRef(props.navigation);
  navigationRef.current = props.navigation;
  const readRunPreview = React.useCallback((runId: string, signal: AbortSignal) => {
    const current = projectionRef.current;
    const text = current ? readChatRunNavigationText(current.visibleEntries, runId, current.liveAssistant) : '';
    return text ? Promise.resolve(text) : navigationRef.current?.readPreview(runId, signal) ?? Promise.resolve('');
  }, []);
  const assistantWaitingTurnId = React.useMemo(() => findChatAssistantWaitingTurnId(
    projection.items,
    props.assistantWaiting !== undefined,
    projection.liveItem,
  ), [projection.items, projection.liveItem, props.assistantWaiting]);

  const [activityRevision, updateActivity] = React.useReducer(value => value + 1, 0);
  const preview = React.useContext(ConversationPreviewContext);
  const messageRenderers = useWorkbenchMatchRenderers<{ cwd: string; entry: ChatSessionEntry; sessionId: string }>('message-renderer', 'chat.timeline.entries', !preview);
  const extensionPresentation = React.useMemo(() => {
    const rendered = new Map<string, () => React.ReactNode>();
    if (!preview && messageRenderers.length) for (const entry of projection.visibleEntries) {
      const input = { cwd: props.cwd, entry, sessionId: props.sessionId };
      const renderer = messageRenderers.find(renderer => renderer.implementation.matches(input));
      if (renderer) rendered.set(entry.id, () => renderer.implementation.render(input));
    }
    return rendered;
  }, [preview, messageRenderers, projection.visibleEntries, props.cwd, props.sessionId]);
  const customIds = React.useMemo(() => new Set(extensionPresentation.keys()), [extensionPresentation]);
  const activityState = React.useMemo(() => timelinePresentationCache(props.sessionId, 'activity', () => ({ mode: activityRenderMode, choices: new Map<string, boolean>() })), [props.sessionId, activityRenderMode]);
  if (activityState.mode !== activityRenderMode) { activityState.mode = activityRenderMode; activityState.choices.clear(); }
  const dialogueChoices = React.useMemo(() => timelinePresentationCache(props.sessionId, 'dialogue-disclosure', () => new Map<string, boolean>()), [props.sessionId]);
  const isActivityExpanded = React.useCallback((id: string) => id.startsWith('dialogue:')
    ? dialogueChoices.get(id) ?? false : activityState.choices.get(id) ?? activityRenderMode === 'summary', [activityState, activityRenderMode, dialogueChoices]);
  const activityTransitions = React.useMemo(() => new Map<string, { phase: 'opening' | 'closing'; timer: ReturnType<typeof setTimeout> }>(), [props.sessionId, renderMode, activityRenderMode]);
  React.useEffect(() => () => { for (const item of activityTransitions.values()) clearTimeout(item.timer); activityTransitions.clear(); }, [activityTransitions]);
  const setActivityExpanded = React.useCallback((id: string, expanded: boolean) => {
    (id.startsWith('dialogue:') ? dialogueChoices : activityState.choices).set(id, expanded);
    const previous = activityTransitions.get(id);
    if (previous) clearTimeout(previous.timer);
    activityTransitions.delete(id);
    if (!id.startsWith('dialogue:') && !prefersReducedMotion()) {
      // Retain virtual rows through their closing motion. The list measures the
      // changing height and keeps its existing reading-position ownership.
      activityTransitions.set(id, { phase: expanded ? 'opening' : 'closing', timer: setTimeout(() => { activityTransitions.delete(id); updateActivity(); }, 220) });
    }
    updateActivity();
  }, [activityState, dialogueChoices, activityTransitions]);
  const blocksRef = React.useRef<ChatTimelineBlocks | undefined>(undefined);
  const blockAliases = React.useMemo(() => timelinePresentationCache(props.sessionId, 'block-identities', () => new Map() as ChatTimelineBlockAliases), [props.sessionId]);
  const blocks = projectChatTimelineBlocks(projection, { sorted: sortedMessages, dialogue: dialogueMessages, expanded: id => isActivityExpanded(id) || activityTransitions.get(id)?.phase === 'closing', previous: blocksRef.current, customIds, showThinking, aliases: blockAliases, executions: props.toolExecutions });
  blocksRef.current = blocks;
  const stickyHeaders = React.useMemo(() => !isMobile && stickyUserHeader ? blocks.items.flatMap((block, index) => block.kind === 'user' ? [index] : []) : [], [blocks.items, isMobile, stickyUserHeader]);
  const waitingGroupId = [...blocks.groups.values()].reverse().find(group => group.ownerId === assistantWaitingTurnId)?.id;

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
    ? blocks.items.findIndex((item) => item.id === entryTarget.itemId)
    : -1, [entryTarget, blocks.items]);
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
  const scrollSample = React.useRef({ top: 0, time: 0, upward: 0 });
  const prefetchFrame = React.useRef<number | null>(null);
  const [viewportHeight, setViewportHeight] = React.useState(0);
  const touchYRef = React.useRef<number | null>(null);
  const manualOwnershipClaimedRef = React.useRef(false);
  const navigationRequestRef = React.useRef<symbol | null>(null);
  const navigationAbort = React.useRef<AbortController | undefined>(undefined);
  if (timelineView.scrollMode !== 'free-scrolling') {
    manualOwnershipClaimedRef.current = false;
  }
  const motionLevel = useMotionLevel();
  const scrollSpringRef = React.useRef<SpringDriver | null>(null);
  const scrollMotionRef = React.useRef<TimelineScrollMotion | null>(null);
  // Last value the spring wrote. A different scrollTop on the next frame means
  // the list (a position adjustment) or the user moved it in between.
  const scrollWriteRef = React.useRef<number | null>(null);
  const followViewportRef = React.useRef(0);
  const followInstantRef = React.useRef(false);
  const followGrowthRef = React.useRef(false);
  const followContentRef = React.useRef({ leafId: props.leafId, assistant: props.liveAssistant, user: props.liveUser });
  /** `generation:turnId` of the sent turn once it has arrived at the top. */
  const anchorSettledRef = React.useRef<string | null>(null);
  const settleScrollMotionRef = React.useRef<(motion: TimelineScrollMotion) => void>(() => undefined);

  const haltScrollMotion = React.useCallback(() => {
    scrollSpringRef.current?.stop();
    scrollMotionRef.current = null;
    scrollWriteRef.current = null;
  }, []);

  const writeScrollMotion = React.useCallback(() => {
    const spring = scrollSpringRef.current;
    const motion = scrollMotionRef.current;
    const node = timelineScroller(listRef.current);
    if (!spring) return;
    if (!motion || !node || !isScrollMotionCurrent(projectionSessionRef.current, motion)) {
      haltScrollMotion();
      return;
    }
    const written = scrollWriteRef.current;
    if (written !== null) {
      const drift = node.scrollTop - written;
      if (Math.abs(drift) > 1) spring.shift(drift);
    }
    // Only the written value is clamped: the room a destination needs (the
    // reservation under a sent turn, a growing end) can arrive a frame later.
    const next = Math.min(maxScrollTop(node), Math.max(0, spring.value));
    node.scrollTop = next;
    scrollWriteRef.current = next;
    // A growing end never lets a return come to rest. Once it reaches the live
    // edge, following takes over the same spring, velocity and all.
    if (motion.kind === 'return' && spring.target - next <= RETURN_HANDOVER_PX) {
      scrollMotionRef.current = { kind: 'follow' };
      spring.configure(FOLLOW_SPRING);
      settleScrollMotionRef.current(motion);
    }
  }, [haltScrollMotion]);

  /** Start, or retarget, the single scroll spring for `motion`. */
  const startScrollMotion = React.useCallback((motion: TimelineScrollMotion, target: number) => {
    const node = timelineScroller(listRef.current);
    if (!node) return;
    const spring = scrollSpringRef.current ??= new SpringDriver({
      spring: FOLLOW_SPRING,
      restDelta: 0.5,
      restSpeed: 4,
      onUpdate: writeScrollMotion,
      onRest: () => {
        const settled = scrollMotionRef.current;
        scrollMotionRef.current = null;
        scrollWriteRef.current = null;
        if (settled) settleScrollMotionRef.current(settled);
      },
    });
    const goal = Math.max(0, target);
    const current = scrollMotionRef.current;
    if (spring.active && current && sameScrollMotion(current, motion)) {
      // Following targets only grow; travel targets track the measured layout.
      if (motion.kind !== 'follow' || goal > spring.target + 0.5) spring.to(goal);
      return;
    }
    haltScrollMotion();
    spring.sync(node.scrollTop);
    if (Math.abs(goal - node.scrollTop) <= CHAT_TIMELINE_EDGE_EPSILON_PX) return;
    scrollMotionRef.current = motion;
    spring.configure(motion.kind === 'follow' ? FOLLOW_SPRING : TRAVEL_SPRING);
    spring.to(goal);
  }, [haltScrollMotion, writeScrollMotion]);

  const endSpaceHeight = React.useCallback(() => endSpaceRef.current?.getBoundingClientRect().height ?? 0, []);

  const captureViewport = React.useCallback(() => {
    const list = listRef.current;
    const index = firstVisibleIndexRef.current;
    if (!list || index < 0) return;
    const state = list.getState();
    const item = state.data[index] as ChatTimelineBlock | undefined;
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
    const block = blocksRef.current?.items[firstVisibleIndexRef.current];
    const runId = block?.kind === 'user' ? block.turn.userEntry?.runId : block?.group.runId;
    if (runId) turnNavigatorRef.current?.setVisibleRun(runId);
  }, []);
  React.useEffect(updateNavigationPosition, [props.navigation?.runs, updateNavigationPosition]);
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
    if (prefetchFrame.current !== null) cancelAnimationFrame(prefetchFrame.current);
    haltScrollMotion();
    navigationRequestRef.current = null; navigationAbort.current?.abort();
    captureViewport();
    if (observedLeafIdRef.current !== undefined) {
      saveTimelineCheckpoint(
        props.sessionId,
        entryEpochRef.current,
        observedLeafIdRef.current,
        viewportRef.current,
      );
    }
  }, [captureViewport, haltScrollMotion, onScrollContainerChange, props.sessionId, saveTimelineCheckpoint]);

  /**
   * Keep the live edge in view. Growth is followed by the scroll spring, so a
   * long reply glides instead of stepping once per measurement. Entering a
   * Thread, a resized viewport and reduced motion place the end directly.
   */
  const followContentEnd = React.useCallback((instant = false) => {
    const list = listRef.current;
    if (!list) return;
    const state = list.getState();
    const offset = getChatTimelineFollowOffset(
      state.contentLength,
      state.scroll,
      state.scrollLength,
      endSpaceHeight(),
    );
    const viewportChanged = followViewportRef.current !== state.scrollLength;
    followViewportRef.current = state.scrollLength;
    if (instant || viewportChanged || currentMotionLevel() !== 'full') {
      haltScrollMotion();
      if (offset - state.scroll > CHAT_TIMELINE_EDGE_EPSILON_PX) {
        void list.scrollToOffset({ animated: false, offset });
      }
      return;
    }
    startScrollMotion({ kind: 'follow' }, offset);
  }, [endSpaceHeight, haltScrollMotion, startScrollMotion]);

  const returnTarget = React.useCallback((): number => {
    const state = listRef.current?.getState();
    return state ? getChatTimelineFollowOffset(state.contentLength, 0, state.scrollLength, endSpaceHeight()) : 0;
  }, [endSpaceHeight]);

  const scrollToContentEnd = React.useCallback((animated: boolean) => (
    listRef.current?.scrollToEnd({
      animated,
      viewOffset: getChatTimelineEndOffset(
        listRef.current?.getState().scrollLength ?? 0,
        endSpaceRef.current?.getBoundingClientRect().height ?? 0,
      ),
    })
  ), []);

  const scheduleFollowEnd = React.useCallback((instant = false) => {
    if (instant) followInstantRef.current = true;
    if (followEndFrameRef.current !== null) return;
    followEndFrameRef.current = requestAnimationFrame(() => {
      followEndFrameRef.current = null;
      // Measuring already-present history is placement, not new output. Only
      // actual content arriving (or a spring already following it) animates.
      const instantFollow = followInstantRef.current || !(followGrowthRef.current || scrollSpringRef.current?.active);
      followInstantRef.current = false;
      followGrowthRef.current = false;
      if (!listLoadedRef.current) return;
      const motion = scrollMotionRef.current;
      // Travel in flight chases its measured destination as rows settle.
      if (motion?.kind === 'return') {
        startScrollMotion(motion, returnTarget());
        return;
      }
      if (motion?.kind === 'anchor') {
        const position = listRef.current?.getState().positionAtIndex(motion.index);
        if (position !== undefined && Number.isFinite(position)) startScrollMotion(motion, position - CHAT_TIMELINE_ANCHOR_OFFSET_PX);
        return;
      }
      const current = useTimelineViewStore.getState().views[props.sessionId];
      if (current?.scrollMode !== 'following-end') return;
      followContentEnd(instantFollow);
    });
  }, [followContentEnd, props.sessionId, returnTarget, startScrollMotion]);

  React.useLayoutEffect(() => {
    const previous = followContentRef.current;
    followContentRef.current = { leafId: props.leafId, assistant: props.liveAssistant, user: props.liveUser };
    if (!listLoadedRef.current) return;
    if (previous.leafId !== props.leafId || previous.assistant !== props.liveAssistant || previous.user !== props.liveUser) {
      followGrowthRef.current = true;
    }
    scheduleFollowEnd();
  }, [projection.items, props.entries, props.leafId, props.liveAssistant, props.liveUser, props.toolExecutions, scheduleFollowEnd]);

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
      // Opening a Thread places its end. A return that has just handed over
      // to following keeps the spring it is already riding.
      if (entryWasApplied || scrollSpringRef.current?.active) followContentEnd(!scrollSpringRef.current?.active);
      else {
        haltScrollMotion();
        const state = list.getState();
        // Own the exact first placement, even if initial estimates put the
        // viewport beyond the reading edge. This also releases the virtual
        // list's preserved bootstrap target before later size measurements.
        void list.scrollToOffset({ animated: false, offset: getChatTimelineFollowOffset(
          state.contentLength, 0, state.scrollLength, endSpaceHeight(),
        ) });
      }
      return;
    }
    const index = blocks.items.findIndex((item) => item.id === target.itemId);
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
    endSpaceHeight,
    followContentEnd,
    haltScrollMotion,
    blocks.items,
    props.leafId,
    props.sessionId,
    requestTimelineReturn,
    scrollToContentEnd,
    timelineView.entry.epoch,
  ]);

  React.useLayoutEffect(() => {
    if (listLoadedRef.current) applyEntryIntent();
  }, [applyEntryIntent, timelineView.entry.epoch]);

  const takeManualOwnership = React.useCallback(() => {
    haltScrollMotion();
    navigationAbort.current?.abort(); navigationRequestRef.current = null;
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
  }, [cancelTimelineAutomation, haltScrollMotion, props.sessionId]);

  const anchoredTurnId = timelineView.newTurn?.turnId;
  const anchorIndex = React.useMemo(() => anchoredTurnId
    ? blocks.items.findIndex((item) => item.id === anchoredTurnId)
    : -1, [anchoredTurnId, blocks.items]);

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
        // The turn is still travelling to the top; it is not anchored yet.
        || anchorSettledRef.current !== `${expectedGeneration}:${expectedTurnId}`
      ) return;
      const list = listRef.current;
      if (!list || anchorIndex < 0) return;
      const correction = getChatAnchoredTurnCorrection(list.getState(), anchorIndex);
      if (!correction || correction.delta <= 1) return;
      // Past the comfortable line the new turn is simply followed. Hand the
      // view to following: the reservation below the turn is used up, and the
      // follow spring (or reduced motion's direct placement) takes over.
      const token = requestTimelineReturn(props.sessionId);
      if (token > 0) completeTimelineReturn(props.sessionId, token);
      modeRef.current = 'following-end';
      if (currentMotionLevel() !== 'full') {
        void list.scrollToOffset({ animated: false, offset: correction.targetScroll });
        return;
      }
      startScrollMotion({ kind: 'follow' }, correction.targetScroll);
    });
  }, [anchorIndex, completeTimelineReturn, props.sessionId, requestTimelineReturn, startScrollMotion, timelineView.generation, timelineView.newTurn?.turnId]);

  settleScrollMotionRef.current = (motion) => {
    if (!isScrollMotionCurrent(props.sessionId, motion)) return;
    if (motion.kind === 'anchor') {
      anchorSettledRef.current = motion.key;
      correctAnchoredTurn();
      return;
    }
    if (motion.kind !== 'return') return;
    atEndRef.current = true;
    observedLeafIdRef.current = props.leafId;
    completeTimelineReturn(props.sessionId, motion.token);
    // Following takes over from here, including any end that grew meanwhile.
    scheduleFollowEnd();
  };

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
        haltScrollMotion();
        const list = listRef.current;
        const position = list?.getState().positionAtIndex(anchorIndex);
        if (list && position !== undefined && Number.isFinite(position) && currentMotionLevel() === 'full') {
          // Travel the new turn to the top while the sent message lands in it.
          startScrollMotion({ kind: 'anchor', generation: anchor.generation, key: positionedKey, index: anchorIndex }, position - CHAT_TIMELINE_ANCHOR_OFFSET_PX);
          if (scrollMotionRef.current?.kind === 'anchor') return;
        } else {
          void list?.scrollToIndex({
            animated: false,
            index: anchorIndex,
            viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET_PX,
            viewPosition: 0,
          });
        }
        anchorSettledRef.current = positionedKey;
      },
      onSizeChanged: correctAnchoredTurn,
    };
  }, [
    anchorIndex,
    correctAnchoredTurn,
    haltScrollMotion,
    startScrollMotion,
    props.leafId,
    props.sessionId,
    timelineView.generation,
    timelineView.newTurn,
    timelineView.scrollMode,
  ]);

  const scheduleHistoryPrefetch = React.useCallback(() => {
    if (prefetchFrame.current !== null) return;
    prefetchFrame.current = requestAnimationFrame(() => {
      prefetchFrame.current = null;
      if (!listLoadedRef.current) return;
      const state = listRef.current?.getState();
      const history = props.earlierHistory;
      if (!state || !history?.available || history.loading || history.error) return;
      // One viewport of breathing room, extended by the actual upward speed
      // and observed transport time. The cursor owner coalesces concurrent reads.
      const lead = state.scrollLength + scrollSample.current.upward * history.latencyMs;
      if (state.scroll <= lead) void history.load();
    });
  }, [props.earlierHistory]);
  React.useEffect(() => { scheduleHistoryPrefetch(); }, [blocks.items, props.earlierHistory, scheduleHistoryPrefetch]);

  const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const now = performance.now();
    const sample = scrollSample.current;
    scrollSample.current = { top: contentOffset.y, time: now, upward: sample.time && now > sample.time ? Math.max(0, (sample.top - contentOffset.y) / (now - sample.time)) : 0 };
    // While the follow spring catches up the view trails the end by design;
    // it still counts as at the end for intent and leaf observation.
    atEndRef.current = (scrollMotionRef.current?.kind === 'follow' && scrollSpringRef.current?.active === true)
      || isChatTimelineAtEnd(
        contentSize.height,
        contentOffset.y,
        layoutMeasurement.height,
        endSpaceHeight(),
      );
    if (atEndRef.current && props.leafId !== undefined) {
      observedLeafIdRef.current = props.leafId;
    }
    if (atEndRef.current && !navigationRequestRef.current && !scrollbarDraggingRef.current) {
      const current = useTimelineViewStore.getState().views[props.sessionId];
      if (current?.scrollMode === 'free-scrolling' && current.pendingReturnToken === undefined) {
        const token = requestTimelineReturn(props.sessionId);
        if (token > 0) completeTimelineReturn(props.sessionId, token);
      }
    }
    scheduleViewportCapture();
    scheduleHistoryPrefetch();
  }, [completeTimelineReturn, endSpaceHeight, props.leafId, props.sessionId, requestTimelineReturn, scheduleViewportCapture, scheduleHistoryPrefetch]);

  const handleReturnToLatest = React.useCallback(() => {
    navigationAbort.current?.abort(); navigationRequestRef.current = null;
    const token = requestTimelineReturn(props.sessionId);
    if (token <= 0) return;
    const list = listRef.current;
    const node = timelineScroller(list);
    haltScrollMotion();
    if (!list || !node || currentMotionLevel() !== 'full') {
      void Promise.resolve(scrollToContentEnd(false))
        .then(() => completeTimelineReturn(props.sessionId, token));
      return;
    }
    const target = Math.min(maxScrollTop(node), returnTarget());
    const lead = list.getState().scrollLength * RETURN_TRAVEL_VIEWPORTS;
    if (target - node.scrollTop > lead) node.scrollTop = target - lead;
    // Travels, then hands over to following when it settles (or chases the
    // end while rows on the way are measured).
    startScrollMotion({ kind: 'return', token }, target);
    if (!scrollMotionRef.current) settleScrollMotionRef.current({ kind: 'return', token });
  }, [completeTimelineReturn, haltScrollMotion, props.sessionId, requestTimelineReturn, returnTarget, scrollToContentEnd, startScrollMotion]);

  const extraData = React.useMemo(() => ({
    projection,
    activityRevision,
    activeRunId: props.activeRunId,
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
    projection,
    activityRevision,
    props.activeRunId,
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
  const renderItem = React.useCallback(({ item: block }: { item: ChatTimelineBlock }) => {
    return (
    <ChatTimelineBlockView
      {...('group' in block && block.group.id === waitingGroupId && props.assistantWaiting
        ? { assistantWaiting: props.assistantWaiting }
        : {})}
      cwd={props.cwd}
      activeRunId={props.activeRunId}
      forkBusyEntryId={props.forkBusyEntryId}
      hiddenThinkingLabel={props.hiddenThinkingLabel}
      block={block} projection={projection} sorted={sortedMessages}
      activityTransition={'group' in block ? activityTransitions.get(block.group.id)?.phase : undefined}
      extensionPresentation={extensionPresentation}
      expanded={block.kind === 'dialogue' ? isActivityExpanded(block.id) : 'group' in block && isActivityExpanded(block.group.id)} onExpandedChange={setActivityExpanded}
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
    projection,
    props.assistantWaiting,
    waitingGroupId,
    props.cwd,
    props.activeRunId,
    props.forkBusyEntryId,
    props.hiddenThinkingLabel,
    sortedMessages,
    isActivityExpanded,
    setActivityExpanded,
    activityTransitions,
    extensionPresentation,
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
    navigationAbort.current?.abort(); navigationRequestRef.current = null;
    if (!shouldReleaseChatTimelineFollow(modeRef.current, atEndRef.current, intent)) return;
    takeManualOwnership();
  }, [takeManualOwnership]);
  React.useEffect(() => {
    const surface = surfaceRef.current;
    const receive = (event: Event) => {
      const intent = (event as CustomEvent).detail;
      if (intent === 'away-from-end' || intent === 'toward-end') releaseAutomationForIntent(intent);
      else if (intent && typeof intent.dragging === 'boolean') {
        scrollbarDraggingRef.current = intent.dragging;
        if (intent.dragging) takeManualOwnership();
        else if (atEndRef.current && !navigationRequestRef.current) {
          const current = useTimelineViewStore.getState().views[props.sessionId];
          if (current?.scrollMode === 'free-scrolling' && current.pendingReturnToken === undefined) {
            const token = requestTimelineReturn(props.sessionId);
            if (token > 0) completeTimelineReturn(props.sessionId, token);
          }
        }
      }
    };
    surface?.addEventListener(CHAT_TIMELINE_SCROLL_INTENT_EVENT, receive);
    return () => surface?.removeEventListener(CHAT_TIMELINE_SCROLL_INTENT_EVENT, receive);
  }, [completeTimelineReturn, props.sessionId, releaseAutomationForIntent, requestTimelineReturn, takeManualOwnership]);

  const selectRun = React.useCallback(async (target: ThreadHistoryRun) => {
    takeManualOwnership();
    const request = Symbol(); navigationRequestRef.current = request;
    const controller = new AbortController(); navigationAbort.current = controller;
    if (!listRef.current) return;
    const current = () => !controller.signal.aborted && navigationRequestRef.current === request
      && listRef.current !== null && projectionSessionRef.current === props.sessionId;
    try {
      if (target.firstItemId) await navigationRef.current?.ensureItem(target.firstItemId, controller.signal);
      if (!current()) return;
      // A newly fetched body must commit before mapping the Run's anchor to a
      // physical row. This mapping never determines the rail's count or order.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!current()) return;
      const list = listRef.current;
      if (!list) return;
      const index = blocksRef.current?.items.findIndex(block => block.kind === 'user'
        ? block.turn.userEntry?.runId === target.runId : block.group.runId === target.runId) ?? -1;
      if (index < 0) { if (!target.firstItemId) handleReturnToLatest(); return; }
      await list.scrollToIndex({ index, viewPosition: 0, viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET_PX, animated: !prefersReducedMotion() });
      if (current()) turnNavigatorRef.current?.setVisibleRun(target.runId);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('chat.history.unavailable'));
    } finally {
      if (navigationRequestRef.current === request) navigationRequestRef.current = null;
      if (navigationAbort.current === controller) navigationAbort.current = undefined;
    }
  }, [props.sessionId, takeManualOwnership, handleReturnToLatest, t]);

  return (
    <ToolTargetScope entries={props.entries} executions={props.toolExecutions}>
    <ChatToolDisclosureScope key={props.sessionId} sessionId={props.sessionId}><ChatContextMenu {...props} projection={projection}
      onRevealEntry={async (entryId) => {
        const source = props.entries.find((entry) => entry.id === entryId);
        const toolCallId = source?.type === 'message' && source.message.role === 'toolResult' ? source.message.toolCallId : undefined;
        const dialogueBlock = dialogueMessages ? blocks.items.find(block => block.kind === 'dialogue'
          && blockGroupDialogue(block.group, projection, showThinking, props.toolExecutions).some(item => item.id === block.itemId && dialogueContains(item, entryId, toolCallId))) : undefined;
        if (dialogueBlock && !isActivityExpanded(dialogueBlock.id)) {
          setActivityExpanded(dialogueBlock.id, true);
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        const activityGroup = sortedMessages ? [...blocks.groups.values()].find(group => !group.sorted.answersBySourceId.has(entryId) && group.sorted.activity.some(activity => activity.sourceId === entryId || activity.kind === 'tool' && activity.call.id === toolCallId)) : undefined;
        if (activityGroup && !isActivityExpanded(activityGroup.id)) {
          setActivityExpanded(activityGroup.id, true);
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        const currentBlocks = blocksRef.current?.items ?? [];
        const activityIndex = activityGroup ? currentBlocks.findIndex(block => block.kind === 'activity' && block.group.id === activityGroup.id
          && activityGroup.sorted.activity.some(activity => activity.id === block.activityId && (activity.sourceId === entryId || activity.kind === 'tool' && activity.call.id === toolCallId))) : -1;
        const index = dialogueBlock ? currentBlocks.findIndex(block => block.id === dialogueBlock.id) : activityIndex >= 0 ? activityIndex : currentBlocks.findIndex(block => block.kind === 'user' ? block.turn.userEntry?.id === entryId
          : block.kind === 'entry' && (block.entry.id === entryId || toolCallId !== undefined && block.entry.type === 'message' && block.entry.message.role === 'assistant'
            && block.entry.message.content.some(part => part.type === 'toolCall' && part.id === toolCallId)));
        if (index < 0) throw new Error(t('chat.context.sourceUnavailable'));
        takeManualOwnership();
        const list = listRef.current;
        const generation = generationRef.current;
        await list?.scrollToIndex({ index, viewPosition: 0, animated: false });
        if (!list || list !== listRef.current || generation !== generationRef.current
          || projectionSessionRef.current !== props.sessionId) return;
        const container = list.getScrollableNode();
        if (toolCallId) {
          const disclosure = container?.querySelector<HTMLDetailsElement>(`details[data-conversation-tool-disclosure="${CSS.escape(`tool:${toolCallId}`)}"]`);
          if (disclosure && !disclosure.open) {
            disclosure.open = true;
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          }
        }
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
    <div ref={surfaceRef} className="conversation-timeline-surface relative flex min-h-0 flex-1">
      {promptNavigatorEnabled && props.navigation ? <ChatTurnNavigator ref={turnNavigatorRef} runs={props.navigation.runs}
        initialRunId={props.navigation.runs.at(-1)?.runId} readPreview={readRunPreview} onSelect={selectRun} /> : null}
      {promptNavigatorEnabled && props.navigation?.error && <button type="button" className="absolute left-2 top-2 z-20 text-muted-foreground"
        aria-label={t('chat.promptNavigator.unavailable')} title={t('chat.promptNavigator.unavailable')} onClick={() => void props.navigation?.retry()}>
        <Icon name="error-warning" className="size-3.5" />
      </button>}
      <LegendList
        ref={listRef}
        anchoredEndSpace={anchoredEndSpace}
        className="overlay-scrollbar-target overlay-scrollbar-container min-h-0 min-w-0 flex-1 overscroll-contain"
        contentContainerClassName="py-5"
        data={blocks.items}
        dataKey={props.sessionId}
        extraData={extraData}
        getItemType={(item) => item.kind}
        initialScrollIndex={initialScrollAtEnd ? (blocks.items.length ? {
          index: blocks.items.length - 1,
          viewPosition: 1,
          // Explicitly align the last row, without letting footer/bottom
          // padding retarget bootstrap to the end of the breathing space.
          viewOffset: 0,
        } : undefined) : {
          index: entryTargetIndex,
          viewOffset: timelineView.entry.target.kind === 'turn'
            ? timelineView.entry.target.offset
            : 0,
          viewPosition: 0,
        }}
        itemsAreEqual={(previous, item) => previous === item}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<>{props.header}{props.earlierHistory?.error && <div role="status" className="chat-message-column flex items-center gap-2 py-1 typography-meta text-muted-foreground">
          <span>{t('chat.history.unavailable')}</span><button className="text-primary hover:underline" onClick={() => void props.earlierHistory?.load(true)}>{t('chat.history.retry')}</button>
        </div>}</>}
        ListFooterComponent={endBreathingSpace}
        maintainScrollAtEnd={false}
        drawDistance={viewportHeight || undefined}
        stickyHeaderIndices={stickyHeaders}
        maintainVisibleContentPosition={timelineView.scrollMode === 'following-end'
          ? false
          : { data: true, size: true }}
        onFirstVisibleItemChanged={({ index }) => {
          firstVisibleIndexRef.current = index;
          updateNavigationPosition();
          captureViewport();
        }}
        onItemSizeChanged={({ itemKey }) => {
          // The reply is rendered as rows after the anchored turn, so any row
          // growing can carry the turn past the comfortable line.
          if (modeRef.current === 'anchoring-new-turn' || itemKey === timelineView.newTurn?.turnId) correctAnchoredTurn();
          if (modeRef.current === 'following-end' || (scrollMotionRef.current && scrollMotionRef.current.kind !== 'follow')) scheduleFollowEnd();
        }}
        onLayout={() => { scheduleFollowEnd(); scheduleHistoryPrefetch(); }}
        onMetricsChange={() => {
          const height = listRef.current?.getState().scrollLength;
          if (height) setViewportHeight(previous => previous === height ? previous : height);
          scheduleFollowEnd(); scheduleHistoryPrefetch();
        }}
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
          scheduleHistoryPrefetch();
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
        // Patched LegendList (bun-patches): a collapsing row's smaller size applies in the same frame,
        // so the rows below follow it instead of trailing a frame behind.
        data-legend-immediate-shrink="true"
        data-conversation-timeline="true"
        tabIndex={0}
      />
      <AnimatePresence initial={false}>
        {timelineView.scrollMode === 'free-scrolling' ? (
          <motion.button
            key="return-to-latest"
            type="button"
            data-conversation-return-latest="true"
            onClick={handleReturnToLatest}
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/70 bg-background/95 px-3 py-1.5 typography-meta text-foreground shadow-lg backdrop-blur hover:bg-interactive-hover"
            aria-label={t('chat.scrollToBottom.aria')}
            title={t('chat.scrollToBottom.aria')}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: transitionFor(motionLevel, RETURN_PILL_ENTER) }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: transitionFor(motionLevel, TWEENS.exit) }}
            whileTap={{ scale: 0.97 }}
          >
            <Icon name="arrow-down" className="size-3.5" />
            {t('chat.scrollToBottom.aria')}
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
    </ChatContextMenu></ChatToolDisclosureScope></ToolTargetScope>
  );
};
