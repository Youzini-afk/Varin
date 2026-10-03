import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { runtimeFetch, type GitStatus } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  parseHarnessThreadMutation,
  parseHarnessThreadSpace,
  projectHarnessThreadState,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
} from './harnessThreadPresentation';
import type { SessionEntriesResult, WorkspaceThreadSpace } from '@varin/protocol';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { parseHarnessSessionBlockResponse, type HarnessSessionBlock } from './harnessBlockPresentation';
import {
  harnessKnowledgeKey,
  parseHarnessKnowledgeSuggestions,
  type HarnessKnowledgeScope,
  type HarnessKnowledgeSuggestion,
} from './harnessKnowledgePresentation';
import { HarnessKnowledgeReviewSection, type KnowledgeDraft } from './HarnessKnowledgeReviewSection';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { HarnessSessionStateTrigger } from './HarnessSessionStateTrigger';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { HarnessThreadIntegrationPanel } from './HarnessThreadIntegrationPanel';
import { HarnessThreadResultHistory } from './HarnessThreadResultHistory';
import { useWebSources, useWebSourcesStore } from '@/stores/useWebSourcesStore';
import { PdfMaterialReader } from './PdfMaterialReader';
import { getGitStatus } from '@/lib/gitApiHttp';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { HarnessOverviewSection } from './HarnessOverviewSection';
import {
  groupOverviewBlocks,
  parseOverviewPlan,
  summarizeGitDiff,
  summarizeOverviewThreads,
  summarizePendingThreadDiffs,
} from './harnessWorkOverviewPresentation';

const LazyThreadTimeline = React.lazy(() => import('./PiTimeline').then((module) => ({ default: module.PiTimeline })));

interface ActivePdfMaterial {
  sessionId: string;
  title: string;
  snapshotId: string;
  sourceHash?: string;
  page?: number;
  region?: import('@varin/protocol').WebDocumentRegion;
  analysisId?: string;
  originalUrl?: string;
}

const stateKey: Record<HarnessThreadState, `harness.threads.state.${HarnessThreadState}`> = {
  queued: 'harness.threads.state.queued',
  starting: 'harness.threads.state.starting',
  running: 'harness.threads.state.running',
  waiting: 'harness.threads.state.waiting',
  stalled: 'harness.threads.state.stalled',
  looping: 'harness.threads.state.looping',
  completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed',
  cancelled: 'harness.threads.state.cancelled',
  interrupted: 'harness.threads.state.interrupted',
  dirty: 'harness.threads.state.dirty',
  'merge-ready': 'harness.threads.state.merge-ready',
  conflict: 'harness.threads.state.conflict',
  merged: 'harness.threads.state.merged',
  archived: 'harness.threads.state.archived',
};

const stateTone: Record<HarnessThreadState, string> = {
  queued: 'bg-muted-foreground/50',
  starting: 'bg-[var(--status-info)]',
  running: 'bg-[var(--status-info)]',
  waiting: 'bg-[var(--status-warning)]',
  stalled: 'bg-[var(--status-warning)]',
  looping: 'bg-[var(--status-warning)]',
  completed: 'bg-[var(--status-success)]',
  failed: 'bg-[var(--status-error)]',
  cancelled: 'bg-muted-foreground/50',
  interrupted: 'bg-[var(--status-error)]',
  dirty: 'bg-[var(--status-warning)]',
  'merge-ready': 'bg-[var(--status-success)]',
  conflict: 'bg-[var(--status-error)]',
  merged: 'bg-[var(--status-success)]',
  archived: 'bg-muted-foreground/50',
};

