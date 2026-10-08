import React from 'react';
import { runtimeFetch, type GitStatus } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { usePiInteractionStore, userQuestionRequest } from '@/stores/usePiInteractionStore';
import { EMPTY_WORK_OVERVIEW_CHOICES, useWorkOverviewStore, workOverviewStateKey } from '@/stores/useWorkOverviewStore';
import { parseHarnessSessionBlockResponse, type HarnessSessionBlock } from './harnessBlockPresentation';
import {
  harnessKnowledgeKey,
  parseHarnessKnowledgeSuggestions,
  type HarnessKnowledgeScope,
  type HarnessKnowledgeSuggestion,
} from './harnessKnowledgePresentation';
import { HarnessKnowledgeReviewSection, type KnowledgeDraft } from './HarnessKnowledgeReviewSection';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { HarnessOverviewControl, type OverviewPeekRow, type OverviewPeekSection } from './HarnessOverviewControl';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { HarnessThreadList } from './HarnessThreadList';
import { HarnessThreadDialog } from './HarnessThreadConversation';
import { THREAD_EXCHANGE_OPEN_EVENT, type ThreadExchangeLocation } from './threadMessages';
import { useWebSources, useWebSourcesStore } from '@/stores/useWebSourcesStore';
import { PdfMaterialReader } from './PdfMaterialReader';
import { getGitStatus } from '@/lib/gitApiHttp';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { useUIStore } from '@/stores/useUIStore';
import { HarnessOverviewSection } from './HarnessOverviewSection';
import { ComputerAutomationSection } from './ComputerAutomationSection';
import { useComputerAutomation } from '@/stores/useComputerAutomation';
import {
  groupOverviewBlocks,
  parseOverviewPlan,
  summarizeGitDiff,
  summarizeOverviewThreads,
  summarizePendingThreadDiffs,
} from './harnessWorkOverviewPresentation';

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

export type WorkOverviewView = 'compact' | 'full' | null;

