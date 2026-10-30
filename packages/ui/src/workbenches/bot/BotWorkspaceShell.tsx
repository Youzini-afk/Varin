import React from 'react';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import type { BotMatter } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type BotSession, type ThreadIdentity } from '@varin/application-client';
import { MainLayout } from '@/components/layout/MainLayout';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  archiveBot, changeBotState, createBot, createBotSession, ensureBotEntry, ensurePrimaryBot, listBots, listBotSessions, listBotWork,
  openBotConversation, openBotWorkInWorkbench, updateBot, useBotNavigation, useBotReturn,
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
  buildTimeline, figureState, isActiveRun, isWaitingStatus, liveRun, needsOf, runStatus, sessionViews, stateLine, workViews,
  type BotFigureState, type BotSessionView,
} from './botPresentation';
import { useBotFacts } from './useBotFacts';
import { BotFigure } from './BotFigure';
import { BotNavigator } from './BotNavigator';
import { BotPanel, BotPanelBody } from './BotPanel';

const BotDetailsDialog = React.lazy(() => import('@/components/sections/bots/BotDetailsDialog').then((module) => ({ default: module.BotDetailsDialog })));

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const RESULT_MS = 3000;
const LISTENING_MS = 2500;

const openBotSettings = () => {
  useUIStore.getState().setSettingsPage('harness-bots');
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
function useBotSidebar(committed: boolean, isMobile: boolean): void {
  React.useEffect(() => {
    if (!committed || isMobile) return undefined;
    const layout = useBotLayout.getState();
    if (layout.ordinarySidebar === null) layout.setOrdinarySidebar(useUIStore.getState().isSidebarOpen);
    useUIStore.getState().setSidebarOpen(layout.sidebarOpen);
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (state.isSidebarOpen !== previous.isSidebarOpen) useBotLayout.getState().setSidebarOpen(state.isSidebarOpen);
    });
    return () => {
      unsubscribe();
      const ordinary = useBotLayout.getState().ordinarySidebar;
      useBotLayout.getState().setOrdinarySidebar(null);
      if (ordinary !== null) useUIStore.getState().setSidebarOpen(ordinary);
    };
  }, [committed, isMobile]);
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
  const { isMobile } = useDeviceInfo();
  const { threads, bots: botsAPI } = useRuntimeAPIs();
  const navigation = useBotNavigation();
  const catalog = useThreadStore(state => state.threads);
  const offline = useThreadStore(state => state.catalogError !== null);
  const appliedNavigation = React.useRef<string | null>(null);
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [details, setDetails] = React.useState<{ id: string; name: string; tab: 'profile' | 'memory' } | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [workResult, setWorkResult] = React.useState<{ botId: string; items: BotWorkItem[] } | null>(null);
  const [sessionResult, setSessionResult] = React.useState<{ botId: string; items: BotSession[] } | { botId: string; error: string } | null>(null);
  const [matters, setMatters] = React.useState<{ botId: string; items: BotMatter[] } | null>(null);
  const [workRevision, refreshWork] = React.useReducer((value: number) => value + 1, 0);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [nameDialog, setNameDialog] = React.useState<{ mode: 'create' } | { mode: 'rename'; bot: BotSummary } | null>(null);
  const [nameDraft, setNameDraft] = React.useState('');
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [focus, setFocus] = React.useState<BotPanelFocus | null>(null);
  const [narrowPanelOpen, setNarrowPanelOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ name: string; until: number } | null>(null);
  const [listening, setListening] = React.useState(false);
  const opening = React.useRef<AbortController | null>(null);
  const selected = bots?.find((bot) => bot.id === selectedId);
  const profileModelKey = JSON.stringify(selected?.model ?? null);
  const [entryModel, setEntryModel] = React.useState<{ botId: string; profileModelKey: string; model: BotModelSelection | null }>();
  const readOnly = Boolean(selected?.archived || selected?.deletion || (selected?.activity && selected.activity.state !== 'awake'));
  const botsRef = React.useRef(bots);
  botsRef.current = bots;
  const alive = React.useRef(true);
  const workItems = workResult?.botId === selectedId ? workResult.items : null;
  const sessionItems = sessionResult?.botId === selectedId && 'items' in sessionResult ? sessionResult.items : null;
  const sessionsError = sessionResult?.botId === selectedId && 'error' in sessionResult ? sessionResult.error : null;
  const panelOpen = useBotLayout(state => state.panelOpen);
  const setPanelOpen = useBotLayout(state => state.setPanelOpen);
  const setTab = useBotLayout(state => state.setTab);
  const floating = useMatchMedia('(min-width: 760px) and (max-width: 1023px)');
  const panelVisible = !isMobile && (floating ? narrowPanelOpen : panelOpen);
  useBotSidebar(committed, isMobile);

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

  const openEntry = React.useCallback(async (botId: string) => {
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    const host = getRuntimeEndpointGeneration();
    setBusy(true);
    setError(null);
    try {
      const known = botsRef.current?.find((bot) => bot.id === botId);
      if (known?.deletion) return;
      const inactive = known && (known.archived || (known.activity && known.activity.state !== 'awake'));
      const { bot, entry, model } = inactive ? { bot: known, model: known.model, entry: known.entry } : await ensureBotEntry(botId, controller.signal);
      if (controller.signal.aborted || getRuntimeEndpointGeneration() !== host) return;
      setBots((list) => list?.map((item) => item.id === bot.id ? bot : item) ?? [bot]);
      await openBotConversation(bot.id, entry, bot.homeDir, model);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
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
    // Sessions fail on their own: the conversation stays usable through the profile entry.
    void listBotSessions(selectedId, signal).then(items => {
      if (!signal.aborted) setSessionResult({ botId: selectedId, items });
    }, (cause: unknown) => {
      if (!signal.aborted) setSessionResult(current => current?.botId === selectedId && 'items' in current ? current : { botId: selectedId, error: message(cause) });
    });
    return () => controller.abort();
  }, [committed, selectedId, settingsOpen, revision, workRevision, botsAPI]);

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

  const selectedEntry = navigation.botId === selectedId ? navigation.entry : null;
  const sessions = React.useMemo<BotSessionView[] | null>(() => {
    if (!selected) return null;
    const known = sessionItems ?? (sessionsError ? [] : null);
    // Until the list answers (or if it failed), the profile entry is still the Bot's conversation.
    const entryThread = catalog.find(thread => thread.thread_id === selected.entry.threadId);
    const items = known?.some(session => session.identity.threadId === selected.entry.threadId) || !entryThread
      ? known
      : [{ identity: selected.entry, thread: entryThread, primary: true }, ...(known ?? [])];
    return items ? sessionViews(items, catalog, []) : null;
  }, [selected, sessionItems, sessionsError, catalog]);
  const facts = useBotFacts({ botId: selected?.id ?? null, sessions: sessions ?? [], threads, revision: revision + workRevision, enabled: committed && Boolean(selected) && !settingsOpen });
  const feeds = React.useMemo(() => facts.feeds.value ?? [], [facts.feeds.value]);
  const work = React.useMemo(() => workViews(workItems ?? [], catalog, feeds), [workItems, catalog, feeds]);
  const sessionsWithWork = React.useMemo(() => sessions && selected ? sessionViews(sessions.map(view => ({ identity: view.identity, thread: view.thread, primary: view.primary })), catalog, work) : sessions, [sessions, selected, catalog, work]);
  const currentSession = sessionsWithWork?.find(session => session.identity.threadId === selectedEntry?.threadId) ?? null;
  const ownsConversation = Boolean(selectedEntry && selected && (currentSession
    || selectedEntry.threadId === selected.entry.threadId
    || catalog.some(thread => thread.thread_id === selectedEntry.threadId && thread.bot_id === selected.id && !thread.parent_thread_id && thread.branches.some(branch => branch.branch_id === selectedEntry.branchId))));
  const sessionEntry = Boolean(ownsConversation);

  React.useEffect(() => {
    if (!committed || !selected || readOnly || !sessionEntry) return;
    if (entryModel?.botId === selected.id && entryModel.profileModelKey === profileModelKey) return;
    const controller = new AbortController();
    const botId = selected.id;
    void ensureBotEntry(botId, controller.signal).then(({ model }) => {
      if (!controller.signal.aborted) setEntryModel({ botId, profileModelKey, model });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [committed, selected, profileModelKey, readOnly, sessionEntry, entryModel]);

  // "Listening" is the user typing into this conversation's composer.
  const draftKey = selectedEntry ? threadComposerKey(threadHostKey(), selectedEntry) : null;
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

  // A piece of work that was running and has now finished shows "has a result" for three seconds.
  const activeWork = React.useRef<Map<string, string> | null>(null);
  React.useEffect(() => {
    const now = new Map(work.filter(item => item.status !== null).map(item => [item.key, item.name]));
    const before = activeWork.current;
    activeWork.current = now;
    if (!before) return;
    const finished = [...before].find(([key]) => !now.has(key) && work.some(item => item.key === key));
    if (finished) setResult({ name: finished[1], until: Date.now() + RESULT_MS });
  }, [work]);
  React.useEffect(() => { activeWork.current = null; setResult(null); }, [selectedId]);
  React.useEffect(() => {
    if (!result) return undefined;
    const timer = setTimeout(() => setResult(null), Math.max(0, result.until - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);

  const needs = React.useMemo(() => selected && sessionsWithWork ? needsOf(selected, sessionsWithWork, work) : [], [selected, sessionsWithWork, work]);
  const working = React.useMemo(() => work.filter(item => item.status !== null && !isWaitingStatus(item.status)), [work]);
  const currentThread = selectedEntry ? catalog.find(thread => thread.thread_id === selectedEntry.threadId) : undefined;
  const currentRun = selectedEntry ? liveRun(currentThread, selectedEntry.branchId, null) : null;
  const thinking = isActiveRun(currentRun) && !isWaitingStatus(runStatus(currentRun));
  const figureOf = React.useCallback((bot: BotSummary): BotFigureState => figureState({
    offline, activity: bot.activity?.state, inactive: Boolean(bot.archived || bot.deletion),
    needs: bot.id === selectedId ? needs.length : 0, result: bot.id === selectedId && result !== null,
    thinking: bot.id === selectedId && thinking, working: bot.id === selectedId ? working.length : 0,
    listening: bot.id === selectedId && listening,
  }), [offline, selectedId, needs.length, result, thinking, working.length, listening]);
  const figures = React.useMemo(() => new Map((bots ?? []).map(bot => [bot.id, figureOf(bot)])), [bots, figureOf]);
  const figure = selected ? figureOf(selected) : 'idle';
  const timeline = React.useMemo(() => buildTimeline(feeds, facts.memory.value), [feeds, facts.memory.value]);

  const sessionTitleOf = React.useCallback((view: BotSessionView) => view.primary && !view.thread.title ? t('bot.session.primary') : view.thread.title || t('bot.session.untitled'), [t]);
  const sessionTitle = React.useCallback((threadId: string) => {
    const view = sessionsWithWork?.find(session => session.identity.threadId === threadId);
    if (view) return sessionTitleOf(view);
    return catalog.find(thread => thread.thread_id === threadId)?.title || threadId;
  }, [sessionsWithWork, sessionTitleOf, catalog]);

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
    useUIStore.getState().setSessionSwitcherOpen(false);
    const order = sessionsWithWork?.map(session => session.identity.threadId) ?? [];
    noteSwitchDirection(order.indexOf(identity.threadId) - order.indexOf(selectedEntry?.threadId ?? ''));
    if (floating) setNarrowPanelOpen(false);
    void openBotConversation(selected.id, identity, selected.homeDir).catch((cause: unknown) => setError(message(cause)));
  }, [selected, sessionsWithWork, selectedEntry, floating]);

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
    setActionBusy(dialog.mode === 'create' ? 'create' : `rename:${dialog.bot.id}`);
    setError(null);
    try {
      const bot = dialog.mode === 'create' ? await createBot({ name: trimmed }) : await updateBot(dialog.bot.id, { name: trimmed });
      if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
      setBots((list) => dialog.mode === 'create' ? [...(list ?? []), bot] : list?.map((item) => item.id === bot.id ? bot : item) ?? [bot]);
      if (dialog.mode === 'create') { useBotNavigation.setState({ botId: null, entry: null }); setShowArchived(false); setSelectedId(bot.id); }
      setNameDialog(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setActionBusy(null);
    }
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
    const host = getRuntimeEndpointGeneration();
    const bot = selected;
    setActionBusy(`session:${bot.id}`);
    setError(null);
    try {
      const session = await createBotSession(bot.id);
      if (!alive.current || host !== getRuntimeEndpointGeneration()) return;
      setSessionResult(current => current?.botId === bot.id && 'items' in current ? { botId: bot.id, items: [...current.items, session] } : current);
      noteSwitchDirection(1);
      await openBotConversation(bot.id, session.identity, bot.homeDir);
      void useThreadStore.getState().loadCatalog().catch(() => {});
      refreshWork();
    } catch (cause) {
      if (alive.current && host === getRuntimeEndpointGeneration()) setError(message(cause));
    } finally {
      if (alive.current) setActionBusy(null);
    }
  }, [selected]);

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
    useUIStore.getState().setSessionSwitcherOpen(false);
    setProfileOpen(false);
    if (botId === selectedId) void openEntry(botId);
    else { useBotNavigation.setState({ botId: null, entry: null }); setSelectedId(botId); }
  };

  const mattersForBot = matters?.botId === selectedId ? matters.items : null;
  const panelModel = React.useMemo<BotPanelModel | null>(() => selected && sessionsWithWork ? {
    bot: selected, figure,
    line: stateLine(selected, figure, { needs, working, resultName: result?.name ?? null }),
    sessions: sessionsWithWork, session: currentSession, work, needs, timeline, facts, matters: mattersForBot, threads,
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
  } : null, [selected, figure, needs, working, result, sessionsWithWork, currentSession, work, timeline, facts, mattersForBot, threads, readOnly, offline, actionBusy, focus, profileOpen,
    sessionTitle, focusTab, openWork, openSession, mutateBot, archiveMatter, newSession]);

  const childNavigation = React.useMemo<ChildNavigation>(() => ({ label: t('bot.work.openInWorkbench'), open: identity => openWork(identity) }), [t, openWork]);
  const memoryNavigation = React.useMemo<MemoryNavigation>(() => ({ label: t('bot.memory.viewInPanel'), open: memoryId => focusTab('memory', memoryId ?? undefined) }), [t, focusTab]);
  const otherSessions = sessionsWithWork?.filter(session => session.identity.threadId !== selectedEntry?.threadId) ?? [];
  const isSidebarOpen = useUIStore(state => state.isSidebarOpen);
  const sidebarAttention = isSidebarOpen ? null : otherSessions.some(session => session.waiting) ? 'warn' : otherSessions.some(session => session.unread) ? 'info' : null;
  const branchIndex = currentSession ? currentSession.branches.findIndex(branch => branch.branchId === selectedEntry?.branchId) : -1;
  const navigationTitle = currentSession ? sessionTitleOf(currentSession) : selected?.name ?? 'Varin bot';
  const navigationSubtitle = currentSession && selected
    ? branchIndex >= 0 ? t('bot.session.branchOf', { bot: selected.name, session: sessionTitleOf(currentSession) }) : selected.name
    : undefined;

  const togglePanel = () => { if (floating) setNarrowPanelOpen(open => !open); else setPanelOpen(!panelOpen); };
  const panelLabel = t(panelVisible ? 'bot.panel.close' : 'bot.panel.open');
  const panelControl = isMobile ? undefined : <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={panelLabel} aria-expanded={panelVisible} onClick={togglePanel}
        className={cn('workbench-icon-button app-region-no-drag relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', panelVisible && 'bg-interactive-selection text-foreground')}>
        <Icon name="layout-right" className="size-4" />
        {!panelVisible && needs.length ? <span className="bot-titlebar-dot" data-tone="warn" aria-hidden="true" /> : null}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{panelLabel}</TooltipContent>
  </Tooltip>;

  const navigator = () => <BotNavigator bots={bots} selectedId={selectedId} sessions={sessionsWithWork} current={ownsConversation ? selectedEntry : null}
    figures={figures} busy={busy || actionBusy !== null} showArchived={showArchived} isMobile={isMobile} sessionTitle={sessionTitleOf}
    onSelectBot={selectBot} onSelectSession={openSession} onNewSession={() => { void newSession(); }}
    onBotAction={(bot, action) => { void mutateBot(bot, action); }} onCreateBot={openCreateDialog}
    onToggleArchived={() => setShowArchived(value => !value)} onRefresh={refresh} onOpenSettings={openBotSettings} />;

  const conversation = (active: boolean) => <div className="flex h-full min-h-0 flex-col"
    onPointerDown={() => { if (floating && narrowPanelOpen) setNarrowPanelOpen(false); }}>
    {selected ? <BotActivityBanner bot={selected} busy={actionBusy !== null} onAction={(action) => { void mutateBot(selected, action); }} /> : null}
    {error ? <div role="alert" className="flex items-center gap-3 border-b border-border px-4 py-3 typography-meta">
      <span className="flex-1 text-destructive">{error}</span>
      <Button variant="ghost" size="sm" onClick={() => { refresh(); if (selectedId) void openEntry(selectedId); }}>{t('research-workbench.retry')}</Button>
    </div> : null}
    {sessionsError ? <p role="alert" className="border-b border-border px-4 py-2 typography-meta text-destructive">{sessionsError}</p> : null}
    {ownsConversation && !busy && active ? <div className="min-h-0 flex-1">{selectedEntry && threads
      ? <ChildNavigationContext.Provider value={childNavigation}><MemoryNavigationContext.Provider value={memoryNavigation}>
        <ThreadConversation key={`${selectedEntry.threadId}:${selectedEntry.branchId}`} api={threads} identity={selectedEntry} initialWorkspacePath={selected?.homeDir} onWorkChanged={refreshWork}
          preferredModel={selected && entryModel?.botId === selected.id && entryModel.profileModelKey === profileModelKey ? entryModel.model : null} readOnly={readOnly}
          emptyHero={selected ? { visual: <BotFigure state={figure} size={64} />, title: t('bot.hero.title', { name: selected.name }) } : undefined}
          onBranchCreated={entry => { if (selected) void openBotConversation(selected.id, entry); refreshWork(); }} />
      </MemoryNavigationContext.Provider></ChildNavigationContext.Provider>
      : <p role="alert">Conversation service unavailable</p>}</div> : (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <BotFigure state={selected ? figure : 'idle'} size={64} />
        <h1 className="typography-title">{selected?.name ?? 'Varin bot'}</h1>
        {busy || (!bots && !error) ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {bots && !bots.some(bot => bot.archived === showArchived) ? <>
          <p className="typography-body text-muted-foreground">{t(showArchived ? 'settings.bots.archivedEmpty' : 'settings.bots.empty')}</p>
          {!showArchived ? <Button disabled={busy || actionBusy !== null} onClick={openCreateDialog}>{t('settings.bots.create')}</Button> : null}
        </> : selected && !selected.deletion && !busy ? <Button onClick={() => { void openEntry(selected.id); }}>{t('settings.bots.openEntry')}</Button> : null}
      </div>
    )}
    <BotNameDialog
      open={nameDialog !== null}
      title={nameDialog?.mode === 'rename' ? t('settings.bots.rename') : t('settings.bots.create')}
      name={nameDraft}
      busy={actionBusy !== null}
      error={error}
      onNameChange={setNameDraft}
      onOpenChange={(open) => { if (!open && actionBusy === null) setNameDialog(null); }}
      onSubmit={(event) => { void saveName(event); }}
    />
    {deleting ? <BotDeleteDialog key={deleting.id} bot={deleting} onClose={() => setDeleting(null)} onAccepted={(bot) => {
      setBots((list) => list?.flatMap((item) => item.id === deleting.id ? bot ? [bot] : [] : [item]) ?? null);
      if (deleting.id === selectedId) setProfileOpen(false);
      refresh();
    }} /> : null}
    {details ? <React.Suspense fallback={null}><BotDetailsDialog bot={details} onClose={() => { setDetails(null); refresh(); }} /></React.Suspense> : null}
  </div>;

  const secondaryPanel = (placement: 'docked' | 'drawer') => placement === 'drawer'
    ? <div className="flex h-full min-h-0 flex-col bg-background">{panelModel ? <BotPanelBody model={panelModel} /> : null}</div>
    : <BotPanel model={panelModel} open={panelVisible && panelModel !== null} floating={floating}
      onOpenChange={open => { if (floating) setNarrowPanelOpen(open); else setPanelOpen(open); }} />;

  return <MainLayout renderNavigator={navigator} renderConversation={conversation} renderSecondaryPanel={secondaryPanel}
    secondaryPanelLabel={t('bot.panel.aria')} secondaryPanelToggleLabels={{ open: t('bot.panel.open'), close: t('bot.panel.close') }}
    navigationTitle={navigationTitle} navigationSubtitle={navigationSubtitle} headerPanelControl={panelControl} sidebarAttention={sidebarAttention} />;
};
