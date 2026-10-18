import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { reportSettingsSaveState } from '@/lib/persistence';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { HarnessSettingsController } from './harness-settings-state';

// Only retain controllers with unfinished edits when their page unmounts.
const controllers = new Map<string, { controller: HarnessSettingsController; users: number }>();

export function useHarnessSettings(runtime: 'agent' = 'agent') {
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  return useWorkspaceHarnessSettings(cwd, runtime);
}

/** The composer supplies its execution workspace rather than the navigation directory. */
export function useWorkspaceHarnessSettings(cwd?: string, runtime: 'agent' = 'agent') {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const targetKey = JSON.stringify([getRuntimeKey(), host, cwd, runtime]);
  const entry = React.useMemo(() => {
    const existing = controllers.get(targetKey);
    if (existing) return existing;
    // Capture this runtime connection; a delayed save cannot follow a host switch.
    const models = createModelConnectionsHttpAPI(host);
    const controller = new HarnessSettingsController({
      read: async () => models.readSettings(cwd),
      write: async (settings, expectedRevision) => models.updateSettings({ cwd, scope: 'global', expectedRevision, set: settings, remove: [] }),
    });
    const next = { controller, users: 0 };
    controllers.set(targetKey, next);
    return next;
  }, [cwd, targetKey, runtime, host]);
  const { controller } = entry;
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  React.useEffect(() => {
    entry.users += 1;
    if (controller.getSnapshot().status === 'loading') void controller.load();
    return () => {
      entry.users -= 1;
      const release = () => {
        if (['idle', 'saved'].includes(controller.getSnapshot().status)) {
          if (entry.users === 0 && controllers.get(targetKey) === entry) controllers.delete(targetKey);
          unsubscribe();
        }
      };
      const unsubscribe = controller.subscribe(release);
      // Child text fields flush during unmount; let those edits enter the queue.
      queueMicrotask(release);
    };
  }, [controller, entry, targetKey]);
  React.useEffect(() => subscribeVarinEvents((event) => {
    if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings') {
      void controller.refresh();
    }
  }), [controller, runtime]);
  React.useEffect(() => {
    if (state.status === 'saving' || state.status === 'saved' || state.status === 'error') {
      reportSettingsSaveState(state.status);
    }
  }, [state.status]);
  return { ...state, update: controller.update, updateReserveRatio: controller.updateReserveRatio, retry: controller.retry, targetKey };
}
