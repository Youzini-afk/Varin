import type {
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  SessionEntriesResult,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
} from '@varin/protocol';
import { actionInstruction } from '@/lib/actionInstructions';
import { renderPiAgentInvocation } from '@/lib/piAgentInvocation';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import {
  captureSurfaceAgentInputContext,
  releaseSurfaceAgentInputContext,
} from '@/lib/pi-runtime/agent-input-context';
import { getRuntimeKey } from '@varin/application-client';
import { useAutoReviewStore, type AutoReviewRun } from '@/stores/useAutoReviewStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  reviewLinkKey,
  useReviewFlowStore,
  type ReviewSessionLink,
} from '@/stores/useReviewFlowStore';
import { useUIStore } from '@/stores/useUIStore';
import type { MultiRunAgentSelection } from '@/types/multirun';

const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_POLL_MS = 400;
const SENT_ENTRY_TIMEOUT_MS = 15_000;
const AUTO_REVIEW_POLL_MS = 300;
const AUTO_REVIEW_MAX_ITERATIONS = 15;
const AUTO_REVIEW_FINAL_MARKER = 'FINAL_REVIEW_STATUS: no_remaining_findings';
const AUTO_REVIEW_FINAL_MARKER_NORMALIZED = AUTO_REVIEW_FINAL_MARKER.toLowerCase();
const REVIEW_SESSION_PREFIX = 'Review: ';
const activeAutoReviewLoops = new Set<string>();
const activeAutoReviewForwardKeys = new Set<string>();

type SessionModelContext = {
  agent?: MultiRunAgentSelection | null;
  modelId: string;
  providerId: string;
  thinkingLevel?: ThinkingLevel;
};

type StartReviewFlowInput = SessionModelContext & {
  originalSessionId: string;
  directory: string;
  generateHandoff?: boolean;
  returnAfterHandoffRequest?: boolean;
  autoReview?: boolean;
};

type AssistantTextEntry = {
  id: string;
  parentId: string | null;
  text: string;
  timestamp: number;
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const entryTimestamp = (entry: PiSessionEntry): number => {
  const parsed = Date.parse(entry.timestamp);
  if (Number.isFinite(parsed)) return parsed;
  if (entry.type === 'message' && typeof entry.message.timestamp === 'number') {
    return entry.message.timestamp;
  }
  return 0;
};

const userMessageText = (entry: PiSessionMessageEntry): string => {
  if (entry.message.role !== 'user') return '';
  if (typeof entry.message.content === 'string') return entry.message.content.trim();
  return entry.message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
    .trim();
};

const assistantMessageText = (message: PiAssistantMessage): string => message.content
  .filter((content) => content.type === 'text')
  .map((content) => content.text)
  .join('\n')
  .trim();

const completedAssistantText = (entry: PiSessionEntry): string => {
  if (entry.type !== 'message' || entry.message.role !== 'assistant') return '';
  if (entry.message.stopReason === 'pending') return '';
  return assistantMessageText(entry.message);
};

const latestAssistantTextEntry = (
  entries: readonly PiSessionEntry[],
  lastForwardedEntryId?: string,
  afterCreatedAt = 0,
  expectedParentId?: string,
): AssistantTextEntry | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.id === lastForwardedEntryId) return null;
    const timestamp = entryTimestamp(entry);
    if (timestamp < afterCreatedAt - 1000) continue;
    if (!isExpectedAutoReviewAssistantParent(entry, expectedParentId)) continue;
    const text = completedAssistantText(entry);
    if (!text) continue;
    return { id: entry.id, parentId: entry.parentId, text, timestamp };
  }
  return null;
};

export const isAutoReviewRuntimeCurrent = (runtimeKey: string): boolean => runtimeKey === getRuntimeKey();

const stopRunForRuntimeMismatch = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
    ...current,
    status: 'stopped',
    error: 'Auto-review stopped because the runtime changed.',
  }));
};

export const assertAutoReviewRuntimeStillCurrent = (expectedRuntimeKey?: string): void => {
  if (expectedRuntimeKey && !isAutoReviewRuntimeCurrent(expectedRuntimeKey)) {
    throw new Error('Auto-review stopped because the runtime changed.');
  }
};

const isRuntimeChangeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('runtime changed');
};

export const hasFinalReviewMarker = (text: string): boolean => {
  const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED;
};

export const stripFinalReviewMarker = (text: string): string => {
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.at(-1)?.trim().toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED) {
    lines.pop();
  }
  return lines.join('\n').trim();
};

