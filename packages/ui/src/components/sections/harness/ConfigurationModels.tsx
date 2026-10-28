import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ModelChannel, type ModelOperation } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';

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
const getEmptyCatalog = () => emptyCatalog;
const noSubscription = () => () => {};
export function useModelChannels(active = true) {
  const key = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const catalog = catalogFor(key);
  return React.useSyncExternalStore(active ? catalog.subscribe : noSubscription, active ? catalog.getSnapshot : getEmptyCatalog, getEmptyCatalog);
}
export function useConfigurationModels() {
  const { channels, error } = useModelChannels();
  const providers = channels.filter(channel => channel.enabled).map(channel => ({ id: channel.id, name: channel.name }));
  const modelsFor = (id: string, operation: ModelOperation) => channels.find(channel => channel.id === id)?.models.filter(model => model.enabled && model.operations.includes(operation)) ?? [];
  return { runtime: 'agent' as const, providers, modelsFor, error };
}
