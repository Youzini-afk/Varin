export type PiTimelineScrollMode =
  | 'following-end'
  | 'anchoring-new-turn'
  | 'free-scrolling';

export interface PiTimelineViewportAnchor {
  itemId: string;
  mode: Exclude<PiTimelineScrollMode, 'anchoring-new-turn'>;
  offset: number;
}

export type PiTimelineEntryTarget =
  | { kind: 'end' }
  | { itemId: string; kind: 'turn'; offset: number };

export interface PiTimelineNewTurnAnchor {
  generation: number;
  previousMode: PiTimelineScrollMode;
  submissionId: string;
  turnId: string;
}

export interface PiTimelineViewState {
  activeTurnId?: string;
  entry: {
    epoch: number;
    generation: number;
    target: PiTimelineEntryTarget;
  };
  generation: number;
  newTurn?: PiTimelineNewTurnAnchor;
  observedLeafId?: string | null;
  pendingReturnToken?: number;
  scrollMode: PiTimelineScrollMode;
  viewport?: PiTimelineViewportAnchor;
}

export const DEFAULT_PI_TIMELINE_VIEW: Readonly<PiTimelineViewState> = {
  entry: { epoch: 0, generation: 0, target: { kind: 'end' } },
  generation: 0,
  scrollMode: 'following-end',
};

export const liveUserTurnId = (timestamp: number): string => `turn:live-user:${timestamp}`;
export const persistedUserTurnId = (entryId: string): string => `turn:${entryId}`;

export const isPiTimelineEntryCurrent = (view: PiTimelineViewState): boolean => (
  view.entry.generation === view.generation
);

export const preparePiTimelineEntry = (
  current: PiTimelineViewState | undefined,
  options: {
    hasAttention: boolean;
    hasLiveOverlay: boolean;
    leafId: string | null;
    working: boolean;
  },
): PiTimelineViewState => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  const restore = !options.working
    && !options.hasAttention
    && !options.hasLiveOverlay
    && view.observedLeafId !== undefined
    && view.observedLeafId === options.leafId
    && view.viewport?.mode === 'free-scrolling';
  const generation = view.generation + 1;
  const next: PiTimelineViewState = {
    ...view,
    entry: {
      epoch: view.entry.epoch + 1,
      generation,
      target: restore
        ? { itemId: view.viewport.itemId, kind: 'turn', offset: view.viewport.offset }
        : { kind: 'end' },
    },
    generation,
    scrollMode: restore ? view.viewport.mode : 'following-end',
  };
  delete next.newTurn;
  delete next.pendingReturnToken;
  return next;
};

export const preparePiTimelineEnd = (
  current: PiTimelineViewState | undefined,
): PiTimelineViewState => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  const generation = view.generation + 1;
  const next: PiTimelineViewState = {
    ...view,
    entry: { epoch: view.entry.epoch + 1, generation, target: { kind: 'end' } },
    generation,
    scrollMode: 'following-end',
  };
  delete next.newTurn;
  delete next.pendingReturnToken;
  return next;
};

export const armPiTimelineTurn = (
  current: PiTimelineViewState | undefined,
  submissionId: string,
  turnId: string,
): PiTimelineViewState => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  const generation = view.generation + 1;
  const previousMode = view.scrollMode === 'anchoring-new-turn'
    ? view.newTurn?.previousMode ?? view.viewport?.mode ?? 'following-end'
    : view.scrollMode;
  const next: PiTimelineViewState = {
    ...view,
    generation,
    newTurn: {
      generation,
      previousMode,
      submissionId,
      turnId,
    },
    scrollMode: 'anchoring-new-turn',
  };
  delete next.pendingReturnToken;
  return next;
};

export const remapPiTimelineAnchor = (
  current: PiTimelineViewState | undefined,
  nextTurnId: string,
): PiTimelineViewState | undefined => {
  if (!current?.newTurn) return current;
  return { ...current, newTurn: { ...current.newTurn, turnId: nextTurnId } };
};

export const clearPiTimelineSubmissionAnchor = (
  current: PiTimelineViewState | undefined,
  submissionId: string,
): PiTimelineViewState => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  if (
    !view.newTurn
    || view.newTurn.submissionId !== submissionId
    || view.newTurn.generation !== view.generation
    || view.scrollMode === 'free-scrolling'
  ) return view;
  const next: PiTimelineViewState = {
    ...view,
    scrollMode: view.newTurn.previousMode,
  };
  delete next.newTurn;
  return next;
};