export const HarnessThreadsPanel: React.FC<{
  workspaceId: string;
  parentSessionId: string;
  fallbackCwd?: string;
  presentation?: 'sidebar' | 'inline';
  title?: string;
  onDesktopOpenChange?: (open: boolean) => void;
}> = ({ workspaceId, parentSessionId, fallbackCwd, presentation = 'sidebar', title, onDesktopOpenChange }) => {
  const { t } = useI18n();
  const prefetchSession = usePiSessionStore((state) => state.prefetchSession);
  const [historyPreview, setHistoryPreview] = React.useState<{ result: SessionEntriesResult; brief: string; cwd?: string } | null>(null);
  React.useEffect(() => { setHistoryPreview(null); }, [workspaceId, parentSessionId]);
  const threadState = useHarnessThreadState();
  const threads = React.useMemo(() => [
    ...threadState.threads,
    ...threadState.researchBranches,
  ], [threadState.threads, threadState.researchBranches]);
  const webSources = useWebSources(parentSessionId);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const toggleContextPanel = useUIStore((state) => state.toggleContextPanel);
  const contextDirectoryKey = fallbackCwd ? normalizeContextPanelDirectoryKey(fallbackCwd) : '';
  const contextPanelOpen = useUIStore((state) => {
    if (!contextDirectoryKey) return false;
    const panel = state.contextPanelByDirectory[contextDirectoryKey];
    return Boolean(panel?.isOpen && panel.tabs.length > 0);
  });
  const pinSource = useWebSourcesStore((state) => state.pinSource);
  const unpinSource = useWebSourcesStore((state) => state.unpinSource);
  const deleteSource = useWebSourcesStore((state) => state.deleteSource);
  const [blocks, setBlocks] = React.useState<HarnessSessionBlock[]>([]);
  const [blocksBranchLeafId, setBlocksBranchLeafId] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<HarnessKnowledgeSuggestion[]>([]);
  const [knowledgeDrafts, setKnowledgeDrafts] = React.useState<Record<string, KnowledgeDraft>>({});
  const [knowledgeBusy, setKnowledgeBusy] = React.useState<string | null>(null);
  const [editingBlock, setEditingBlock] = React.useState<string | null>(null);
  const [blockDraft, setBlockDraft] = React.useState('');
  const [savingBlock, setSavingBlock] = React.useState(false);
  const [narrowOpen, setNarrowOpen] = React.useState(false);
  const [convertingThreadId, setConvertingThreadId] = React.useState<string | null>(null);
  const [space, setSpace] = React.useState<WorkspaceThreadSpace | null>(null);
  const [threadAction, setThreadAction] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [messageDrafts, setMessageDrafts] = React.useState<Record<string, string>>({});
  const [activePdfMaterial, setActivePdfMaterial] = React.useState<ActivePdfMaterial | null>(null);
  const [overviewOpen, setOverviewOpen] = React.useState(false);
  const [gitStatus, setGitStatus] = React.useState<GitStatus | null>(null);
  const messageRequests = React.useRef(new Map<string, { id: string; text: string; mode: string; inFlight: boolean }>());
  const spaceTargetRef = React.useRef(`${workspaceId}\u0000${parentSessionId}`);
  spaceTargetRef.current = `${workspaceId}\u0000${parentSessionId}`;
  const gitTargetRef = React.useRef(fallbackCwd ?? '');
  gitTargetRef.current = fallbackCwd ?? '';

  const readError = (body: unknown, fallback: string): string => {
    if (!body || typeof body !== 'object') return fallback;
    if ('message' in body && typeof body.message === 'string') return body.message;
    if ('error' in body && typeof body.error === 'string') return body.error;
    return fallback;
  };

  const reloadSpace = React.useCallback(async (signal?: AbortSignal) => {
    const target = `${workspaceId}\u0000${parentSessionId}`;
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/space`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        if (spaceTargetRef.current === target) setSpace(null);
        return;
      }
      throw new Error(`Unable to load thread space (${response.status})`);
    }
    const next = parseHarnessThreadSpace(await response.json());
    if (spaceTargetRef.current === target) setSpace(next);
  }, [parentSessionId, spaceTargetRef, workspaceId]);

  const reloadGitStatus = React.useCallback(async () => {
    const target = fallbackCwd?.trim() ?? '';
    if (!target) {
      setGitStatus(null);
      return;
    }
    try {
      const next = await getGitStatus(target);
      if (gitTargetRef.current === target) setGitStatus(next);
    } catch {
      // Work overview is useful outside Git repositories too. A missing or
      // temporarily unavailable Git status must not hide the rest of it.
      if (gitTargetRef.current === target) setGitStatus(null);
    }
  }, [fallbackCwd]);

  const refreshAfterResultRelease = React.useCallback(async () => {
    await reloadSpace();
    await threadState.reload();
  }, [reloadSpace, threadState]);

  const applyThreadMutation = React.useCallback(async (path: string, failedKey: 'harness.threads.archiveFailed' | 'harness.threads.restoreFailed' | 'harness.threads.reclaimFailed' | 'harness.threads.keepFailed', body?: unknown) => {
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${path}`,
      {
        method: 'POST',
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readError(payload, t(failedKey)));
    const mutated = parseHarnessThreadMutation(payload);
    const restoreFailed = path.endsWith('/restore')
      && payload
      && typeof payload === 'object'
      && 'restoreStatus' in payload
      && payload.restoreStatus !== 'restored';
    threadState.merge(mutated);
    if (payload && typeof payload === 'object' && 'space' in payload) {
      try { setSpace(parseHarnessThreadSpace((payload as { space: unknown }).space)); }
      catch { await reloadSpace(); }
    } else {
      await reloadSpace();
    }
    await threadState.reload();
    if (restoreFailed) throw new Error(readError(payload, t(failedKey)));
    return mutated;
  }, [parentSessionId, reloadSpace, t, threadState]);

  const deleteThread = React.useCallback(async (entry: HarnessThreadSnapshot) => {
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}`,
      { method: 'DELETE' },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readError(payload, t('harness.threads.deleteFailed')));
    if (payload && typeof payload === 'object' && 'space' in payload) {
      try { setSpace(parseHarnessThreadSpace((payload as { space: unknown }).space)); }
      catch { await reloadSpace(); }
    } else {
      await reloadSpace();
    }
    await threadState.reload();
  }, [parentSessionId, reloadSpace, t, threadState]);

  const openThread = React.useCallback(async (entry: HarnessThreadSnapshot) => {
    const sessionId = entry.activeRun?.sessionId ?? entry.thread.report?.transcriptRef.sessionId;
    if (!sessionId) return;
    const target = `${workspaceId}\u0000${parentSessionId}`;
    setThreadAction(entry.thread.id);
    try {
      // Catalog preview reads native Pi history without a worker, a new Run,
      // or materializing a reclaimed execution directory.
      const result = await prefetchSession(sessionId);
      if (spaceTargetRef.current !== target) return;
      const cwd = entry.thread.worktree?.path ?? fallbackCwd;
      setHistoryPreview({ result, brief: entry.thread.brief, ...(cwd ? { cwd } : {}) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.restoreFailed'));
    } finally {
      setThreadAction((current) => current === entry.thread.id ? null : current);
    }
  }, [prefetchSession, workspaceId, parentSessionId, fallbackCwd, t]);

  const sendThreadMessage = React.useCallback(async (entry: HarnessThreadSnapshot, mode: 'request' | 'fresh' | 'inform') => {
    const text = (messageDrafts[entry.thread.id] ?? '').trim();
    if (!text) return;
    const target = `${workspaceId}\u0000${parentSessionId}`;
    const key = `${target}\u0000${entry.thread.id}`;
    let operation = messageRequests.current.get(key);
    if (operation?.inFlight) return;
    if (!operation || operation.text !== text || operation.mode !== mode) {
      operation = { id: crypto.randomUUID(), text, mode, inFlight: false };
      messageRequests.current.set(key, operation);
    }
    operation.inFlight = true;
    setThreadAction(entry.thread.id);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}/send`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            requestId: operation.id,
            kind: mode === 'inform' ? 'inform' : 'request',
            ...(mode === 'fresh' ? { context: 'fresh' } : {}),
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(readError(payload, t('harness.threads.sendFailed')));
      const result = payload && typeof payload === 'object' && 'result' in payload
        ? payload.result as { accepted?: unknown; messageId?: unknown } : undefined;
      if (result?.accepted !== true || result.messageId !== operation.id) {
        throw new Error(t('harness.threads.sendFailed'));
      }
      messageRequests.current.delete(key);
      if (spaceTargetRef.current !== target) return;
      setMessageDrafts((current) => (current[entry.thread.id] ?? '').trim() === text
        ? { ...current, [entry.thread.id]: '' } : current);
      if (payload && typeof payload === 'object' && 'thread' in payload) {
        try {
          threadState.merge(parseHarnessThreadMutation(payload));
        } catch {
          await threadState.reload();
        }
      } else {
        await threadState.reload();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.sendFailed'));
    } finally {
      operation.inFlight = false;
      setThreadAction((current) => current === entry.thread.id ? null : current);
    }
  }, [messageDrafts, parentSessionId, t, threadState, workspaceId]);

  const convertDiscussion = React.useCallback(async (entry: HarnessThreadSnapshot) => {
    if (convertingThreadId) return;
    setConvertingThreadId(entry.thread.id);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}/convert`,
        { method: 'POST' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : `Unable to convert discussion thread (${response.status})`,
        );
      }
      const converted = parseHarnessThreadMutation(body);
      threadState.merge(converted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.convertFailed'));
    } finally {
      setConvertingThreadId(null);
    }
  }, [convertingThreadId, parentSessionId, t, threadState]);

  const reloadBlocks = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setBlocks([]);
        setBlocksBranchLeafId(null);
        return;
      }
      throw new Error(`Unable to load session blocks (${response.status})`);
    }
    const body = await response.json();
    const parsed = parseHarnessSessionBlockResponse(body);
    setBlocks(parsed.blocks);
    setBlocksBranchLeafId(parsed.branchLeafId);
  }, [parentSessionId]);

  const reloadKnowledge = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setSuggestions([]);
        setKnowledgeDrafts({});
        return;
      }
      throw new Error(`Unable to load knowledge suggestions (${response.status})`);
    }
    const incoming = parseHarnessKnowledgeSuggestions(await response.json());
    setSuggestions(incoming);
    setKnowledgeDrafts(Object.fromEntries(incoming.map((suggestion) => [
      harnessKnowledgeKey(suggestion),
      { content: suggestion.content, trigger: suggestion.trigger, supersedes: [] },
    ])));
  }, [parentSessionId]);

  const rememberBlock = React.useCallback(async (block: HarnessSessionBlock, scope: HarnessKnowledgeScope) => {
    const busyKey = `create:${scope}:${block.label}`;
    if (knowledgeBusy) return;
    setKnowledgeBusy(busyKey);
    try {
      // BC1: an explicit user remember commits through the unified memory
      // service — no per-row review gate for direct marks.
      const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: block.content,
          trigger: '',
          kind: `block:${block.label}`,
          ...(scope === 'user' ? { scope: 'user' } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Unable to save memory (${response.status})`);
      await reloadKnowledge();
      toast.success(t('harness.knowledge.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusy(null);
    }
  }, [knowledgeBusy, parentSessionId, reloadKnowledge, t]);

  const saveKnowledgeDraft = React.useCallback(async (suggestion: HarnessKnowledgeSuggestion): Promise<boolean> => {
    const key = harnessKnowledgeKey(suggestion);
    const draft = knowledgeDrafts[key];
    if (!draft?.content.trim()) {
      toast.error(t('harness.knowledge.contentRequired'));
      return false;
    }
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions/${suggestion.scope}/${suggestion.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: draft.content,
          trigger: draft.trigger,
          expectedContent: suggestion.content,
          expectedTrigger: suggestion.trigger,
          expectedStatus: 'suggested',
          expectedInvalidAt: null,
        }),
      },
    );
    if (response.status === 409) {
      await reloadKnowledge();
      toast.error(t('harness.knowledge.conflict'));
      return false;
    }
    if (!response.ok) throw new Error(`Unable to update knowledge suggestion (${response.status})`);
    return true;
  }, [knowledgeDrafts, parentSessionId, reloadKnowledge, t]);

  const actOnKnowledge = React.useCallback(async (
    suggestion: HarnessKnowledgeSuggestion,
    action: 'save' | 'accept' | 'dismiss',
  ) => {
    const key = harnessKnowledgeKey(suggestion);
    if (knowledgeBusy) return;
    setKnowledgeBusy(key);
    try {
      if (action === 'save') {
        if (!await saveKnowledgeDraft(suggestion)) return;
      } else {
        const draft = knowledgeDrafts[key];
        const response = await runtimeFetch(
          `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions/${suggestion.scope}/${suggestion.id}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action === 'accept' ? {
              supersedes: draft?.supersedes ?? [],
              content: draft?.content ?? suggestion.content,
              trigger: draft?.trigger ?? suggestion.trigger,
              expectedContent: suggestion.content,
              expectedTrigger: suggestion.trigger,
              expectedStatus: 'suggested',
              expectedInvalidAt: null,
            } : {
              supersedes: [],
              expectedContent: suggestion.content,
              expectedTrigger: suggestion.trigger,
              expectedStatus: 'suggested',
              expectedInvalidAt: null,
            }),
          },
        );
        if (response.status === 409) {
          await reloadKnowledge();
          toast.error(t('harness.knowledge.conflict'));
          return;
        }
        if (!response.ok) throw new Error(`Unable to ${action} knowledge suggestion (${response.status})`);
      }
      await reloadKnowledge();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusy(null);
    }
  }, [knowledgeBusy, knowledgeDrafts, parentSessionId, reloadKnowledge, saveKnowledgeDraft, t]);

  const saveBlock = React.useCallback(async (block: HarnessSessionBlock) => {
    if (savingBlock) return;
    setSavingBlock(true);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks/${encodeURIComponent(block.label)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: blockDraft,
            expectedUpdatedAt: block.updatedAt,
            expectedBranchLeafId: blocksBranchLeafId,
          }),
        },
      );
      if (response.status === 409) {
        setEditingBlock(null);
        await reloadBlocks();
        throw new Error(t('harness.blocks.conflict'));
      }
      if (!response.ok) throw new Error(`Unable to save session block (${response.status})`);
      await reloadBlocks();
      setEditingBlock(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingBlock(false);
    }
  }, [blockDraft, blocksBranchLeafId, parentSessionId, reloadBlocks, savingBlock, t]);

  React.useEffect(() => {
    const controller = new AbortController();
    setBlocks([]);
    setBlocksBranchLeafId(null);
    setSuggestions([]);
    setKnowledgeDrafts({});
    setEditingBlock(null);
    setNarrowOpen(false);
    setOverviewOpen(false);
    setConvertingThreadId(null);
    setGitStatus(null);
    void reloadBlocks(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load session blocks:', error);
    });
    void reloadKnowledge(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load knowledge suggestions:', error);
    });
    void reloadSpace(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load thread space:', error);
    });
    void reloadGitStatus();
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type === 'stream-ready') {
        void reloadBlocks(controller.signal).catch(() => undefined);
        void reloadKnowledge(controller.signal).catch(() => undefined);
        void reloadSpace(controller.signal).catch(() => undefined);
        void reloadGitStatus();
        return;
      }
      if (event.type === 'harness-blocks-changed' && event.workspaceId === workspaceId && event.sessionId === parentSessionId) {
        void reloadBlocks(controller.signal).catch(() => undefined);
        void reloadGitStatus();
        return;
      }
      if (event.type === 'harness-thread-changed' && event.workspaceId === workspaceId) {
        void reloadGitStatus();
        return;
      }
      if (event.type === 'harness-knowledge-changed' && (
        event.scope === 'user'
        || event.sessionId === parentSessionId
        || !event.sessionId
      )) {
        void reloadKnowledge(controller.signal).catch(() => undefined);
        return;
      }
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [parentSessionId, reloadBlocks, reloadGitStatus, reloadKnowledge, reloadSpace, workspaceId]);

  React.useEffect(() => {
    const target = fallbackCwd?.trim();
    if (!target) return;
    const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    return workspaceEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(target)) return;
      void reloadGitStatus();
    });
  }, [fallbackCwd, reloadGitStatus]);

  React.useEffect(() => {
    if (presentation !== 'sidebar') return;
    if (overviewOpen) {
      onDesktopOpenChange?.(true);
      return;
    }
    const release = window.setTimeout(() => onDesktopOpenChange?.(false), 190);
    return () => window.clearTimeout(release);
  }, [onDesktopOpenChange, overviewOpen, presentation]);

  React.useEffect(() => () => {
    if (presentation === 'sidebar') onDesktopOpenChange?.(false);
  }, [onDesktopOpenChange, presentation]);

  const hasThreadRecords = threads.length > 0 || (space?.threads.length ?? 0) > 0;
  const hasWorkspaceChanges = (gitStatus?.files.length ?? 0) > 0;
  const hasOverviewData = threads.length > 0 || hasThreadRecords || blocks.length > 0 || suggestions.length > 0
    || webSources.length > 0 || hasWorkspaceChanges;
  if (presentation === 'inline' && !hasOverviewData && !activePdfMaterial) return null;

  const blockGroups = groupOverviewBlocks(blocks);
  const planSummary = parseOverviewPlan(blockGroups.plan?.content ?? '');
  const threadSummary = summarizeOverviewThreads(threads);
  const gitDiff = summarizeGitDiff(gitStatus);
  const pendingThreadDiff = summarizePendingThreadDiffs(threads);
  const memoryBlocks = [
    ...(blockGroups.progress ? [blockGroups.progress] : []),
    ...(blockGroups.decisions ? [blockGroups.decisions] : []),
    ...blockGroups.other,
  ];
  const hasOutputs = gitDiff.files > 0 || pendingThreadDiff.files > 0;
  const attentionCount = suggestions.length + planSummary.blocked + threadSummary.attention;
  const activityCount = attentionCount || planSummary.open + threadSummary.active + threadSummary.integrationPending;
  const overviewSummary = threadSummary.attention > 0
    ? t('harness.overview.summary.attention', { count: threadSummary.attention })
    : planSummary.blocked > 0
      ? t('harness.overview.summary.blocked', { count: planSummary.blocked })
      : suggestions.length > 0
        ? t('harness.overview.summary.review', { count: suggestions.length })
        : threadSummary.active > 0
          ? t('harness.overview.summary.running', { count: threadSummary.active })
          : planSummary.total > 0 && planSummary.done < planSummary.total
            ? t('harness.overview.summary.plan', { done: planSummary.done, total: planSummary.total })
            : planSummary.total > 0 && planSummary.done === planSummary.total
              ? t('harness.overview.summary.done', { done: planSummary.done, total: planSummary.total })
              : hasOutputs
                ? t('harness.overview.summary.changed', { count: gitDiff.files || pendingThreadDiff.files })
                : t('harness.overview.summary.context');
  const formatLogical = (bytes: number | null, unknown: boolean): string => (
    unknown || bytes === null ? t('harness.threads.space.unknownSize') : t('harness.threads.space.bytes', { bytes })
  );
  const content = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!hasOverviewData ? (
        <p className="px-3 py-4 typography-meta text-muted-foreground">{t('harness.overview.empty')}</p>
      ) : null}
      {suggestions.length > 0 ? (
        <HarnessOverviewSection
          title={t('harness.overview.review')}
          icon="error-warning"
          status={t('harness.overview.reviewCount', { count: suggestions.length })}
          defaultOpen
          attention
        >
        <HarnessKnowledgeReviewSection
          suggestions={suggestions}
          drafts={knowledgeDrafts}
          busy={knowledgeBusy !== null}
          embedded
          onDraftChange={(key, draft) => setKnowledgeDrafts((current) => ({ ...current, [key]: draft }))}
          onAction={(suggestion, action) => { void actOnKnowledge(suggestion, action); }}
        />
        </HarnessOverviewSection>
      ) : null}
      {blockGroups.plan ? (
        <HarnessOverviewSection
          title={t('harness.overview.plan')}
          icon="file-text"
          status={planSummary.total > 0
            ? t('harness.overview.planProgress', { done: planSummary.done, total: planSummary.total })
            : undefined}
          defaultOpen={planSummary.open > 0 || planSummary.blocked > 0}
          attention={planSummary.blocked > 0}
        >
          {editingBlock === blockGroups.plan.label ? (
            <div className="space-y-2">
              <textarea
                value={blockDraft}
                onChange={(event) => setBlockDraft(event.target.value)}
                className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 typography-meta leading-5 text-foreground outline-none focus:border-primary"
              />
              <div className="flex justify-end gap-1.5">
                <button type="button" className="rounded px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover" onClick={() => setEditingBlock(null)}>
                  {t('harness.blocks.cancel')}
                </button>
                <button type="button" disabled={savingBlock} className="rounded bg-primary px-2 py-1 typography-micro text-primary-foreground disabled:opacity-50" onClick={() => void saveBlock(blockGroups.plan!)}>
                  {t('harness.blocks.save')}
                </button>
              </div>
            </div>
          ) : (
            <>
              {planSummary.items.length > 0 ? (
                <div className="space-y-1.5">
                  {planSummary.items.map((item, index) => {
                    const current = planSummary.currentIndex === index;
                    return (
                      <div key={index + ':' + item.text} className={cn(
                        'flex items-start gap-2 rounded-md px-1.5 py-1 typography-meta leading-5',
                        current && item.status === 'open' && 'bg-[var(--status-info)]/8 text-foreground',
                      )}>
                        {item.status === 'done' ? (
                          <Icon name="checkbox-circle" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-success)]" />
                        ) : item.status === 'blocked' ? (
                          <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-warning)]" />
                        ) : (
                          <span className={cn(
                            'mt-1 size-2.5 shrink-0 rounded-full border border-muted-foreground/45',
                            current && 'border-[var(--status-info)] bg-[var(--status-info)]/25',
                          )} />
                        )}
                        <span className={cn(
                          'min-w-0 flex-1',
                          item.status === 'done' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                          item.status === 'blocked' && 'text-[var(--status-warning)]',
                          current && item.status === 'open' && 'font-medium',
                        )}>{item.text}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="whitespace-pre-wrap typography-meta leading-5 text-muted-foreground">{blockGroups.plan.content}</p>
              )}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                  onClick={() => {
                    setEditingBlock(blockGroups.plan!.label);
                    setBlockDraft(blockGroups.plan!.content);
                  }}
                >
                  <Icon name="edit" className="size-3" />
                  {t('harness.blocks.edit')}
                </button>
              </div>
            </>
          )}
        </HarnessOverviewSection>
      ) : null}

      {hasOutputs ? (
        <HarnessOverviewSection
          title={t('harness.overview.outputs')}
          icon="git-branch"
          status={gitDiff.files > 0
            ? t('harness.overview.outputFiles', { count: gitDiff.files })
            : t('harness.overview.outputFiles', { count: pendingThreadDiff.files })}
          defaultOpen
        >
          <div className="space-y-2">
            {gitStatus && gitStatus.files.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2 px-1.5 pb-0.5">
                  <span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground">
                    {t('harness.overview.workspaceChanges')}
                  </span>
                  <span className="typography-micro tabular-nums text-muted-foreground">
                    {t('harness.overview.outputDiff', {
                      files: gitDiff.files,
                      insertions: gitDiff.insertions,
                      deletions: gitDiff.deletions,
                    })}
                  </span>
                </div>
                {gitStatus.files.slice(0, 6).map((file) => {
                  const marker = file.working_dir.trim() || file.index.trim() || 'M';
                  const stats = gitStatus.diffStats?.[file.path];
                  return (
                    <div key={file.path} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-interactive-hover/45">
                      <span className="w-4 shrink-0 font-mono typography-micro font-medium text-muted-foreground">{marker}</span>
                      <span className="min-w-0 flex-1 truncate font-mono typography-micro text-foreground" title={file.path}>{file.path}</span>
                      {stats ? (
                        <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
                          +{stats.insertions} −{stats.deletions}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                {gitStatus.files.length > 6 ? (
                  <p className="px-1.5 typography-micro text-muted-foreground">
                    {t('harness.overview.moreItems', { count: gitStatus.files.length - 6 })}
                  </p>
                ) : null}
                <div className="flex items-center justify-end gap-2 px-1.5 pt-1 typography-micro text-muted-foreground">
                  {fallbackCwd ? (
                    <button
                      type="button"
                      className="rounded px-1.5 py-1 hover:bg-interactive-hover hover:text-foreground"
                      onClick={() => openContextSurface(fallbackCwd, 'git')}
                    >
                      {t('harness.overview.viewChanges')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {pendingThreadDiff.files > 0 ? (
              <div className="rounded-lg border border-border/45 bg-background/35 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="typography-micro font-medium text-foreground">{t('harness.overview.pendingThreadChanges')}</span>
                  <span className="typography-micro tabular-nums text-muted-foreground">
                    {t('harness.overview.outputDiff', {
                      files: pendingThreadDiff.files,
                      insertions: pendingThreadDiff.insertions,
                      deletions: pendingThreadDiff.deletions,
                    })}
                  </span>
                </div>
                <p className="mt-1 typography-micro leading-5 text-muted-foreground">{t('harness.overview.pendingThreadChangesDescription')}</p>
              </div>
            ) : null}
          </div>
        </HarnessOverviewSection>
      ) : null}

      {hasThreadRecords ? (
        <HarnessOverviewSection
          title={t('harness.overview.threads')}
          icon="git-branch"
          status={t('harness.overview.threadsSummary', {
            active: threadSummary.active + threadSummary.attention + threadSummary.integrationPending,
            completed: threadSummary.completed,
          })}
          defaultOpen={threadSummary.active + threadSummary.attention + threadSummary.integrationPending > 0}
          attention={threadSummary.attention > 0}
        >
            <div className="flex items-center justify-end gap-2 pb-1.5">
              <button
                type="button"
                onClick={() => threadState.setIncludeArchived(!threadState.includeArchived)}
                className="rounded px-1.5 py-0.5 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground"
              >
                {t(threadState.includeArchived ? 'harness.threads.hideArchived' : 'harness.threads.showArchived')}
              </button>
            </div>
            {space && (space.status === 'over-budget' || space.status === 'low-free' || space.status === 'enospc') ? (
              <div className="mb-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 typography-micro leading-5 text-muted-foreground">
                {space.status === 'over-budget' ? <p className="text-[var(--status-warning)]">{t('harness.threads.space.overBudget')}</p> : null}
                {space.status === 'low-free' ? <p className="text-[var(--status-warning)]">{t('harness.threads.space.lowFree')}</p> : null}
                {space.status === 'enospc' ? <p className="text-[var(--status-error)]">{t('harness.threads.space.enospc')}</p> : null}
              </div>
            ) : null}
            <div className="space-y-1.5">
        {threads.length === 0 ? (
          <p className="px-1 typography-micro text-muted-foreground">{t('harness.threads.empty')}</p>
        ) : null}
        {threads.map((entry) => {
          const state = projectHarnessThreadState(entry);
          // A closed/reclaimed thread still has readable native history.
          const sessionId = entry.activeRun?.sessionId ?? entry.thread.report?.transcriptRef.sessionId;
          const converting = convertingThreadId === entry.thread.id;
          const occupancy = space?.threads.find((item) => item.threadId === entry.thread.id);
          const busy = threadAction === entry.thread.id;
          const deletionPending = entry.thread.deletion !== undefined;
          const label = entry.thread.preset ?? (
            entry.thread.kind === 'discussion'
              ? t('harness.threads.discussion')
              : t('harness.threads.userThread')
          );
          return (
            <div key={entry.thread.id} className="overflow-hidden rounded-lg border border-transparent transition-colors hover:border-border/60 hover:bg-interactive-hover">
              <button
                type="button"
                disabled={!sessionId || busy || deletionPending}
                title={sessionId ? t('harness.threads.transcript') : undefined}
                onClick={() => {
                  if (!sessionId) return;
                  void openThread(entry);
                }}
                className="group w-full px-2.5 py-2 text-left disabled:cursor-default disabled:opacity-80"
              >
                <div className="flex items-center gap-2">
                  {state === 'running' || state === 'starting' ? (
                    <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-[var(--status-info)]" />
                  ) : (
                    <span className={cn('size-2 shrink-0 rounded-full', stateTone[state])} aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{label}</span>
                  <span className="rounded bg-muted/60 px-1 py-0.5 typography-micro text-muted-foreground">
                    {t(entry.thread.kind === 'discussion' ? 'harness.threads.kind.discussion' : 'harness.threads.kind.implementation')}
                  </span>
                  <span className="shrink-0 typography-micro text-muted-foreground">{t(stateKey[state])}</span>
                </div>
                <p className="mt-1 line-clamp-2 typography-meta leading-5 text-muted-foreground">{entry.thread.brief}</p>
                {entry.thread.waitingFor ? (
                  <p className="mt-1 line-clamp-2 typography-meta leading-5 text-[var(--status-warning)]">
                    ? {entry.thread.waitingFor.text}
                  </p>
                ) : null}
                {entry.thread.deletion ? (
                  <p className="mt-1 line-clamp-2 typography-micro leading-5 text-[var(--status-warning)]">
                    {t('harness.threads.deleting')} · {entry.thread.deletion.phase}
                    {entry.thread.deletion.error ? ` · ${entry.thread.deletion.error}` : ''}
                  </p>
                ) : null}
                <div className="mt-1.5 flex items-center gap-2 typography-micro tabular-nums text-muted-foreground/80">
                  <span>↳ {entry.activeRun?.steps ?? 0}</span>
                  {entry.thread.diffStats && entry.thread.diffStats.files > 0 ? (
                    <span>Δ {entry.thread.diffStats.files} · +{entry.thread.diffStats.insertions} −{entry.thread.diffStats.deletions}</span>
                  ) : null}
                </div>
              </button>
              {!deletionPending && entry.thread.kind === 'implementation'
                && (entry.thread.integration === 'dirty'
                  || entry.thread.integration === 'merge-ready'
                  || entry.thread.integration === 'conflict') ? (
                <HarnessThreadIntegrationPanel
                  workspaceId={workspaceId}
                  parentSessionId={parentSessionId}
                  entry={entry}
                  onThread={(next) => threadState.merge({ thread: next, activeRun: entry.activeRun })}
                />
              ) : null}
              <details className="group/details border-t border-border/35">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 typography-micro text-muted-foreground hover:bg-background/45 hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Icon name="arrow-right-s" className="size-3 transition-transform group-open/details:rotate-90" />
                  <span>{t('harness.overview.runDetails')}</span>
                  {occupancy ? (
                    <span className="ml-auto tabular-nums typography-micro text-muted-foreground/75">
                      {t('harness.threads.space.logical', { bytes: formatLogical(occupancy.materialized.logicalBytes, occupancy.materialized.unknown) })}
                    </span>
                  ) : null}
                </summary>
                <div className="border-t border-border/30 bg-background/20 px-2.5 py-2">
                  {(() => {
                    const last = entry.thread.messages?.[entry.thread.messages.length - 1];
                    if (!last) return null;
                    const peer = last.from.kind === 'user'
                      ? t('harness.threads.peer.user')
                      : last.from.kind === 'session'
                        ? t('harness.threads.peer.session')
                        : last.from.id;
                    return (
                      <p className="mb-1.5 line-clamp-2 typography-micro leading-5 text-muted-foreground/80">
                        {last.direction === 'in' ? '↓' : '↑'} {peer} · {t(last.kind === 'request' ? 'harness.threads.msg.request' : 'harness.threads.msg.inform')}
                        {(last.status === 'held' || last.status === 'pending') ? ` · ${t('harness.threads.msg.held')}` : ''}
                      </p>
                    );
                  })()}
                  {entry.thread.verification?.childChecks ? (
                    <p className="mb-1 typography-micro leading-5 text-muted-foreground">
                      {t('harness.threads.verification.child', { revision: String(entry.thread.verification.childChecks.resultRevision) })}: {' '}
                      {entry.thread.verification.childChecks.commands.length === 0
                        ? t('harness.threads.verification.childEmpty')
                        : entry.thread.verification.childChecks.commands
                          .map((command) => t('harness.threads.verification.command', {
                            code: command.exitCode === null ? '—' : String(command.exitCode),
                            command: command.command,
                          }))
                          .join('; ')}
                    </p>
                  ) : null}
                  {entry.thread.integrationBinding ? (
                    <p className="mb-1 typography-micro leading-5 text-muted-foreground">
                      {t('harness.threads.verification.merge')}: {' '}
                      {entry.thread.integrationBinding.valid === false
                        ? t('harness.threads.previewStale')
                        : entry.thread.integrationBinding.mergeReady
                          ? t('harness.threads.state.merge-ready')
                          : t('harness.threads.state.dirty')}
                    </p>
                  ) : null}
                  {entry.thread.verification?.parentChecks ? (
                    <p className="mb-1 typography-micro leading-5 text-muted-foreground">
                      {t('harness.threads.verification.parent')}: {' '}
                      {entry.thread.verification.parentChecks.draftUnsaved
                        ? t('harness.threads.verification.parentUnsaved')
                        : entry.thread.verification.parentChecks.binding === 'not-recorded'
                          ? t('harness.threads.verification.parentNone')
                          : entry.thread.verification.parentChecks.note ?? entry.thread.verification.parentChecks.binding}
                    </p>
                  ) : null}
                  {entry.thread.verification?.review && entry.thread.verification.review.status !== 'none' ? (
                    <p className="mb-1 typography-micro leading-5 text-muted-foreground">
                      {t('harness.threads.verification.review', { revision: String(entry.thread.verification.review.resultRevision) })}: {' '}
                      {entry.thread.verification.review.status === 'running'
                        ? t('harness.threads.verification.reviewRunning')
                        : entry.thread.verification.review.conclusion
                          ?? entry.thread.verification.review.error
                          ?? entry.thread.verification.review.status}
                    </p>
                  ) : null}
                  {occupancy && occupancy.keepReasons.length > 0 ? (
                    <p className="mb-1 typography-micro leading-5 text-muted-foreground">
                      {t('harness.threads.space.kept', { reason: occupancy.keepReasons.join('; ') })}
                    </p>
                  ) : null}
                  {entry.thread.worktree?.retentionReason ? (
                    <p className="mb-1 typography-micro leading-5 text-[var(--status-warning)]">{entry.thread.worktree.retentionReason}</p>
                  ) : null}
              {!deletionPending ? (
                <HarnessThreadResultHistory
                  parentSessionId={parentSessionId}
                  threadId={entry.thread.id}
                  onReleased={refreshAfterResultRelease}
                />
              ) : null}
              {!deletionPending && entry.thread.kind === 'implementation' && entry.thread.lifecycle !== 'archived' ? (
                <div className="flex flex-wrap items-center gap-1 border-t border-border/40 px-2 py-1.5">
                  <input
                    type="text"
                    value={messageDrafts[entry.thread.id] ?? ''}
                    disabled={busy}
                    placeholder={t('harness.threads.askPlaceholder')}
                    onChange={(event) => setMessageDrafts((current) => ({ ...current, [entry.thread.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void sendThreadMessage(entry, 'request');
                      }
                    }}
                    className="min-w-0 basis-full rounded bg-background/60 px-1.5 py-1 typography-meta text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border disabled:opacity-50"
                  />
                  <button
                    type="button"
                    disabled={busy || !(messageDrafts[entry.thread.id] ?? '').trim()}
                    title={t('harness.threads.ask')}
                    onClick={() => { void sendThreadMessage(entry, 'request'); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name={busy ? 'loader-4' : 'send-plane'} className={cn('size-3', busy && 'animate-spin')} />
                    {t('harness.threads.ask')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !(messageDrafts[entry.thread.id] ?? '').trim()}
                    title={t('harness.threads.fresh')}
                    onClick={() => { void sendThreadMessage(entry, 'fresh'); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name="refresh" className="size-3" />
                    {t('harness.threads.fresh')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !(messageDrafts[entry.thread.id] ?? '').trim()}
                    title={t('harness.threads.note')}
                    onClick={() => { void sendThreadMessage(entry, 'inform'); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name="sticky-note" className="size-3" />
                    {t('harness.threads.note')}
                  </button>
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-1 border-t border-border/40 px-2 py-1">
                {entry.thread.kind === 'discussion' && entry.thread.lifecycle === 'active' ? (
                  <button
                    type="button"
                    disabled={convertingThreadId !== null || deletionPending}
                    onClick={() => { void convertDiscussion(entry); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name={converting ? 'loader-4' : 'git-branch'} className={cn('size-3', converting && 'animate-spin')} />
                    {t(converting ? 'harness.threads.converting' : 'harness.threads.convert')}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy || deletionPending}
                  onClick={() => {
                    setThreadAction(entry.thread.id);
                    void applyThreadMutation(
                      `${encodeURIComponent(entry.thread.id)}/keep-worktree`,
                      'harness.threads.keepFailed',
                      { keepWorktree: !entry.thread.keepWorktree },
                    ).catch((error) => {
                      toast.error(error instanceof Error ? error.message : t('harness.threads.keepFailed'));
                    }).finally(() => setThreadAction(null));
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                >
                  {t(entry.thread.keepWorktree ? 'harness.threads.keepWorktreeOn' : 'harness.threads.keepWorktree')}
                </button>
                {occupancy?.reclaimable ? (
                  <button
                    type="button"
                    disabled={busy || deletionPending}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/reclaim`,
                        'harness.threads.reclaimFailed',
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.reclaimFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.reclaiming' : 'harness.threads.reclaim')}
                  </button>
                ) : null}
                {entry.thread.lifecycle === 'archived' ? (
                  <button
                    type="button"
                    disabled={busy || deletionPending}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/restore`,
                        'harness.threads.restoreFailed',
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.restoreFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.restoring' : 'harness.threads.restore')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || deletionPending}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/archive`,
                        'harness.threads.archiveFailed',
                        { keepWorktree: entry.thread.keepWorktree === true },
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.archiveFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.archiving' : 'harness.threads.archive')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirmDeleteId !== entry.thread.id) {
                      setConfirmDeleteId(entry.thread.id);
                      return;
                    }
                    setConfirmDeleteId(null);
                    setThreadAction(entry.thread.id);
                    void deleteThread(entry).catch((error) => {
                      toast.error(error instanceof Error ? error.message : t('harness.threads.deleteFailed'));
                    }).finally(() => setThreadAction(null));
                  }}
                  onBlur={() => {
                    if (confirmDeleteId === entry.thread.id) setConfirmDeleteId(null);
                  }}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-1 typography-micro disabled:opacity-50 ${confirmDeleteId === entry.thread.id ? 'bg-[var(--status-error)]/15 text-[var(--status-error)] hover:bg-[var(--status-error)]/25' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                >
                  {t((busy || deletionPending) && confirmDeleteId !== entry.thread.id
                    ? 'harness.threads.deleting'
                    : confirmDeleteId === entry.thread.id
                      ? 'harness.threads.deleteConfirm'
                      : 'harness.threads.delete')}
                </button>
              </div>
                </div>
              </details>
            </div>
          );
        })}
            </div>
        </HarnessOverviewSection>
      ) : null}
      {webSources.length > 0 ? (
        <HarnessOverviewSection
          title={t('harness.overview.sources')}
          icon="global"
          status={webSources.length}
        >
          <div className="space-y-1">
              {[...webSources].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.fetchedAt - left.fetchedAt).map((source) => (
                (() => {
                  const isPdf = Boolean(source.snapshotId && source.document?.kind === 'pdf');
                  const openPdf = () => setActivePdfMaterial({
                    sessionId: parentSessionId,
                    title: source.title,
                    snapshotId: source.snapshotId!,
                    ...(source.sourceHash ? { sourceHash: source.sourceHash } : {}),
                    originalUrl: source.url,
                  });
                  return (
                  <div key={source.id} className="group/source flex items-start gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-interactive-hover">
                    <Icon name={source.tool === 'websearch' ? 'search' : source.tool === 'research_search' ? 'book' : source.tool === 'materials' ? 'archive-stack' : source.tool === 'research_decide' ? 'scales-3' : isPdf ? 'file-image' : 'global'} className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                    {isPdf ? (
                      <div className="min-w-0 flex-1">
                        <button type="button" className="block w-full truncate text-left typography-meta text-foreground hover:underline" onClick={openPdf} title={source.title}>{source.title}</button>
                        <a href={source.url} target="_blank" rel="noreferrer" className="block truncate typography-micro text-muted-foreground hover:text-foreground" title={source.url}>{t('harness.sources.originalSource')}</a>
                      </div>
                    ) : (
                      <a href={source.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1" title={source.url}>
                        <span className="block truncate typography-meta text-foreground">{source.title}</span>
                        <span className="block truncate typography-micro text-muted-foreground">{source.url}</span>
                      </a>
                    )}
                    {source.paperId ? (
                      <span className="block truncate typography-micro text-muted-foreground/70" title={source.paperId}>
                        {source.provider}:{source.paperId}{source.relation ? ` · ${source.relation}` : ''}
                      </span>
                    ) : null}
                    <button
                    type="button"
                    onClick={() => source.pinned ? unpinSource(source.id) : pinSource(source.id)}
                    aria-label={t(source.pinned ? 'harness.sources.unpin' : 'harness.sources.pin')}
                    className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-background hover:text-foreground group-hover/source:opacity-100"
                  >
                    <Icon name={source.pinned ? 'pushpin-2-fill' : 'pushpin'} className="size-3" />
                  </button>
                    <button
                    type="button"
                    onClick={() => deleteSource(source.id)}
                    aria-label={t('harness.sources.remove')}
                    className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-background hover:text-[var(--status-error)] group-hover/source:opacity-100"
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                  </div>
                  );
                })()
              ))}
          </div>
        </HarnessOverviewSection>
      ) : null}
      {memoryBlocks.length > 0 ? (
        <HarnessOverviewSection
          title={t('harness.overview.memory')}
          icon="brain"
          status={memoryBlocks.length}
        >
          <div className="space-y-2">
            {memoryBlocks.map((block) => {
              const editing = editingBlock === block.label;
              const friendlyLabel = block.label === 'progress'
                ? t('harness.overview.memoryProgress')
                : block.label === 'decisions'
                  ? t('harness.overview.memoryDecisions')
                  : block.label;
              return (
                <div key={block.label} className="rounded-lg border border-border/45 bg-background/35 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{friendlyLabel}</span>
                    <button
                      type="button"
                      title={t('harness.blocks.edit')}
                      aria-label={t('harness.blocks.edit')}
                      onClick={() => {
                        setEditingBlock(editing ? null : block.label);
                        setBlockDraft(block.content);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    >
                      <Icon name={editing ? 'close' : 'edit'} className="size-3" />
                    </button>
                  </div>
                  {editing ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={blockDraft}
                        onChange={(event) => setBlockDraft(event.target.value)}
                        className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 typography-meta leading-5 text-foreground outline-none focus:border-primary"
                      />
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className="rounded px-2 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover" onClick={() => setEditingBlock(null)}>
                          {t('harness.blocks.cancel')}
                        </button>
                        <button type="button" disabled={savingBlock} className="rounded bg-primary px-2 py-1 typography-micro text-primary-foreground disabled:opacity-50" onClick={() => void saveBlock(block)}>
                          {t('harness.blocks.save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap typography-micro leading-5 text-muted-foreground">{block.content}</p>
                  )}
                  {!editing ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button type="button" disabled={knowledgeBusy !== null} className="rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50" onClick={() => void rememberBlock(block, 'workspace')}>
                        {t('harness.knowledge.rememberWorkspace')}
                      </button>
                      <button type="button" disabled={knowledgeBusy !== null} className="rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50" onClick={() => void rememberBlock(block, 'user')}>
                        {t('harness.knowledge.rememberUser')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </HarnessOverviewSection>
      ) : null}

    </div>
  );

  return (
    <>
      {activePdfMaterial ? (
        <PdfMaterialReader
          open
          sessionId={activePdfMaterial.sessionId}
          title={activePdfMaterial.title}
          snapshotId={activePdfMaterial.snapshotId}
          {...(activePdfMaterial.sourceHash ? { sourceHash: activePdfMaterial.sourceHash } : {})}
          {...(activePdfMaterial.page ? { initialPage: activePdfMaterial.page } : {})}
          {...(activePdfMaterial.region ? { initialRegion: activePdfMaterial.region } : {})}
          {...(activePdfMaterial.analysisId ? { analysisId: activePdfMaterial.analysisId } : {})}
          {...(activePdfMaterial.originalUrl ? { originalUrl: activePdfMaterial.originalUrl } : {})}
          onOpenChange={(open) => { if (!open) setActivePdfMaterial(null); }}
        />
      ) : null}
      <Dialog open={historyPreview !== null} onOpenChange={(open) => { if (!open) setHistoryPreview(null); }}>
        <DialogContent className="flex h-[80dvh] max-w-[90vw] flex-col">
          <DialogHeader>
            <DialogTitle>{t('harness.threads.transcript')}</DialogTitle>
            <DialogDescription>{historyPreview?.brief} — {t('harness.threads.transcriptReadOnly')}</DialogDescription>
          </DialogHeader>
          {historyPreview ? (
            <React.Suspense fallback={<div role="status">{t('sessions.sidebar.group.empty.loadingSessions')}</div>}>
              <LazyThreadTimeline sessionId={historyPreview.result.sessionId} entries={historyPreview.result.entries}
                leafId={historyPreview.result.leafId} cwd={historyPreview.cwd ?? ''} toolExecutions={{}} />
            </React.Suspense>
          ) : null}
        </DialogContent>
      </Dialog>
      {presentation === 'inline' ? (
        <details className="group shrink-0 border-b border-border/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 typography-meta text-muted-foreground hover:text-foreground sm:px-6">
            <Icon name="arrow-right-s" className="size-3.5 transition-transform group-open:rotate-90" />
            <span>{title ?? t('harness.overview.title')}</span>
            <span className="ml-auto min-w-0 truncate typography-micro text-muted-foreground/80">{overviewSummary}</span>
          </summary>
          <div className="max-h-[40dvh] overflow-auto">{content}</div>
        </details>
      ) : <>
      <div
        className="pointer-events-none absolute right-3 top-2 z-40 hidden flex-col items-end xl:flex"
      >
        <div
          className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-border/70 bg-background/90 p-1 shadow-sm backdrop-blur-xl"
          data-harness-overview-controls="true"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setOverviewOpen((open) => !open)}
                aria-expanded={overviewOpen}
                aria-label={t(overviewOpen ? 'harness.overview.collapse' : 'harness.overview.expand')}
                className={cn(
                  'relative flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground',
                  overviewOpen && 'bg-interactive-selection text-foreground',
                )}
              >
                <Icon name="stack" className="size-4" />
                {activityCount > 0 ? (
                  <span className={cn(
                    'absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[8px] font-semibold tabular-nums text-muted-foreground',
                    attentionCount > 0 && 'bg-[var(--status-warning)] text-white',
                  )}>{activityCount}</span>
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t(overviewOpen ? 'harness.overview.collapse' : 'harness.overview.expand')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!contextDirectoryKey}
                onClick={() => {
                  if (!contextDirectoryKey) return;
                  setOverviewOpen(false);
                  toggleContextPanel(contextDirectoryKey);
                }}
                aria-expanded={contextPanelOpen}
                aria-label={t(contextPanelOpen ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel')}
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:cursor-default disabled:opacity-40',
                  contextPanelOpen && 'bg-interactive-selection text-primary',
                )}
              >
                <Icon name="layout-right" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t(contextPanelOpen ? 'contextPanel.actions.closePanel' : 'contextPanel.actions.openPanel')}</TooltipContent>
          </Tooltip>
        </div>
        <AnimatePresence initial={false}>
        {overviewOpen ? (
          <motion.section
            aria-label={t('harness.overview.title')}
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -5, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.22, 0.8, 0.2, 1] }}
            style={{ transformOrigin: 'top right' }}
            className="pointer-events-auto mt-2 flex max-h-[min(72dvh,46rem)] w-[min(20rem,calc(100vw-6rem))] flex-col overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-lg backdrop-blur-xl will-change-transform"
            data-harness-overview-floating="true"
          >
            {content}
          </motion.section>
        ) : null}
        </AnimatePresence>
      </div>
      <HarnessSessionStateTrigger count={activityCount} attention={attentionCount > 0} onOpen={() => setNarrowOpen(true)} />
      <MobileOverlayPanel
        open={narrowOpen}
        onClose={() => setNarrowOpen(false)}
        title={t('harness.overview.title')}
        className="h-[min(82dvh,720px)]"
        contentMaxHeightClassName="flex-1"
      >
        {content}
      </MobileOverlayPanel>
      </>}
    </>
  );
};
