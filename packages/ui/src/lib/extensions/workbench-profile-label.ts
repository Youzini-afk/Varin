import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_IDE_PROFILE_LABEL,
  VARIN_WORKBENCH_RESEARCH_PROFILE_ID,
  VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL,
} from '@varin/extension-contract';
import type { I18nKey } from '@/lib/i18n';

const officialDefaultProfileLabels = new Set([
  VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL,
  'Default',
]);

const officialIdeProfileLabels = new Set([
  VARIN_WORKBENCH_IDE_PROFILE_LABEL,
]);

const officialResearchProfileLabels = new Set([
  VARIN_WORKBENCH_RESEARCH_PROFILE_LABEL,
]);

export const workbenchProfileLabel = (
  profile: { id: string; label: string },
  t: (key: I18nKey) => string,
): string => {
  if (profile.id === VARIN_WORKBENCH_DEFAULT_PROFILE_ID && officialDefaultProfileLabels.has(profile.label)) {
    return t('settings.varin.extensions.workbench.profile.agent');
  }
  if (profile.id === VARIN_WORKBENCH_IDE_PROFILE_ID && officialIdeProfileLabels.has(profile.label)) {
    return t('settings.varin.extensions.workbench.profile.ide');
  }
  if (profile.id === VARIN_WORKBENCH_RESEARCH_PROFILE_ID && officialResearchProfileLabels.has(profile.label)) {
    return t('research-workbench.profile.label');
  }
  return profile.label;
};

/** General and Research are workspaces within Workbench mode. */
export const workbenchWorkspaceLabel = (
  profile: { id: string; label: string },
  t: (key: I18nKey) => string,
): string => {
  if (profile.id === VARIN_WORKBENCH_DEFAULT_PROFILE_ID && officialDefaultProfileLabels.has(profile.label)) {
    return t('workbench.switcher.general');
  }
  return workbenchProfileLabel(profile, t);
};

export const workbenchExtensionDisplayName = (
  entry: { manifest: { id: string; displayName?: string } },
  t: (key: I18nKey) => string,
): string => {
  if (entry.manifest.id === VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID) {
    return t('settings.varin.extensions.workbench.extension.agentWorkspace');
  }
  if (entry.manifest.id === VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID) {
    return t('settings.varin.extensions.workbench.extension.ideWorkbench');
  }
  return entry.manifest.displayName ?? entry.manifest.id;
};
