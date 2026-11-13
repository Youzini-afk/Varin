import { ThreadDraftConversation } from '@/components/thread/ThreadDraftConversation';
import { MessageHandoff } from '@/components/conversation/messageHandoff';
import React from 'react';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import type { BotMatter } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type BotSession, type ThreadIdentity } from '@varin/application-client';
import { MainLayout } from '@/components/layout/MainLayout';
import { BOT_CONVERSATION_PANEL_SCOPE, openConversationTree } from '@/lib/openConversationTree';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import {
  archiveBot, changeBotState, createBot, createBotSession, ensureBotEntry, ensurePrimaryBot, listBots, listBotSessions, listBotWork,
  openBotConversation, openBotWorkInWorkbench, sameBotEntry, updateBot, useBotNavigation, useBotReturn,
  type BotModelSelection, type BotReturnPoint, type BotSummary, type BotWorkItem,
} from '@/lib/bots';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { ChildNavigationContext, type ChildNavigation } from '@/components/conversation/childNavigation';
import { MemoryNavigationContext, type MemoryNavigation } from '@/components/conversation/memoryNavigation';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { threadComposerKey, threadHostKey, useThreadStore } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { noteSwitchDirection } from '@/lib/motion/switchDirection';
import { BotNameDialog } from '@/components/sections/bots/BotNameDialog';
import type { BotMenuAction } from '@/components/sections/bots/BotMenu';
import { BotActivityBanner } from '@/components/sections/bots/BotActivityBanner';
import { BotDeleteDialog } from '@/components/sections/bots/BotDeleteDialog';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useBotLayout, type BotPanelTab } from './botLayout';
import type { BotPanelFocus, BotPanelModel } from './botPanelModel';
import {
  botSessionTitle, buildTimeline, figureState, isActiveRun, isWaitingStatus, liveRun, needsOf, presenceNeeds, runStatus, sessionViews, showsTeamMoments, stagePose, stateLine,
  teamMomentLine, workViews, type BotFigureState, type BotSessionView, type BotStateLine, type BotTeamMoment,
} from './botPresentation';
import type { BotStageEvent } from './botStageDirector';
import type { BotStageFeed } from './botStageRenderer';
import { useBotFacts, useBotPresence } from './useBotFacts';
import { useBotOrganization } from './useBotOrganization';
import { useBotStage } from './useBotStage';
import { BotFigure } from './BotFigure';
import { BotMobileTitle } from './BotMobileTitle';
import { BotNavigator } from './BotNavigator';
import type { BotSessionAction } from './BotSessionMenu';
import { BotPanel } from './BotPanel';
import { useBotWorkspaces } from './useBotWorkspaces';
import { BotWorkspaceNavigationContext } from './botWorkspaceViews';
import { BotWorkspaceArea } from './BotWorkspaceArea';
import { workKey } from './botPresentation';

const BotDetailsDialog = React.lazy(() => import('@/components/sections/bots/BotDetailsDialog').then((module) => ({ default: module.BotDetailsDialog })));
const ContextPanel = React.lazy(() => import('@/components/layout/ContextPanel').then(module => ({ default: module.ContextPanel })));
const ConversationTreePanel = React.lazy(() => import('@/components/thread/ConversationTreePanel').then(module => ({ default: module.ConversationTreePanel })));
const ContextPanelContent = React.lazy(() => import('@/components/layout/ContextSidebarTab').then(module => ({ default: module.ContextPanelContent })));
const CONVERSATION_SURFACES = ['tree', 'context'] as const;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** How long the state line names a team moment (§5.7.3). */
const MOMENT_MS = 2600;
const LISTENING_MS = 2500;
const momentOf = (event: BotStageEvent, nameOf: (key: string) => string): BotTeamMoment | null => {
  if (event.kind === 'dispatch' || event.kind === 'continue') return { kind: event.kind, name: nameOf(event.lead) };
  if (event.kind === 'lead-report') return { kind: 'report', name: nameOf(event.lead), failed: event.outcome === 'fail' };
  if (event.kind === 'gather') return { kind: 'gather', count: event.count };
  return null;
};

const openSettings = () => {
  useUIStore.getState().setSettingsDialogOpen(true);
};

function useMatchMedia(query: string): boolean {
  const subscribe = React.useCallback((change: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, [query]);
  const read = React.useCallback(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches, [query]);
  return React.useSyncExternalStore(subscribe, read, () => false);
}

/**
 * While Bot is shown, the shared sidebar follows the Bot's own preference (collapsed by default),
 * and the ordinary workbench gets its own back on leaving (docs/design/bot-ui.md §2).
 */
function useBotSidebar(committed: boolean, isMobile: boolean, floating: boolean): void {
  // A floating sidebar is a passing overlay: it starts closed and its opening is not the preference.
  const floatingNow = React.useRef(floating);
  floatingNow.current = floating;
  React.useEffect(() => {
    if (!committed || isMobile) return undefined;
    // Captures the ordinary workbench's sidebar first, before anything below changes it.
    const layout = useBotLayout.getState();
    if (layout.ordinarySidebar === null) layout.setOrdinarySidebar(useUIStore.getState().isSidebarOpen);
    useUIStore.getState().setSidebarOpen(floatingNow.current ? false : layout.sidebarOpen);
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (state.isSidebarOpen !== previous.isSidebarOpen && !floatingNow.current) useBotLayout.getState().setSidebarOpen(state.isSidebarOpen);
    });
    return () => {
      unsubscribe();
      const ordinary = useBotLayout.getState().ordinarySidebar;
      useBotLayout.getState().setOrdinarySidebar(null);
      if (ordinary !== null) useUIStore.getState().setSidebarOpen(ordinary);
    };
  }, [committed, isMobile]);
  // Entering or leaving the floating width: the overlay starts closed; docked again, the preference returns.
  const wasFloating = React.useRef(floating);
  React.useEffect(() => {
    const before = wasFloating.current;
    wasFloating.current = floating;
    if (!committed || isMobile || before === floating) return;
    useUIStore.getState().setSidebarOpen(floating ? false : useBotLayout.getState().sidebarOpen);
  }, [committed, isMobile, floating]);
}

/** Bot identity, sessions and work remain Host-owned; this shell selects and presents them. */
export const BotWorkspaceShell: React.FC<Record<string, unknown>> = () => {
  // Candidate shells render before profile commit. They must never create a Bot
  // or change the shared session selection during that hidden render.
  const active = useWorkbenchShellActive();
  const committed = useWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID && active;
  const runtimeKey = useThreadStore((state) => state.hostKey);
  return <BotWorkspace key={runtimeKey} committed={committed} />;
};

