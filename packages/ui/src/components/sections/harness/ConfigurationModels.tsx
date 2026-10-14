import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ModelChannel, type ModelOperation } from '@varin/application-client';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export const ConfigurationRuntime = React.createContext<'agent' | 'pi'>('agent');
interface CatalogState { channels: ModelChannel[]; error: string | null }
const emptyCatalog: CatalogState = { channels: [], error: null };
class ModelCatalog {
  state = emptyCatalog;
  readonly listeners = new Set<() => void>();
  readonly api = createModelConnectionsHttpAPI();
  controller: AbortController | undefined;
  stop: (() => void) | undefined;
  pending: Promise<void> | undefined;
  refreshRequested = false;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.controller) {
      this.controller = new AbortController();
      this.stop = subscribeVarinEvents(event => { if (event.type === 'settings-changed' && event.owner === 'agent-settings' && event.ids.includes('model-channels')) this.refresh(); });
      this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.stop?.(); this.controller?.abort(); this.controller = undefined; }
    };
  };
  refresh() {
    this.refreshRequested = true;
    if (this.pending) return;
    const work = Promise.resolve().then(async () => {
      while (this.refreshRequested && this.controller) {
        this.refreshRequested = false;
        const controller = this.controller;
        try {
          const value = await this.api.read(controller.signal);
          if (this.controller === controller) this.state = { channels: value.channels, error: null };
        } catch (error) {
          if (this.controller === controller && !controller.signal.aborted) this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) };
        }
        if (this.controller === controller && !controller.signal.aborted) for (const listener of this.listeners) listener();
      }
    }).finally(() => { if (this.pending === work) this.pending = undefined; if (this.refreshRequested && this.controller) this.refresh(); });
    this.pending = work;
  }
}
let sharedCatalog: { generation: number; catalog: ModelCatalog } | undefined;
const catalogFor = (generation: number) => {
  if (!sharedCatalog || sharedCatalog.generation !== generation) sharedCatalog = { generation, catalog: new ModelCatalog() };
  return sharedCatalog.catalog;
};
const noSubscribe = () => () => {};
const getEmptyCatalog = () => emptyCatalog;
export function useConfigurationModels() {
  const runtime = React.useContext(ConfigurationRuntime);
  const legacy = usePiProviderStore(state => state.providers);
  const loadLegacy = usePiProviderStore(state => state.load);
  const cwd = useDirectoryStore(state => state.currentDirectory);
  const [legacyError, setLegacyError] = React.useState<string | null>(null);
  const key = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const catalog = runtime === 'agent' ? catalogFor(key) : undefined;
  const state = React.useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? getEmptyCatalog, getEmptyCatalog);
  React.useEffect(() => {
    const abort = new AbortController();
    if (runtime === 'pi') void loadLegacy(cwd).then(() => { if (!abort.signal.aborted) setLegacyError(null); }, error => { if (!abort.signal.aborted) setLegacyError(String(error)); });
    return () => abort.abort();
  }, [runtime, key, cwd, loadLegacy]);
  const { channels } = state;
  const error = runtime === 'agent' ? state.error : legacyError;
  const providers = runtime === 'agent' ? channels.filter(channel => channel.enabled).map(channel => ({ id: channel.id, name: channel.name })) : legacy.map(provider => ({ id: provider.id, name: provider.name }));
  const modelsFor = (id: string, operation: ModelOperation): Array<{ id: string; name?: string }> => {
    if (runtime === 'agent') return channels.find(channel => channel.id === id)?.models.filter(model => model.enabled && model.operations.includes(operation)).map(model => ({ id: model.id, name: model.name })) ?? [];
    const provider = legacy.find(provider => provider.id === id);
    if (operation === 'chat') return provider?.models.map(model => ({ id: model.id, name: model.name })) ?? [];
    return provider?.details?.capabilities?.[operation as 'embedding' | 'rerank' | 'decision']?.models ?? [];
  };
  return { runtime, providers, modelsFor, error };
}
