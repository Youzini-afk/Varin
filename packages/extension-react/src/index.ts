import { createElement, createContext, useContext, type ComponentType, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  VarinManagedSurfaceContext,
  VarinMatchRenderer,
  VarinMessageRendererPropsV1,
  VarinToolRendererPropsV1,
  VarinSessionDecorationPropsV1,
  VarinSettingsPageMountPropsV1,
  VarinShellMountContext,
  VarinShellMountImplementation,
  VarinSurfaceMountImplementation,
  VarinWorkbenchCompositionHost,
  VarinTransitionSceneMountProps,
  VarinTransitionSceneFrameV1,
} from "@varin/extension-sdk";

export interface VarinReactContribution<TProps extends object = Record<string, unknown>>
  extends VarinSurfaceMountImplementation<TProps> {
  Component: ComponentType<TProps>;
  framework: "react-19";
  props?: Partial<TProps>;
}

export interface VarinReactReplacementProps {
  target: string;
}

export type VarinReactReplacementContribution = VarinReactContribution<VarinReactReplacementProps>;
export type VarinReactTransitionSceneContribution = VarinReactContribution<VarinTransitionSceneMountProps>;

export interface VarinReactShellProps {
  workbench: VarinWorkbenchCompositionHost;
}

export interface VarinReactShellContribution extends VarinShellMountImplementation<VarinReactShellProps> {
  Component: ComponentType<VarinReactShellProps>;
  framework: "react-19";
}

const WorkbenchCompositionHostContext = createContext<VarinWorkbenchCompositionHost | null>(null);

/**
 * Access the composition host supplied to a managed Shell mount.
 * Returns `null` when the component is rendered outside a Shell mount
 * (e.g. in tests or isolated previews).
 */
export const useWorkbenchCompositionHost = (): VarinWorkbenchCompositionHost | null => (
  useContext(WorkbenchCompositionHostContext)
);

export const WorkbenchCompositionHostProvider = WorkbenchCompositionHostContext.Provider;

export const defineReactReplacement = (
  Component: ComponentType<VarinReactReplacementProps>,
): VarinReactReplacementContribution => defineReactContribution(Component);

export const defineReactContribution = <TProps extends object>(
  Component: ComponentType<TProps>,
  props?: Partial<TProps>,
): VarinReactContribution<TProps> => ({
  Component,
  framework: "react-19",
  ...(props ? { props } : {}),
  mount: (container, context) => {
    const root = createRoot(container, {
      onUncaughtError: (error) => context.reportError(error),
    });
    try {
      root.render(createElement(Component, { ...props, ...context.props } as TProps));
    } catch (error) {
      try {
        root.unmount();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "React contribution mount and cleanup failed");
      }
      throw error;
    }
    return () => root.unmount();
  },
});

export const defineReactShell = (
  Component: ComponentType<VarinReactShellProps>,
): VarinReactShellContribution => ({
  Component,
  framework: "react-19",
  mount: (container, context: VarinShellMountContext<VarinReactShellProps>) => {
    const workbench = context.workbench;
    const root = createRoot(container, {
      onUncaughtError: (error) => context.reportError(error),
    });
    try {
      root.render(createElement(
        WorkbenchCompositionHostProvider,
        { value: workbench },
        createElement(Component, { workbench }),
      ));
    } catch (error) {
      try {
        root.unmount();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "React shell mount and cleanup failed");
      }
      throw error;
    }
    return () => root.unmount();
  },
});
export const defineReactView = defineReactContribution;
export const defineReactEditor = defineReactContribution;
export const defineReactTransitionScene = (
  Component: ComponentType<VarinTransitionSceneMountProps>,
): VarinReactTransitionSceneContribution => defineReactContribution(Component);

export const useVarinTransitionScene = (
  transition: VarinTransitionSceneMountProps["transition"],
): VarinTransitionSceneFrameV1 => useSyncExternalStore(
  transition.subscribe,
  transition.getSnapshot,
  transition.getSnapshot,
);

export const ownReactRoot = (context: VarinManagedSurfaceContext, root: Root): Root => {
  context.onDispose(() => root.unmount());
  return root;
};

/** These adapters use the same extension-owned root and mount lifetime as ordinary views. */
export const defineReactSettingsPage = defineReactContribution<VarinSettingsPageMountPropsV1>;
export const defineReactMessageRenderer = (
  matches: VarinMatchRenderer<VarinMessageRendererPropsV1>['matches'],
  Component: ComponentType<VarinMessageRendererPropsV1>,
) => ({ ...defineReactContribution(Component), matches });
export const defineReactToolRenderer = (
  matches: VarinMatchRenderer<VarinToolRendererPropsV1>['matches'],
  Component: ComponentType<VarinToolRendererPropsV1>,
) => ({ ...defineReactContribution(Component), matches });
export const defineReactSessionDecoration = (
  matches: VarinMatchRenderer<VarinSessionDecorationPropsV1>['matches'],
  Component: ComponentType<VarinSessionDecorationPropsV1>,
) => ({ ...defineReactContribution(Component), matches });
