/**
 * Shell component registry for built-in workbench shells.
 *
 * The extension runtime (lib/extensions) must not import from workbenches/
 * directly. Instead, workbench shells register themselves here, and the
 * extension runtime resolves them by extension ID.
 */

import type { ComponentType } from 'react';

export type ShellComponent = ComponentType<Record<string, unknown>>;

const shellComponents = new Map<string, ShellComponent>();
const loadRetries = new Map<string, () => void>();

/**
 * Register a shell component for a built-in workbench extension ID.
 * Called by the workbenches layer during initialization.
 */
export const registerWorkbenchShellComponent = (
  extensionId: string,
  component: ShellComponent,
  retryLoad?: () => void,
): void => {
  shellComponents.set(extensionId, component);
  if (retryLoad) loadRetries.set(extensionId, retryLoad);
  else loadRetries.delete(extensionId);
};

/** An explicit recovery action can retry a failed lazy import without changing the Shell's identity. */
export const retryWorkbenchShellLoad = (extensionId: string): void => loadRetries.get(extensionId)?.();

/**
 * Resolve a shell component by extension ID.
 * Returns undefined if no component is registered.
 */
export const resolveWorkbenchShellComponent = (
  extensionId: string,
): ShellComponent | undefined => shellComponents.get(extensionId);
