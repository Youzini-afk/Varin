import { ComposerActionForm } from './ComposerActionForm';
import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { independentFollowup } from '@/lib/followupPresentation';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { threadSubtreeIds } from '@/lib/agent-runtime/thread-tree';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { createBotSession, openBotConversation } from '@/lib/bots';
import { useOpenThreadContext } from '@/lib/openThreadContext';
import { isDesktopShell } from '@/lib/desktop';
import type { ComposerCommandAction } from '@/lib/commands/surface-command-types';
import { ThreadTokenUsage } from './ThreadTokenUsage';
import { ThreadMemory } from './ThreadMemory';
import { ThreadGoal } from './ThreadGoal';
import { ThreadFollowups } from './ThreadFollowups';
import { BotHandoffDialog } from '@/components/sections/bots/BotHandoffDialog';

export function useThreadComposerCommands({ api, identity, snapshot, sourcePath, disabled, readOnly = false, onHistory, onFork, refresh, onSources, act }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot?: ThreadSnapshot; sourcePath?: string; disabled?: string; readOnly?: boolean;
  onHistory(): void; onFork(head: string): Promise<void>; refresh(): Promise<void>; onSources(): void; act(work: () => Promise<unknown>): Promise<void>;
}): Record<string, ComposerCommandAction | undefined> {
  const { t } = useI18n();
  const openThreadContext = useOpenThreadContext();
  const thread = snapshot?.thread;
  const branch = thread?.branches.find(item => item.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const settings = (slug: string) => { const ui = useUIStore.getState(); ui.setSettingsPage(slug); ui.setSettingsDialogOpen(true); };
  const target = { ...identity }, host = getRuntimeEndpointGeneration();
  const verify = () => { if (host !== getRuntimeEndpointGeneration()) throw new Error(t('composer.scope.changed')); };
  const updateTree = async (kind: 'archive' | 'delete') => {
    verify(); const store = useThreadStore.getState();
    const results = await Promise.allSettled(threadSubtreeIds(store.threads, target.threadId).map(id => kind === 'delete' ? store.deleteThread(id) : store.updateThread(id, { archived: !thread?.archived })));
    const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  };
  const count = threadSubtreeIds(useThreadStore.getState().threads, target.threadId).length - 1;
  const nativeDisabled = disabled ?? (!snapshot ? t('common.loading') : undefined);
  return {
    new: { run: async () => { verify(); if (thread?.bot_id) { const entry = await createBotSession(thread.bot_id); verify(); await openBotConversation(thread.bot_id, entry.identity); } else await startThreadFromNavigation({ directory: sourcePath }); } },
    branch: { disabled: nativeDisabled ?? (!branch?.head ? t('composer.menu.unavailable') : undefined), content: complete => <div className="space-y-2">
      <ComposerActionForm description={t('composer.branch.current')} confirm={async () => { verify(); if (!branch?.head) throw new Error(t('composer.menu.unavailable')); await onFork(branch.head); }} onDone={complete} />
      <button type="button" onClick={() => { onHistory(); complete(); }}>{t('composer.branch.history')}</button>
    </div> },
    rename: { disabled: nativeDisabled, content: complete => <ComposerActionForm initial={thread?.title} label={t('composer.name')} confirm={async title => { verify(); await useThreadStore.getState().updateThread(target.threadId, { title }); }} onDone={complete} /> },
    pin: { disabled: nativeDisabled, value: t(thread?.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin'), run: async () => { verify(); await useThreadStore.getState().updateThread(target.threadId, { pinned: !thread?.pinned }); } },
    archive: { disabled: nativeDisabled, run: () => updateTree('archive') },
    delete: { disabled: nativeDisabled, content: complete => <ComposerActionForm danger description={t(count > 1 ? 'sessions.sidebar.dialogs.deleteSession.withManySubtasks' : count ? 'sessions.sidebar.dialogs.deleteSession.withOneSubtask' : 'sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: thread?.title ?? '', count })} confirm={() => updateTree('delete')} onDone={complete} /> },
    context: { run: () => { verify(); openThreadContext(target, sourcePath, undefined, readOnly); } },
    usage: { content: <ThreadTokenUsage identity={target} /> },
    tasks: api.family ? { run: () => { verify(); useUIStore.getState().openContextPanelTab(useDirectoryStore.getState().currentDirectory, { mode: 'threads' }); } } : undefined,
    goal: snapshot ? { content: <ThreadGoal api={api.goals} identity={target} goals={snapshot.goals} sourceRunId={run?.id} refresh={refresh} /> } : undefined,
    schedule: snapshot ? { disabled: nativeDisabled ?? (!run && !snapshot.thread.bot_id && !snapshot.followups.some(independentFollowup) ? t('followups.needsRun') : undefined), content: <ThreadFollowups api={api.followups} botId={snapshot.thread.bot_id} family={api.family} mediaRead={api.mediaRead} research={api.research} identity={target}
      run={run ?? undefined} operations={snapshot.operations} followups={snapshot.followups} pending={Boolean(disabled)} act={work => act(async () => { verify(); await work(); })} cancelObservation={id => act(async () => { verify(); await api.cancelOperation(id); })} /> } : undefined,
    memory: snapshot && (thread?.bot_id || snapshot.context.checkpoint?.personalization) ? { content: <ThreadMemory identity={target} botId={thread?.bot_id ?? null} basis={snapshot.context.checkpoint?.personalization} expanded /> } : undefined,
    bot: thread && (!thread.bot_id || thread.parent_thread_id) ? { content: complete => <React.Suspense fallback={<p>{t('common.loading')}</p>}><BotHandoffDialog embedded identity={target} onClose={complete} /></React.Suspense> } : undefined,
    mcp: { run: () => settings('mcp-connections') },
    terminal: { run: () => { verify(); if (sourcePath) useUIStore.getState().openContextSurface(sourcePath, 'terminal'); else onSources(); } },
    pet: isDesktopShell() ? { run: () => settings('companion') } : undefined,
  };
}
