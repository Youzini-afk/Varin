import { expect, test } from 'vitest';
import {
  VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_IDE_PROFILE_LABEL,
} from '@varin/extension-contract';
import type { I18nKey } from '@/lib/i18n';
import { workbenchExtensionDisplayName, workbenchProfileLabel } from './workbench-profile-label';

const t = (key: I18nKey): string => {
  if (key === 'settings.varin.extensions.workbench.profile.agent') return '智能体';
  if (key === 'settings.varin.extensions.workbench.profile.ide') return 'IDE';
  if (key === 'settings.varin.extensions.workbench.extension.agentWorkspace') return '智能体工作区';
  if (key === 'settings.varin.extensions.workbench.extension.ideWorkbench') return 'IDE 工作台';
  return key;
};

test('localizes the official Agent profile and keeps custom profile labels', () => {
  expect(workbenchProfileLabel({ id: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, label: VARIN_WORKBENCH_DEFAULT_PROFILE_LABEL }, t)).toBe('智能体');
  expect(workbenchProfileLabel({ id: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, label: 'Default' }, t)).toBe('智能体');
  expect(workbenchProfileLabel({ id: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, label: 'Studio Agent' }, t)).toBe('Studio Agent');
  expect(workbenchProfileLabel({ id: 'studio', label: 'Studio' }, t)).toBe('Studio');
});

test('localizes the official IDE profile and keeps custom IDE labels', () => {
  expect(workbenchProfileLabel({ id: VARIN_WORKBENCH_IDE_PROFILE_ID, label: VARIN_WORKBENCH_IDE_PROFILE_LABEL }, t)).toBe('IDE');
  expect(workbenchProfileLabel({ id: VARIN_WORKBENCH_IDE_PROFILE_ID, label: 'Studio IDE' }, t)).toBe('Studio IDE');
});

test('localizes the official Agent Workspace extension display name', () => {
  expect(workbenchExtensionDisplayName({
    manifest: { id: VARIN_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, displayName: 'Agent Workspace' },
  }, t)).toBe('智能体工作区');
  expect(workbenchExtensionDisplayName({
    manifest: { id: 'dev.example.shell', displayName: 'Community Shell' },
  }, t)).toBe('Community Shell');
});

test('localizes the official IDE Workbench extension display name', () => {
  expect(workbenchExtensionDisplayName({
    manifest: { id: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, displayName: 'IDE Workbench' },
  }, t)).toBe('IDE 工作台');
});
