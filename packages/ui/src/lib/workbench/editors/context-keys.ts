import { evaluateVarinContextExpression, type VarinContextExpressionV1 } from '@varin/extension-contract';

type WorkbenchContextValue = string | boolean | number;

const keys = new Map<string, WorkbenchContextValue>();
const baseKeys = new Map<string, WorkbenchContextValue>();
const listenersByKey = new Map<string, Set<() => void>>();
const pendingNotifications = new Set<string>();
let notificationBatchDepth = 0;

const notifyContextKey = (key: string): void => {
  if (notificationBatchDepth > 0) {
    pendingNotifications.add(key);
    return;
  }
  for (const listener of listenersByKey.get(key) ?? []) listener();
};

export const batchWorkbenchContextKeyUpdates = (operation: () => void): void => {
  notificationBatchDepth += 1;
  try {
    operation();
  } finally {
    notificationBatchDepth -= 1;
    if (notificationBatchDepth === 0 && pendingNotifications.size > 0) {
      const changed = [...pendingNotifications];
      pendingNotifications.clear();
      for (const key of changed) notifyContextKey(key);
    }
  }
};

export const setWorkbenchContextKey = (key: string, value: string | boolean | number): void => {
  baseKeys.set(key, value);
  recomputeEffectiveKey(key);
};

export const getWorkbenchContextKey = (key: string): string | boolean | number | undefined => keys.get(key);

/**
 * Return a read-only view of the entire context key store.
 * Used by the Surface runtime to evaluate `when` expressions.
 */
export const getWorkbenchContextKeyStore = (): ReadonlyMap<string, string | boolean | number> => keys;

export const clearWorkbenchContextKeys = (prefix?: string): void => {
  const affected = new Set([...keys.keys(), ...baseKeys.keys()].filter((key) => !prefix || key.startsWith(prefix)));
  for (const key of [...baseKeys.keys()]) {
    if (!prefix || key.startsWith(prefix)) baseKeys.delete(key);
  }
  for (const layer of ownerLayers) {
    for (const key of [...layer.values.keys()]) {
      if (!prefix || key.startsWith(prefix)) {
        layer.values.delete(key);
        affected.add(key);
      }
    }
  }
  batchWorkbenchContextKeyUpdates(() => {
    for (const key of affected) recomputeEffectiveKey(key);
  });
};

export const subscribeWorkbenchContextKey = (key: string, listener: () => void): (() => void) => {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
};

export const whenWorkbenchContext = (expression: Record<string, string | boolean | number>): boolean => (
  Object.entries(expression).every(([key, value]) => keys.get(key) === value)
);

/**
 * Evaluate a structured VarinContextExpressionV1 against the workbench
 * context key store. This is the structured-expression counterpart to
 * whenWorkbenchContext, used by extension contribution visibility projection.
 */
export const evaluateWorkbenchContextExpression = (expression: VarinContextExpressionV1): boolean => (
  evaluateVarinContextExpression(expression, keys as ReadonlyMap<string, string | number | boolean>)
);

// --- Owner-scoped context key writers ---

interface OwnerContextLayer {
  commitOrder: number;
  committed: boolean;
  disposed: boolean;
  previousActive?: OwnerContextLayer;
  prefix: string;
  scopeKey: string;
  values: Map<string, WorkbenchContextValue>;
}

const activeOwnerLayers = new Map<string, OwnerContextLayer>();
const ownerLayers = new Set<OwnerContextLayer>();
let nextCommitOrder = 0;

const winningOwnerValue = (
  key: string,
  layers: Iterable<OwnerContextLayer> = activeOwnerLayers.values(),
): WorkbenchContextValue | undefined => {
  let winner: OwnerContextLayer | undefined;
  for (const layer of layers) {
    if (layer.disposed || !layer.values.has(key)) continue;
    if (!winner || layer.commitOrder > winner.commitOrder) winner = layer;
  }
  return winner?.values.get(key);
};

const recomputeEffectiveKey = (key: string): void => {
  const ownerValue = winningOwnerValue(key);
  const hasOwnerValue = ownerValue !== undefined;
  const hasBaseValue = baseKeys.has(key);
  const nextValue = hasOwnerValue ? ownerValue : baseKeys.get(key);
  if (!hasOwnerValue && !hasBaseValue) {
    if (!keys.delete(key)) return;
    notifyContextKey(key);
    return;
  }
  if (keys.has(key) && keys.get(key) === nextValue) return;
  keys.set(key, nextValue as WorkbenchContextValue);
  notifyContextKey(key);
};

const previousLiveLayer = (
  layer: OwnerContextLayer | undefined,
  removed: ReadonlySet<OwnerContextLayer> = new Set(),
): OwnerContextLayer | undefined => {
  let candidate = layer;
  while (candidate && (candidate.disposed || removed.has(candidate))) candidate = candidate.previousActive;
  return candidate;
};

