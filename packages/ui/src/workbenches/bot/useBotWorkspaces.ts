import React from 'react';
import { createResourceFilesHttpAPI, getRuntimeEndpointGeneration, type ThreadSourceTargets } from '@varin/application-client';
import { listComputers, type ComputerCatalog } from '@/lib/computers';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useUIStore } from '@/stores/useUIStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { workKey } from './botPresentation';
import type { BotPanelModel } from './botPanelModel';
import type { BotWorkspaceNavigation, BotWorkspaceView } from './botWorkspaceViews';

export function useBotWorkspaces(model: BotPanelModel | null, enabled: boolean, reveal: () => void): BotWorkspaceNavigation {
  const botId = model?.bot.id ?? '';
  const [spaces, setSpaces] = React.useState<Record<string, { views: BotWorkspaceView[]; activeKey: string | null }>>({});
  const views = spaces[botId]?.views ?? [];
  const activeKey = spaces[botId]?.activeKey ?? null;
  const [focusRevision, focus] = React.useReducer(value => value + 1, 0);
  const select = React.useCallback((activeKey: string | null) => setSpaces(current => ({ ...current, [botId]: { views: current[botId]?.views ?? [], activeKey } })), [botId]);
  const [sources, setSources] = React.useState<ThreadSourceTargets | null>(null);
  const [computers, setComputers] = React.useState<ComputerCatalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const apis = model?.threads;
  React.useEffect(() => {
    if (!enabled || !apis) return;
    const controller = new AbortController();
    void Promise.allSettled([apis.sources.list(null, controller.signal), listComputers()]).then(([files, desktops]) => {
      if (controller.signal.aborted) return;
      if (files.status === 'fulfilled') setSources(files.value);
      if (desktops.status === 'fulfilled') setComputers(desktops.value);
      setError([files, desktops].flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []).join('\n') || null);
    });
    return () => controller.abort();
  }, [apis, enabled, revision]);
  React.useEffect(() => enabled ? subscribeVarinEvents(event => {
    if (event.type === 'stream-ready' || event.type === 'settings-changed') refresh();
  }) : undefined, [enabled]);
  const revealRef = React.useRef(reveal); revealRef.current = reveal;
  const open = React.useCallback((view: BotWorkspaceView) => {
    setSpaces(current => { const previous = current[botId]?.views ?? []; return { ...current, [botId]: { views: previous.some(item => item.key === view.key) ? previous.map(item => item.key === view.key && view.kind === 'work' ? view : item) : [...previous, view], activeKey: view.key } }; });
    focus();
    revealRef.current();
  }, [botId]);
  const close = React.useCallback((key: string) => {
    setSpaces(current => { const previous = current[botId]; return previous ? { ...current, [botId]: { views: previous.views.filter(view => view.key !== key), activeKey: previous.activeKey === key ? null : previous.activeKey } } : current; });
  }, [botId]);
  return {
    views, activeKey, focusRevision, sources, computers, error, refresh, open, select, close,
    files: (owner, title, task, path) => open({ kind: 'files', key: JSON.stringify(['files', owner, task ?? null, path ?? null]), owner, title, ...(task ? { task } : {}), ...(path ? { path } : {}) }),
    computer: desktop => open({ kind: 'computer', key: `computer:${desktop.id}`, title: desktop.label, desktop }),
    connections: () => { const ui = useUIStore.getState(); ui.setSettingsPage('connections'); ui.setSettingsDialogOpen(true); },
    cite: async (location, path, target) => {
      const identity = target ?? model?.session?.identity;
      if (!identity) throw new Error('Open a conversation first');
      const host = getRuntimeEndpointGeneration();
      const attachment = await createResourceFilesHttpAPI().retain(location, path, identity, crypto.randomUUID());
      if (host !== getRuntimeEndpointGeneration()) return;
      const key = threadComposerKey(threadHostKey(), identity);
      useThreadDraftStore.getState().patch(key, draft => ({ selectedAttachments: [...(draft.selectedAttachments ?? []).filter(item => !('ref' in item.selection) || item.selection.ref !== attachment.ref),
        { id: attachment.ref, host, filename: attachment.filename, selection: { ref: attachment.ref }, attachment }] }));
      if (target) open({ kind: 'work', key: workKey(target), identity: target, title: model?.work.find(item => workKey(item.identity) === workKey(target))?.name ?? target.threadId });
    },
  };
}
