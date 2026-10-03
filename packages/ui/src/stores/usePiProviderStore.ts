import type {
  ModelDescriptor,
  ProviderConfigDetails,
  ProviderDescriptor,
} from '@varin/protocol';
import { PROVIDER_INFERENCE_CAPABILITIES } from '@varin/protocol';
import { create } from 'zustand';
import {
  getPiProviderConfig,
  listPiModels,
  listPiProviders,
} from '@/lib/pi-runtime/providers';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';

export interface PiProviderView extends ProviderDescriptor {
  connected: boolean;
  details?: ProviderConfigDetails;
  models: ModelDescriptor[];
}

interface PiProviderState {
  allProviders: PiProviderView[];
  cwd: string | null;
  error: string | null;
  isLoading: boolean;
  loaded: boolean;
  load(cwd: string, options?: { force?: boolean }): Promise<PiProviderView[]>;
  providers: PiProviderView[];
  reset(): void;
  selectedProviderId: string;
  setSelectedProvider(providerId: string): void;
}

let loadGeneration = 0;
let inFlight: { cwd: string; promise: Promise<PiProviderView[]> } | null = null;

const hasConfigSource = (details: ProviderConfigDetails | undefined): boolean => (
  details !== undefined && Object.values(details.locations).some((location) => location.exists)
);

const catalog = async (cwd: string): Promise<PiProviderView[]> => {
  const [descriptors, models] = await Promise.all([
    listPiProviders(cwd),
    listPiModels(cwd),
  ]);
  const detailResults = await Promise.allSettled(
    descriptors.map((provider) => getPiProviderConfig(cwd, provider.id)),
  );
  const modelsByProvider = new Map<string, ModelDescriptor[]>();
  for (const model of models) {
    const entries = modelsByProvider.get(model.provider) ?? [];
    entries.push(model);
    modelsByProvider.set(model.provider, entries);
  }

  return descriptors.map((provider, index) => {
    const detailsResult = detailResults[index];
    const details = detailsResult?.status === 'fulfilled' ? detailsResult.value : undefined;
    const providerModels = modelsByProvider.get(provider.id) ?? [];
    return {
      ...provider,
      modelCount: new Set([...providerModels.map(model => model.id), ...PROVIDER_INFERENCE_CAPABILITIES.flatMap(kind =>
        details?.capabilities?.[kind]?.enabled === false ? [] : details?.capabilities?.[kind]?.models?.map(model => model.id) ?? [])]).size,
      connected:
        provider.auth.configured
        || hasConfigSource(details)
        || providerModels.some((model) => model.available),
      ...(details === undefined ? {} : { details }),
      models: providerModels,
    };
  });
};

export const usePiProviderStore = create<PiProviderState>((set, get) => ({
  allProviders: [],
  cwd: null,
  error: null,
  isLoading: false,
  loaded: false,
  load: async (cwd, options) => {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) throw new Error('A workspace directory is required');
    const current = get();
    if (!options?.force && current.loaded && current.cwd === normalizedCwd) {
      return current.allProviders;
    }
    if (!options?.force && inFlight?.cwd === normalizedCwd) return inFlight.promise;

    const generation = ++loadGeneration;
    set({ cwd: normalizedCwd, error: null, isLoading: true, loaded: false });
    const promise = catalog(normalizedCwd)
      .then((allProviders) => {
        if (generation === loadGeneration) {
          set({
            allProviders,
            cwd: normalizedCwd,
            error: null,
            isLoading: false,
            loaded: true,
            providers: allProviders.filter((provider) => provider.connected),
          });
        }
        return allProviders;
      })
      .catch((error: unknown) => {
        if (generation === loadGeneration) {
          set({
            error: error instanceof Error ? error.message : String(error),
            isLoading: false,
            loaded: false,
          });
        }
        throw error;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { cwd: normalizedCwd, promise };
    return promise;
  },
  providers: [],
  reset: () => {
    loadGeneration += 1;
    inFlight = null;
    set({
      allProviders: [],
      cwd: null,
      error: null,
      isLoading: false,
      loaded: false,
      providers: [],
    });
  },
  selectedProviderId: '',
  setSelectedProvider: (selectedProviderId) => set({ selectedProviderId }),
}));

subscribeRuntimeEndpointChanged(() => {
  usePiProviderStore.getState().reset();
});
