import { create } from 'zustand';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { hasDesktopInvoke } from '@/lib/desktop';
import {
  createDesktopSshInstance,
  desktopSshConnect,
  desktopSshDisconnect,
  desktopSshImportHosts,
  desktopSshInstancesGet,
  desktopSshInstancesSet,
  desktopSshStatus,
  listenDesktopSshStatus,
  type DesktopSshImportCandidate,
  type DesktopSshInstance,
  type DesktopSshInstanceStatus,
} from '@/lib/desktopSsh';

type DesktopSshState = {
  instances: DesktopSshInstance[];
  statusesById: Record<string, DesktopSshInstanceStatus>;
  importCandidates: DesktopSshImportCandidate[];
  isLoading: boolean;
  isSaving: boolean;
  isImportsLoading: boolean;
  initialized: boolean;
  listenerReady: boolean;
  error: string | null;
  load: () => Promise<void>;
  loadImports: () => Promise<void>;
  refreshStatuses: () => Promise<void>;
  upsertInstance: (instance: DesktopSshInstance) => Promise<void>;
  createFromCommand: (id: string, sshCommand: string, nickname?: string) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  setInstances: (instances: DesktopSshInstance[]) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  getStatus: (id: string) => DesktopSshInstanceStatus | null;
  clearError: () => void;
};

const byUpdatedAt = (a: DesktopSshInstanceStatus, b: DesktopSshInstanceStatus) => {
  return b.updatedAtMs - a.updatedAtMs;
};
let ownerGeneration = 0;
let stopStatusListener: (() => Promise<void>) | undefined;

export const useDesktopSshStore = create<DesktopSshState>((set, get) => ({
  instances: [],
  statusesById: {},
  importCandidates: [],
  isLoading: false,
  isSaving: false,
  isImportsLoading: false,
  initialized: false,
  listenerReady: false,
  error: null,

  load: async () => {
    if (get().isLoading) return;
    const generation = ownerGeneration;
    set({ isLoading: true, error: null });
    try {
      const [config, statuses] = await Promise.all([desktopSshInstancesGet(), desktopSshStatus()]);
      if (generation !== ownerGeneration) return;
      const statusMap: Record<string, DesktopSshInstanceStatus> = {};
      for (const status of statuses.sort(byUpdatedAt)) {
        statusMap[status.id] = status;
      }

      if (!get().listenerReady) {
        const stop = await listenDesktopSshStatus((status) => {
          if (generation !== ownerGeneration) return;
          set((state) => ({
            statusesById: {
              ...state.statusesById,
              [status.id]: status,
            },
          }));
        });
        if (generation !== ownerGeneration) { await stop(); return; }
        stopStatusListener = stop;
      }

      set({
        instances: config.instances,
        statusesById: statusMap,
        isLoading: false,
        initialized: true,
        listenerReady: true,
      });
    } catch (error) {
      if (generation !== ownerGeneration) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  loadImports: async () => {
    if (get().isImportsLoading) return;
    const generation = ownerGeneration;
    set({ isImportsLoading: true, error: null });
    try {
      const importCandidates = await desktopSshImportHosts();
      if (generation !== ownerGeneration) return;
      set({ importCandidates, isImportsLoading: false });
    } catch (error) {
      if (generation !== ownerGeneration) return;
      set({
        isImportsLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refreshStatuses: async () => {
    const generation = ownerGeneration;
    try {
      const statuses = await desktopSshStatus();
      if (generation !== ownerGeneration) return;
      const statusMap: Record<string, DesktopSshInstanceStatus> = {};
      for (const status of statuses.sort(byUpdatedAt)) {
        statusMap[status.id] = status;
      }
      set({ statusesById: statusMap });
    } catch (error) {
      if (generation !== ownerGeneration) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  setInstances: async (instances) => {
    const generation = ownerGeneration;
    set({ isSaving: true, error: null });
    try {
      await desktopSshInstancesSet({ instances });
      if (generation !== ownerGeneration) return;
      set({ instances, isSaving: false });
      await get().refreshStatuses();
    } catch (error) {
      if (generation !== ownerGeneration) throw error;
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  upsertInstance: async (instance) => {
    const current = get().instances;
    const next = current.some((item) => item.id === instance.id)
      ? current.map((item) => (item.id === instance.id ? instance : item))
      : [instance, ...current];
    await get().setInstances(next);
  },

  createFromCommand: async (id, sshCommand, nickname) => {
    const instance = createDesktopSshInstance(id, sshCommand);
    if (nickname && nickname.trim()) {
      instance.nickname = nickname.trim();
    }
    await get().upsertInstance(instance);
  },

  removeInstance: async (id) => {
    const generation = ownerGeneration;
    await desktopSshDisconnect(id).catch(() => undefined);
    if (generation !== ownerGeneration) return;
    const next = get().instances.filter((item) => item.id !== id);
    await get().setInstances(next);
    if (generation !== ownerGeneration) return;
    set((state) => {
      const statusesById = { ...state.statusesById };
      delete statusesById[id];
      return { statusesById };
    });
  },

  connect: async (id) => {
    const generation = ownerGeneration;
    set({ error: null });
    try {
      await desktopSshConnect(id);
      if (generation !== ownerGeneration) return;
      await get().refreshStatuses();
    } catch (error) {
      if (generation !== ownerGeneration) throw error;
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  disconnect: async (id) => {
    const generation = ownerGeneration;
    set({ error: null });
    try {
      await desktopSshDisconnect(id);
      if (generation !== ownerGeneration) return;
      await get().refreshStatuses();
    } catch (error) {
      if (generation !== ownerGeneration) throw error;
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  retry: async (id) => {
    await get().connect(id);
  },

  getStatus: (id) => {
    return get().statusesById[id] || null;
  },

  clearError: () => set({ error: null }),
}));

subscribeRuntimeEndpointChanged(() => {
  if (hasDesktopInvoke()) return;
  ownerGeneration += 1;
  void stopStatusListener?.();
  stopStatusListener = undefined;
  useDesktopSshStore.setState({ instances: [], statusesById: {}, importCandidates: [], initialized: false,
    listenerReady: false, isLoading: false, isImportsLoading: false, isSaving: false, error: null });
  void useDesktopSshStore.getState().load();
  void useDesktopSshStore.getState().loadImports();
});
