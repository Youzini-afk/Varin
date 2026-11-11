import React from 'react';
import { getDocumentRegistry } from './session';
import { toDocumentMeta, type DocumentIdentity, type DocumentMeta, type DocumentRecord } from './types';

const EMPTY_DIRTY_IDS: ReadonlySet<string> = new Set();

const subscribeRecord = (identity: DocumentIdentity | undefined, onStoreChange: () => void): (() => void) => {
  if (!identity) return () => undefined;
  return getDocumentRegistry().subscribe(identity, onStoreChange);
};

const readRecord = (identity: DocumentIdentity | undefined): DocumentRecord | undefined => (
  identity ? getDocumentRegistry().get(identity) : undefined
);

export const useDocumentRecord = (identity: DocumentIdentity | undefined, registry?: ReturnType<typeof getDocumentRegistry>): DocumentRecord | undefined => (
  React.useSyncExternalStore(
    (onStoreChange) => registry && identity ? registry.subscribe(identity, onStoreChange) : subscribeRecord(identity, onStoreChange),
    () => registry && identity ? registry.get(identity) : readRecord(identity),
    () => undefined,
  )
);

export const useDocumentMeta = (identity: DocumentIdentity | undefined, registry?: ReturnType<typeof getDocumentRegistry>): DocumentMeta | undefined => {
  const record = useDocumentRecord(identity, registry);
  return record ? toDocumentMeta(record) : undefined;
};

export const useDirtyResourceIds = (workspaceId: string | undefined, registry?: ReturnType<typeof getDocumentRegistry>): ReadonlySet<string> => (
  React.useSyncExternalStore(
    (onStoreChange) => (workspaceId ? (registry ?? getDocumentRegistry()).subscribeDirty(workspaceId, onStoreChange) : () => undefined),
    () => (workspaceId ? (registry ?? getDocumentRegistry()).dirtyResourceIds(workspaceId) : EMPTY_DIRTY_IDS),
    () => EMPTY_DIRTY_IDS,
  )
);
