import {
  resolveVarinWorkbenchProfile,
  type VarinApplicationSurface,
  type VarinExtensionHostStateSnapshot,
  type VarinExtensionServiceRoutingContext,
} from '@varin/extension-contract';

/** The two workspace owners have distinct namespaces; neither is an alias of the other. */
export function surfaceServiceRoutingContext(input: {
  configurationDirectory?: string;
  documentWorkspaceId?: string;
  runtimeId: string;
  sessionId?: string;
  snapshot?: VarinExtensionHostStateSnapshot;
  surface: VarinApplicationSurface;
}): VarinExtensionServiceRoutingContext {
  const profileId = input.snapshot && resolveVarinWorkbenchProfile(input.snapshot.workbench.document, input.snapshot.catalog, {
    surface: input.surface, userId: 'default',
    ...(input.documentWorkspaceId ? { workspaceId: input.documentWorkspaceId } : {}),
  }).profileId;
  return {
    userId: 'default', runtimeId: input.runtimeId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.configurationDirectory ? { workspaceId: input.configurationDirectory } : {}),
    ...(profileId ? { profileId } : {}),
  };
}
