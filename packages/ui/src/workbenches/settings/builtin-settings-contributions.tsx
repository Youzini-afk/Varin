import type { SurfaceActivationContext } from '@varin/extension-surface';
import { AgentMemoryPage } from '@/components/sections/assistant/AgentMemoryPage';
import { AgentPromptPage } from '@/components/sections/assistant/AgentPromptPage';
import { CommandsPage } from '@/components/sections/commands/CommandsPage';
import { ExtensionsPage } from '@/components/sections/extensions/ExtensionsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
import { LanguageSupportPage } from '@/components/sections/language-support/LanguageSupportPage';
import { VarinSettingsPage } from '@/components/sections/varin/VarinSettingsPage';
import type { VarinSettingsSection } from '@/components/sections/varin/types';
import { PluginsPage } from '@/components/sections/plugins';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { ProjectsSidebar } from '@/components/sections/projects/ProjectsSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { PiRuntimeSettingsPage } from '@/components/sections/runtime/PiRuntimeSettingsPage';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import {
  BUILTIN_SETTINGS_PAGE_SPECS,
  BUILTIN_SETTINGS_EXTENSION_ID,
  isBuiltinSettingsPageAvailable,
  type BuiltinSettingsPageSpec,
} from '@/lib/settings/builtin-page-metadata';
import type { SettingsPageImplementation } from '@/lib/settings/page-types';
import { BuiltinAboutSettingsPage } from './BuiltinAboutSettingsPage';

const varinPage = (section: VarinSettingsSection): SettingsPageImplementation => ({
  renderContent: () => <VarinSettingsPage section={section} />,
});

const implementationFor = (spec: BuiltinSettingsPageSpec): SettingsPageImplementation => {
  let implementation: SettingsPageImplementation | null = null;
  if (spec.renderer.startsWith('varin:')) {
    implementation = varinPage(spec.renderer.slice('varin:'.length) as VarinSettingsSection);
  } else {
    switch (spec.renderer) {
      case 'agent-memory': implementation = { renderContent: () => <AgentMemoryPage /> }; break;
      case 'agent-prompt': implementation = { renderContent: () => <AgentPromptPage /> }; break;
      case 'empty': implementation = { renderContent: () => null }; break;
      case 'about': implementation = { renderContent: () => <BuiltinAboutSettingsPage /> }; break;
      case 'commands': implementation = { renderContent: () => <CommandsPage /> }; break;
      case 'extensions': implementation = { renderContent: () => <ExtensionsPage /> }; break;
      case 'git': implementation = { renderContent: () => <GitPage /> }; break;
      case 'language-support': implementation = { renderContent: () => <LanguageSupportPage /> }; break;
      case 'plugins': implementation = { renderContent: () => <PluginsPage /> }; break;
      case 'projects': implementation = { renderContent: () => <ProjectsPage />, renderSidebar: (options) => <ProjectsSidebar onItemSelect={options.onItemSelect} /> }; break;
      case 'providers': implementation = { renderContent: () => <ProvidersPage />, renderSidebar: (options) => <ProvidersSidebar onItemSelect={options.onItemSelect} /> }; break;
      case 'remote-instances': implementation = { renderContent: () => <RemoteInstancesPage /> }; break;
      case 'runtime': implementation = { renderContent: () => <PiRuntimeSettingsPage /> }; break;
      case 'skills': implementation = { renderContent: () => <SkillsPage />, renderSidebar: (options) => <SkillsSidebar onItemSelect={options.onItemSelect} /> }; break;
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