export interface WorkbenchContextWriterLease {
  commit(): void;
  dispose(): void;
  writer: { set(key: string, value: WorkbenchContextValue): boolean; delete(key: string): boolean };
}

// Identity lookup for leases owned by this context store; values remain in the original layers.
const writerLayers = new WeakMap<WorkbenchContextWriterLease, OwnerContextLayer>();

/** Project the same winner policy without changing keys, commit order, layers, or notifications. */
export const previewWorkbenchContextKeyUpdates = (changes: {
  commit: readonly WorkbenchContextWriterLease[];
  dispose: readonly WorkbenchContextWriterLease[];
}): ReadonlyMap<string, WorkbenchContextValue> => {
  const layerFor = (lease: WorkbenchContextWriterLease): OwnerContextLayer => {
    const layer = writerLayers.get(lease);
    if (!layer) throw new Error('Context preview lease does not belong to this Workbench context store');
    return layer;
  };
  const removed = new Set(changes.dispose.map(layerFor));
  const projected = new Map(activeOwnerLayers);
  for (const [key, layer] of projected) {
    if (!removed.has(layer)) continue;
    const previous = previousLiveLayer(layer.previousActive, removed);
    if (previous) projected.set(key, previous);
    else projected.delete(key);
  }
  let order = nextCommitOrder;
  for (const lease of changes.commit) {
    const layer = layerFor(lease);
    if (layer.disposed || layer.committed || removed.has(layer)) continue;
    projected.set(layer.scopeKey, { ...layer, commitOrder: ++order });
  }
  const result = new Map(baseKeys);
  const affected = new Set([...projected.values()].flatMap((layer) => [...layer.values.keys()]));
  for (const key of affected) {
    const value = winningOwnerValue(key, projected.values());
    if (value !== undefined) result.set(key, value);
  }
  return result;
};

/**
 * Create an owner-scoped context key writer. Keys written through the
 * returned writer are namespaced with the owner's prefix and fenced by
 * generation — writes from a stale generation are silently rejected.
 * All owner-scoped keys are cleaned up when the returned dispose function
 * is called.
 */
export const createOwnerScopedContextWriter = (
  owner: { extensionId: string; entrypointId: string; generation: number; realmId: string },
): {
  commit: () => void;
  writer: { set: (key: string, value: WorkbenchContextValue) => boolean; delete: (key: string) => boolean };
  dispose: () => void;
} => {
  const scopeKey = `${owner.extensionId}\0${owner.realmId}\0${owner.entrypointId}`;
  const prefix = `${owner.extensionId}.`;
  const layer: OwnerContextLayer = {
    commitOrder: 0,
    committed: false,
    disposed: false,
    prefix,
    scopeKey,
    values: new Map(),
  };
  ownerLayers.add(layer);

  const namespacedKey = (key: string): string => `${prefix}${key}`;
  const acceptsWrites = (): boolean => !layer.disposed && (
    !layer.committed || activeOwnerLayers.get(scopeKey) === layer
  );

  const writer = {
    set: (key: string, value: WorkbenchContextValue): boolean => {
      if (!acceptsWrites()) return false;
      const fullKey = namespacedKey(key);
      layer.values.set(fullKey, value);
      if (layer.committed) recomputeEffectiveKey(fullKey);
      return true;
    },
    delete: (key: string): boolean => {
      if (!acceptsWrites()) return false;
      const fullKey = namespacedKey(key);
      const removed = layer.values.delete(fullKey);
      if (layer.committed && removed) recomputeEffectiveKey(fullKey);
      return removed;
    },
  };

  const commit = (): void => {
    if (layer.disposed || layer.committed) return;
    const previous = activeOwnerLayers.get(scopeKey);
    if (previous) layer.previousActive = previous;
    layer.committed = true;
    layer.commitOrder = ++nextCommitOrder;
    activeOwnerLayers.set(scopeKey, layer);
    const affected = new Set([...layer.values.keys(), ...(previous?.values.keys() ?? [])]);
    batchWorkbenchContextKeyUpdates(() => {
      for (const key of affected) recomputeEffectiveKey(key);
    });
  };

  const dispose = (): void => {
    if (layer.disposed) return;
    layer.disposed = true;
    ownerLayers.delete(layer);
    if (activeOwnerLayers.get(scopeKey) === layer) {
      const previous = previousLiveLayer(layer.previousActive);
      if (previous) activeOwnerLayers.set(scopeKey, previous);
      else activeOwnerLayers.delete(scopeKey);
      const affected = new Set([...layer.values.keys(), ...(previous?.values.keys() ?? [])]);
      batchWorkbenchContextKeyUpdates(() => {
        for (const key of affected) recomputeEffectiveKey(key);
      });
    }
    layer.values.clear();
  };

  const lease = { commit, writer, dispose };
  writerLayers.set(lease, layer);
  return lease;
};
