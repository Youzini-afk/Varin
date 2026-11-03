import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { parseVarinCommandContributionData, type JsonValue } from '@varin/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@varin/extension-surface';
import {
  createBuiltinSurfaceController,
  varinSurfaceRuntime,
} from '@/lib/extensions/surface-runtime';
import {
  BUILTIN_COMMANDS_EXTENSION_ID,
  registerBuiltinWorkbenchCommands,
} from './builtin-command-contributions';
import type {
  WorkbenchCommandImplementation,
  WorkbenchCommandMeta,
  WorkbenchCommandRegistration,
} from './surface-command-types';

const builtinCommandsController = createBuiltinSurfaceController({
  activate: registerBuiltinWorkbenchCommands,
  extensionId: BUILTIN_COMMANDS_EXTENSION_ID,
  extensionVersion: '0.1.0',
});

export const ensureBuiltinWorkbenchCommands = (): Promise<void> => builtinCommandsController.ensure();

export const setBuiltinWorkbenchCommandsEnabled = (enabled: boolean): Promise<void> => (
  builtinCommandsController.setEnabled(enabled)
);

const stringData = (data: Record<string, JsonValue>, key: string): string | undefined => (
  typeof data[key] === 'string' ? data[key] : undefined
);

const isDeclarativeImplementation = (value: unknown): boolean => (
  typeof value === 'object'
  && value !== null
  && (value as { kind?: unknown }).kind === 'declarative'
);

interface SurfaceCommandExecutionDependencies {
  getSnapshot(): SurfaceRegistrySnapshot;
  trigger(contribution: SurfaceContribution): Promise<void>;
}

const surfaceCommandExecutionDependencies: SurfaceCommandExecutionDependencies = {
  getSnapshot: varinSurfaceRuntime.getSnapshot,
  trigger: async (contribution) => {
    const { surfaceExtensionLoader } = await import('@/lib/extensions/managed-runtime');
    await surfaceExtensionLoader.triggerActivation('command', {
      contributionId: contribution.descriptor.id,
      extensionId: contribution.owner.extensionId,
    });
  },
};

export const executeSurfaceCommandContribution = async (
  contributionId: string,
  context: Parameters<WorkbenchCommandImplementation['execute']>[0],
  dependencies: SurfaceCommandExecutionDependencies = surfaceCommandExecutionDependencies,
): Promise<void> => {
  const assertTarget = () => { if (context.composer && context.composer.host !== getRuntimeEndpointGeneration()) throw new Error('Conversation target changed'); };
  assertTarget();
  const contribution = dependencies.getSnapshot().visibleContributions.find((candidate) => (
    candidate.descriptor.id === contributionId && candidate.descriptor.kind === 'command'
  ));
  if (!contribution) throw new Error(`Surface command contribution is no longer available: ${contributionId}`);
  if (isDeclarativeImplementation(contribution.implementation)) {
    await dependencies.trigger(contribution);
  }
  assertTarget();
  const latest = dependencies.getSnapshot().visibleContributions.find((candidate) => (
    candidate.descriptor.id === contributionId && candidate.descriptor.kind === 'command'
  ));
  const implementation = latest?.implementation as Partial<WorkbenchCommandImplementation> | undefined;
  if (!implementation || typeof implementation.execute !== 'function') {
    throw new Error(`Surface command did not provide an executable implementation: ${contributionId}`);
  }
  if (implementation.isAvailable && !implementation.isAvailable(context)) throw new Error('Command is no longer available in this conversation');
  const publicContext = context.composer ? { ...context, composer: { host: context.composer.host, identity: context.composer.identity, source: context.composer.source } } : context;
  await implementation.execute((contribution.owner.extensionId === BUILTIN_COMMANDS_EXTENSION_ID ? context : publicContext) as Parameters<WorkbenchCommandImplementation['execute']>[0]);
};

const commandRegistration = (contribution: SurfaceContribution): WorkbenchCommandRegistration | null => {
  if (contribution.descriptor.kind !== 'command') return null;
  const data = contribution.descriptor.data;
  let publicData: ReturnType<typeof parseVarinCommandContributionData> | undefined;
  if (data.titleKey === undefined && data.title !== undefined) {
    try { publicData = parseVarinCommandContributionData(data); }
    catch { return null; } // Do not let one invalid legacy v1 declaration break the whole palette.
  }
  const commandId = publicData ? contribution.descriptor.id : stringData(data, 'commandId');
  const titleKey = stringData(data, 'titleKey');
  const icon = publicData ? 'play' : stringData(data, 'icon');
  const mobileTitleKey = stringData(data, 'mobileTitleKey');
  const shortcutId = stringData(data, 'shortcutId');
  const order = publicData ? contribution.descriptor.placement?.order ?? 50
    : typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : undefined;
  const keywords = Array.isArray(data.keywords)
    ? data.keywords.filter((value): value is string => typeof value === 'string')
    : [];
  const providedImplementation = contribution.implementation as Partial<WorkbenchCommandImplementation>;
  const implementation: WorkbenchCommandImplementation | null = typeof providedImplementation?.execute === 'function'
    ? publicData ? { execute: context => executeSurfaceCommandContribution(contribution.descriptor.id, context),
      ...(providedImplementation.isAvailable ? { isAvailable: providedImplementation.isAvailable } : {}) } : providedImplementation as WorkbenchCommandImplementation
    : isDeclarativeImplementation(contribution.implementation)
      ? { execute: (context) => executeSurfaceCommandContribution(contribution.descriptor.id, context) }
      : null;
  if (!commandId || (!titleKey && !publicData) || !icon || order === undefined || !implementation) {
    return null;
  }
  return {
    contributionId: contribution.descriptor.id,
    implementation,
    meta: {
      commandId,
      ...(data.composer && typeof data.composer === 'object' && !Array.isArray(data.composer)
        && typeof data.composer.name === 'string' && typeof data.composer.group === 'string'
        && ['conversation', 'execution', 'context', 'collaboration', 'resources', 'application', 'management', 'skills'].includes(data.composer.group)
        && ['action', 'select'].includes(String(data.composer.interaction))
        ? { composer: data.composer as unknown as NonNullable<WorkbenchCommandMeta['composer']> } : {}),
      ...(titleKey ? { titleKey: titleKey as WorkbenchCommandMeta['titleKey'] } : {}),
      ...(publicData ? { title: publicData.title } : {}),
      icon: icon as WorkbenchCommandMeta['icon'],
      keywords,
      ...(mobileTitleKey ? { mobileTitleKey: mobileTitleKey as WorkbenchCommandMeta['mobileTitleKey'] } : {}),
      order,
      ...(shortcutId ? { shortcutId } : {}),
    },
  };
};

export const workbenchCommandRegistrationsFromSnapshot = (
  snapshot: SurfaceRegistrySnapshot,
): WorkbenchCommandRegistration[] => snapshot.visibleContributions
  .map(commandRegistration)
  .filter((value): value is WorkbenchCommandRegistration => value !== null);

export const useWorkbenchCommandRegistrations = (): WorkbenchCommandRegistration[] => {
  React.useEffect(() => {
    void ensureBuiltinWorkbenchCommands().catch((error) => {
      console.error('[Varin Extensions] Failed to activate built-in workbench commands:', error);
    });
  }, []);
  const snapshot = React.useSyncExternalStore(
    varinSurfaceRuntime.subscribe,
    varinSurfaceRuntime.getSnapshot,
    varinSurfaceRuntime.getSnapshot,
  );
  return React.useMemo(() => workbenchCommandRegistrationsFromSnapshot(snapshot), [snapshot]);
};
