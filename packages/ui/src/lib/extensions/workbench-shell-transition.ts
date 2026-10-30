import type {
  VarinApplicationSurface,
  VarinWorkbenchLayoutLayer,
  VarinWorkbenchLayoutUpdateRequest,
  VarinWorkbenchProfileSelectionRequest,
} from '@varin/extension-contract';
import {
  inspectVarinWorkbenchShell,
  VARIN_WORKBENCH_BOT_PROFILE_ID,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  resolveVarinWorkbenchLayout,
  resolveVarinWorkbenchLayoutForProfile,
  type VarinWorkbenchShellStatus,
} from '@varin/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@varin/extension-surface';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { prefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { VarinExtensionCatalogStoreState } from './catalog-store';
import {
  getVarinExtensionCatalogState,
  refreshVarinExtensionCatalog,
  setVarinExtensionEnabled,
} from './catalog-store';
import {
  beginWorkbenchProfileTransition,
  markWorkbenchProfileTransitionOperationPrepared,
  revealWorkbenchProfileTransition,
  resolveTransitionDirection,
  waitForWorkbenchProfileTransitionCovered,
  waitForWorkbenchProfileTransitionTargetPainted,
} from '@/lib/workbench/profile-transition';
import {
  stageWorkbenchShellRender,
  type WorkbenchShellRenderStagingHandle,
} from './workbench-shell-staging-store';
import { varinSurfaceRuntime } from './surface-runtime';
import { prepareWorkbenchTransitionScene } from './workbench-transition-scene';
import { useThreadStore } from '@/stores/useThreadStore';
import {
  rememberOrdinarySession,
  restoreOrdinarySession,
} from '@/lib/workbench/bot-session-location';

export type WorkbenchShellUnavailableStatus = Extract<VarinWorkbenchShellStatus, 'disabled' | 'failed' | 'missing'>;

export class WorkbenchShellUnavailableError extends Error {
  readonly profileId: string;
  readonly shellContributionId: string;
  readonly shellExtensionId?: string;
  readonly status: WorkbenchShellUnavailableStatus;

  constructor(input: {
    profileId: string;
    shellContributionId: string;
    shellExtensionId?: string;
    status: WorkbenchShellUnavailableStatus;
  }) {
    super(`Workbench shell is ${input.status}`);
    this.name = 'WorkbenchShellUnavailableError';
    this.profileId = input.profileId;
    this.shellContributionId = input.shellContributionId;
    this.status = input.status;
    if (input.shellExtensionId) this.shellExtensionId = input.shellExtensionId;
  }
}

export class WorkbenchShellTransitionAbortedError extends Error {
  constructor(readonly reason: 'superseded' | 'host-changed' = 'superseded') {
    super(reason === 'superseded'
      ? 'Workbench shell candidate was superseded'
      : 'Application Host changed during workbench switch');
    this.name = 'WorkbenchShellTransitionAbortedError';
  }
}

export interface WorkbenchProfileTransitionOptions {
  /** Internal commit gate used by the live cover transaction after candidate preparation succeeds. */
  beforeCommit?: () => Promise<void>;
  /**
   * Leaving Bot normally restores the ordinary conversation the user left. A caller that
   * navigates to a specific conversation selects it here instead, before the reveal paints.
   */
  selectOnLeavingBot?: () => void;
  beforePrepare?: () => Promise<void>;
  enableShell?: boolean;
}

interface WorkbenchShellTransitionOptions extends WorkbenchProfileTransitionOptions {
  signal?: AbortSignal;
}

export interface WorkbenchShellTransitionDependencies {
  getCatalogState(): VarinExtensionCatalogStoreState;
  getRuntimeGeneration(): number;
  getSurface(): VarinApplicationSurface;
  getSurfaceSnapshot(): SurfaceRegistrySnapshot;
  refreshCatalog(): Promise<void>;
  selectProfile(request: VarinWorkbenchProfileSelectionRequest): Promise<void>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  stageRender(
    contribution: SurfaceContribution,
    props: Readonly<Record<string, unknown>>,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<WorkbenchShellRenderStagingHandle>;
  triggerActivation(contributionId: string, extensionId: string): Promise<void>;
  triggerVisible(contributions: readonly SurfaceContribution[]): Promise<void>;
  updateLayout(request: VarinWorkbenchLayoutUpdateRequest): Promise<void>;
}

let transitionQueue: Promise<void> = Promise.resolve();
interface LiveProfileSelection {
  controller: AbortController;
  profileId: string;
  workspaceId?: string;
  runtimeGeneration: number;
  options: WorkbenchProfileTransitionOptions;
  promise?: Promise<void>;
}
let liveProfileSelection: LiveProfileSelection | null = null;

const enqueueWorkbenchShellTransition = (operation: () => Promise<void>): Promise<void> => {
  const run = transitionQueue.then(operation, operation);
  transitionQueue = run.then(() => undefined, () => undefined);
  return run;
};

const isDeclarativeImplementation = (value: unknown): boolean => (
  typeof value === 'object'
  && value !== null
  && (value as { kind?: unknown }).kind === 'declarative'
);

const createLiveWorkbenchShellTransitionDependencies = (): WorkbenchShellTransitionDependencies => ({
  getCatalogState: getVarinExtensionCatalogState,
  getRuntimeGeneration: getRuntimeEndpointGeneration,
  getSurface: () => varinSurfaceRuntime.surface,
  getSurfaceSnapshot: () => varinSurfaceRuntime.getSnapshot(),
  refreshCatalog: refreshVarinExtensionCatalog,
  selectProfile: async (request) => {
    const extensions = getRegisteredRuntimeAPIs()?.extensions;
    if (!extensions) throw new Error('Varin Extensions runtime is unavailable');
    await extensions.selectWorkbenchProfile(request);
  },
  setEnabled: setVarinExtensionEnabled,
  stageRender: stageWorkbenchShellRender,
  triggerActivation: async (contributionId, extensionId) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    await surfaceExtensionLoader.triggerActivation('contribution-visible', { contributionId, extensionId });
  },
  triggerVisible: async (contributions) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    for (const contribution of contributions) {
      if (
        typeof contribution.implementation !== 'object'
        || contribution.implementation === null
        || (contribution.implementation as { kind?: unknown }).kind !== 'declarative'
      ) continue;
      await surfaceExtensionLoader.triggerActivation('contribution-visible', {
        contributionId: contribution.descriptor.id,
        extensionId: contribution.owner.extensionId,
      });
    }
  },
  updateLayout: async (request) => {
    const extensions = getRegisteredRuntimeAPIs()?.extensions;
    if (!extensions) throw new Error('Varin Extensions runtime is unavailable');
    await extensions.updateWorkbenchLayout(request);
  },
});

