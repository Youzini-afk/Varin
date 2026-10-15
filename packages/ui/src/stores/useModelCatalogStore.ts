import { create } from 'zustand';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type ModelChannel } from '@varin/application-client';

/** Saved native channels, scoped to the selected Host. No credential or inferred provider catalog. */
export const useModelCatalogStore = create<{
  channels: ModelChannel[]; loaded: boolean; loading: boolean; error: string | null;
  load(): Promise<void>;
}>((set) => ({
  channels: [], loaded: false, loading: false, error: null,
  load() {
    if (pending) { reloadAgain = true; return pending; }
    const operation = (async () => {
    const owner = getRuntimeEndpointGeneration(); const request = ++generation;
    set({ loading: true, error: null });
    try {
      do {
        reloadAgain = false;
        const snapshot = await createModelConnectionsHttpAPI(owner).read();
        if (owner !== getRuntimeEndpointGeneration() || request !== generation) return;
        set({ channels: snapshot.channels, loaded: true, loading: false });
      } while (reloadAgain);
    } catch (error) {
      if (owner === getRuntimeEndpointGeneration() && request === generation) set({ error: error instanceof Error ? error.message : String(error), loading: false });
      throw error;
    }
    })();
    pending = operation;
    void operation.finally(() => { if (pending === operation) pending = undefined; }).catch(() => {});
    return operation;
  },
}));
let generation = 0;
let pending: Promise<void> | undefined;
let reloadAgain = false;
subscribeRuntimeEndpointWillChange(() => { generation += 1; pending = undefined; reloadAgain = false; useModelCatalogStore.setState({ channels: [], loaded: false, loading: false, error: null }); });
