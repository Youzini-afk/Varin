/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { ComponentType } from 'react';
import type {
  JsonValue,
  VarinExtensionContributionKind,
  VarinWorkbenchDistributionProfile,
} from '@varin/extension-contract';
import {
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  parseVarinWorkbenchShellContributionData,
  resolveVarinWorkbenchLayout,
  resolveVarinWorkbenchShellSurfaceSeams,
} from '@varin/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@varin/extension-surface';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import {
  getVarinExtensionCatalogState,
  refreshVarinExtensionCatalog,
  useVarinExtensionCatalog,
} from './catalog-store';
import { useWorkbenchWorkspace } from './workbench-workspace';
import {
  startWorkbenchMountSession,
  type WorkbenchMountImplementation,
} from './workbench-mount';
import { varinSurfaceRuntime } from './surface-runtime';
import { createWorkbenchCompositionHost } from './workbench-composition-host';

export { VARIN_WORKBENCH_REPLACEMENT_TARGETS as WORKBENCH_REPLACEMENT_TARGETS } from '@varin/extension-contract';
export { startWorkbenchMountSession } from './workbench-mount';
export {
  selectActiveWorkbenchProfile,
  setWorkbenchReplacementSelection,
  WorkbenchShellUnavailableError,
} from './workbench-shell-transition';

type RenderImplementation<TProps extends object> = {
  render(props: TProps): React.ReactNode;
};

type MountImplementation<TProps extends object> = WorkbenchMountImplementation<TProps>;

interface ReactContribution<TProps extends object> {
  Component: ComponentType<TProps>;
  framework: 'react-19';
  props?: TProps;
}

interface ReactReplacementProps {
  fallback: React.ReactNode;
  target: string;
}

interface MountReplacementProps {
  target: string;
}

interface MountOwnedViewProps {
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
  target: string;
}

const isReactContribution = <TProps extends object>(
  value: unknown,
): value is ReactContribution<TProps> => (
  typeof value === 'object'
  && value !== null
  && (value as { framework?: unknown }).framework === 'react-19'
  && typeof (value as { Component?: unknown }).Component === 'function'
);

const isRenderImplementation = <TProps extends object>(
  value: unknown,
): value is RenderImplementation<TProps> => (
  typeof value === 'object' && value !== null && typeof (value as { render?: unknown }).render === 'function'
);

const isMountImplementation = <TProps extends object>(
  value: unknown,
): value is MountImplementation<TProps> => (
  typeof value === 'object' && value !== null && typeof (value as { mount?: unknown }).mount === 'function'
);

export const workbenchContributionInstanceKey = (contribution: SurfaceContribution): string => {
  const { owner } = contribution;
  return [
    contribution.descriptor.id,
    owner.extensionId,
    owner.entrypointId,
    owner.realmId,
    owner.generation,
  ].join('\0');
};

const renderImplementation = <TProps extends object>(
  implementation: unknown,
  props: TProps,
): React.ReactNode => {
  if (isReactContribution<TProps>(implementation)) {
    const Component = implementation.Component;
    return <Component {...implementation.props} {...props} />;
  }
  if (isRenderImplementation<TProps>(implementation)) return implementation.render(props);
  return null;
};

interface ContributionRenderBoundaryProps {
  children: React.ReactNode;
  contribution: SurfaceContribution;
  fallback: React.ReactNode | ((error: unknown, retry: () => void) => React.ReactNode);
}

interface ContributionRenderBoundaryState {
  error?: unknown;
  failed: boolean;
}

class ContributionRenderBoundary extends React.Component<
  ContributionRenderBoundaryProps,
  ContributionRenderBoundaryState
> {
  state: ContributionRenderBoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): ContributionRenderBoundaryState {
    return { error, failed: true };
  }

  retry = (): void => {
    this.setState({ error: undefined, failed: false });
  };

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    const { descriptor, owner } = this.props.contribution;
    console.error(
      `[Varin Extensions] Contribution ${descriptor.id} from ${owner.extensionId} failed to render:`,
      error,
      errorInfo,
    );
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return typeof this.props.fallback === 'function'
      ? this.props.fallback(this.state.error, this.retry)
      : this.props.fallback;
  }
}

