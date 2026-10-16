import type { DesktopLocalHostMode, DesktopLocalHostModeInput } from '@varin/application-client/desktop';
import type { SettingsFileStore } from '@varin/settings-store';

export interface LocalHostModeContext {
  environment: Pick<NodeJS.ProcessEnv, 'VARIN_SKIP_LOCAL_SERVER' | 'VARIN_SERVER_URL'>;
  recoveryUiAvailable: boolean;
  startedEnabled: boolean | null;
  runtime: DesktopLocalHostMode['runtime'];
}

const savedLocalHostEnabled = (root: Record<string, unknown>): boolean => {
  if (root.desktopLocalHostEnabled !== undefined && typeof root.desktopLocalHostEnabled !== 'boolean') {
    throw new Error('Invalid desktop local Host startup mode');
  }
  return root.desktopLocalHostEnabled !== false;
};

/** Adapt the existing native settings owner. No server or connection is stopped by a save. */
export function readLocalHostMode(store: Pick<SettingsFileStore, 'readSync'>, context: LocalHostModeContext): DesktopLocalHostMode {
  const enabled = savedLocalHostEnabled(store.readSync());
  const environmentDisabled = context.environment.VARIN_SKIP_LOCAL_SERVER === '1';
  // Never strand a saved GUI preference in a development/server-rendered build
  // that no longer has the independent recovery shell. Explicit env mode is unchanged.
  const effectiveEnabled = !environmentDisabled && (enabled || !context.recoveryUiAvailable);
  return {
    enabled, effectiveEnabled, environmentDisabled,
    environmentRemoteTarget: Boolean(context.environment.VARIN_SERVER_URL?.trim()),
    canDisable: context.recoveryUiAvailable,
    runtime: context.runtime,
    requiresRestart: context.startedEnabled !== null && context.startedEnabled !== effectiveEnabled,
  };
}

export async function writeLocalHostMode(store: Pick<SettingsFileStore, 'readSync' | 'update'>,
  input: DesktopLocalHostModeInput, context: LocalHostModeContext): Promise<DesktopLocalHostMode> {
  if (typeof input.enabled !== 'boolean' || (input.selectLocalOnRestart !== undefined && typeof input.selectLocalOnRestart !== 'boolean')) {
    throw new Error('Local Host startup mode requires boolean values');
  }
  if (context.environment.VARIN_SKIP_LOCAL_SERVER === '1') throw new Error('Local Host startup is controlled by VARIN_SKIP_LOCAL_SERVER');
  if (!input.enabled && !context.recoveryUiAvailable) throw new Error('Frontend-only mode requires the bundled recovery UI');
  if (input.selectLocalOnRestart && (!input.enabled || context.environment.VARIN_SERVER_URL?.trim())) {
    throw new Error('Local recovery cannot override VARIN_SERVER_URL or a disabled local Host');
  }
  await store.update(root => {
    savedLocalHostEnabled(root);
    root.desktopLocalHostEnabled = input.enabled;
    if (input.selectLocalOnRestart) {
      root.desktopDefaultHostId = 'local';
      root.desktopInitialHostChoiceCompleted = true;
    }
  });
  return readLocalHostMode(store, context);
}

/** Deliberately separate from updater-driven restart. Cleanup must finish first. */
export async function restartDesktopNormally(lifecycle: { prepare(): Promise<void>; relaunch(): void; exit(): void }): Promise<void> {
  await lifecycle.prepare();
  lifecycle.relaunch();
  lifecycle.exit();
}
