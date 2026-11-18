/* Name and reachability of the Varin service this client is connected to, for the settings titlebar and scope labels. */
import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, runtimeFetch, subscribeRuntimeEndpointChanged } from '@varin/application-client';

export interface ServiceIdentity { name: string; machine: string | null; local: boolean; reachable: boolean; clientId?: string | null }

let cache: { generation: number; value: ServiceIdentity | null } = { generation: -1, value: null };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

function fallbackName(): string {
  try {
    const url = new URL(getRuntimeApiBaseUrl() || '/', window.location.href);
    return url.host;
  } catch { return 'Varin'; }
}

function load(generation: number) {
  const entry = { generation, value: cache.generation === generation ? cache.value : null };
  cache = entry;
  void runtimeFetch('/api/devices/self').then(async response => {
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json() as { name?: string; machine?: { hostname?: string }; local?: boolean; clientId?: string | null };
    if (cache !== entry) return;
    cache.value = { name: body.name || fallbackName(), machine: body.machine?.hostname ?? null, local: body.local === true, reachable: true, clientId: body.clientId ?? null };
    notify();
  }).catch(() => {
    if (cache !== entry) return;
    cache.value = { name: fallbackName(), machine: null, local: false, reachable: false };
    notify();
  });
}

/** Invalidated whenever the runtime endpoint switches; never reports the previous service's name. */
export function useServiceIdentity(): ServiceIdentity | null {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const value = React.useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (cache.generation === generation ? cache.value : null),
    () => null,
  );
  React.useEffect(() => { if (cache.generation !== generation) load(generation); }, [generation]);
  return value;
}

export function refreshServiceIdentity() { load(getRuntimeEndpointGeneration()); }