const WorkbenchRenderImplementation = <TProps extends object>({
  fallbackOnEmpty,
  implementation,
  props,
}: {
  fallbackOnEmpty: React.ReactNode;
  implementation: unknown;
  props: TProps;
}): React.ReactNode => {
  const rendered = renderImplementation(implementation, props);
  return rendered === null || rendered === undefined ? fallbackOnEmpty : rendered;
};

interface MountFailure {
  contributionKey: string;
  error: unknown;
  implementation: unknown;
  props: object;
}

const WorkbenchMountHost = <TProps extends object>({
  className,
  contribution,
  fallback,
  implementation,
  onMountReady,
  props,
}: {
  className?: string;
  contribution: SurfaceContribution;
  fallback: React.ReactNode | ((error: unknown, retry: () => void) => React.ReactNode);
  implementation: MountImplementation<TProps>;
  onMountReady?: () => void;
  props: TProps;
}): React.ReactNode => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mountInputs = React.useRef({ contribution, implementation, onMountReady, props });
  mountInputs.current = { contribution, implementation, onMountReady, props };
  const [failure, setFailure] = React.useState<MountFailure | null>(null);
  const contributionKey = workbenchContributionInstanceKey(contribution);
  const failed = failure?.contributionKey === contributionKey
    && failure.implementation === implementation
    && failure.props === props;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    let mountFailed = false;
    const reportMountError = (error: unknown, phase: 'dispose' | 'mount' | 'render') => {
      console.error(
        `[Varin Extensions] Contribution ${contribution.descriptor.id} from ${contribution.owner.extensionId} failed during ${phase}:`,
        error,
      );
      if (!active || phase === 'dispose') return;
      mountFailed = true;
      setFailure({ contributionKey, error, implementation, props });
    };
    // Non-shell mount points stay attached across owner generations. Their actual mounted child
    // participates in the Surface candidate transaction before React observes the new registry.
    if (contribution.descriptor.kind !== 'shell') {
      const point = createWorkbenchCompositionHost({
        shellContributionId: `workbench.mount.${contribution.descriptor.id}`,
        owner: contribution.owner,
        allowedReplacementTargets: new Set(),
        allowedSlots: new Set(['workbench.mount']),
        activate: async () => undefined,
        resolveReplacement: () => undefined,
        resolveSlotCandidates: (_slot, _kind, preview) => {
          const candidate = preview
            ? preview.visibleContributions.find((item) => item.descriptor.id === contribution.descriptor.id)
            : varinSurfaceRuntime.getSnapshot().visibleContributions.find((item) => item.descriptor.id === contribution.descriptor.id);
          if (!candidate || !isMountImplementation<TProps>(candidate.implementation)) return [];
          const mountable = candidate.implementation;
          return [{ ...candidate, implementation: {
            mount: async (target: HTMLElement, context: Parameters<MountImplementation<TProps>['mount']>[1]) => {
              const dispose = await mountable.mount(target, { ...context, props: mountInputs.current.props });
              return dispose;
            },
          } }];
        },
        registerContributionConsumer: varinSurfaceRuntime.registerContributionConsumer,
        subscribe: varinSurfaceRuntime.subscribe,
        onError: reportMountError,
      });
      void point.mountSlot({ container, slot: 'workbench.mount' }).then(() => {
        if (active && !mountFailed) mountInputs.current.onMountReady?.();
      }).catch((error) => reportMountError(error, 'mount'));
      return () => {
        active = false;
        void point.dispose(`Surface contribution ${contribution.descriptor.id} was unmounted`);
      };
    }
    let composition: ReturnType<typeof createWorkbenchCompositionHost> | null = null;
    if (contribution.descriptor.kind === 'shell') {
      try {
        const shellData = parseVarinWorkbenchShellContributionData(
          contribution.descriptor.data,
          contribution.descriptor.supports,
        );
        const seams = resolveVarinWorkbenchShellSurfaceSeams(shellData, varinSurfaceRuntime.surface);
        composition = createWorkbenchCompositionHost({
          shellContributionId: contribution.descriptor.id,
          owner: contribution.owner,
          allowedReplacementTargets: new Set(seams.replacementTargets),
          allowedSlots: new Set(seams.slots),
          activate: triggerVisibleSurfaceContributions,
          registerContributionConsumer: varinSurfaceRuntime.registerContributionConsumer,
          resolveReplacement: (target, preview) => {
            if (target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell
              || target === VARIN_WORKBENCH_REPLACEMENT_TARGETS.transition) return undefined;
            const selected = preview
              ? preview.visibleContributions.find((candidate) => candidate.descriptor.replacement?.target === target)
              : selectedReplacement(varinSurfaceRuntime.getSnapshot(), target);
            if (!selected || workbenchContributionInstanceKey(selected) === contributionKey) return undefined;
            return { contribution: selected, props: { target } };
          },
          resolveSlotCandidates: (slot, kind, preview) => (preview?.visibleContributions ?? varinSurfaceRuntime.getSnapshot().visibleContributions).filter((candidate) => (
            candidate.descriptor.placement?.slot === slot
            && candidate.descriptor.replacement === undefined
            && (kind === undefined || candidate.descriptor.kind === kind)
          )),
          subscribe: varinSurfaceRuntime.subscribe,
          onError: (error, phase) => {
            console.error(
              `[Varin Extensions] Child contribution hosted by ${contribution.descriptor.id} failed during ${phase}:`,
              error,
            );
          },
        });
      } catch (error) {
        reportMountError(error, 'mount');
        return;
      }
    }
    const session = startWorkbenchMountSession({
      container,
      contributionId: contribution.descriptor.id,
      implementation,
      owner: contribution.owner,
      props,
      ...(composition ? { context: { workbench: composition } } : {}),
      onError: (error, phase) => {
        reportMountError(error, phase);
        void composition?.dispose(error);
        void session.dispose(error);
      },
    });
    void session.mounted.then(() => {
      if (active && !mountFailed) onMountReady?.();
    });
    return () => {
      active = false;
      const reason = `Surface contribution ${contribution.descriptor.id} was unmounted`;
      void (async () => {
        await composition?.dispose(reason);
        await session.dispose(reason);
      })();
    };
  // Registry generations are committed by the connected consumer; prop changes remount this host point.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contribution.descriptor.id, contribution.descriptor.kind === 'shell' ? contributionKey : null, props]);

  if (failed && failure) {
    return typeof fallback === 'function'
      ? fallback(failure.error, () => setFailure(null))
      : fallback;
  }
  return (
    <div
      ref={containerRef}
      className={className}
      data-varin-surface-contribution={contribution.descriptor.id}
    />
  );
};