export const cancelPiTimelineAutomation = (
  current: PiTimelineViewState | undefined,
): PiTimelineViewState => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  const next: PiTimelineViewState = {
    ...view,
    generation: view.generation + 1,
    scrollMode: 'free-scrolling',
  };
  delete next.pendingReturnToken;
  return next;
};

export const requestPiTimelineReturn = (
  current: PiTimelineViewState | undefined,
): { token: number; view: PiTimelineViewState } => {
  const view = current ?? DEFAULT_PI_TIMELINE_VIEW;
  const token = view.generation + 1;
  return {
    token,
    view: { ...view, generation: token, pendingReturnToken: token },
  };
};

export const completePiTimelineReturn = (
  current: PiTimelineViewState | undefined,
  token: number,
): PiTimelineViewState | undefined => {
  if (
    !current
    || current.generation !== token
    || current.pendingReturnToken !== token
  ) return current;
  const next: PiTimelineViewState = {
    ...current,
    entry: { epoch: current.entry.epoch + 1, generation: token, target: { kind: 'end' } },
    scrollMode: 'following-end',
  };
  delete next.newTurn;
  delete next.pendingReturnToken;
  return next;
};

export const savePiTimelineCheckpoint = (
  current: PiTimelineViewState | undefined,
  entryEpoch: number,
  observedLeafId: string | null,
  viewport: PiTimelineViewportAnchor | undefined,
): PiTimelineViewState | undefined => {
  if (!current || current.entry.epoch !== entryEpoch) return current;
  const next: PiTimelineViewState = { ...current, observedLeafId };
  if (viewport) {
    next.viewport = viewport;
    if (viewport.itemId.startsWith('turn:')) next.activeTurnId = viewport.itemId;
    else delete next.activeTurnId;
  }
  return next;
};

export const PI_TIMELINE_ANCHOR_OFFSET_PX = 16;
// Browser scroll metrics can differ by a fractional device pixel.
export const PI_TIMELINE_EDGE_EPSILON_PX = 2;

export const isPiTimelineAtEnd = (
  contentHeight: number,
  scrollOffset: number,
  viewportHeight: number,
  endSpaceHeight = 0,
): boolean => (
  contentHeight - endSpaceHeight - (scrollOffset + viewportHeight) <= PI_TIMELINE_EDGE_EPSILON_PX
);

/** Leave manually revealed end space in place until new content fills it. */
export const getPiTimelineFollowOffset = (
  contentHeight: number,
  scrollOffset: number,
  viewportHeight: number,
  endSpaceHeight: number,
): number => Math.max(scrollOffset, 0, contentHeight - endSpaceHeight - viewportHeight);

export type PiTimelineScrollIntent = 'toward-end' | 'away-from-end';

/**
 * User input at the live edge should not accidentally opt out of auto-follow.
 * Browsers still deliver wheel/touch/key events when there is nowhere farther
 * down to scroll; treating those no-op gestures as manual ownership leaves the
 * timeline in free-scrolling mode while streaming content grows underneath it.
 */
export const shouldReleasePiTimelineFollow = (
  mode: PiTimelineScrollMode,
  atEnd: boolean,
  intent: PiTimelineScrollIntent,
): boolean => (
  mode !== 'following-end'
  || !atEnd
  || intent === 'away-from-end'
);

export interface PiTimelineMeasurementState {
  data: readonly unknown[];
  positionAtIndex(index: number): number;
  scroll: number;
  scrollLength: number;
  sizeAtIndex(index: number): number;
}

export interface PiAnchoredTurnCorrection {
  delta: number;
  targetScroll: number;
  turnHeight: number;
  usableViewportHeight: number;
}

export const getPiAnchoredTurnCorrection = (
  state: PiTimelineMeasurementState,
  anchorIndex: number,
  anchorOffset = PI_TIMELINE_ANCHOR_OFFSET_PX,
): PiAnchoredTurnCorrection | null => {
  if (state.data.length === 0 || anchorIndex < 0 || anchorIndex >= state.data.length) return null;
  const anchorTop = state.positionAtIndex(anchorIndex);
  const lastIndex = state.data.length - 1;
  const lastTop = state.positionAtIndex(lastIndex);
  const lastSize = state.sizeAtIndex(lastIndex);
  if (![anchorTop, lastTop, lastSize].every(Number.isFinite)) return null;
  const lastBottom = lastTop + Math.max(1, lastSize);
  const usableViewportHeight = Math.max(0, state.scrollLength - anchorOffset);
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const targetScroll = Math.max(0, lastBottom - usableViewportHeight);
  return {
    delta: Math.max(0, targetScroll - state.scroll),
    targetScroll,
    turnHeight,
    usableViewportHeight,
  };
};