export const HarnessThreadsPanel: React.FC<{
  workspaceId: string;
  parentSessionId: string;
  fallbackCwd?: string;
  presentation?: 'sidebar' | 'inline';
  title?: string;
  onDesktopViewChange?: (view: WorkOverviewView) => void;
}> = ({ workspaceId, parentSessionId, fallbackCwd, presentation = 'sidebar', title, onDesktopViewChange }) => {
  const { t } = useI18n();
  const { breakpoint } = useDeviceInfo();
  const narrowScreen = breakpoint !== 'xl' && breakpoint !== '2xl';
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const branch = usePiSessionStore(state => state.records[parentSessionId]?.branchEntries);
  const todoCommits = usePiSessionStore(state => Object.values(state.records[parentSessionId]?.toolExecutions ?? {})
    .filter(tool => tool.name === 'todo' && tool.status === 'success').map(tool => tool.toolCallId).join('\0'));
  const computer = useComputerAutomation(parentSessionId);
  const overviewKey = workOverviewStateKey(runtimeKey, parentSessionId);
  const selectedOverviewRef = React.useRef(overviewKey);
  selectedOverviewRef.current = overviewKey;
  const blocksRead = React.useRef(0);
  const knowledgeRead = React.useRef(0);
  const gitRead = React.useRef(0);
  const choices = useWorkOverviewStore((state) => state.bySession[overviewKey] ?? EMPTY_WORK_OVERVIEW_CHOICES);
  const setDisclosure = useWorkOverviewStore((state) => state.setDisclosure);
  const overviewOpen = choices.overview ?? false;
  const narrowOpen = choices.mobile ?? false;
  const compactOpen = Boolean(choices.compact && !overviewOpen && !narrowOpen);
  const setOverviewOpen = (open: boolean) => setDisclosure(overviewKey, 'overview', open);
  const setNarrowOpen = (open: boolean) => setDisclosure(overviewKey, 'mobile', open);
  const setCompactOpen = (open: boolean) => setDisclosure(overviewKey, 'compact', open);
  const [selectedThreadId, setSelectedThreadId] = React.useState<string | null>(null);
  const [messageFocus, setMessageFocus] = React.useState<ThreadExchangeLocation | null>(null);
  React.useEffect(() => { setSelectedThreadId(null); setMessageFocus(null); }, [workspaceId, parentSessionId]);
  const threadState = useHarnessThreadState();
  const threadScopeRef = React.useRef(threadState.workspaceId);
  threadScopeRef.current = threadState.workspaceId;
  React.useEffect(() => {
    const openExchange = (event: Event) => {
      const location = (event as CustomEvent<ThreadExchangeLocation>).detail;
      if (!location || ![...(threadState.peers ?? []), ...threadState.threads, ...threadState.branches, ...threadState.rootThreads].some(entry => entry.thread.id === location.threadId)) return;
      setSelectedThreadId(location.threadId);
      setMessageFocus(location);
    };
    window.addEventListener(THREAD_EXCHANGE_OPEN_EVENT, openExchange);
    return () => window.removeEventListener(THREAD_EXCHANGE_OPEN_EVENT, openExchange);
  }, [threadState.peers, threadState.threads, threadState.branches, threadState.rootThreads]);
  const threads = React.useMemo(() => [
    ...threadState.threads,
    ...threadState.branches,
  ], [threadState.threads, threadState.branches]);
  const dialogs = usePiInteractionStore(state => state.dialogs);
  const showQuestion = usePiInteractionStore(state => state.showQuestion);
  const respondQuestion = usePiInteractionStore(state => state.respondDialog);
  const questionSessions = new Set([parentSessionId, ...[...threads, ...threadState.rootThreads, ...(threadState.peers ?? [])]
    .map(thread => thread.activeRun?.sessionId)]);
  const questions = dialogs.filter(dialog => dialog.method === 'question' && questionSessions.has(dialog.sessionId));
  const webSources = useWebSources(parentSessionId);
  const openContextSurface = useUIStore((state) => state.openContextSurface);
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
  const [activePdfMaterial, setActivePdfMaterial] = React.useState<ActivePdfMaterial | null>(null);
  const [gitStatus, setGitStatus] = React.useState<GitStatus | null>(null);
  const gitTargetRef = React.useRef(fallbackCwd ?? '');
  gitTargetRef.current = fallbackCwd ?? '';

  const reloadGitStatus = React.useCallback(async () => {
    if (selectedOverviewRef.current !== overviewKey) return;
    const read = ++gitRead.current;
    const target = fallbackCwd?.trim() ?? '';
    if (!target) {
      setGitStatus(null);
      return;
    }
    try {
      const next = await getGitStatus(target);
      if (read === gitRead.current && selectedOverviewRef.current === overviewKey && gitTargetRef.current === target) setGitStatus(next);
    } catch {
      // Work overview is useful outside Git repositories too. A missing or
      // temporarily unavailable Git status must not hide the rest of it.
      if (read === gitRead.current && selectedOverviewRef.current === overviewKey && gitTargetRef.current === target) setGitStatus(null);
    }
  }, [fallbackCwd, overviewKey]);

  const reloadBlocks = React.useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted || selectedOverviewRef.current !== overviewKey) return;
    const read = ++blocksRead.current;
    const current = () => !signal?.aborted && read === blocksRead.current && selectedOverviewRef.current === overviewKey;
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        if (!current()) return;
        setBlocks([]);
        setBlocksBranchLeafId(null);
        return;
      }
      throw new Error(`Unable to load session blocks (${response.status})`);
    }
    const body = await response.json();
    const parsed = parseHarnessSessionBlockResponse(body);
    if (!current()) return;
    setBlocks(parsed.blocks);
    setBlocksBranchLeafId(parsed.branchLeafId);
  }, [overviewKey, parentSessionId]);

  const reloadKnowledge = React.useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted || selectedOverviewRef.current !== overviewKey) return;
    const read = ++knowledgeRead.current;
    const current = () => !signal?.aborted && read === knowledgeRead.current && selectedOverviewRef.current === overviewKey;
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        if (!current()) return;
        setSuggestions([]);
        setKnowledgeDrafts({});
        return;
      }
      throw new Error(`Unable to load knowledge suggestions (${response.status})`);
    }
    const incoming = parseHarnessKnowledgeSuggestions(await response.json());
    if (!current()) return;
    setSuggestions(incoming);
    setKnowledgeDrafts(Object.fromEntries(incoming.map((suggestion) => [
      harnessKnowledgeKey(suggestion),
      { content: suggestion.content, trigger: suggestion.trigger, supersedes: [] },
    ])));
  }, [overviewKey, parentSessionId]);

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
    setGitStatus(null);
    void reloadBlocks(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load session blocks:', error);
    });
    void reloadKnowledge(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load knowledge suggestions:', error);
    });
    void reloadGitStatus();
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type === 'stream-ready') {
        void reloadBlocks(controller.signal).catch(() => undefined);
        void reloadKnowledge(controller.signal).catch(() => undefined);
        void reloadGitStatus();
        return;
      }
      // Blocks are session-addressed. Their knowledge owner can differ from
      // the current execution workspace (for example a Bot or isolated child).
      if (event.type === 'harness-blocks-changed' && event.sessionId === parentSessionId) {
        void reloadBlocks(controller.signal).catch(() => undefined);
        void reloadGitStatus();
        return;
      }
      if (event.type === 'harness-thread-changed' && event.workspaceId === threadScopeRef.current) {
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
  }, [parentSessionId, reloadBlocks, reloadGitStatus, reloadKnowledge]);

  React.useEffect(() => {
    if (todoCommits) void reloadBlocks().catch(error => console.warn('[HarnessThreadsPanel] Failed to load updated plan:', error));
  }, [todoCommits, reloadBlocks]);

  const viewedBranch = React.useRef<{ key: string; leafId: string | null } | null>(null);
  React.useEffect(() => {
    if (!branch) return;
    const previous = viewedBranch.current;
    viewedBranch.current = { key: overviewKey, leafId: branch.leafId };
    // Appends keep their ancestor. Navigation replaces the active path and
    // therefore changes which plan/progress/decision revisions are visible.
    if (previous?.key === overviewKey && previous.leafId && !branch.entries.some(entry => entry.id === previous.leafId)) {
      void reloadBlocks().catch(error => console.warn('[HarnessThreadsPanel] Failed to load branch blocks:', error));
      void reloadGitStatus();
    }
  }, [branch, overviewKey, reloadBlocks, reloadGitStatus]);

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
    const view: WorkOverviewView = narrowScreen ? null : overviewOpen ? 'full' : compactOpen ? 'compact' : null;
    if (view) {
      onDesktopViewChange?.(view);
      return;
    }
    const release = window.setTimeout(() => onDesktopViewChange?.(null), 190);
    return () => window.clearTimeout(release);
  }, [onDesktopViewChange, overviewOpen, compactOpen, narrowScreen, presentation]);

  React.useEffect(() => () => {
    if (presentation === 'sidebar') onDesktopViewChange?.(null);
  }, [onDesktopViewChange, presentation]);

  const hasThreadRecords = threads.length > 0;
  const hasWorkspaceChanges = (gitStatus?.files.length ?? 0) > 0;
  const computerRequests = computer.state?.requests.filter(item => item.status === 'pending').length ?? 0;
  const hasComputer = Boolean(computer.state?.leases.length || computerRequests || computer.activities.length || computer.state && computer.state.status !== 'enabled');
  const hasOverviewData = questions.length > 0 || threads.length > 0 || hasThreadRecords || blocks.length > 0 || suggestions.length > 0
    || webSources.length > 0 || hasWorkspaceChanges || hasComputer;
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
  const attentionCount = questions.length + suggestions.length + planSummary.blocked + threadSummary.attention + computerRequests + (computer.state?.status === 'stop-unconfirmed' ? 1 : 0);
  const overviewSummary = questions.length > 0 ? t('pi.question.pending') + ' · ' + questions.length : threadSummary.attention > 0
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
  const peekRows: OverviewPeekRow[] = [];
  if (hasComputer) peekRows.push({ id: 'computer', section: 'computer', icon: 'computer', label: t('computer.automation.title'),
    value: computerRequests ? t('computer.automation.pending', { count: computerRequests })
      : computer.state?.status !== 'enabled' ? t(`computer.automation.${computer.state?.status ?? 'stopped'}`)
        : computer.activities.find(entry => entry.activity.status === 'running')?.activity.app ?? computer.state?.leases.length,
    ...(computerRequests || computer.state?.status === 'stop-unconfirmed' ? { tone: 'attention' as const } : {}),
    ...(computer.state?.active && computer.state.status !== 'stopped' ? { action: { label: t('computer.automation.stop'), disabled: computer.busy || computer.state.status === 'stopping', run: () => void computer.stop() } } : {}) });
  const planProgress = { done: planSummary.done, total: planSummary.total };
  if (blockGroups.plan) peekRows.push({
    id: 'plan', section: 'plan',
    icon: planSummary.total > 0 && planSummary.done === planSummary.total ? 'checkbox-circle' : 'file-text',
    label: planSummary.total === 0 ? t('harness.overview.plan')
      : planSummary.done === planSummary.total ? t('harness.overview.summary.done', planProgress)
        : planSummary.blocked > 0 ? t('harness.overview.summary.blocked', { count: planSummary.blocked }) + ' · '
          + t('harness.overview.planProgress', planProgress) : t('harness.overview.summary.plan', planProgress),
    ...(planSummary.total > 0 ? { progress: planSummary.done / planSummary.total } : {}),
    ...(planSummary.blocked > 0 ? { tone: 'attention' as const } : planSummary.total > 0 && planSummary.done === planSummary.total ? { tone: 'success' as const } : {}),
  });
  if (questions.length) peekRows.push({ id: 'questions', section: 'questions', icon: 'question', label: t('pi.question.pending'), value: questions.length, tone: 'attention' });
  if (suggestions.length) peekRows.push({ id: 'review', section: 'review', icon: 'error-warning', label: t('harness.overview.review'), value: suggestions.length, tone: 'attention' });
  if (threadSummary.total) peekRows.push({ id: 'threads', section: 'threads', icon: 'git-branch', label: t('harness.overview.threads'),
    value: t('harness.overview.threadCounts', { active: threadSummary.active, done: threadSummary.completed }) });
  if (threadSummary.attention) peekRows.push({ id: 'threadAttention', section: 'threads', icon: 'error-warning',
    label: t('harness.overview.summary.attention', { count: threadSummary.attention }), tone: 'attention' });
  if (gitDiff.files) peekRows.push({ id: 'workspace', section: 'outputs', icon: 'file-code', label: t('harness.overview.workspaceChanges'), value: t('harness.overview.outputFiles', { count: gitDiff.files }) });
  if (pendingThreadDiff.files) peekRows.push({ id: 'pendingChanges', section: 'outputs', icon: 'git-branch', label: t('harness.overview.pendingThreadChanges'), value: t('harness.overview.outputFiles', { count: pendingThreadDiff.files }) });
  if (webSources.length) peekRows.push({ id: 'sources', section: 'sources', icon: 'global', label: t('harness.overview.sources'), value: webSources.length });
  if (memoryBlocks.length) peekRows.push({ id: 'memory', section: 'memory', icon: 'file-text', label: t('harness.overview.memory'), value: memoryBlocks.length });
  const openDetails = (section?: OverviewPeekSection) => {
    if (section) setDisclosure(overviewKey, section, true);
    if (narrowScreen) setNarrowOpen(true); else setOverviewOpen(true);
  };
  const content = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!hasOverviewData ? (
        <p className="px-3 py-4 typography-meta text-muted-foreground">{t('harness.overview.empty')}</p>
      ) : null}
      {hasComputer ? <HarnessOverviewSection title={t('computer.automation.title')} icon="computer" status={computerRequests || undefined}
        attention={computerRequests > 0 || computer.state?.status === 'stop-unconfirmed'} open={choices.computer ?? true} onOpenChange={open => setDisclosure(overviewKey, 'computer', open)}>
        <ComputerAutomationSection view={computer} directory={fallbackCwd ?? ''} />
      </HarnessOverviewSection> : null}
      {questions.length > 0 ? <HarnessOverviewSection title={t('pi.question.pending')} icon="question" status={questions.length} attention open={choices.questions ?? true} onOpenChange={open => setDisclosure(overviewKey, 'questions', open)}>
        <div className="space-y-2">{questions.map(dialog => <div key={dialog.id} className="flex items-start gap-2 rounded-md bg-muted/25 px-2 py-2">
          <button type="button" className="min-w-0 flex-1 text-left typography-meta hover:text-primary" onClick={() => showQuestion(dialog.id)}>{userQuestionRequest(dialog)?.questions.map(question => question.question).join(' · ')}</button>
          <button type="button" aria-label={t('pi.question.close')} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => void respondQuestion(dialog.id, undefined, true).catch(error => toast.error(error instanceof Error ? error.message : String(error)))}><Icon name="close" className="size-3.5" /></button>
        </div>)}</div>
      </HarnessOverviewSection> : null}
      {suggestions.length > 0 ? (
        <HarnessOverviewSection
          key={`${overviewKey}:review`}
          title={t('harness.overview.review')}
          icon="error-warning"
          status={t('harness.overview.reviewCount', { count: suggestions.length })}
          open={choices.review ?? true}
          onOpenChange={(open) => setDisclosure(overviewKey, 'review', open)}
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
          key={`${overviewKey}:plan`}
          title={t('harness.overview.plan')}
          icon="file-text"
          status={planSummary.total > 0
            ? t('harness.overview.planProgress', { done: planSummary.done, total: planSummary.total })
            : undefined}
          open={choices.plan ?? true}
          onOpenChange={(open) => setDisclosure(overviewKey, 'plan', open)}
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
                    const current = item.status === 'in_progress';
                    return (
                      <div key={index + ':' + item.text} className={cn(
                        'flex items-start gap-2 rounded-md px-1.5 py-1 typography-meta leading-5',
                        current && 'bg-[var(--status-info)]/8 text-foreground',
                      )}>
                        {item.status === 'completed' ? (
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
                          item.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                          item.status === 'blocked' && 'text-[var(--status-warning)]',
                          current && 'font-medium',
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
          key={`${overviewKey}:outputs`}
          title={t('harness.overview.outputs')}
          icon="git-branch"
          status={gitDiff.files > 0
            ? t('harness.overview.outputFiles', { count: gitDiff.files })
            : t('harness.overview.outputFiles', { count: pendingThreadDiff.files })}
          open={choices.outputs ?? true}
          onOpenChange={(open) => setDisclosure(overviewKey, 'outputs', open)}
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
          key={`${overviewKey}:threads`}
          title={t('harness.overview.threads')}
          icon="git-branch"
          status={threads.length}
          open={choices.threads ?? true}
          onOpenChange={(open) => setDisclosure(overviewKey, 'threads', open)}
          attention={threadSummary.attention > 0}
        >
          <div className="max-h-[40dvh] overflow-y-auto">
            <HarnessThreadList entries={threads} parentSessionId={parentSessionId} onSelect={(entry) => setSelectedThreadId(entry.thread.id)} />
          </div>
          {fallbackCwd ? <button type="button"
            className="mt-1 flex w-full items-center justify-center gap-1 border-t border-border/40 px-3 py-2 typography-meta text-muted-foreground hover:text-foreground"
            onClick={() => openContextSurface(fallbackCwd, 'threads')}>
            {t('harness.threads.viewAll')}<Icon name="arrow-right-s" className="size-3.5" />
          </button> : null}
        </HarnessOverviewSection>
      ) : null}
      {webSources.length > 0 ? (
        <HarnessOverviewSection
          key={`${overviewKey}:sources`}
          title={t('harness.overview.sources')}
          icon="global"
          status={webSources.length}
          open={choices.sources ?? false}
          onOpenChange={(open) => setDisclosure(overviewKey, 'sources', open)}
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
          key={`${overviewKey}:memory`}
          title={t('harness.overview.memory')}
          icon="brain"
          status={memoryBlocks.length}
          open={choices.memory ?? true}
          onOpenChange={(open) => setDisclosure(overviewKey, 'memory', open)}
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
      <HarnessThreadDialog entry={[...threads, ...threadState.rootThreads, ...(threadState.peers ?? [])].find((entry) => entry.thread.id === selectedThreadId) ?? null}
        parentSessionId={parentSessionId} cwd={fallbackCwd} messageFocus={messageFocus?.threadId === selectedThreadId ? messageFocus : null}
        onClose={() => { setSelectedThreadId(null); setMessageFocus(null); }} />
      {presentation === 'inline' ? (
        <details
          key={overviewKey}
          className="group shrink-0 border-b border-border/60"
          open={overviewOpen}
          onToggle={(event) => {
            if (event.target === event.currentTarget && event.currentTarget.open !== overviewOpen) {
              setOverviewOpen(event.currentTarget.open);
            }
          }}
        >
          <summary className="workbench-overview-heading flex cursor-pointer list-none items-center gap-2 px-4 py-2 typography-meta text-muted-foreground hover:text-foreground sm:px-6">
            <Icon name="arrow-right-s" className="size-3.5 transition-transform group-open:rotate-90" />
            <span>{title ?? t('harness.overview.title')}</span>
            <span className="ml-auto min-w-0 truncate typography-micro text-muted-foreground/80">{overviewSummary}</span>
          </summary>
          <div className="max-h-[40dvh] overflow-auto">{content}</div>
        </details>
      ) : <>
      <HarnessOverviewControl open={narrowScreen ? narrowOpen : overviewOpen} compactOpen={compactOpen}
        attention={attentionCount > 0} rows={peekRows} onSelect={openDetails}
        onOpenChange={narrowScreen ? setNarrowOpen : setOverviewOpen} onCompactChange={setCompactOpen}>
        {!narrowScreen ? content : null}
      </HarnessOverviewControl>
      <MobileOverlayPanel
        open={narrowOpen && narrowScreen}
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