export const isExpectedAutoReviewAssistantParent = (
  entry: Pick<PiSessionEntry, 'parentId'>,
  expectedParentId?: string,
): boolean => !expectedParentId || entry.parentId === expectedParentId;

const getAutoReviewForwardKey = (run: AutoReviewRun, entryId: string): string => [
  run.runtimeKey,
  run.originalSessionID,
  run.phase,
  run.expectedAssistantParentID ?? '',
  entryId,
].join(':');

export const claimAutoReviewForward = (run: AutoReviewRun, entryId: string): string | null => {
  const key = getAutoReviewForwardKey(run, entryId);
  if (activeAutoReviewForwardKeys.has(key)) return null;
  activeAutoReviewForwardKeys.add(key);
  return key;
};

export const releaseAutoReviewForward = (key: string): void => {
  activeAutoReviewForwardKeys.delete(key);
};

const autoReviewReviewerInstructions = (): string => (
  `This review is part of an automatic review loop. If there are no remaining issues, end your response with this exact final line:\n${AUTO_REVIEW_FINAL_MARKER}\nIf you found issues that require changes, do not include that final status line.`
);

const ensureSessionOpen = async (sessionId: string, directory: string): Promise<SessionSnapshot> => {
  const { client } = await getPiRuntimeConnection();
  return client.request('session.open', { cwd: directory, sessionId });
};

const readSessionState = async (
  sessionId: string,
): Promise<{ entries: SessionEntriesResult; snapshot: SessionSnapshot }> => {
  const { client } = await getPiRuntimeConnection();
  const [snapshot, entries] = await Promise.all([
    client.request('session.snapshot', { sessionId }),
    client.request('session.entries', { scope: 'branch', sessionId }),
  ]);
  return { entries, snapshot };
};

const waitForSentUserEntry = async (
  sessionId: string,
  previousEntryIds: ReadonlySet<string>,
  afterCreatedAt: number,
): Promise<string> => {
  const deadline = Date.now() + SENT_ENTRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { entries } = await readSessionState(sessionId);
    for (let index = entries.entries.length - 1; index >= 0; index -= 1) {
      const entry = entries.entries[index];
      if (previousEntryIds.has(entry.id) || entryTimestamp(entry) < afterCreatedAt - 1000) continue;
      if (entry.type === 'message' && userMessageText(entry)) return entry.id;
    }
    await sleep(HANDOFF_POLL_MS);
  }
  throw new Error('Timed out waiting for the Pi runtime to persist the review prompt');
};

const requestChatForceScrollBottom = (sessionId: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('varin:chat-force-scroll-bottom', {
    detail: { sessionId },
  }));
};

const sendPiMessage = async (
  sessionId: string,
  directory: string,
  text: string,
  modelContext?: SessionModelContext,
  instructions?: string,
  expectedRuntimeKey?: string,
): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  await ensureSessionOpen(sessionId, directory);
  const { client } = await getPiRuntimeConnection();
  if (modelContext) {
    await client.request('model.select', {
      modelId: modelContext.modelId,
      provider: modelContext.providerId,
      sessionId,
    });
    if (modelContext.thinkingLevel) {
      await client.request('thinking.select', {
        level: modelContext.thinkingLevel,
        sessionId,
      });
    }
  }
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const before = await client.request('session.entries', { scope: 'branch', sessionId });
  const previousEntryIds = new Set(before.entries.map((entry) => entry.id));
  const startedAt = Date.now();
  const task = modelContext?.agent && instructions
    ? `${text}\n\n<varin-review-instructions>\n${instructions}\n</varin-review-instructions>`
    : text;
  const promptText = modelContext?.agent
    ? renderPiAgentInvocation(modelContext.agent, task)
    : task;
  const inputContext = await captureSurfaceAgentInputContext(sessionId);
  let result;
  try {
    result = await client.request('agent.prompt', {
      ...(modelContext?.agent || !instructions ? {} : { instructions }),
      inputContext,
      sessionId,
      text: promptText,
    });
  } catch (error) {
    await releaseSurfaceAgentInputContext(sessionId, inputContext);
    throw error;
  }
  if (!result.accepted) await releaseSurfaceAgentInputContext(sessionId, inputContext);
  if (!result.accepted) throw new Error('The Pi runtime did not accept the review prompt');
  requestChatForceScrollBottom(sessionId);
  return waitForSentUserEntry(sessionId, previousEntryIds, startedAt);
};