const isMessageImplementation = (
  value: unknown,
): value is { postMessage(message: JsonValue): void } => (
  typeof value === 'object'
  && value !== null
  && typeof (value as { postMessage?: unknown }).postMessage === 'function'
);

export function WorkbenchSurfaceContributionHost<TProps extends object>({
  className,
  contribution,
  fallback,
  isolatedProps,
  onMountReady,
  props,
}: {
  className?: string;
  contribution: SurfaceContribution;
  fallback: React.ReactNode;
  isolatedProps?: JsonValue;
  onMountReady?: () => void;
  props: TProps;
}): React.ReactNode {
  useVisibleContributionActivation([contribution]);
  const contributionKey = workbenchContributionInstanceKey(contribution);
  React.useEffect(() => {
    if (isolatedProps === undefined || !isMessageImplementation(contribution.implementation)) return;
    contribution.implementation.postMessage({
      contributionId: contribution.descriptor.id,
      props: isolatedProps,
      type: 'workbench.mount',
    });
    return () => {
      if (!isMessageImplementation(contribution.implementation)) return;
      contribution.implementation.postMessage({
        contributionId: contribution.descriptor.id,
        type: 'workbench.unmount',
      });
    };
  }, [contribution, isolatedProps]);
  if (isMountImplementation<TProps>(contribution.implementation)) {
    return (
      <WorkbenchMountHost
        key={contribution.descriptor.id}
        className={className}
        contribution={contribution}
        fallback={fallback}
        implementation={contribution.implementation}
        onMountReady={onMountReady}
        props={props}
      />
    );
  }
  return (
    <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={fallback}>
      <ContributionReadySignal onReady={onMountReady}>
        <WorkbenchRenderImplementation
          fallbackOnEmpty={fallback}
          implementation={contribution.implementation}
          props={props}
        />
      </ContributionReadySignal>
    </ContributionRenderBoundary>
  );
}

