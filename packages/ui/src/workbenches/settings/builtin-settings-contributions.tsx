import type React from 'react';
import { GeneralPage } from '@/components/sections/preferences/GeneralPage';
import { AppearancePage } from '@/components/sections/preferences/AppearancePage';
import { ChatPage } from '@/components/sections/preferences/ChatPage';
import { EditorPage, TerminalPage } from '@/components/sections/preferences/EditorTerminalPages';
import { NotificationsPage, ShortcutsPage, VoicePage } from '@/components/sections/preferences/PreferenceWrappers';
import { DevicesPage } from '@/components/sections/devices/DevicesPage';
import { RemoteAccessPage } from '@/components/sections/devices/RemoteAccessPage';
import { ProxyPage } from '@/components/sections/devices/ProxyPage';
import { WorkspacesPage } from '@/components/sections/devices/WorkspacesPage';
import { CodeIntelPage } from '@/components/sections/language-support/CodeIntelPage';
import { BrowserSettingsPage } from '@/components/sections/browsers/BrowserSettingsPage';
import { ExternalAgentsPage } from '@/components/sections/external-agents/ExternalAgentsPage';
import { HistorySettingsPage } from '@/components/sections/connections/SettingsUtilityPages';
import { StorageSettingsPage } from '@/components/sections/storage/StorageSettingsPage';
import { UsageSettingsPage } from '@/components/sections/usage/UsageSettingsPage';
import type { SurfaceActivationContext } from '@varin/extension-surface';
import { AgentMemoryPage } from '@/components/sections/assistant/AgentMemoryPage';
import { AgentPromptPage } from '@/components/sections/assistant/AgentPromptPage';
import { ExtensionsPage } from '@/components/sections/extensions/ExtensionsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
import { VarinSettingsPage } from '@/components/sections/varin/VarinSettingsPage';
import { CompanionSettings } from '@/components/sections/varin/CompanionSettings';
import type { VarinSettingsSection } from '@/components/sections/varin/types';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { ProjectsSidebar } from '@/components/sections/projects/ProjectsSidebar';
import { ModelRolesPage } from '@/components/sections/harness/ModelRolesPage';
import { ModelConnectionsPage } from '@/components/sections/providers/ModelConnectionsPage';
import { McpConnectionsPage } from '@/components/sections/mcp/McpConnectionsPage';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import {
  BUILTIN_SETTINGS_PAGE_SPECS,
  BUILTIN_SETTINGS_EXTENSION_ID,
  isBuiltinSettingsPageAvailable,
  type BuiltinSettingsPageSpec,
} from '@/lib/settings/builtin-page-metadata';
import type { SettingsPageImplementation } from '@/lib/settings/page-types';
import { BuiltinAboutSettingsPage } from './BuiltinAboutSettingsPage';

const PREFERENCE_PAGES: Partial<Record<VarinSettingsSection, () => React.ReactNode>> = {
  general: () => <GeneralPage />,
  visual: () => <AppearancePage />,
  chat: () => <ChatPage />,
  notifications: () => <NotificationsPage />,
  voice: () => <VoicePage />,
  shortcuts: () => <ShortcutsPage />,
  editor: () => <EditorPage />,
  terminal: () => <TerminalPage />,
};
const varinPage = (section: VarinSettingsSection): SettingsPageImplementation => ({
  renderContent: PREFERENCE_PAGES[section] ?? (() => <VarinSettingsPage section={section} />),
});

const implementationFor = (spec: BuiltinSettingsPageSpec): SettingsPageImplementation => {
  let implementation: SettingsPageImplementation | null = null;
  if (spec.renderer.startsWith('varin:')) {
    implementation = varinPage(spec.renderer.slice('varin:'.length) as VarinSettingsSection);
  } else {
    switch (spec.renderer) {
      case 'companion': implementation = { renderContent: () => <CompanionSettings /> }; break;
      case 'external-agents': implementation = { renderContent: () => <ExternalAgentsPage /> }; break;
      case 'history': implementation = { renderContent: () => <HistorySettingsPage /> }; break;
      case 'storage': implementation = { renderContent: () => <StorageSettingsPage /> }; break;
      case 'usage': implementation = { renderContent: () => <UsageSettingsPage /> }; break;
      case 'devices': implementation = { renderContent: () => <DevicesPage /> }; break;
      case 'remote-access': implementation = { renderContent: () => <RemoteAccessPage /> }; break;
      case 'proxy': implementation = { renderContent: () => <ProxyPage /> }; break;
      case 'workspaces': implementation = { renderContent: () => <WorkspacesPage /> }; break;
      case 'code-intel': implementation = { renderContent: () => <CodeIntelPage /> }; break;
      case 'browsers': implementation = { renderContent: () => <BrowserSettingsPage /> }; break;
      case 'agent-memory': implementation = { renderContent: () => <AgentMemoryPage /> }; break;
      case 'agent-prompt': implementation = { renderContent: () => <AgentPromptPage /> }; break;
      case 'empty': implementation = { renderContent: () => null }; break;
      case 'about': implementation = { renderContent: () => <BuiltinAboutSettingsPage /> }; break;
      case 'extensions': implementation = { renderContent: () => <ExtensionsPage /> }; break;
      case 'git': implementation = { renderContent: () => <GitPage /> }; break;
      case 'projects': implementation = { renderContent: () => <ProjectsPage />, renderSidebar: (options) => <ProjectsSidebar onItemSelect={options.onItemSelect} /> }; break;
      case 'model-roles': implementation = { renderContent: () => <ModelRolesPage /> }; break;
      case 'model-connections': implementation = { renderContent: () => <ModelConnectionsPage /> }; break;
      case 'mcp-connections': implementation = { renderContent: () => <McpConnectionsPage /> }; break;
      case 'skills': implementation = { renderContent: () => <SkillsPage /> }; break;
    }
  }
  if (!implementation) throw new Error(`Unknown built-in Settings renderer: ${spec.renderer}`);
  return spec.availability
    ? { ...implementation, isAvailable: (context) => isBuiltinSettingsPageAvailable(spec, context) }
    : implementation;
};

export const registerBuiltinSettingsContributions = (context: SurfaceActivationContext): void => {
  for (const spec of BUILTIN_SETTINGS_PAGE_SPECS) {
    context.contribute({
      id: `${BUILTIN_SETTINGS_EXTENSION_ID}.page.${spec.meta.slug}`,
      kind: 'settings-page',
      contractVersion: 1,
      supports: ['web', 'desktop', 'mobile'],
      placement: { slot: `settings.nav.${spec.meta.group}`, order: spec.meta.order },
      data: {
        slug: spec.meta.slug,
        title: spec.meta.title,
        titleKey: spec.meta.titleKey,
        group: spec.meta.group,
        kind: spec.meta.kind,
        icon: spec.meta.icon,
        order: spec.meta.order,
        ...(spec.meta.badgeKey ? { badgeKey: spec.meta.badgeKey } : {}),
        keywords: spec.meta.keywords ?? [],
      },
    }, implementationFor(spec));
  }
};