const BotWorkspace: React.FC<{ committed: boolean }> = ({ committed }) => {
  const { t } = useI18n();
  const contextPanel = useUIStore(state => state.contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]);
  const conversationTab = contextPanel?.isOpen ? contextPanel.tabs.find(tab => tab.id === contextPanel.activeTabId && (tab.mode === 'tree' || tab.mode === 'context')) : undefined;
  const treeTab = conversationTab?.mode === 'tree' ? conversationTab : undefined;
  const [conversationPanelMounted, setConversationPanelMounted] = React.useState(Boolean(conversationTab));
  React.useEffect(() => { if (conversationTab) setConversationPanelMounted(true); }, [conversationTab]);
  const closeConversationPanel = () => useUIStore.getState().closeContextPanel(BOT_CONVERSATION_PANEL_SCOPE);
  const { isMobile } = useDeviceInfo();
  const { threads, bots: botsAPI } = useRuntimeAPIs();
  const navigation = useBotNavigation();
  const selectedDraftKey = useThreadStore(state => state.selectedDraftKey);
  const selectedNativeIdentity = useThreadStore(state => state.selectedIdentity);
  const selectedDraft = useThreadDraftStore(state => selectedDraftKey ? state.drafts[selectedDraftKey] : undefined);
  const [dismissedDraftKey, setDismissedDraftKey] = React.useState<string | null>(null);
  const [draftTransfer, setDraftTransfer] = React.useState<{ key: string; botId: string } | null>(null);
  const transferredDraft = useThreadDraftStore(state => draftTransfer ? state.drafts[draftTransfer.key] : undefined);
  const [messageHandoff] = React.useState(() => new MessageHandoff());
  React.useLayoutEffect(() => () => messageHandoff.dispose(), [messageHandoff]);
  const dismissDraft = React.useCallback(() => { setDismissedDraftKey(useThreadStore.getState().selectedDraftKey); setDraftTransfer(null); }, []);

  const catalog = useThreadStore(state => state.threads);
  const offline = useThreadStore(state => state.catalogError !== null);
  const appliedNavigation = React.useRef<string | null>(null);
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const organization = useBotOrganization(bots, committed && !settingsOpen);
  const [showArchived, setShowArchived] = React.useState(false);
  const [details, setDetails] = React.useState<{ id: string; name: string; tab: 'profile' | 'memory' } | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!committed || !selectedDraftKey || selectedDraftKey === dismissedDraftKey || !selectedDraft?.botId) return;
    setSelectedId(selectedDraft.botId);
    setDraftTransfer({ key: selectedDraftKey, botId: selectedDraft.botId });
  }, [committed, selectedDraftKey, selectedDraft?.botId, dismissedDraftKey]);
  const activeDraftKey = selectedDraftKey && selectedDraftKey !== dismissedDraftKey && selectedDraft?.botId === selectedId ? selectedDraftKey : null;
  const materializedDraft = !selectedDraftKey && draftTransfer?.botId === selectedId && transferredDraft?.identity && transferredDraft.identity.threadId === selectedNativeIdentity?.threadId ? transferredDraft.identity : null;
  React.useEffect(() => {
    if (!committed || !materializedDraft || !draftTransfer) return;
    if (!sameBotEntry(navigation.entry, materializedDraft) || navigation.botId !== draftTransfer.botId) void openBotConversation(draftTransfer.botId, materializedDraft);
    if (catalog.some(thread => thread.thread_id === materializedDraft.threadId)) setDraftTransfer(null);
  }, [committed, materializedDraft, draftTransfer, navigation.entry, navigation.botId, catalog]);

  const [workResult, setWorkResult] = React.useState<{ botId: string; items: BotWorkItem[] } | null>(null);
  const [sessionResult, setSessionResult] = React.useState<{ botId: string; items: BotSession[] } | { botId: string; error: string } | null>(null);
  const [matters, setMatters] = React.useState<{ botId: string; items: BotMatter[] } | null>(null);
  const [workRevision, refreshWork] = React.useReducer((value: number) => value + 1, 0);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [nameDialog, setNameDialog] = React.useState<{ mode: 'create' } | { mode: 'rename'; bot: BotSummary } | { mode: 'session'; session: BotSessionView } | null>(null);
  const [nameDraft, setNameDraft] = React.useState('');
  const sessionForkKeys = React.useRef(new Map<string, string>());
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const [deletingSession, setDeletingSession] = React.useState<{ botId: string; identity: ThreadIdentity; branch: boolean; title: string } | null>(null);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [focus, setFocus] = React.useState<BotPanelFocus | null>(null);
  const [narrowPanelOpen, setNarrowPanelOpen] = React.useState(false);
  const [spaceExpanded, setSpaceExpanded] = React.useState(false);
  const [moment, setMoment] = React.useState<{ line: BotStateLine; until: number } | null>(null);
  const [listening, setListening] = React.useState(false);
  const opening = React.useRef<AbortController | null>(null);
  const selected = bots?.find((bot) => bot.id === selectedId);
  const profileModelKey = JSON.stringify(selected?.model ?? null);
  const [entryResolution, setEntryResolution] = React.useState<{ botId: string; entry: ThreadIdentity; profileModelKey: string; model: BotModelSelection | null }>();
  const readOnly = Boolean(selected?.archived || selected?.deletion || (selected?.activity && selected.activity.state !== 'awake'));
  const botsRef = React.useRef(bots);
  botsRef.current = bots;
  const alive = React.useRef(true);
  const workItems = workResult?.botId === selectedId ? workResult.items : null;
  const sessionItems = sessionResult?.botId === selectedId && 'items' in sessionResult ? sessionResult.items : null;
  const sessionsError = sessionResult?.botId === selectedId && 'error' in sessionResult ? sessionResult.error : null;
  const catalogSessionIds = React.useMemo(() => JSON.stringify(catalog
    .filter(thread => thread.bot_id === selectedId && !thread.parent_thread_id)
    .map(thread => thread.thread_id).sort()), [catalog, selectedId]);
  const panelOpen = useBotLayout(state => state.panelOpen);
  const setPanelOpen = useBotLayout(state => state.setPanelOpen);
  const setTab = useBotLayout(state => state.setTab);
  const floating = useMatchMedia('(min-width: 760px) and (max-width: 1023px)');
  const panelVisible = !isMobile && (floating ? narrowPanelOpen : panelOpen);
  // Below 1280px the sidebar opens over the conversation instead of pushing it (§8).
  const floatingSidebar = useMatchMedia('(max-width: 1279px)') && !isMobile;
  useBotSidebar(committed, isMobile, floatingSidebar);

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; opening.current?.abort(); }; }, []);
  React.useEffect(() => committed ? subscribeVarinEvents((event) => {
    if (event.type === 'bot-changed' || event.type === 'stream-ready') refresh();
    if (event.type === 'bot-work-changed') refreshWork();
  }) : undefined, [committed]);

  React.useEffect(() => {
    if (!committed || settingsOpen) return;
    const controller = new AbortController();
    void listBots(controller.signal).then(async (list) => {
      if (!showArchived && !list.some(bot => !bot.archived && !bot.deletion)) {
        const primary = await ensurePrimaryBot(controller.signal);
        list = [...list.filter(bot => bot.id !== primary.id), primary];
      }
      if (controller.signal.aborted) return;
      const visible = list.filter((bot) => bot.archived === showArchived);
      setBots(list);
      setError(null);
      setSelectedId((previous) => visible.find((bot) => bot.id === useBotNavigation.getState().botId)?.id
        ?? visible.find((bot) => bot.id === previous)?.id
        ?? visible[0]?.id ?? null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [committed, settingsOpen, revision, showArchived]);

  const openEntry = React.useCallback(async (botId: string, navigate = false) => {
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    const host = getRuntimeEndpointGeneration();
    const surface = useUIStore.getState().mainSurfaceSelectionRevision;
    const superseded = () => controller.signal.aborted || getRuntimeEndpointGeneration() !== host
      || navigate && surface !== useUIStore.getState().mainSurfaceSelectionRevision;
    setBusy(true);
    setError(null);
    try {
      const known = botsRef.current?.find((bot) => bot.id === botId);
      if (known?.deletion) return;
      const inactive = known && (known.archived || (known.activity && known.activity.state !== 'awake'));
      if (inactive) {
        const sessions = await listBotSessions(botId, controller.signal);
        if (superseded()) return;
        const entry = sessions.find(session => session.primary && !session.thread.archived)
          ?? sessions.find(session => !session.thread.archived);
        useBotNavigation.setState({ botId, entry: entry?.identity ?? null, model: known.model, archived: known.archived });
        setSelectedId(botId);
        if (navigate) useUIStore.getState().closeMainSurfaces();
        return;
      }
      const { bot, entry, model } = await ensureBotEntry(botId, controller.signal);
      if (superseded()) return;
      setBots((list) => list?.map((item) => item.id === bot.id ? bot : item) ?? [bot]);
      setEntryResolution({ botId: bot.id, entry, profileModelKey: JSON.stringify(bot.model), model });
      // Restoring the shell's entry is not a navigation gesture. In particular it
      // must not dismiss a page the user opened while this request was pending.
      useBotNavigation.setState({ botId: bot.id, entry, model, archived: bot.archived });
      setSelectedId(bot.id);
      if (navigate) useUIStore.getState().closeMainSurfaces();
    } catch (cause) {
      if (!superseded()) setError(message(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (!committed || !selectedId) return;
    if (useBotNavigation.getState().botId !== selectedId || !useBotNavigation.getState().entry) void openEntry(selectedId);
    return () => opening.current?.abort();
  }, [committed, selectedId, openEntry, readOnly]);

  React.useEffect(() => {
    if (!committed || !selectedId || settingsOpen) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void Promise.all([listBotWork(selectedId, signal), botsAPI?.matters.list(selectedId, signal) ?? []]).then(([items, list]) => {
      if (!signal.aborted) { setWorkResult({ botId: selectedId, items }); setMatters({ botId: selectedId, items: list }); }
    }).catch((cause: unknown) => {
      if (!signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [committed, selectedId, settingsOpen, revision, workRevision, botsAPI]);

  React.useEffect(() => {
    if (!committed || !selectedId || settingsOpen) return;
    const controller = new AbortController();
    const signal = controller.signal;
    // Sessions fail on their own: the conversation stays usable through the profile entry.
    void listBotSessions(selectedId, signal).then(items => {
      if (!signal.aborted) setSessionResult({ botId: selectedId, items });
    }, (cause: unknown) => {
      if (!signal.aborted) setSessionResult(current => current?.botId === selectedId && 'items' in current ? current : { botId: selectedId, error: message(cause) });
    });
    return () => controller.abort();
  }, [committed, selectedId, settingsOpen, revision, workRevision, catalogSessionIds]);

  React.useEffect(() => {
    if (!navigation.botId || !navigation.entry) return;
    const key = JSON.stringify([navigation.botId, navigation.entry]);
    if (appliedNavigation.current === key) return;
    const target = bots?.find(bot => bot.id === navigation.botId);
    if (!target && navigation.archived === undefined) return;
    appliedNavigation.current = key;
    setShowArchived(target?.archived ?? navigation.archived!);
    setSelectedId(navigation.botId);
  }, [navigation.botId, navigation.entry, navigation.archived, bots]);

  const selectedEntry = materializedDraft ?? (navigation.botId === selectedId ? navigation.entry : null);
  const sessions = React.useMemo<BotSessionView[] | null>(() => {
    if (!selected) return null;
    const known = sessionItems ?? (sessionsError ? [] : null);
    // Until the list answers (or if it failed), the profile entry is still the Bot's conversation.
    const entryThread = catalog.find(thread => thread.thread_id === selected.entry.threadId);
    const items = sessionItems ?? (entryThread && entryThread.deleted_at_ms === null
      ? [{ identity: selected.entry, thread: entryThread, primary: true }]
      : known);
    return items ? sessionViews(items, catalog, []) : null;
  }, [selected, sessionItems, sessionsError, catalog]);
  const facts = useBotFacts({ botId: selected?.id ?? null, identity: selectedEntry ?? undefined, followups: threads?.followups, revision: revision + workRevision, enabled: committed && Boolean(selected) && !settingsOpen });
  const activity = facts.activity.value;
  const work = React.useMemo(() => workViews(workItems ?? [], catalog, activity), [workItems, catalog, activity]);
  // The Host's presence for every live Bot drives their figures; the selected Bot falls back to the
  // live catalog only until its first projection arrives.
  const liveBotIds = React.useMemo(() => (bots ?? []).filter(bot => !bot.archived && !bot.deletion).map(bot => bot.id), [bots]);
  const presence = useBotPresence(liveBotIds, committed && !settingsOpen);
  const selectedPresence = selectedId ? presence.get(selectedId)?.value ?? null : null;
  const sessionsWithWork = React.useMemo(() => sessions && selected ? sessionViews(sessions.map(view => ({ identity: view.identity, thread: view.thread, primary: view.primary })), catalog, work) : sessions, [sessions, selected, catalog, work]);
  const currentSession = sessionsWithWork?.find(session => session.identity.threadId === selectedEntry?.threadId) ?? null;
  const conversationArchived = currentSession?.thread.archived ?? catalog.find(thread => thread.thread_id === selectedEntry?.threadId)?.archived ?? false;
  const ownsConversation = Boolean(selectedEntry && selected && (materializedDraft || currentSession
    || (entryResolution?.botId === selected.id && sameBotEntry(entryResolution.entry, selectedEntry))
    || (!sessionItems && selectedEntry.threadId === selected.entry.threadId)
    || catalog.some(thread => thread.thread_id === selectedEntry.threadId && thread.bot_id === selected.id && !thread.parent_thread_id && thread.branches.some(branch => branch.branch_id === selectedEntry.branchId))));
  const sessionEntry = Boolean(ownsConversation);

  React.useEffect(() => {
    if (!committed || !selected || readOnly || conversationArchived || !sessionEntry) return;
    if (entryResolution?.botId === selected.id && entryResolution.profileModelKey === profileModelKey) return;
    const controller = new AbortController();
    const botId = selected.id;
    void ensureBotEntry(botId, controller.signal).then(({ entry, model }) => {
      if (!controller.signal.aborted) setEntryResolution({ botId, entry, profileModelKey, model });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [committed, selected, profileModelKey, readOnly, conversationArchived, sessionEntry, entryResolution]);

  // "Listening" is the user typing into this conversation's composer.
  const draftKey = activeDraftKey ?? (selectedEntry ? threadComposerKey(threadHostKey(), selectedEntry) : null);
  const draftText = useThreadDraftStore(state => draftKey ? state.drafts[draftKey]?.text ?? '' : '');
  const lastDraft = React.useRef(draftText);
  React.useEffect(() => {
    const changed = lastDraft.current !== draftText;
    lastDraft.current = draftText;
    if (!changed || !draftText.trim()) { if (!draftText.trim()) setListening(false); return undefined; }
    setListening(true);
    const timer = setTimeout(() => setListening(false), LISTENING_MS);
    return () => clearTimeout(timer);
  }, [draftText]);

  // The stage: her own round, her team on the ledge and the moments between them (§5.7.2).
  const stage = useBotStage({ threads, botId: selectedId, enabled: committed && !settingsOpen && Boolean(selected) && !offline, preferThreadId: selectedEntry?.threadId ?? null });
  const memberNames = React.useRef(new Map<string, string>());
  for (const lead of stage.view.leads) {
    const named = work.find(item => item.identity.threadId === lead.threadId && item.identity.branchId === lead.branchId)?.name;
    memberNames.current.set(lead.key, named || lead.title || lead.threadId);
  }
  // A dispatch, a report or reports taken in are named on the state line for a moment.
  const seenMoment = React.useRef(0);
  React.useEffect(() => {
    const fresh = stage.moments.filter(entry => entry.id > seenMoment.current);
    if (!fresh.length) return;
    seenMoment.current = fresh[fresh.length - 1]!.id;
    const nameOf = (key: string) => memberNames.current.get(key) ?? '';
    const latest = fresh.map(entry => momentOf(entry.event, nameOf)).filter((value): value is BotTeamMoment => value !== null).pop();
    if (latest && (latest.kind === 'gather' || latest.name)) setMoment({ line: teamMomentLine(latest), until: Date.now() + MOMENT_MS });
  }, [stage.moments]);
  React.useEffect(() => { setMoment(null); }, [selectedId]);
  React.useEffect(() => {
    if (!moment) return undefined;
    const timer = setTimeout(() => setMoment(null), Math.max(0, moment.until - Date.now()));
    return () => clearTimeout(timer);
  }, [moment]);

  const needs = React.useMemo(() => selectedPresence ? presenceNeeds(selectedPresence, catalog) : selected && sessionsWithWork ? needsOf(selected, sessionsWithWork, work) : [], [selectedPresence, catalog, selected, sessionsWithWork, work]);
  const working = React.useMemo<readonly { name: string }[]>(() => selectedPresence?.working ?? work.filter(item => item.status !== null && !isWaitingStatus(item.status)), [selectedPresence, work]);
  const currentThread = selectedEntry ? catalog.find(thread => thread.thread_id === selectedEntry.threadId) : undefined;
  const currentRun = selectedEntry ? liveRun(currentThread, selectedEntry.branchId, null) : null;
  const thinking = selectedPresence ? selectedPresence.replying.length > 0 : isActiveRun(currentRun) && !isWaitingStatus(runStatus(currentRun));
  const figureOf = React.useCallback((bot: BotSummary): BotFigureState => {
    const current = bot.id === selectedId;
    const other = current ? null : presence.get(bot.id)?.value ?? null;
    return figureState({
      offline, activity: bot.activity?.state, inactive: Boolean(bot.archived || bot.deletion),
      needs: current ? needs.length : other?.needs.length ?? 0,
      thinking: current ? thinking : Boolean(other?.replying.length), working: current ? working.length : other?.working.length ?? 0,
      listening: current && listening,
    });
  }, [offline, selectedId, presence, needs.length, thinking, working.length, listening]);
  const figures = React.useMemo(() => new Map((bots ?? []).map(bot => [bot.id, figureOf(bot)])), [bots, figureOf]);
  const figure = selected ? figureOf(selected) : 'idle';
  const pose = stagePose(figure, stage.view.own, stage.view.leads.length > 0);
  const stageFeed = React.useMemo<BotStageFeed>(() => ({ leads: stage.view.leads, events: stage.moments, typing: listening }), [stage.view.leads, stage.moments, listening]);
  const timeline = React.useMemo(() => buildTimeline(activity, facts.memory.value), [activity, facts.memory.value]);

  const sessionTitleOf = React.useCallback((view: BotSessionView) => botSessionTitle(view.thread.title, selected?.name ?? 'Varin'), [selected?.name]);
  const sessionTitle = React.useCallback((threadId: string) => {
    const view = sessionsWithWork?.find(session => session.identity.threadId === threadId);
    if (view) return sessionTitleOf(view);
    const thread = catalog.find(thread => thread.thread_id === threadId);
    return thread ? botSessionTitle(thread.title, selected?.name ?? 'Varin') : threadId;
  }, [sessionsWithWork, sessionTitleOf, catalog, selected?.name]);

  // Coming back from the workbench lights the row the user left from.
  const returned = useBotReturn(state => state.returned);
  const focusToken = React.useRef(0);
  const focusTab = React.useCallback((tab: BotPanelTab, id?: string) => {
    setProfileOpen(false);
    setTab(tab);
    if (id) setFocus({ tab, id, token: ++focusToken.current });
    if (floating) setNarrowPanelOpen(true); else if (!isMobile) setPanelOpen(true);
  }, [setTab, floating, isMobile, setPanelOpen]);
  React.useEffect(() => {
    if (!committed || !returned || returned.botId !== selectedId) return;
    useBotReturn.setState({ returned: null });
    if (returned.focus) focusTab(returned.focus.tab, returned.focus.id);
  }, [committed, returned, selectedId, focusTab]);

  const openSession = React.useCallback((identity: ThreadIdentity) => {
    if (!selected) return;
    dismissDraft();
    opening.current?.abort();
    setBusy(false);
    useUIStore.getState().setSessionSwitcherOpen(false);
    const order = sessionsWithWork?.map(session => session.identity.threadId) ?? [];
    noteSwitchDirection(order.indexOf(identity.threadId) - order.indexOf(selectedEntry?.threadId ?? ''));
    if (floating) setNarrowPanelOpen(false);
    if (floatingSidebar) useUIStore.getState().setSidebarOpen(false);
    void openBotConversation(selected.id, identity).catch((cause: unknown) => setError(message(cause)));
  }, [selected, sessionsWithWork, selectedEntry, floating, floatingSidebar, dismissDraft]);

  const openWork = React.useCallback((identity: ThreadIdentity, origin?: BotReturnPoint['focus']) => {
    if (!selected) return;
    const session = selectedEntry ?? selected.entry;
    const point: BotReturnPoint = { botId: selected.id, botName: selected.name, session, sessionTitle: sessionTitle(session.threadId), workThreadId: identity.threadId, ...(origin ? { focus: origin } : {}) };
    void openBotWorkInWorkbench(point, identity).catch((cause: unknown) => setError(message(cause)));
  }, [selected, selectedEntry, sessionTitle]);

  const openCreateDialog = () => {
    setError(null);
    setNameDraft('');
    setNameDialog({ mode: 'create' });
  };

  const saveName = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const host = getRuntimeEndpointGeneration();
    const dialog = nameDialog;
    const trimmed = nameDraft.trim();
    if (!dialog || !trimmed) return;
    setActionBusy(dialog.mode === 'create' ? 'create' : `rename:${dialog.mode === 'session' ? dialog.session.identity.threadId : dialog.bot.id}`);
    setError(null);
    try {
      if (dialog.mode === 'session') {
        await useThreadStore.getState().updateThread(dialog.session.identity.threadId, { title: trimmed });
        if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
        refreshWork();
      } else {
        const bot = dialog.mode === 'create' ? await createBot({ name: trimmed }) : await updateBot(dialog.bot.id, { name: trimmed });
        if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
        setBots((list) => dialog.mode === 'create' ? [...(list ?? []), bot] : list?.map((item) => item.id === bot.id ? bot : item) ?? [bot]);
        if (dialog.mode === 'create') { useBotNavigation.setState({ botId: null, entry: null }); setShowArchived(false); setSelectedId(bot.id); }
      }
      setNameDialog(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setActionBusy(null);
    }
  };

  const mutateSession = async (botId: string, threadId: string, action: 'archive' | 'restore' | 'delete') => {
    const host = getRuntimeEndpointGeneration();
    const current = () => alive.current && host === getRuntimeEndpointGeneration();
    setActionBusy(`session:${threadId}`);
    setError(null);
    try {
      const store = useThreadStore.getState();
      if (!store.threads.some(thread => thread.thread_id === threadId)) await store.loadCatalog();
      if (!current()) return;
      if (action === 'delete') await store.deleteThread(threadId);
      else await store.updateThread(threadId, { archived: action === 'archive' });
      if (!current()) return;
      if (action === 'delete') {
        setDeletingSession(null);
        setSessionResult(result => result?.botId === botId && 'items' in result
          ? { ...result, items: result.items.filter(session => session.identity.threadId !== threadId) }
          : result);
      }
      toast.success(t(action === 'restore' ? 'sessions.sidebar.session.unarchive.success' : action === 'archive' ? 'sessions.sidebar.session.archive.success' : 'sessions.sidebar.session.delete.success'));
      const navigation = useBotNavigation.getState();
      if (navigation.botId === botId && navigation.entry?.threadId === threadId && action !== 'restore') {
        useBotNavigation.setState({ entry: null });
        await openEntry(botId);
      }
      if (current()) refreshWork();
    } catch (cause) {
      if (current()) setError(message(cause));
    } finally {
      if (current()) setActionBusy(null);
    }
  };

  const confirmSessionDelete = async () => {
    if (!deletingSession) return;
    const { identity, botId, branch } = deletingSession;
    if (!branch) {
      await mutateSession(botId, identity.threadId, 'delete');
      return;
    }
    const host = getRuntimeEndpointGeneration();
    const current = () => alive.current && host === getRuntimeEndpointGeneration();
    setActionBusy(`session:${identity.threadId}`);
    setError(null);
    try {
      const store = useThreadStore.getState();
      if (!store.threads.some(thread => thread.thread_id === identity.threadId)) await store.loadCatalog();
      if (!current()) return;
      const fallback = await store.deleteBranch(identity);
      if (!current()) return;
      const navigation = useBotNavigation.getState();
      if (navigation.botId === botId && navigation.entry?.threadId === identity.threadId && navigation.entry.branchId === identity.branchId) {
        await openBotConversation(botId, fallback);
      }
      setDeletingSession(null);
      toast.success(t('bot.session.branchDeleted'));
      refreshWork();
    } catch (cause) {
      if (current()) setError(message(cause));
    } finally {
      if (current()) setActionBusy(null);
    }
  };

  const sessionAction = async (session: BotSessionView, identity: ThreadIdentity, action: BotSessionAction) => {
    if (!selected || !threads) return;
    if (action === 'delete') {
      setError(null);
      const branch = identity.branchId !== session.thread.main_branch_id;
      const title = branch ? t('bot.session.branch', { index: session.branches.findIndex(item => item.branchId === identity.branchId) + 1 }) : sessionTitleOf(session);
      setDeletingSession({ botId: selected.id, identity, branch, title });
      return;
    }
    if (action === 'archive' || action === 'restore') {
      await mutateSession(selected.id, identity.threadId, action);
      return;
    }
    if (action === 'rename') {
      setError(null); setNameDraft(sessionTitleOf(session)); setNameDialog({ mode: 'session', session }); return;
    }
    if (action === 'open' || action === 'tree') {
      openSession(identity);
      if (action === 'tree') openConversationTree('bot');
      return;
    }
    const host = getRuntimeEndpointGeneration(), botId = selected.id;
    const current = () => alive.current && host === getRuntimeEndpointGeneration();
    setActionBusy(`session:${identity.threadId}`); setError(null);
    try {
      if (action === 'copy') {
        const result = await copyTextToClipboard(identity.branchId === session.thread.main_branch_id ? identity.threadId : identity.branchId);
        if (!result.ok) throw new Error(result.error);
        if (current()) toast.success(t('sessions.sidebar.session.menu.copied'));
      } else if (action === 'fork') {
        const head = session.thread.branches.find(branch => branch.branch_id === identity.branchId)?.head;
        if (!head) return;
        const intent = JSON.stringify([host, identity, head]);
        const key = sessionForkKeys.current.get(intent) ?? crypto.randomUUID();
        sessionForkKeys.current.set(intent, key);
        const branch = await threads.fork({ ...identity, key, headId: head });
        sessionForkKeys.current.delete(intent);
        if (current() && useBotNavigation.getState().botId === botId) await openBotConversation(botId, branch);
        if (current()) { refreshWork(); void useThreadStore.getState().loadCatalog().catch(() => {}); }
      } else {
        await useThreadStore.getState().updateThread(identity.threadId, action === 'pin' ? { pinned: !session.thread.pinned } : { titleMode: 'automatic' });
        if (current()) refreshWork();
      }
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { if (current()) setActionBusy(null); }
  };

  const mutateBot = React.useCallback(async (bot: BotSummary, action: BotMenuAction) => {
    if (action === 'delete') { setDeleting(bot); return; }
    if (action === 'rename') { setError(null); setNameDraft(bot.name); setNameDialog({ mode: 'rename', bot }); return; }
    if (action === 'profile' || action === 'memory') {
      // The selected Bot's profile and memory live in its panel; another Bot opens without switching.
      if (bot.id === selectedId) { if (action === 'profile') { setProfileOpen(true); if (!floating && !isMobile) setPanelOpen(true); else if (floating) setNarrowPanelOpen(true); } else focusTab('memory'); }
      else setDetails({ id: bot.id, name: bot.name, tab: action });
      return;
    }
    setActionBusy(`${action}:${bot.id}`);
    setError(null);
    const host = getRuntimeEndpointGeneration();
    try {
      const updated = action === 'pin' ? await updateBot(bot.id, { pinned: !bot.pinnedAt })
        : action === 'archive' ? await archiveBot(bot.id) : await changeBotState(bot.id, action);
      if (!alive.current || getRuntimeEndpointGeneration() !== host) return;
      setBots((list) => list?.map((item) => item.id === updated.id ? updated : item) ?? [updated]);
      refresh();
    } catch (cause) {
      if (alive.current && getRuntimeEndpointGeneration() === host) setError(message(cause));
    } finally {
      if (alive.current) setActionBusy(null);
    }
  }, [selectedId, floating, isMobile, setPanelOpen, focusTab]);

  const newSession = React.useCallback(async () => {
    if (!selected) return;
    dismissDraft();
    const host = getRuntimeEndpointGeneration();
    const bot = selected;
    setActionBusy(`session:${bot.id}`);
    setError(null);
    try {
      const session = await createBotSession(bot.id);
      if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
      setSessionResult(current => current?.botId === bot.id && 'items' in current ? { botId: bot.id, items: [...current.items, session] } : current);
      noteSwitchDirection(1);
      await openBotConversation(bot.id, session.identity);
      void useThreadStore.getState().loadCatalog().catch(() => {});
      refreshWork();
    } catch (cause) {
      if (alive.current && host === getRuntimeEndpointGeneration()) setError(message(cause));
    } finally {
      if (alive.current) setActionBusy(null);
    }
  }, [selected, dismissDraft]);

  const archiveMatter = React.useCallback((matter: BotMatter) => {
    if (!selected || !botsAPI) return;
    const host = getRuntimeEndpointGeneration();
    setActionBusy(`matter:${matter.id}`);
    void botsAPI.matters.update({ botId: selected.id, key: crypto.randomUUID(), expectedRevision: matter.revision, matter: { ...matter, archived: true } })
      .then(() => { if (host === getRuntimeEndpointGeneration()) refreshWork(); })
      .catch((cause: unknown) => { if (host === getRuntimeEndpointGeneration()) setError(message(cause)); })
      .finally(() => { if (host === getRuntimeEndpointGeneration()) setActionBusy(null); });
  }, [selected, botsAPI]);

  const selectBot = (botId: string) => {
    dismissDraft();
    useUIStore.getState().setSessionSwitcherOpen(false);
    setProfileOpen(false);
    // Keep the current conversation/page until the requested Bot entry is ready.
    void openEntry(botId, true);
  };

  const mattersForBot = matters?.botId === selectedId ? matters.items : null;
  const own = stage.view.own;
  const line = React.useMemo(() => !selected ? null : moment && showsTeamMoments(pose) ? moment.line
    : stateLine(selected, pose, { needs, working, own }), [selected, pose, moment, needs, working, own]);
  const panelModel = React.useMemo<BotPanelModel | null>(() => selected && sessionsWithWork && line ? {
    bot: selected, figure: pose, stage: stageFeed, line,
    sessions: sessionsWithWork, session: currentSession, work, workItems: workItems ?? [], needs, timeline, facts, matters: mattersForBot, threads,
    readOnly: readOnly || offline, busy: actionBusy !== null, focus, profileOpen,
    sessionTitle, focusTab,
    openWork,
    openSession,
    openNeed: need => need.session ? openSession(need.identity) : openWork(need.identity, { tab: 'overview', id: need.key }),
    changeState: action => { void mutateBot(selected, action); },
    archiveMatter,
    newSession: () => { void newSession(); },
    openProfile: () => setProfileOpen(true),
    closeProfile: () => setProfileOpen(false),
    onBotChanged: bot => { if (bot) setBots(list => list?.map(item => item.id === bot.id ? bot : item) ?? [bot]); refresh(); },
    requestDelete: () => setDeleting(selected),
    archive: () => { void mutateBot(selected, 'archive'); },
  } : null, [selected, pose, stageFeed, line, needs, sessionsWithWork, currentSession, work, timeline, facts, mattersForBot, threads, readOnly, offline, actionBusy, focus, profileOpen,
    sessionTitle, focusTab, openWork, openSession, mutateBot, archiveMatter, newSession, workItems]);

  const spaces = useBotWorkspaces(panelModel, committed && !settingsOpen, () => { closeConversationPanel(); if (floating) setNarrowPanelOpen(true); else setPanelOpen(true); });
  const openSpace = spaces.open;
  const shownPanel = React.useMemo<BotPanelModel | null>(() => panelModel && ({ ...panelModel,
    openNeed: need => openSpace({ kind: 'work', key: workKey(need.identity), identity: need.identity, title: need.name, operationId: need.operationId }),
  }), [panelModel, openSpace]);
  React.useEffect(() => { if (!spaces.activeKey) setSpaceExpanded(false); }, [spaces.activeKey]);

  const childNavigation = React.useMemo<ChildNavigation>(() => ({ label: t('bot.workspace.details'), open: identity => openSpace({ kind: 'work', key: workKey(identity), identity, title: work.find(item => item.key === workKey(identity))?.name ?? t('bot.workspace.details') }) }), [t, openSpace, work]);
  const memoryNavigation = React.useMemo<MemoryNavigation>(() => ({ label: t('bot.memory.viewInPanel'), open: memoryId => focusTab('memory', memoryId ?? undefined) }), [t, focusTab]);
  const otherSessions = sessionsWithWork?.filter(session => session.identity.threadId !== selectedEntry?.threadId) ?? [];
  const isSidebarOpen = useUIStore(state => state.isSidebarOpen);
  const sidebarAttention = isSidebarOpen ? null : otherSessions.some(session => session.waiting) ? 'warn' : otherSessions.some(session => session.unread) ? 'info' : null;
  const branchIndex = currentSession ? currentSession.branches.findIndex(branch => branch.branchId === selectedEntry?.branchId) : -1;
  const navigationTitle = activeDraftKey ? t('bot.session.new') : currentSession ? sessionTitleOf(currentSession) : selected?.name ?? 'Varin';
  const navigationSubtitle = activeDraftKey ? selected?.name : currentSession && selected
    ? branchIndex >= 0 ? t('bot.session.branchOf', { bot: selected.name, session: sessionTitleOf(currentSession) }) : selected.name
    : undefined;

  const togglePanel = () => { if (floating) setNarrowPanelOpen(open => !open); else setPanelOpen(!panelOpen); };
  const panelLabel = t(panelVisible ? 'bot.panel.close' : 'bot.panel.open');
  const panelControl = isMobile ? undefined : <>
    {selectedEntry && !activeDraftKey && <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t('chat.tree.title')} aria-expanded={Boolean(treeTab)}
      className="workbench-icon-button app-region-no-drag flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
      onClick={() => treeTab ? closeConversationPanel() : openConversationTree('bot')}><Icon name="conversation-tree" className="size-4" /></button></TooltipTrigger><TooltipContent>{t('chat.tree.title')}</TooltipContent></Tooltip>}
    <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={panelLabel} aria-expanded={panelVisible} onClick={togglePanel}
        className="workbench-icon-button app-region-no-drag relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name="layout-right" className="size-4" />
        {!panelVisible && needs.length ? <span className="bot-titlebar-dot" data-tone="warn" aria-hidden="true" /> : null}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{panelLabel}</TooltipContent>
  </Tooltip></>;

  const navigator = () => <BotNavigator bots={bots} organization={organization} selectedId={selectedId} sessions={sessionsWithWork} current={!activeDraftKey && ownsConversation ? selectedEntry : null}
    figures={figures} busy={busy || actionBusy !== null} showArchived={showArchived} isMobile={isMobile} sessionTitle={sessionTitleOf}
    onSelectBot={selectBot} onSelectSession={openSession} onNewSession={() => { void newSession(); }}
    onSessionAction={(session, identity, action) => { void sessionAction(session, identity, action); }}
    onBotAction={(bot, action) => { void mutateBot(bot, action); }} onCreateBot={openCreateDialog}
    onToggleArchived={() => setShowArchived(value => !value)} onRefresh={refresh} onOpenSettings={openSettings} />;

  const conversation = (active: boolean) => <div className="flex h-full min-h-0 flex-col"
    onPointerDown={() => { if (floating && narrowPanelOpen) setNarrowPanelOpen(false); }}>
    {selected ? <BotActivityBanner bot={selected} busy={actionBusy !== null} onAction={(action) => { void mutateBot(selected, action); }} /> : null}
    {error ? <div role="alert" className="flex items-center gap-3 border-b border-border px-4 py-3 typography-meta">
      <span className="flex-1 text-destructive">{error}</span>
      <Button variant="ghost" size="sm" onClick={() => { refresh(); if (selectedId) void openEntry(selectedId); }}>{t('common.retry')}</Button>
    </div> : null}
    {sessionsError ? <p role="alert" className="border-b border-border px-4 py-2 typography-meta text-destructive">{sessionsError}</p> : null}
    {activeDraftKey && threads && active ? <div className="min-h-0 flex-1"><ThreadDraftConversation key={activeDraftKey} api={threads} draftKey={activeDraftKey} handoff={messageHandoff} /></div> : ownsConversation && !busy && active ? <div className="min-h-0 flex-1">{selectedEntry && threads
      ? <ChildNavigationContext.Provider value={childNavigation}><MemoryNavigationContext.Provider value={memoryNavigation}>
        <ThreadConversation key={`${selectedEntry.threadId}:${selectedEntry.branchId}`} surface="bot" api={threads} identity={selectedEntry} messageHandoff={messageHandoff} onWorkChanged={refreshWork} onActivity={stage.onActivity}
          inheritWorkbenchModel={!selected?.model}
          preferredModel={selected && entryResolution?.botId === selected.id && entryResolution.profileModelKey === profileModelKey ? entryResolution.model : null} readOnly={readOnly || conversationArchived}
          emptyHero={selected ? { visual: <BotFigure bot={selected} state={figure} size={64} />, title: t('bot.hero.title', { name: selected.name }) } : undefined}
          onBranchCreated={entry => { if (selected) void openBotConversation(selected.id, entry); refreshWork(); }} />
      </MemoryNavigationContext.Provider></ChildNavigationContext.Provider>
      : <p role="alert">Conversation service unavailable</p>}</div> : (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <BotFigure {...(selected ? { bot: selected } : {})} state={selected ? figure : 'idle'} size={64} />
        <h1 className="typography-title">{selected?.name ?? 'Varin'}</h1>
        {busy || (!bots && !error) ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {bots && !bots.some(bot => bot.archived === showArchived) ? <>
          <p className="typography-body text-muted-foreground">{t(showArchived ? 'settings.bots.archivedEmpty' : 'settings.bots.empty')}</p>
          {!showArchived ? <Button disabled={busy || actionBusy !== null} onClick={openCreateDialog}>{t('settings.bots.create')}</Button> : null}
        </> : selected && !readOnly && !busy ? <Button onClick={() => { void openEntry(selected.id); }}>{t('settings.bots.openEntry')}</Button> : null}
      </div>
    )}
    <BotNameDialog
      open={nameDialog !== null}
      title={nameDialog?.mode === 'session' ? t('sessions.sidebar.session.menu.rename') : nameDialog?.mode === 'rename' ? t('settings.bots.rename') : t('settings.bots.create')}
      submitLabel={nameDialog?.mode === 'create' ? t('settings.bots.createAction') : t('settings.bots.save')}
      name={nameDraft}
      busy={actionBusy !== null}
      error={error}
      onNameChange={setNameDraft}
      onOpenChange={(open) => { if (!open && actionBusy === null) setNameDialog(null); }}
      onSubmit={(event) => { void saveName(event); }}
    />
    <Dialog open={deletingSession !== null} onOpenChange={open => { if (!open && actionBusy === null) setDeletingSession(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t(deletingSession?.branch ? 'bot.session.deleteBranch.title' : 'sessions.sidebar.dialogs.deleteSession.title')}</DialogTitle>
          <DialogDescription>{deletingSession?.branch
            ? t('bot.session.deleteBranch.description', { name: deletingSession.title })
            : t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: deletingSession?.title ?? '' })}</DialogDescription>
        </DialogHeader>
        {error && deletingSession ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={actionBusy !== null} onClick={() => setDeletingSession(null)}>{t('sessions.sidebar.dialogs.cancel')}</Button>
          <Button variant="destructive" size="sm" disabled={actionBusy !== null} onClick={() => { void confirmSessionDelete(); }}>
            {t(deletingSession?.branch ? 'bot.session.menu.deleteBranch' : 'sessions.sidebar.dialogs.deleteSession.titleAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {deleting ? <BotDeleteDialog key={deleting.id} bot={deleting} onClose={() => setDeleting(null)} onAccepted={(bot) => {
      setBots((list) => list?.flatMap((item) => item.id === deleting.id ? bot ? [bot] : [] : [item]) ?? null);
      if (deleting.id === selectedId) setProfileOpen(false);
      refresh();
    }} /> : null}
    {details ? <React.Suspense fallback={null}><BotDetailsDialog bot={details} onClose={() => { setDetails(null); refresh(); }} /></React.Suspense> : null}
    {isMobile && <Dialog open={Boolean(conversationTab)} onOpenChange={open => { if (!open) closeConversationPanel(); }}>
      <DialogContent className="flex h-[85dvh] max-w-full flex-col gap-0 p-0"><DialogHeader className="px-4 py-3"><DialogTitle>{t(treeTab ? 'chat.tree.title' : 'contextPanel.mode.context')}</DialogTitle></DialogHeader>
        <div className="min-h-0 flex-1"><React.Suspense fallback={null}>{conversationTab?.mode === 'context'
          ? conversationTab.thread
            ? <ContextPanelContent active identity={conversationTab.thread} jobRunId={conversationTab.targetPath ?? undefined} readOnly={conversationTab.readOnly} />
            : <p className="p-6 typography-ui-label text-muted-foreground">{t('contextSidebar.empty.openSession')}</p>
          : <ConversationTreePanel active={Boolean(treeTab)} />}</React.Suspense></div>
      </DialogContent>
    </Dialog>}
  </div>;

  const workspaceArea = (visible: boolean) => shownPanel && <BotWorkspaceArea model={shownPanel} active={committed && !settingsOpen && visible} expanded={spaceExpanded} onExpand={() => setSpaceExpanded(value => !value)} />;
  const secondaryPanel = (placement: 'docked' | 'drawer', visible: boolean) => placement === 'drawer'
    ? <div className="flex h-full min-h-0 flex-col bg-background">{workspaceArea(visible)}</div>
    : <><BotPanel model={panelModel} open={!conversationTab && panelVisible && panelModel !== null} floating={floating}
      workspace={Boolean(spaces.activeKey)} expanded={Boolean(spaces.activeKey) && spaceExpanded}
      onOpenChange={open => { if (floating) setNarrowPanelOpen(open); else setPanelOpen(open); }}>{workspaceArea(!conversationTab && panelVisible)}</BotPanel>
      {conversationPanelMounted && !isMobile && <React.Suspense fallback={null}><ContextPanel layoutScope={BOT_CONVERSATION_PANEL_SCOPE} surfaceModes={CONVERSATION_SURFACES}
        contextOwner={{ identity: ownsConversation ? selectedEntry : null, readOnly: readOnly || conversationArchived }} /></React.Suspense>}</>;

  return <BotWorkspaceNavigationContext.Provider value={spaces}><MainLayout renderNavigator={navigator} renderConversation={conversation} renderSecondaryPanel={secondaryPanel}
    secondaryPanelFocus={spaces.activeKey ? `${spaces.activeKey}:${spaces.focusRevision}` : null}
    secondaryPanelLabel={t('bot.panel.aria')} secondaryPanelToggleLabels={{ open: t('bot.panel.open'), close: t('bot.panel.close') }}
    navigationTitle={navigationTitle} navigationSubtitle={navigationSubtitle} headerPanelControl={panelControl} sidebarAttention={sidebarAttention}
    floatingSidebar={floatingSidebar}
    renderMobileTitle={isMobile && selected && line ? panel => <BotMobileTitle bot={selected} model={shownPanel} figure={figure} line={line} open={panel.open} onToggle={panel.toggle} /> : undefined} /></BotWorkspaceNavigationContext.Provider>;
};
