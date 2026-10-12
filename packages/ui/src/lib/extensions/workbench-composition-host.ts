import type { JsonObject, JsonValue, VarinExtensionContributionKind } from '@varin/extension-contract';
import type { VarinWorkbenchChildMount, VarinWorkbenchCompositionHost } from '@varin/extension-sdk';
import type { SurfaceContribution, SurfaceContributionConsumer, SurfaceContributionLease, SurfaceContributionPreview } from '@varin/extension-surface';
import { createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { startWorkbenchMountSession, type WorkbenchMountSession } from './workbench-mount';

interface ReplacementCandidate {
  contribution: SurfaceContribution;
  props: JsonObject;
}

export interface WorkbenchCompositionHostOptions {
  shellContributionId: string;
  owner: SurfaceContribution['owner'];
  allowedReplacementTargets: ReadonlySet<string>;
  allowedSlots: ReadonlySet<string>;
  activate(contributions: readonly SurfaceContribution[]): Promise<void>;
  resolveReplacement(target: string, preview?: SurfaceContributionPreview): ReplacementCandidate | undefined;
  resolveSlotCandidates(slot: string, kind?: VarinExtensionContributionKind, preview?: SurfaceContributionPreview): SurfaceContribution[];
  registerContributionConsumer?(consumer: SurfaceContributionConsumer): () => void;
  subscribe(listener: () => void): () => void;
  onError(error: unknown, phase: 'dispose' | 'mount' | 'render'): void;
}

export interface WorkbenchCompositionHostController extends VarinWorkbenchCompositionHost {
  dispose(reason?: unknown): Promise<void>;
}

interface MountedChild {
  container: HTMLElement;
  inspectorId: string;
  key: string;
  session: WorkbenchMountSession;
  contribution: SurfaceContribution;
  show(): void;
}

interface CompositionBinding extends VarinWorkbenchChildMount {
  start(): Promise<void>;
}

export interface WorkbenchCompositionInspectorEntry {
  contributionId: string;
  extensionId: string;
  generation: number;
  host: 'replacement' | 'slot';
  hostId: string;
  shellContributionId: string;
}

let inspectorRevision = 0;
let inspectorSnapshot: Readonly<{ revision: number; entries: readonly WorkbenchCompositionInspectorEntry[] }> = {
  revision: 0,
  entries: [],
};
let inspectorCounter = 0;
const inspectorEntries = new Map<string, WorkbenchCompositionInspectorEntry>();
const inspectorListeners = new Set<() => void>();

const publishInspector = (): void => {
  inspectorRevision += 1;
  inspectorSnapshot = {
    revision: inspectorRevision,
    entries: [...inspectorEntries.values()].sort((left, right) => (
      left.shellContributionId.localeCompare(right.shellContributionId)
      || left.hostId.localeCompare(right.hostId)
      || left.contributionId.localeCompare(right.contributionId)
    )),
  };
  for (const listener of inspectorListeners) listener();
};

export const getWorkbenchCompositionInspectorSnapshot = () => inspectorSnapshot;
export const subscribeWorkbenchCompositionInspector = (listener: () => void): (() => void) => {
  inspectorListeners.add(listener);
  return () => inspectorListeners.delete(listener);
};

const contributionKey = (contribution: SurfaceContribution): string => [
  contribution.descriptor.id,
  contribution.owner.extensionId,
  contribution.owner.entrypointId,
  contribution.owner.realmId,
  contribution.owner.generation,
].join('\0');

const sameOwner = (
  left: SurfaceContribution['owner'],
  right: SurfaceContribution['owner'],
): boolean => left.extensionId === right.extensionId
  && left.entrypointId === right.entrypointId
  && left.realmId === right.realmId
  && left.generation === right.generation;

const isJsonValue = (value: unknown, seen: Set<object>): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
};

const normalizeProps = (value: JsonObject | undefined): JsonObject => {
  const props = value ?? {};
  if (!isJsonValue(props, new Set()) || Array.isArray(props)) {
    throw new TypeError('Workbench composition props must be a JSON-safe object');
  }
  return structuredClone(props);
};

const createChildContainer = (container: HTMLElement, kind: 'replacement' | 'slot'): HTMLElement => {
  const child = container.ownerDocument.createElement('div');
  child.dataset.varinWorkbenchChild = kind;
  if (kind === 'replacement') child.className = 'h-full min-h-0 w-full min-w-0';
  else {
    child.className = 'varin-workbench-slot-child';
    child.style.display = 'contents';
  }
  container.appendChild(child);
  return child;
};

