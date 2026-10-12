import React from 'react';
import type { DocumentsAPI } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export type WorkbenchWorkspaceResolution =
  | { directory: null; key: string; status: 'none' }
  | { directory: string; key: string; status: 'loading' }
  | { directory: string; errorMessage: string; key: string; status: 'error' }
  | { directory: string; key: string; status: 'ready'; workspaceId: string };

export type WorkbenchWorkspaceState = WorkbenchWorkspaceResolution & {
  retry(): void;
};

const NONE: WorkbenchWorkspaceResolution = { directory: null, key: 'none', status: 'none' };
let currentResolution: WorkbenchWorkspaceResolution = NONE;
let requestGeneration = 0;
const listeners = new Set<() => void>();

const publish = (next: WorkbenchWorkspaceResolution): void => {
  currentResolution = next;
  for (const listener of listeners) listener();
};

export const subscribeWorkbenchWorkspace = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = (): WorkbenchWorkspaceResolution => currentResolution;

const workspaceKey = (directory: string, generation: number): string => `${generation}\0${directory}`;

const comparableDirectory = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const getResolvedWorkbenchWorkspaceId = (directory: string): string | undefined => (
  currentResolution.status === 'ready'
  && currentResolution.key === workspaceKey(currentResolution.directory, getRuntimeEndpointGeneration())
  && comparableDirectory(currentResolution.directory) === comparableDirectory(directory)
    ? currentResolution.workspaceId
    : undefined
);

export const setWorkbenchWorkspaceResolutionForTests = (
  directory?: string,
  workspaceId?: string,
): void => {
  requestGeneration += 1;
  if (!directory || !workspaceId) {
    publish(NONE);
    return;
  }
  publish({
    directory,
    key: workspaceKey(directory, getRuntimeEndpointGeneration()),
    status: 'ready',
    workspaceId,
  });
};

const ensureResolution = (
  documents: DocumentsAPI,
  directory: string | null,
  generation: number,
  force = false,
): void => {
  if (!directory) {
    requestGeneration += 1;
    if (currentResolution.status !== 'none') publish(NONE);
    return;
  }
  const key = workspaceKey(directory, generation);
  if (!force && currentResolution.key === key) return;
  const request = ++requestGeneration;
  publish({ directory, key, status: 'loading' });
  void documents.resolveWorkspace({ path: directory }).then((identity) => {
    if (
      request !== requestGeneration
      || generation !== getRuntimeEndpointGeneration()
      || currentResolution.key !== key
    ) return;
    publish({ directory, key, status: 'ready', workspaceId: identity.workspaceId });
  }).catch((error) => {
    if (
      request !== requestGeneration
      || generation !== getRuntimeEndpointGeneration()
      || currentResolution.key !== key
    ) return;
    publish({
      directory,
      errorMessage: error instanceof Error ? error.message : String(error),
      key,
      status: 'error',
    });
  });
};

export const useWorkbenchWorkspace = (): WorkbenchWorkspaceState => {
  const documents = useRuntimeAPIs().documents;
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory || null);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setRuntimeEpoch((value) => value + 1);
  }), []);

  const generation = getRuntimeEndpointGeneration();
  const expectedKey = currentDirectory ? workspaceKey(currentDirectory, generation) : NONE.key;
  const resolved = React.useSyncExternalStore(subscribeWorkbenchWorkspace, snapshot, snapshot);

  React.useEffect(() => {
    ensureResolution(documents, currentDirectory, generation);
  }, [currentDirectory, documents, generation, runtimeEpoch]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const retryAfterSettingsSync = (): void => {
      if (!currentDirectory) return;
      const currentGeneration = getRuntimeEndpointGeneration();
      const key = workspaceKey(currentDirectory, currentGeneration);
      if (currentResolution.key !== key || currentResolution.status !== 'error') return;
      ensureResolution(documents, currentDirectory, currentGeneration, true);
    };
    window.addEventListener('varin:settings-synced', retryAfterSettingsSync);
    return () => window.removeEventListener('varin:settings-synced', retryAfterSettingsSync);
  }, [currentDirectory, documents]);

  const effective = resolved.key === expectedKey
    ? resolved
    : currentDirectory
      ? { directory: currentDirectory, key: expectedKey, status: 'loading' } as const
      : NONE;
  const retry = React.useCallback(() => {
    ensureResolution(documents, currentDirectory, getRuntimeEndpointGeneration(), true);
  }, [currentDirectory, documents]);
  return { ...effective, retry };
};

export const useWorkbenchWorkspaceId = (): string | undefined => {
  const workspace = useWorkbenchWorkspace();
  return workspace.status === 'ready' ? workspace.workspaceId : undefined;
};
