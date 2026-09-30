import React from 'react';
import { VARIN_WORKBENCH_BOT_PROFILE_ID } from '@varin/extension-contract';
import { MainLayout } from '@/components/layout/MainLayout';
import { WorkbenchProfileSwitcher } from '@/components/layout/WorkbenchProfileSwitcher';
import { ChatView } from '@/components/views/ChatView';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { createBot, ensureBotEntry, listBots, listBotWork, type BotSummary, type BotWorkItem } from '@/lib/bots';
import { useWorkbenchProfileId } from '@/lib/workbench/profile-context';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';

const openBotSettings = () => {
  useUIStore.getState().setSettingsPage('harness-bots');
  useUIStore.getState().setSettingsDialogOpen(true);
};

/** Bot identity/work remain Host-owned; this shell only selects their existing sessions. */
export const BotWorkspaceShell: React.FC<Record<string, unknown>> = () => {
  // Candidate shells render before profile commit. They must never create a Bot
  // or change the shared session selection during that hidden render.
  const committed = useWorkbenchProfileId() === VARIN_WORKBENCH_BOT_PROFILE_ID;
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  return <BotWorkspace key={runtimeKey} committed={committed} />;
};

const BotWorkspace: React.FC<{ committed: boolean }> = ({ committed }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [workResult, setWorkResult] = React.useState<{ botId: string; items: BotWorkItem[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const opening = React.useRef<AbortController | null>(null);
  const selected = bots?.find((bot) => bot.id === selectedId);
  const work = workResult?.botId === selectedId ? workResult.items : null;
  const entryStreaming = usePiSessionStore((state) => (
    selected?.entrySessionId ? state.records[selected.entrySessionId]?.snapshot?.isStreaming === true : false
  ));

  React.useEffect(() => () => { opening.current?.abort(); }, []);

  React.useEffect(() => {
    if (!committed || settingsOpen) return;
    const controller = new AbortController();
    void listBots(controller.signal).then((list) => {
      if (controller.signal.aborted) return;
      const active = list.filter((bot) => !bot.archived);
      setBots(active);
      setError(null);
      setSelectedId((previous) => active.find((bot) => bot.id === previous)?.id
        ?? active.find((bot) => bot.entrySessionId === usePiSessionStore.getState().currentSessionId)?.id
        ?? active[0]?.id ?? null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [committed, settingsOpen, revision]);

  const openEntry = React.useCallback(async (botId: string) => {
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    const runtimeKey = usePiSessionStore.getState().runtimeKey;
    setBusy(true);
    setError(null);
    try {
      const { bot, sessionId } = await ensureBotEntry(botId, controller.signal);
      if (controller.signal.aborted || usePiSessionStore.getState().runtimeKey !== runtimeKey) return;
      setBots((list) => list?.map((item) => item.id === bot.id ? bot : item) ?? [bot]);
      await openPiSessionFromNavigation({ sessionId, directory: bot.homeDir });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (!committed || !selectedId) return;
    void openEntry(selectedId);
    return () => opening.current?.abort();
  }, [committed, selectedId, openEntry]);

  React.useEffect(() => {
    if (!committed || !selectedId || settingsOpen) return;
    const controller = new AbortController();
    void listBotWork(selectedId, controller.signal).then((items) => {
      if (!controller.signal.aborted) setWorkResult({ botId: selectedId, items });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [committed, selectedId, settingsOpen, revision, entryStreaming]);

  const create = async () => {
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    setBusy(true);
    setError(null);
    try {
      const bot = await createBot();
      if (controller.signal.aborted) return;
      setBots((list) => [...(list ?? []), bot]);
      setSelectedId(bot.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const selectBot = (botId: string) => {
    useUIStore.getState().setSessionSwitcherOpen(false);
    if (botId === selectedId) void openEntry(botId);
    else setSelectedId(botId);
  };
  const ownsConversation = Boolean(currentSessionId && (
    currentSessionId === selected?.entrySessionId || work?.some((item) => item.sessionId === currentSessionId)
  ));
  const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

  const navigator = () => (
    <nav className="flex h-full min-h-0 flex-col" aria-label="Varin bot">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="flex-1 typography-ui-label font-medium">{isMobile ? <WorkbenchProfileSwitcher /> : 'Varin bot'}</div>
        <Button variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={t('tasksHub.refresh')} onClick={refresh}>
          <Icon name="refresh" className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        {bots?.map((bot) => <button key={bot.id} type="button" disabled={busy} onClick={() => selectBot(bot.id)}
          aria-current={bot.id === selectedId ? 'page' : undefined}
          className={cn(rowClass, bot.id === selectedId ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <Icon name="robot" className="size-4 shrink-0" /><span className="truncate">{bot.name}</span>
        </button>)}
        <button type="button" disabled={busy || !bots} onClick={() => { void create(); }} className={cn(rowClass, 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50')}>
          <Icon name="add" className="size-4 shrink-0" />{t('settings.bots.create')}
        </button>
        {selected ? <>
          <div className="px-2 pb-1 pt-6 typography-meta text-muted-foreground">{t('settings.bots.section.work')}</div>
          {!work && !error ? <p role="status" className="px-2 py-2 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
          {work?.length === 0 ? <p className="px-2 py-2 typography-meta text-muted-foreground">{t('settings.bots.work.empty')}</p> : null}
          {work?.map((item) => <button key={item.thread.id} type="button" disabled={!item.sessionId || busy}
            aria-current={item.sessionId === currentSessionId ? 'page' : undefined}
            onClick={() => {
              if (!item.sessionId) return;
              useUIStore.getState().setSessionSwitcherOpen(false);
              void openPiSessionFromNavigation({ sessionId: item.sessionId }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
            className={cn(rowClass, 'disabled:opacity-50', item.sessionId === currentSessionId ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
            <Icon name="chat-3" className="size-4 shrink-0" /><span className="truncate">{item.thread.brief || item.thread.id}</span>
          </button>)}
        </> : null}
      </div>
      <div className="border-t border-border px-2.5 py-2">
        <button type="button" onClick={() => useUIStore.getState().setScheduledTasksDialogOpen(true)} className={cn(rowClass, 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <Icon name="calendar-schedule" className="size-4 shrink-0" />{t('tasksHub.title')}
        </button>
        <button type="button" onClick={openBotSettings} className={cn(rowClass, 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground')}>
          <Icon name="settings-3" className="size-4 shrink-0" />{t('settings.bots.section.profile')}
        </button>
      </div>
    </nav>
  );

  const conversation = (active: boolean) => <div className="flex h-full min-h-0 flex-col">
    {error ? <div role="alert" className="flex items-center gap-3 border-b border-border px-4 py-3 typography-meta">
      <span className="flex-1 text-destructive">{error}</span>
      <Button variant="ghost" size="sm" onClick={() => { refresh(); if (selectedId) void openEntry(selectedId); }}>{t('research-workbench.retry')}</Button>
    </div> : null}
    {ownsConversation && !busy ? <div className="min-h-0 flex-1"><ChatView active={active} /></div> : (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <Icon name="robot" className="size-9 text-muted-foreground" />
        <h1 className="typography-title">Varin bot</h1>
        {busy || (!bots && !error) ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {bots?.length === 0 ? <>
          <p className="typography-body text-muted-foreground">{t('settings.bots.empty')}</p>
          <Button disabled={busy} onClick={() => { void create(); }}>{t('settings.bots.create')}</Button>
        </> : selected && !busy ? <Button onClick={() => { void openEntry(selected.id); }}>{t('settings.bots.openEntry')}</Button> : null}
      </div>
    )}
  </div>;

  return <MainLayout renderNavigator={navigator} renderConversation={conversation} navigationTitle={selected?.name ?? 'Varin bot'} />;
};