const waitForAssistantText = async (
  sessionId: string,
  directory: string,
  afterCreatedAt: number,
  expectedParentId?: string,
): Promise<string> => {
  await ensureSessionOpen(sessionId, directory);
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { entries } = await readSessionState(sessionId);
    const latest = latestAssistantTextEntry(
      entries.entries,
      undefined,
      afterCreatedAt,
      expectedParentId,
    );
    if (latest) return latest.text;
    await sleep(HANDOFF_POLL_MS);
  }
  throw new Error('Timed out waiting for the handoff response');
};

const getReviewSessionTitle = (original: SessionSummary | undefined, originalSessionId: string): string => {
  const implementationTitle = original?.name?.trim() || original?.firstMessage.trim() || originalSessionId;
  return `${REVIEW_SESSION_PREFIX}${implementationTitle}`;
};

const findStoredLink = (originalSessionId: string): ReviewSessionLink | undefined => (
  useReviewFlowStore.getState().linksByOriginal[reviewLinkKey(getRuntimeKey(), originalSessionId)]
);

const listDirectorySessions = async (directory: string): Promise<SessionSummary[]> => {
  const { client } = await getPiRuntimeConnection();
  return client.request('session.list', { cwd: directory });
};

const resolveReviewSummary = (
  originalSessionId: string,
  summaries: readonly SessionSummary[],
): SessionSummary | undefined => {
  const stored = findStoredLink(originalSessionId);
  if (stored) {
    const linked = summaries.find((summary) => summary.id === stored.reviewSessionId);
    if (linked) return linked;
  }
  return summaries.find((summary) => (
    summary.parentId === originalSessionId && summary.name?.startsWith(REVIEW_SESSION_PREFIX)
  ));
};

const rememberReviewLink = (
  originalSessionId: string,
  reviewSessionId: string,
  directory: string,
): void => {
  useReviewFlowStore.getState().upsertLink({
    directory,
    originalSessionId,
    reviewSessionId,
    runtimeKey: getRuntimeKey(),
  });
};

const createOrReuseReviewSession = async (
  originalSessionId: string,
  directory: string,
  expectedRuntimeKey?: string,
): Promise<SessionSnapshot> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  await ensureSessionOpen(originalSessionId, directory);
  let summaries = await listDirectorySessions(directory);
  const existing = resolveReviewSummary(originalSessionId, summaries);
  if (existing) {
    try {
      const snapshot = await ensureSessionOpen(existing.id, directory);
      rememberReviewLink(originalSessionId, existing.id, directory);
      return snapshot;
    } catch {
      useReviewFlowStore.getState().removeLink(getRuntimeKey(), originalSessionId);
    }
  }

  summaries = await listDirectorySessions(directory);
  const original = summaries.find((summary) => summary.id === originalSessionId);
  const originalSnapshot = await ensureSessionOpen(originalSessionId, directory);
  const parentSession = original?.sessionFile || originalSnapshot.sessionFile;
  const { client } = await getPiRuntimeConnection();
  const review = await client.request('session.create', {
    cwd: directory,
    name: getReviewSessionTitle(original, originalSessionId),
    ...(parentSession ? { parentSession } : {}),
    ...(original?.workspace ? { workspace: original.workspace } : {}),
  });
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  rememberReviewLink(originalSessionId, review.sessionId, directory);
  void usePiSessionStore.getState().loadCatalog(directory).catch(() => undefined);
  return review;
};

const openReviewSessionPanel = (
  directory: string,
  reviewSessionId: string,
  label?: string,
  readOnly = false,
): void => {
  useUIStore.getState().openContextPanelTab(directory, {
    mode: 'chat',
    dedupeKey: `session:${reviewSessionId}`,
    label: label ?? null,
    sessionTitleFallback: label ?? null,
    readOnly,
  });
};

const findLinkByReviewSession = (
  reviewSessionId: string,
  directory: string,
  summaries: readonly SessionSummary[],
): ReviewSessionLink | undefined => {
  const runtimeKey = getRuntimeKey();
  const stored = Object.values(useReviewFlowStore.getState().linksByOriginal).find((link) => (
    link.runtimeKey === runtimeKey && link.reviewSessionId === reviewSessionId
  ));
  if (stored) return stored;
  const review = summaries.find((summary) => summary.id === reviewSessionId);
  if (!review?.parentId) return undefined;
  return {
    directory,
    originalSessionId: review.parentId,
    reviewSessionId,
    runtimeKey,
  };
};