const ContributionReadySignal: React.FC<{
  children: React.ReactNode;
  onReady?: () => void;
}> = ({ children, onReady }) => {
  React.useEffect(() => {
    onReady?.();
  }, [onReady]);
  return <>{children}</>;
};

export const useSurfaceRegistrySnapshot = (): SurfaceRegistrySnapshot => React.useSyncExternalStore(
  varinSurfaceRuntime.subscribe,
  varinSurfaceRuntime.getSnapshot,
  varinSurfaceRuntime.getSnapshot,
);

interface VisibleContributionActivationDependencies {
  trigger(contribution: SurfaceContribution): Promise<void>;
}

const visibleContributionActivationDependencies: VisibleContributionActivationDependencies = {
  trigger: async (contribution) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    await surfaceExtensionLoader.triggerActivation('contribution-visible', {
      contributionId: contribution.descriptor.id,
      extensionId: contribution.owner.extensionId,
    });
  },
};

export const triggerVisibleSurfaceContributions = async (
  contributions: readonly SurfaceContribution[],
  dependencies: VisibleContributionActivationDependencies = visibleContributionActivationDependencies,
): Promise<void> => {
  for (const contribution of contributions) {
    if (
      typeof contribution.implementation !== 'object'
      || contribution.implementation === null
      || (contribution.implementation as { kind?: unknown }).kind !== 'declarative'
    ) continue;
    await dependencies.trigger(contribution);
  }
};

