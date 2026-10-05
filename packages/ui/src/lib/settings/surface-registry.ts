import React from 'react';
import {
  type SurfaceContribution,
  type SurfaceRegistrySnapshot,
} from '@varin/extension-surface';
import type { JsonValue } from '@varin/extension-contract';
import {
  createBuiltinSurfaceController,
  varinSurfaceRuntime,
  type BuiltinSurfaceController,
} from '@/lib/extensions/surface-runtime';
import { startBuiltinVarinExtensions } from '@/lib/extensions/builtin-surface-manager';
import type { SurfaceActivation } from '@varin/extension-surface';
import type { SettingsPageImplementation, SettingsPageMeta, SettingsPageRegistration } from './page-types';

export { varinSurfaceRuntime };

let builtinSettingsController: BuiltinSurfaceController | null = null;

export const registerBuiltinSettingsContributionSource = (source: {
  activate: SurfaceActivation;
  extensionId: string;
  extensionVersion: string;
}): void => {
  if (builtinSettingsController) return;
  builtinSettingsController = createBuiltinSurfaceController(source);
};

const requireBuiltinSettingsController = (): BuiltinSurfaceController => {
  if (!builtinSettingsController) {
    throw new Error('Built-in Settings workbench composition was not registered before use');
  }
  return builtinSettingsController;
};

export const ensureBuiltinSettingsContributions = (): Promise<void> => {
  return requireBuiltinSettingsController().ensure().then(() => {
    void startBuiltinVarinExtensions().catch((error) => {
      console.error('[Varin Extensions] Failed to load built-in integration state:', error);
    });
  }).catch((error) => {
    console.error('[Varin Extensions] Failed to activate built-in settings contributions:', error);
    throw error;
  });
};

export const setBuiltinSettingsContributionsEnabled = (enabled: boolean): Promise<void> => {
  return requireBuiltinSettingsController().setEnabled(enabled);
};

const stringData = (data: Record<string, JsonValue>, key: string): string | undefined => (
  typeof data[key] === 'string' ? data[key] : undefined
);

const pageRegistration = (contribution: SurfaceContribution): SettingsPageRegistration | null => {
  if (contribution.descriptor.kind !== 'settings-page') return null;
  const data = contribution.descriptor.data;
  const slug = stringData(data, 'slug');
  const title = stringData(data, 'title');
  const titleKey = stringData(data, 'titleKey');
  const group = stringData(data, 'group');
  const kind = stringData(data, 'kind');
  const icon = data.icon === null || typeof data.icon === 'string' ? data.icon : undefined;
  const badgeKey = stringData(data, 'badgeKey');
  const order = typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : undefined;
  if (!slug || !title || !titleKey || !group || !kind || icon === undefined || order === undefined) return null;
  if (group !== 'general' && group !== 'projects' && group !== 'harness' && group !== 'pi') return null;
  if (kind !== 'single' && kind !== 'split') return null;
  const keywords = Array.isArray(data.keywords)
    ? data.keywords.filter((value): value is string => typeof value === 'string')
    : undefined;
  const implementation = contribution.implementation as SettingsPageImplementation;
  if (!implementation || typeof implementation.renderContent !== 'function') return null;
  return {
    contributionId: contribution.descriptor.id,
    implementation,
    meta: {
      slug,
      title,
      titleKey: titleKey as SettingsPageMeta['titleKey'],
      group,
      kind,
      icon: icon as SettingsPageMeta['icon'],
      order,
      ...(badgeKey ? { badgeKey: badgeKey as SettingsPageMeta['badgeKey'] } : {}),
      ...(keywords ? { keywords } : {}),
      ...(implementation.isAvailable ? { isAvailable: implementation.isAvailable } : {}),
    },
  };
};

export const settingsPageRegistrationsFromSnapshot = (
  snapshot: SurfaceRegistrySnapshot,
): SettingsPageRegistration[] => snapshot.visibleContributions
  .map(pageRegistration)
  .filter((value): value is SettingsPageRegistration => value !== null);

export const getSettingsPageRegistrations = (): SettingsPageRegistration[] => {
  void ensureBuiltinSettingsContributions().catch(() => undefined);
  return settingsPageRegistrationsFromSnapshot(varinSurfaceRuntime.getSnapshot());
};

export const subscribeSettingsPageRegistrations = (listener: () => void): (() => void) => {
  void ensureBuiltinSettingsContributions().catch(() => undefined);
  return varinSurfaceRuntime.subscribe(listener);
};

export const useSettingsPageRegistrations = (): SettingsPageRegistration[] => {
  React.useEffect(() => {
    void ensureBuiltinSettingsContributions().catch(() => undefined);
  }, []);
  const snapshot = React.useSyncExternalStore(
    varinSurfaceRuntime.subscribe,
    varinSurfaceRuntime.getSnapshot,
    varinSurfaceRuntime.getSnapshot,
  );
  return React.useMemo(() => settingsPageRegistrationsFromSnapshot(snapshot), [snapshot]);
};