const mountImplementation = (contribution: SurfaceContribution) => {
  const implementation = contribution.implementation as {
    Component?: ComponentType<Record<string, unknown>>;
    framework?: string;
    mount?: (container: HTMLElement, context: Record<string, unknown>) => unknown;
    props?: Record<string, unknown>;
    render?: (props: Record<string, unknown>) => unknown;
  };
  if (typeof implementation.mount === 'function') return implementation as never;
  if (implementation.framework === 'react-19' && typeof implementation.Component === 'function') {
    return {
      mount: (container: HTMLElement, context: { props: Record<string, unknown>; reportError(error: unknown): void }) => {
        const root = createRoot(container, { onUncaughtError: context.reportError });
        root.render(createElement(implementation.Component!, { ...implementation.props, ...context.props }));
        return () => root.unmount();
      },
    };
  }
  if (typeof implementation.render === 'function') {
    return {
      mount: (container: HTMLElement, context: { props: Record<string, unknown>; reportError(error: unknown): void }) => {
        const root = createRoot(container, { onUncaughtError: context.reportError });
        root.render(implementation.render!(context.props) as never);
        return () => root.unmount();
      },
    };
  }
  throw new TypeError(`Contribution ${contribution.descriptor.id} does not provide a mountable implementation`);
};

const disposeMountedChild = async (child: MountedChild | null, reason?: unknown): Promise<void> => {
  if (!child) return;
  await child.session.dispose(reason);
  child.container.remove();
  if (inspectorEntries.delete(child.inspectorId)) publishInspector();
};

const mountContribution = async (
  options: WorkbenchCompositionHostOptions,
  container: HTMLElement,
  contribution: SurfaceContribution,
  props: JsonObject,
  kind: 'replacement' | 'slot',
  hostId: string,
  signal?: AbortSignal,
): Promise<MountedChild> => {
  if (contribution.descriptor.id === options.shellContributionId && sameOwner(contribution.owner, options.owner)) {
    throw new Error(`Shell contribution ${contribution.descriptor.id} cannot mount itself`);
  }
  const target = createChildContainer(container, kind);
  target.hidden = true;
  let implementation;
  try {
    implementation = mountImplementation(contribution);
  } catch (error) {
    target.remove();
    throw error;
  }
  let mountFailure: unknown;
  let mountFailed = false;
  const session = startWorkbenchMountSession({
    container: target,
    contributionId: contribution.descriptor.id,
    implementation,
    onError: (error, phase) => {
      // Mount errors are reported by the serial binding's catch — don't double-report.
      // Only forward render and dispose errors here.
      if (phase !== 'mount') options.onError(error, phase);
      if (phase !== 'dispose') { mountFailure = error; mountFailed = true; }
    },
    owner: contribution.owner,
    props: props as never,
  });
  const abortMount = () => { void session.dispose(signal?.reason); };
  signal?.addEventListener('abort', abortMount, { once: true });
  if (signal?.aborted) abortMount();
  await session.mounted;
  signal?.removeEventListener('abort', abortMount);
  if (signal?.aborted) {
    await session.dispose(signal.reason);
    target.remove();
    throw new Error('Workbench host point closed during mount preparation');
  }
  if (mountFailed) {
    await session.dispose(mountFailure);
    target.remove();
    throw mountFailure;
  }
  const inspectorId = `composition-child-${++inspectorCounter}`;
  let shown = false;
  return {
    container: target, inspectorId, key: contributionKey(contribution), session, contribution,
    show: () => {
      target.hidden = false;
      if (shown) return;
      shown = true;
      inspectorEntries.set(inspectorId, {
        contributionId: contribution.descriptor.id,
        extensionId: contribution.owner.extensionId,
        generation: contribution.owner.generation,
        host: kind, hostId, shellContributionId: options.shellContributionId,
      });
      publishInspector();
    },
  };
};