const useVisibleContributionActivation = (contributions: readonly SurfaceContribution[]): void => {
  const activationKey = contributions.map(workbenchContributionInstanceKey).join('\n');
  React.useEffect(() => {
    void triggerVisibleSurfaceContributions(contributions).catch((error) => {
      console.error('[Varin Extensions] Visible Surface contribution activation failed:', error);
    });
  // The owner-generation key changes exactly when a newly visible implementation needs evaluation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);
};

export const WorkbenchProfileBridge: React.FC = () => {
  const catalog = useVarinExtensionCatalog();
  const workspace = useWorkbenchWorkspace();
  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const workbench = catalog.snapshot?.workbench;
  React.useEffect(() => {
    if (!workbench?.authoritative) return;
    if (workspace.status === 'loading' || workspace.status === 'error') return;
    const resolved = resolveVarinWorkbenchLayout(workbench.document, {
      surface: varinSurfaceRuntime.surface,
      userId: 'default',
      ...(workspaceId ? { workspaceId } : {}),
    });
    varinSurfaceRuntime.setWorkbenchState(resolved.references, resolved.replacementSelections);
  }, [workspace.status, workspaceId, workbench]);
  return null;
};

const selectedReplacement = (
  snapshot: SurfaceRegistrySnapshot,
  target: string,
): SurfaceContribution | undefined => snapshot.visibleContributions.find((contribution) => (
  contribution.descriptor.replacement?.target === target
));

export const WorkbenchReplacement: React.FC<{
  errorFallback?: React.ReactNode | ((error: unknown, retry: () => void) => React.ReactNode);
  expectedContributionId?: string;
  fallback: React.ReactNode;
  onMountReady?(contributionId: string, contributionInstanceKey: string): void;
  target: string;
}> = ({ errorFallback, expectedContributionId, fallback, onMountReady, target }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const mountProps = React.useMemo<MountReplacementProps>(() => ({ target }), [target]);
  const selected = selectedReplacement(snapshot, target);
  const contribution = selected?.descriptor.id === expectedContributionId || expectedContributionId === undefined
    ? selected
    : undefined;
  const contributionId = contribution?.descriptor.id;
  const contributionInstanceKey = contribution ? workbenchContributionInstanceKey(contribution) : undefined;
  const signalReady = React.useCallback(() => {
    if (contributionId && contributionInstanceKey) onMountReady?.(contributionId, contributionInstanceKey);
  }, [contributionId, contributionInstanceKey, onMountReady]);
  useVisibleContributionActivation(contribution ? [contribution] : []);
  if (!contribution) return <>{fallback}</>;
  const contributionKey = workbenchContributionInstanceKey(contribution);
  const failureFallback = (
    <ContributionReadySignal onReady={signalReady}>
      {typeof errorFallback === 'function' ? fallback : (errorFallback ?? fallback)}
    </ContributionReadySignal>
  );
  const renderFailureFallback = typeof errorFallback === 'function'
    ? (error: unknown, retry: () => void) => (
        <ContributionReadySignal onReady={signalReady}>
          {errorFallback(error, retry)}
        </ContributionReadySignal>
      )
    : failureFallback;
  if (isMountImplementation<MountReplacementProps>(contribution.implementation)) {
    return (
      <WorkbenchMountHost
        key={contribution.descriptor.id}
        className="h-full min-h-0 w-full min-w-0"
        contribution={contribution}
        fallback={renderFailureFallback}
        implementation={contribution.implementation}
        onMountReady={signalReady}
        props={mountProps}
      />
    );
  }
  return (
    <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={renderFailureFallback}>
      <ContributionReadySignal onReady={signalReady}>
        <WorkbenchRenderImplementation
          fallbackOnEmpty={fallback}
          implementation={contribution.implementation}
          props={{ fallback, target } satisfies ReactReplacementProps}
        />
      </ContributionReadySignal>
    </ContributionRenderBoundary>
  );
};

export interface WorkbenchOwnedViewImplementation {
  renderContent?(): React.ReactNode;
  renderSidebar?(options: { onItemSelect?(): void }): React.ReactNode;
}

export const WorkbenchOwnedView: React.FC<{
  fallback: React.ReactNode;
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
  target: string;
}> = ({ fallback, onItemSelect, region, target }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const mountProps = React.useMemo<MountOwnedViewProps>(
    () => ({ region, target, ...(onItemSelect ? { onItemSelect } : {}) }),
    [onItemSelect, region, target],
  );
  const contribution = selectedReplacement(snapshot, target);
  useVisibleContributionActivation(contribution ? [contribution] : []);
  if (!contribution) return <>{fallback}</>;
  const contributionKey = workbenchContributionInstanceKey(contribution);
  if (isMountImplementation<MountOwnedViewProps>(contribution.implementation)) {
    return (
      <WorkbenchMountHost
        key={contribution.descriptor.id}
        className="h-full min-h-0 w-full min-w-0"
        contribution={contribution}
        fallback={fallback}
        implementation={contribution.implementation}
        props={mountProps}
      />
    );
  }
  const implementation = contribution.implementation as WorkbenchOwnedViewImplementation;
  return (
    <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={fallback}>
      <WorkbenchOwnedViewRender
        fallback={fallback}
        implementation={implementation}
        onItemSelect={onItemSelect}
        region={region}
      />
    </ContributionRenderBoundary>
  );
};

const WorkbenchOwnedViewRender: React.FC<{
  fallback: React.ReactNode;
  implementation: WorkbenchOwnedViewImplementation;
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
}> = ({ fallback, implementation, onItemSelect, region }) => {
  const rendered = region === 'content'
    ? implementation.renderContent?.()
    : implementation.renderSidebar?.({ onItemSelect });
  return rendered === undefined ? <>{fallback}</> : <>{rendered}</>;
};

const EMPTY_MOUNT_PROPS: Readonly<Record<string, unknown>> = {};

export const WorkbenchContributionSlot: React.FC<{
  kind?: VarinExtensionContributionKind;
  props?: Record<string, unknown>;
  slot: string;
}> = ({ kind, props, slot }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const contributionProps = props ?? EMPTY_MOUNT_PROPS;
  const contributions = snapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.placement?.slot === slot
    && (kind === undefined || contribution.descriptor.kind === kind)
    && contribution.descriptor.replacement === undefined
  ));
  useVisibleContributionActivation(contributions);
  return <>{contributions.map((contribution) => {
    const contributionKey = workbenchContributionInstanceKey(contribution);
    if (isMountImplementation<Record<string, unknown>>(contribution.implementation)) {
      return (
        <WorkbenchMountHost
          key={contribution.descriptor.id}
          contribution={contribution}
          fallback={null}
          implementation={contribution.implementation}
          props={contributionProps}
        />
      );
    }
    return (
      <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={null}>
        <WorkbenchRenderImplementation
          fallbackOnEmpty={null}
          implementation={contribution.implementation}
          props={contributionProps}
        />
      </ContributionRenderBoundary>
    );
  })}</>;
};