const runAutoReviewLoop = async (originalSessionId: string): Promise<void> => {
  const initial = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionId];
  if (!initial) return;
  await Promise.all([
    ensureSessionOpen(initial.originalSessionID, initial.directory),
    ensureSessionOpen(initial.reviewSessionID, initial.directory),
  ]);

  while (true) {
    const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionId];
    if (!run || run.status !== 'running') return;
    if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
      stopRunForRuntimeMismatch(run);
      return;
    }

    const sourceSessionId = run.phase === 'waiting_for_reviewer'
      ? run.reviewSessionID
      : run.originalSessionID;
    const { entries, snapshot } = await readSessionState(sourceSessionId);
    if (snapshot.busy) {
      await sleep(AUTO_REVIEW_POLL_MS);
      continue;
    }
    const latest = latestAssistantTextEntry(
      entries.entries,
      run.lastForwardedMessageID,
      run.waitAfterCreatedAt,
      run.expectedAssistantParentID,
    );
    if (!latest) {
      await sleep(AUTO_REVIEW_POLL_MS);
      continue;
    }

    const forwardKey = claimAutoReviewForward(run, latest.id);
    if (!forwardKey) {
      await sleep(AUTO_REVIEW_POLL_MS);
      continue;
    }
    try {
      assertAutoReviewRuntimeStillCurrent(run.runtimeKey);
      const waitAfterCreatedAt = Date.now();
      if (run.phase === 'waiting_for_reviewer') {
        const finalReview = hasFinalReviewMarker(latest.text);
        const reviewFeedback = finalReview ? stripFinalReviewMarker(latest.text) : latest.text;
        const sentEntryId = await sendReviewFeedbackToOriginal(
          run.reviewSessionID,
          run.directory,
          reviewFeedback,
          run.runtimeKey,
        );
        if (finalReview) {
          useAutoReviewStore.getState().completeRun(run.originalSessionID);
          return;
        }
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_implementer',
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentEntryId,
          waitAfterCreatedAt,
        }));
      } else {
        if (run.iteration >= run.maxIterations) {
          useAutoReviewStore.getState().stopRun(run.originalSessionID);
          return;
        }
        const sentEntryId = await sendImplementationResponseToReviewer(
          run.originalSessionID,
          run.directory,
          latest.text,
          true,
          run.runtimeKey,
        );
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_reviewer',
          iteration: current.iteration + 1,
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentEntryId,
          waitAfterCreatedAt,
        }));
      }
    } finally {
      releaseAutoReviewForward(forwardKey);
    }
  }
};

const startAutoReviewRun = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().upsertRun(run);
  resumeAutoReviewRun(run.originalSessionID);
};

