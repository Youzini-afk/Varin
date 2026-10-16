import { getRuntimeEndpointGeneration, type StorageScope } from '@varin/application-client';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { useUIStore } from '@/stores/useUIStore';

// A one-shot UI navigation target, never a persisted setting or storage authority.
interface StorageNavigationTarget { id: number; generation: number; scope: StorageScope }
let serial = 0;
let target: StorageNavigationTarget | null = null;
const listeners = new Set<() => void>();
export const subscribeStorageNavigation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getStorageNavigationTarget = () => target?.generation === getRuntimeEndpointGeneration() ? target : null;
export function acknowledgeStorageNavigation(id: number): void {
  if (target?.id !== id) return;
  target = null;
  listeners.forEach(listener => listener());
}
export function openStorageSettings(workspaceId?: string): void {
  const generation = getRuntimeEndpointGeneration();
  requestSettingsNavigation(() => {
    // A workspace identity from the previous Host must not be reused on another Host.
    if (generation !== getRuntimeEndpointGeneration()) return;
    target = { id: ++serial, generation, scope: workspaceId === undefined ? { kind: 'all' } : { kind: 'workspace', workspaceId } };
    listeners.forEach(listener => listener());
    useUIStore.getState().setSettingsPage('storage');
  });
}