export interface WorkbenchMatchRenderer<TInput> {
  matches(input: TInput): boolean;
  render(input: TInput): React.ReactNode;
}

export interface WorkbenchMatchRendererRegistration<TInput> {
  contributionId: string;
  implementation: WorkbenchMatchRenderer<TInput>;
}

export const useWorkbenchMatchRenderers = <TInput,>(
  kind: 'message-renderer' | 'tool-renderer' | 'session-decoration',
  slot: string,
): WorkbenchMatchRendererRegistration<TInput>[] => {
  const snapshot = useSurfaceRegistrySnapshot();
  const contributions = React.useMemo(() => snapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.kind === kind && contribution.descriptor.placement?.slot === slot
  )), [kind, slot, snapshot]);
  useVisibleContributionActivation(contributions);
  return React.useMemo(() => contributions.flatMap((contribution) => {
    const implementation = contribution.implementation as Partial<WorkbenchMatchRenderer<TInput>>;
    return typeof implementation.matches === 'function' && typeof implementation.render === 'function'
      ? [{ contributionId: contribution.descriptor.id, implementation: implementation as WorkbenchMatchRenderer<TInput> }]
      : [];
  }), [contributions]);
};

export const renderFirstWorkbenchMatch = <TInput,>(
  renderers: readonly WorkbenchMatchRendererRegistration<TInput>[],
  input: TInput,
): React.ReactNode | undefined => {
  for (const renderer of renderers) {
    if (renderer.implementation.matches(input)) return renderer.implementation.render(input);
  }
  return undefined;
};

export const upsertWorkbenchProfile = async (
  profile: VarinWorkbenchDistributionProfile,
): Promise<void> => {
  const snapshot = getVarinExtensionCatalogState().snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Varin Extensions runtime is unavailable');
  await extensions.upsertWorkbenchProfile({
    expectedRevision: snapshot.document.revision,
    profile,
  });
  await refreshVarinExtensionCatalog();
};

export const removeWorkbenchProfile = async (profileId: string): Promise<void> => {
  const snapshot = getVarinExtensionCatalogState().snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Varin Extensions runtime is unavailable');
  await extensions.removeWorkbenchProfile({
    expectedRevision: snapshot.document.revision,
    profileId,
  });
  await refreshVarinExtensionCatalog();
};

export const applyWorkbenchProfile = async (profileId: string): Promise<void> => {
  const snapshot = getVarinExtensionCatalogState().snapshot;
  if (!snapshot?.workbench.authoritative) throw new Error('Workbench profile state is unavailable');
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Varin Extensions runtime is unavailable');
  await extensions.applyWorkbenchProfile({
    expectedCatalogRevision: snapshot.catalog.revision,
    profileId,
  });
  await refreshVarinExtensionCatalog();
};
