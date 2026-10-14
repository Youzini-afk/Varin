import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeKey } from '@varin/application-client';
import { getPiRuntimeConnection } from '@/lib/pi-runtime/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { reportSettingsSaveState } from '@/lib/persistence';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { HarnessSettingsController } from './harness-settings-state';

// Only retain controllers with unfinished edits when their page unmounts.
const controllers = new Map<string, { controller: HarnessSettingsController; users: number }>();

export function useHarnessSettings(runtime: 'agent' | 'pi' = 'agent') {
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const targetKey = JSON.stringify([getRuntimeKey(), cwd, runtime]);
  const entry = React.useMemo(() => {
    const existing = controllers.get(targetKey);
    if (existing) return existing;
    // Capture this runtime connection; a delayed save cannot follow a host switch.
    const connection = runtime === 'pi' ? getPiRuntimeConnection() : null;
    const models = runtime === 'agent' ? createModelConnectionsHttpAPI() : null;
    const target = { cwd };
    const controller = new HarnessSettingsController({
      read: async () => models ? models.readSettings(cwd) : (await connection!).client.request('settings.get', target),
      write: async (harness, expectedRevision) => models ? models.updateSettings({ cwd, scope: 'global', expectedRevision, set: { harness }, remove: [] }) : (await connection!).client.request('settings.update', {
        ...target, scope: 'global', expectedRevision, remove: [], set: { harness },
      }),
    });
    const next = { controller, users: 0 };
    controllers.set(targetKey, next);
    return next;
  }, [cwd, targetKey, runtime]);
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
    if (event.type === 'settings-changed' && event.owner === (runtime === 'agent' ? 'agent-settings' : 'pi-settings')) {
      void controller.refresh();
    }
  }), [controller, runtime]);
  React.useEffect(() => {
    if (state.status === 'saving' || state.status === 'saved' || state.status === 'error') {
      reportSettingsSaveState(state.status);
    }
  }, [state.status]);
  return { ...state, update: controller.update, retry: controller.retry, targetKey };
}