/** Each host point owns its mounts. Candidate preparation never holds the registry publication path. */
const createBinding = (
  options: WorkbenchCompositionHostOptions,
  container: HTMLElement,
  kind: 'replacement' | 'slot',
  hostId: string,
  resolve: (preview?: SurfaceContributionPreview) => ReplacementCandidate[],
  onDispose: () => void,
): CompositionBinding => {
  let disposed = false;
  const controller = new AbortController();
  let current: MountedChild[] = [];
  let tail = Promise.resolve();
  const pending = new Set<MountedChild>();
  const preparing = new Set<Promise<unknown>>();

  const prepare = async (preview?: SurfaceContributionPreview): Promise<SurfaceContributionLease | undefined> => {
    if (disposed) return;
    const desired = resolve(preview);
    const affectedIds = preview ? new Set(preview.affectedExtensionIds) : null;
    const affected = (child: MountedChild) => !affectedIds || affectedIds.has(child.contribution.owner.extensionId);
    const relevant = desired.filter((candidate) => !affectedIds || affectedIds.has(candidate.contribution.owner.extensionId));
    const previous = current.filter(affected);
    if (previous.map((child) => child.key).join('\n') === relevant.map((candidate) => contributionKey(candidate.contribution)).join('\n')) return;
    const created: MountedChild[] = [];
    const next: MountedChild[] = [];
    try {
      for (const candidate of relevant) {
        const retained = previous.find((child) => child.key === contributionKey(candidate.contribution));
        if (retained) next.push(retained);
        else {
          const child = await mountContribution(options, container, candidate.contribution, candidate.props, kind, hostId, controller.signal);
          created.push(child);
          pending.add(child);
          next.push(child);
          if (disposed) throw new Error('Workbench host point closed during mount preparation');
        }
      }
    } catch (error) {
      for (const child of created.reverse()) { pending.delete(child); await disposeMountedChild(child, error); }
      throw error;
    }
    const retired = previous.filter((child) => !next.includes(child));
    let finished = false;
    const rollback = async () => {
      if (finished) return;
      finished = true;
      for (const child of [...created].reverse()) { pending.delete(child); await disposeMountedChild(child, 'Surface candidate rolled back'); }
    };
    return {
      validate: () => {
        if (disposed) throw new Error('Workbench host point closed during mount preparation');
        const actual = current.filter(affected);
        if (actual.length !== previous.length || actual.some((child, index) => child !== previous[index])) {
          throw new Error('Workbench mount candidate was superseded by a newer owner');
        }
        // A selection change matters only when it changes this host point's affected owners.
        if (preview && resolve(preview).filter((candidate) => affectedIds?.has(candidate.contribution.owner.extensionId))
          .map((candidate) => contributionKey(candidate.contribution)).join('\n') !== relevant.map((candidate) => contributionKey(candidate.contribution)).join('\n')) {
          throw new Error('Workbench selection changed during mount preparation');
        }
      },
      commit: () => {
        // Closing a window while the authoritative Host commit is in flight cannot undo that commit.
        if (disposed) return rollback;
        if (finished) return;
        finished = true;
        for (const child of created) pending.delete(child);
        current = [...current.filter((child) => !affected(child)), ...next];
        const order = desired.map((candidate) => contributionKey(candidate.contribution));
        current.sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key));
        for (const child of retired) child.container.hidden = true;
        for (const child of current) { child.show(); container.appendChild(child.container); }
        return async () => { for (const child of [...retired].reverse()) await disposeMountedChild(child, 'Surface owner replaced'); };
      },
      rollback,
    };
  };
  const schedule = (propagate: boolean): Promise<void> => {
    if (disposed) return tail;
    const operation = tail.then(async () => {
      if (disposed) return;
      const candidates = resolve();
      await options.activate(candidates.map((candidate) => candidate.contribution));
      if (disposed) return;
      const lease = await prepare();
      if (!lease) return;
      try { lease.validate(); const retire = lease.commit(); await retire?.(); }
      catch (error) { await lease.rollback(); throw error; }
    });
    tail = operation.catch((error) => { options.onError(error, 'mount'); });
    return propagate ? operation : tail;
  };
  const unsubscribe = options.subscribe(() => { void schedule(false); });
  const unregister = options.registerContributionConsumer?.((preview) => {
    const operation = prepare(preview);
    preparing.add(operation);
    void operation.finally(() => preparing.delete(operation)).catch(() => undefined);
    return operation;
  });
  return {
    start: () => schedule(true),
    dispose: async (reason) => {
      if (disposed) return;
      disposed = true;
      controller.abort(reason);
      unsubscribe(); unregister?.();
      // Abort active mounts immediately, even if a separate candidate is still preparing.
      const children = [...new Set([...pending, ...current])];
      current = []; pending.clear();
      await Promise.all(children.map((child) => disposeMountedChild(child, reason)));
      await Promise.allSettled([tail, ...preparing]);
      onDispose();
    },
  };
};

export const createWorkbenchCompositionHost = (
  options: WorkbenchCompositionHostOptions,
): WorkbenchCompositionHostController => {
  const bindings: CompositionBinding[] = [];
  let disposed = false;
  const own = async (binding: CompositionBinding): Promise<VarinWorkbenchChildMount> => {
    if (disposed) { await binding.dispose('Shell composition host is disposed'); throw new Error('Shell composition host is disposed'); }
    bindings.push(binding);
    try { await binding.start(); return binding; }
    catch (error) { await binding.dispose(error); throw error; }
  };
  const bind = (
    container: HTMLElement, kind: 'replacement' | 'slot', hostId: string,
    resolve: (preview?: SurfaceContributionPreview) => ReplacementCandidate[],
  ) => {
    const binding = createBinding(options, container, kind, hostId, resolve, () => {
      const index = bindings.indexOf(binding);
      if (index >= 0) bindings.splice(index, 1);
    });
    return own(binding);
  };
  return {
    mountReplacement: async ({ container, target, props }) => {
      if (!options.allowedReplacementTargets.has(target)) throw new Error(`Shell did not declare replacement target ${target}`);
      const normalizedProps = normalizeProps(props);
      return bind(container, 'replacement', target, (preview) => {
        const candidate = options.resolveReplacement(target, preview);
        return candidate ? [{ contribution: candidate.contribution, props: normalizeProps({ ...candidate.props, ...normalizedProps }) }] : [];
      });
    },
    mountSlot: async ({ container, slot, kind, props }) => {
      if (!options.allowedSlots.has(slot)) throw new Error(`Shell did not declare slot ${slot}`);
      const normalizedProps = normalizeProps(props);
      return bind(container, 'slot', slot, (preview) => options.resolveSlotCandidates(slot, kind, preview)
        .map((contribution) => ({ contribution, props: normalizedProps })));
    },
    dispose: async (reason) => {
      if (disposed) return;
      disposed = true;
      await Promise.all([...bindings].reverse().map((binding) => binding.dispose(reason)));
      bindings.length = 0;
    },
  };
};