export const resumeAutoReviewRun = (originalSessionId: string): void => {
  const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionId];
  if (
    !run
    || run.status !== 'running'
    || !isAutoReviewRuntimeCurrent(run.runtimeKey)
    || activeAutoReviewLoops.has(originalSessionId)
  ) return;
  activeAutoReviewLoops.add(originalSessionId);
  void runAutoReviewLoop(originalSessionId).catch((error) => {
    console.error('[review-flow] auto-review loop failed', error);
    useAutoReviewStore.getState().updateRun(originalSessionId, (current) => ({
      ...current,
      status: isRuntimeChangeError(error) ? 'stopped' : 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }).finally(() => {
    activeAutoReviewLoops.delete(originalSessionId);
  });
};

export const startReviewFlow = async (input: StartReviewFlowInput): Promise<void> => {
  const expectedRuntimeKey = input.autoReview ? getRuntimeKey() : undefined;
  const modelContext: SessionModelContext = {
    agent: input.agent,
    modelId: input.modelId,
    providerId: input.providerId,
    thinkingLevel: input.thinkingLevel,
  };

  const startReviewSession = async (reviewPrompt: string): Promise<void> => {
    const review = await createOrReuseReviewSession(
      input.originalSessionId,
      input.directory,
      expectedRuntimeKey,
    );
    const runtimeKey = expectedRuntimeKey ?? getRuntimeKey();
    const waitAfterCreatedAt = Date.now();
    const sentEntryId = await sendPiMessage(
      review.sessionId,
      input.directory,
      reviewPrompt,
      modelContext,
      input.autoReview ? autoReviewReviewerInstructions() : undefined,
      input.autoReview ? runtimeKey : undefined,
    );
    if (input.autoReview) {
      startAutoReviewRun({
        originalSessionID: input.originalSessionId,
        reviewSessionID: review.sessionId,
        directory: input.directory,
        runtimeKey,
        status: 'running',
        phase: 'waiting_for_reviewer',
        iteration: 0,
        maxIterations: AUTO_REVIEW_MAX_ITERATIONS,
        expectedAssistantParentID: sentEntryId,
        waitAfterCreatedAt,
      });
    } else {
      openReviewSessionPanel(input.directory, review.sessionId, review.name);
    }
  };

  if (input.generateHandoff ?? true) {
    const visibleText = await actionInstruction('session.reviewHandoff.visible');
    const instructionsText = await actionInstruction('session.reviewHandoff.instructions');
    const startedAt = Date.now();
    const sentEntryId = await sendPiMessage(
      input.originalSessionId,
      input.directory,
      visibleText,
      undefined,
      instructionsText,
      expectedRuntimeKey,
    );
    const continueFromHandoff = async (): Promise<void> => {
      const handoff = await waitForAssistantText(
        input.originalSessionId,
        input.directory,
        startedAt,
        sentEntryId,
      );
      assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
      const prompt = await actionInstruction('session.reviewSession.visible', { handoff });
      await startReviewSession(prompt);
    };
    if (input.returnAfterHandoffRequest) {
      void continueFromHandoff().catch((error) => {
        console.error('[review-flow] failed to finish background review flow', error);
      });
      return;
    }
    await continueFromHandoff();
    return;
  }

  await startReviewSession(await actionInstruction('session.reviewSessionWithoutHandoff.visible'));
};

export const sendReviewFeedbackToOriginal = async (
  reviewSessionId: string,
  directory: string,
  reviewFeedback: string,
  expectedRuntimeKey?: string,
): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const summaries = await listDirectorySessions(directory);
  const link = findLinkByReviewSession(reviewSessionId, directory, summaries);
  if (!link) throw new Error('Original session is missing');
  rememberReviewLink(link.originalSessionId, reviewSessionId, directory);
  const prompt = await actionInstruction('session.reviewFeedbackToImplementer.visible', {
    review_feedback: reviewFeedback,
  });
  return sendPiMessage(
    link.originalSessionId,
    directory,
    prompt,
    undefined,
    undefined,
    expectedRuntimeKey,
  );
};

export const sendImplementationResponseToReviewer = async (
  originalSessionId: string,
  directory: string,
  implementationResponse: string,
  autoReview = false,
  expectedRuntimeKey?: string,
): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const summaries = await listDirectorySessions(directory);
  const review = resolveReviewSummary(originalSessionId, summaries);
  if (!review) throw new Error('Review session is missing');
  rememberReviewLink(originalSessionId, review.id, directory);
  const prompt = await actionInstruction('session.implementationResponseToReviewer.visible', {
    implementation_response: implementationResponse,
  });
  const sentEntryId = await sendPiMessage(
    review.id,
    directory,
    prompt,
    undefined,
    autoReview ? autoReviewReviewerInstructions() : undefined,
    expectedRuntimeKey,
  );
  if (!autoReview) openReviewSessionPanel(directory, review.id, review.name);
  return sentEntryId;
};

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';

type SessionReference = string | { id: string } | null | undefined;

export const getReviewTransferDirection = (
  session: SessionReference,
): ReviewTransferDirection | null => {
  const sessionId = typeof session === 'string' ? session : session?.id;
  if (!sessionId) return null;
  const runtimeKey = getRuntimeKey();
  const links = Object.values(useReviewFlowStore.getState().linksByOriginal).filter((link) => (
    link.runtimeKey === runtimeKey
  ));
  if (links.some((link) => link.reviewSessionId === sessionId)) return 'review-to-original';
  if (links.some((link) => link.originalSessionId === sessionId)) return 'original-to-review';

  const summaries = usePiSessionStore.getState().summaries;
  const summary = summaries.find((candidate) => candidate.id === sessionId);
  if (summary?.parentId && summary.name?.startsWith(REVIEW_SESSION_PREFIX)) {
    return 'review-to-original';
  }
  if (summaries.some((candidate) => (
    candidate.parentId === sessionId && candidate.name?.startsWith(REVIEW_SESSION_PREFIX)
  ))) return 'original-to-review';
  return null;
};