const requireAuthoritativeWorkbench = (deps: WorkbenchShellTransitionDependencies) => {
  const snapshot = deps.getCatalogState().snapshot;
  if (!snapshot?.workbench.authoritative) throw new Error('Workbench profile state is unavailable');
  return snapshot;
};

const captureIdentity = (deps: WorkbenchShellTransitionDependencies) => {
  const snapshot = requireAuthoritativeWorkbench(deps);
  return {
    generation: deps.getRuntimeGeneration(),
    hostId: snapshot.catalog.hostId,
    revision: snapshot.workbench.document.revision,
  };
};

const assertSameIdentity = (
  expected: ReturnType<typeof captureIdentity>,
  deps: WorkbenchShellTransitionDependencies,
): void => {
  const current = captureIdentity(deps);
  if (current.generation !== expected.generation || current.hostId !== expected.hostId) {
    throw new WorkbenchShellTransitionAbortedError('host-changed');
  }
};

const findContribution = (
  snapshot: SurfaceRegistrySnapshot,
  contributionId: string,
): SurfaceContribution | undefined => snapshot.contributions.find((contribution) => (
  contribution.descriptor.id === contributionId
));

const proveShellReady = async (
  contributionId: string,
  extensionId: string | undefined,
  deps: WorkbenchShellTransitionDependencies,
  captured: ReturnType<typeof captureIdentity>,
  profileId: string,
  signal?: AbortSignal,
): Promise<WorkbenchShellRenderStagingHandle> => {
  let contribution = findContribution(deps.getSurfaceSnapshot(), contributionId);
  if (!contribution || isDeclarativeImplementation(contribution.implementation)) {
    if (extensionId) await deps.triggerActivation(contributionId, extensionId);
    else if (contribution) await deps.triggerVisible([contribution]);
    signal?.throwIfAborted();
    assertSameIdentity(captured, deps);
    contribution = findContribution(deps.getSurfaceSnapshot(), contributionId);
  }
  if (!contribution) throw new Error(`Workbench shell contribution did not activate: ${contributionId}`);
  if (isDeclarativeImplementation(contribution.implementation)) {
    throw new Error(`Workbench shell contribution did not activate: ${contributionId}`);
  }
  const props = { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell };
  const session = await deps.stageRender(contribution, props, profileId, signal);
  try {
    signal?.throwIfAborted();
    assertSameIdentity(captured, deps);
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
};

const persistProfileSelection = async (
  deps: WorkbenchShellTransitionDependencies,
  profileId: string,
  expectedRevision: number,
): Promise<void> => {
  await deps.selectProfile({
    expectedRevision,
    profileId,
    scope: 'user',
    scopeId: 'default',
  });
  await deps.refreshCatalog();
};

const persistReplacementSelection = async (
  deps: WorkbenchShellTransitionDependencies,
  target: string,
  contributionId: string | null,
  options: { scope?: 'user' | 'workspace'; scopeId?: string } | undefined,
  expectedRevision: number,
): Promise<void> => {
  const snapshot = requireAuthoritativeWorkbench(deps).workbench;
  const scope = options?.scope ?? (options?.scopeId ? 'workspace' : 'user');
  const scopeId = options?.scopeId ?? 'default';
  const resolved = resolveVarinWorkbenchLayout(snapshot.document, {
    surface: deps.getSurface(),
    userId: 'default',
    ...(scope === 'workspace' ? { workspaceId: scopeId } : {}),
  });
  const currentLayer = snapshot.document.layouts.find((layer) => (
    layer.profileId === resolved.profileId
    && layer.surface === deps.getSurface()
    && layer.scope === scope
    && layer.scopeId === scopeId
  ));
  const replacementSelections = { ...(currentLayer?.replacementSelections ?? {}) };
  if (contributionId === null) delete replacementSelections[target];
  else replacementSelections[target] = contributionId;
  const layer: VarinWorkbenchLayoutLayer = {
    profileId: resolved.profileId,
    references: currentLayer?.references ?? [],
    replacementSelections,
    scope,
    scopeId,
    surface: deps.getSurface(),
  };
  await deps.updateLayout({ expectedRevision, layer });
  await deps.refreshCatalog();
};

const commitCandidateShell = async (
  deps: WorkbenchShellTransitionDependencies,
  input: {
    signal?: AbortSignal;
    beforeCommit?: () => Promise<void>;
    beforePrepare?: () => Promise<void>;
    enableShell?: boolean;
    profileId: string;
    replacementSelections: Readonly<Record<string, string>>;
    persist(expectedRevision: number): Promise<void>;
  },
): Promise<void> => {
  const inspectShell = (): ReturnType<typeof inspectVarinWorkbenchShell> => {
    const current = requireAuthoritativeWorkbench(deps);
    const surface = deps.getSurfaceSnapshot();
    return inspectVarinWorkbenchShell(
      input.replacementSelections,
      current.catalog.extensions,
      deps.getSurface(),
      {
        hostId: current.catalog.hostId,
        realmIds: surface.actual.map((state) => state.realmId),
      },
    );
  };
  let autoEnabledExtensionId: string | undefined;
  let committed = false;
  try {
    input.signal?.throwIfAborted();
    let inspected = inspectShell();
    if (input.enableShell && inspected.status === 'disabled' && inspected.shellExtensionId) {
      await deps.setEnabled(inspected.shellExtensionId, true);
      autoEnabledExtensionId = inspected.shellExtensionId;
      inspected = inspectShell();
    }
    const captured = captureIdentity(deps);
    if (inspected.status === 'builtin') {
      await input.beforeCommit?.();
      input.signal?.throwIfAborted();
      assertSameIdentity(captured, deps);
      await input.persist(captured.revision);
      committed = true;
      return;
    }
    if (inspected.status === 'missing' || inspected.status === 'disabled' || inspected.status === 'failed') {
      throw new WorkbenchShellUnavailableError({
        profileId: input.profileId,
        shellContributionId: inspected.shellContributionId ?? '',
        status: inspected.status,
        ...(inspected.shellExtensionId ? { shellExtensionId: inspected.shellExtensionId } : {}),
      });
    }
    await input.beforePrepare?.();
    input.signal?.throwIfAborted();
    assertSameIdentity(captured, deps);
    const staging = await proveShellReady(
      inspected.shellContributionId ?? '',
      inspected.shellExtensionId,
      deps,
      captured,
      input.profileId,
      input.signal,
    );
    try {
      assertSameIdentity(captured, deps);
      await input.beforeCommit?.();
      input.signal?.throwIfAborted();
      assertSameIdentity(captured, deps);
      await input.persist(captured.revision);
      committed = true;
      await staging.promote();
    } catch (error) {
      await staging.dispose();
      throw error;
    }
    await staging.dispose();
  } catch (error) {
    if (autoEnabledExtensionId && !committed) {
      await deps.setEnabled(autoEnabledExtensionId, false).catch((rollbackError) => {
        console.error('[Varin Extensions] Failed to roll back workbench shell enablement:', rollbackError);
      });
    }
    throw error;
  }
};

export const runSelectActiveWorkbenchProfile = (
  deps: WorkbenchShellTransitionDependencies,
  profileId: string,
  workspaceId?: string,
  options?: WorkbenchShellTransitionOptions,
): Promise<void> => enqueueWorkbenchShellTransition(async () => {
  options?.signal?.throwIfAborted();
  const snapshot = requireAuthoritativeWorkbench(deps);
  const layout = resolveVarinWorkbenchLayoutForProfile(snapshot.workbench.document, {
    surface: deps.getSurface(),
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  }, profileId);
  await commitCandidateShell(deps, {
    signal: options?.signal,
    ...(options?.beforePrepare ? { beforePrepare: options.beforePrepare } : {}),
    ...(options?.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
    persist: (expectedRevision) => persistProfileSelection(deps, profileId, expectedRevision),
    profileId,
    replacementSelections: layout.replacementSelections,
    ...(options?.enableShell ? { enableShell: true } : {}),
  });
});

const runSetWorkbenchReplacementSelection = (
  deps: WorkbenchShellTransitionDependencies,
  target: string,
  contributionId: string | null,
  options?: { scope?: 'user' | 'workspace'; scopeId?: string },
): Promise<void> => enqueueWorkbenchShellTransition(async () => {
  const snapshot = requireAuthoritativeWorkbench(deps);
  const persist = (expectedRevision: number) => persistReplacementSelection(
    deps,
    target,
    contributionId,
    options,
    expectedRevision,
  );
  if (target !== VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell) {
    await persist(snapshot.workbench.document.revision);
    return;
  }
  const context = {
    surface: deps.getSurface(),
    userId: 'default',
    ...(options?.scope === 'workspace' && options.scopeId ? { workspaceId: options.scopeId } : {}),
  };
  const resolved = resolveVarinWorkbenchLayout(snapshot.workbench.document, context);
  const replacementSelections = { ...resolved.replacementSelections };
  if (contributionId === null) delete replacementSelections[target];
  else replacementSelections[target] = contributionId;
  await commitCandidateShell(deps, {
    persist,
    profileId: resolved.profileId,
    replacementSelections,
  });
});

/**
 * The live switch. The transition cover is driven from here rather than from the switcher component,
 * because the switcher is rendered inside the shell being replaced and stops existing partway
 * through. Identical pending choices share one transaction; different navigation callbacks retain
 * their own intent and supersede it. Every settled outcome still has to release its own cover.
 */
export const selectActiveWorkbenchProfile = (
  profileId: string,
  workspaceId?: string,
  options?: WorkbenchProfileTransitionOptions,
): Promise<void> => {
  const previous = liveProfileSelection;
  const runtimeGeneration = getRuntimeEndpointGeneration();
  if (previous?.promise
    && previous.runtimeGeneration === runtimeGeneration
    && previous.profileId === profileId && previous.workspaceId === workspaceId
    && Boolean(previous.options.enableShell) === Boolean(options?.enableShell)
    && previous.options.beforePrepare === options?.beforePrepare
    && previous.options.beforeCommit === options?.beforeCommit
    && previous.options.selectOnLeavingBot === options?.selectOnLeavingBot) return previous.promise;

  const selection: LiveProfileSelection = {
    controller: new AbortController(), profileId, workspaceId, runtimeGeneration, options: { ...options },
  };
  liveProfileSelection = selection;
  previous?.controller.abort(new WorkbenchShellTransitionAbortedError());
  selection.promise = performWorkbenchProfileSwitch(profileId, workspaceId, {
    ...selection.options, signal: selection.controller.signal,
  }).then(() => {
    // Stop the superseded caller too: it must not apply follow-up conversation navigation
    // as though its profile had become authoritative.
    selection.controller.signal.throwIfAborted();
  }).finally(() => {
    if (liveProfileSelection === selection) liveProfileSelection = null;
  });
  return selection.promise;
};

const performWorkbenchProfileSwitch = async (
  profileId: string,
  workspaceId?: string,
  options?: WorkbenchShellTransitionOptions,
): Promise<void> => {
  const workbench = getVarinExtensionCatalogState().snapshot?.workbench;
  const profileIds = workbench?.document.profiles.map((profile) => profile.id) ?? [];
  const transitionContext = {
    surface: varinSurfaceRuntime.surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  };
  const fromProfileId = workbench?.authoritative
    ? resolveVarinWorkbenchLayout(workbench.document, transitionContext).profileId
    : null;
  const enteringBot = fromProfileId !== VARIN_WORKBENCH_BOT_PROFILE_ID
    && profileId === VARIN_WORKBENCH_BOT_PROFILE_ID;
  const leavingBot = fromProfileId === VARIN_WORKBENCH_BOT_PROFILE_ID
    && profileId !== VARIN_WORKBENCH_BOT_PROFILE_ID;
  const runtimeKey = useThreadStore.getState().hostKey;
  if (enteringBot) rememberOrdinarySession();
  if (leavingBot) void useThreadStore.getState().loadCatalog().catch(() => {});

  const targetLayout = workbench?.authoritative
    ? resolveVarinWorkbenchLayoutForProfile(workbench.document, transitionContext, profileId)
    : null;
  const scenePreparation = prepareWorkbenchTransitionScene(targetLayout?.replacementSelections ?? {});
  let resolveTransitionId!: (id: number | null) => void;
  const transitionIdReady = new Promise<number | null>((resolve) => {
    resolveTransitionId = resolve;
  });
  // Scene activation can finish out of order. A superseded request must release its queued
  // candidate without ever starting a scene over the newer choice.
  let cancelPreparation!: () => void;
  const preparationCancelled = new Promise<null>((resolve) => {
    cancelPreparation = () => { resolveTransitionId(null); resolve(null); };
  });
  options?.signal?.addEventListener('abort', cancelPreparation, { once: true });
  // Resolve the candidate beside scene activation. Heavy rendering waits for the opaque cover;
  // the prepared subtree is then promoted in place at the authoritative commit boundary.
  const candidate = runSelectActiveWorkbenchProfile(
    createLiveWorkbenchShellTransitionDependencies(),
    profileId,
    workspaceId,
    {
      ...options,
      beforePrepare: async () => {
        options?.signal?.throwIfAborted();
        await options?.beforePrepare?.();
        const id = await transitionIdReady;
        options?.signal?.throwIfAborted();
        if (id === null || !await waitForWorkbenchProfileTransitionCovered(id)) throw new WorkbenchShellTransitionAbortedError();
      },
      beforeCommit: async () => {
        options?.signal?.throwIfAborted();
        await options?.beforeCommit?.();
        const transitionId = await transitionIdReady;
        options?.signal?.throwIfAborted();
        if (transitionId === null) throw new WorkbenchShellTransitionAbortedError();
        markWorkbenchProfileTransitionOperationPrepared(transitionId);
        const covered = await waitForWorkbenchProfileTransitionCovered(transitionId);
        if (!covered) throw new WorkbenchShellTransitionAbortedError();
      },
    },
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ error, ok: false as const }),
  );

  const preparedScene = await Promise.race([scenePreparation, preparationCancelled]);
  options?.signal?.removeEventListener('abort', cancelPreparation);
  if (!preparedScene || options?.signal?.aborted) {
    resolveTransitionId(null);
    await candidate;
    return;
  }
  if (preparedScene.status === 'failed') {
    console.error('[Varin Motion] Transition Scene preparation failed; using Core fallback:', preparedScene.error);
  }
  const transitionId = beginWorkbenchProfileTransition({
    direction: resolveTransitionDirection(profileIds, fromProfileId, profileId),
    fromProfileId,
    reducedMotion: prefersReducedMotion(),
    scene: preparedScene.scene,
    toProfileId: profileId,
  });
  resolveTransitionId(transitionId);

  const result = await candidate;
  if (options?.signal?.aborted) return;
  try {
    if (!result.ok) {
      // A preparation failure is also a settled result. If it happened while covering, reveal the
      // previous authoritative shell at the scene's quick tempo after cover completes.
      markWorkbenchProfileTransitionOperationPrepared(transitionId);
    } else {
      // Restore the ordinary conversation before the new Shell crosses its paint boundary.
      // Restoring after it started a second content mount together with the reveal wave.
      if (leavingBot && useThreadStore.getState().hostKey === runtimeKey) {
        if (options?.selectOnLeavingBot) options.selectOnLeavingBot();
        else restoreOrdinarySession();
      }
      const targetPainted = await waitForWorkbenchProfileTransitionTargetPainted(transitionId);
      // A newer selection owns its reveal; the ID checks in finally leave that scene alone.
      if (!targetPainted) return;
    }
  } finally {
    // Restoring focus can fail after the Profile already committed. That error must not leave
    // a completed switch behind an opaque cover or require another switch to release it.
    const covered = await waitForWorkbenchProfileTransitionCovered(transitionId);
    if (covered) await revealWorkbenchProfileTransition(transitionId);
  }
  if (!result.ok) throw result.error;
};

export const setWorkbenchReplacementSelection = (
  target: string,
  contributionId: string | null,
  options?: { scope?: 'user' | 'workspace'; scopeId?: string },
): Promise<void> => runSetWorkbenchReplacementSelection(
  createLiveWorkbenchShellTransitionDependencies(),
  target,
  contributionId,
  options,
);
