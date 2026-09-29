/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import {
  VARIN_BUILTIN_AGENTS_EXTENSION,
  VARIN_BUILTIN_EXTENSION_DEFINITIONS,
  VARIN_BUILTIN_FLEET_EXTENSION,
  VARIN_BUILTIN_HARNESS_EXTENSION,
  VARIN_BUILTIN_MCP_EXTENSION,
  VARIN_BUILTIN_PLUGIN_SETTINGS_EXTENSION,
  VARIN_BUILTIN_RECOVERY_EXTENSION,
  type VarinBuiltinExtensionDefinition,
} from '@varin/extension-builtins';
import {
  type VarinApplicationSurface,
} from '@varin/extension-contract';
import type { SurfaceActivation, SurfaceActivationContext } from '@varin/extension-surface';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { AgentsSidebar } from '@/components/sections/agents/AgentsSidebar';
import { FleetPage } from '@/components/sections/fleet';
import {
  HarnessSettingsPage,
  type HarnessSettingsSection,
} from '@/components/sections/harness/HarnessSettingsPage';
import { McpPage } from '@/components/sections/mcp/McpPage';
import { McpSidebar } from '@/components/sections/mcp/McpSidebar';
import { RecoverySettings } from '@/components/sections/varin/RecoverySettings';
import { PluginSettingsPage, PluginSettingsSidebar } from '@/components/sections/plugin-settings';
import { ContextModeSettings } from '@/components/sections/plugin-settings/ContextModeSettings';
import { AftSettings } from '@/components/sections/plugin-settings/AftSettings';
import { HermesMemorySettings } from '@/components/sections/plugin-settings/HermesMemorySettings';
import { MagicContextSettings } from '@/components/sections/plugin-settings/MagicContextSettings';
import { ObservationalMemorySettings } from '@/components/sections/plugin-settings/ObservationalMemorySettings';
import { OpenAICodexCompatSettings } from '@/components/sections/plugin-settings/OpenAICodexCompatSettings';
import { PiLensSettings } from '@/components/sections/plugin-settings/PiLensSettings';
import { RtkSettings } from '@/components/sections/plugin-settings/RtkSettings';
import { SubagentsSettings } from '@/components/sections/plugin-settings/SubagentsSettings';
import { WebAccessSettings } from '@/components/sections/plugin-settings/WebAccessSettings';
import { Button } from '@/components/ui/button';
import { BuiltinWorkbenchTransitionScene } from '@/components/ui/BuiltinWorkbenchTransitionScene';
import { useI18n } from '@/lib/i18n';
import type { SettingsPageImplementation } from '@/lib/settings/page-types';
import { useUIStore } from '@/stores/useUIStore';
import type {
  PiPluginSettingsAdapterImplementation,
  PiPluginSettingsAdapterRenderProps,
  PiSettingsPanelImplementation,
} from './pi-integration-registry';
import { resolveWorkbenchShellComponent } from './shell-component-registry';
import {
  WorkbenchOwnedView,
  WORKBENCH_REPLACEMENT_TARGETS,
} from './workbench-registry';

const HARNESS_SECTION_BY_SLUG: Record<string, HarnessSettingsSection> = {
  'harness-tools': 'tools',
  'harness-permissions': 'permissions',
  'harness-models': 'models',
  'harness-context': 'context',
  'harness-retrieval': 'retrieval',
  'harness-index': 'index',
  'harness-web': 'web',
  'harness-computers': 'computers',
  'harness-bots': 'bots',
};

const pageImplementation = (
  definition: VarinBuiltinExtensionDefinition,
  contributionId: string,
): SettingsPageImplementation => {
  switch (definition.manifest.id) {
    case VARIN_BUILTIN_AGENTS_EXTENSION.manifest.id:
      return {
        renderContent: () => (
          <WorkbenchOwnedView
            target={WORKBENCH_REPLACEMENT_TARGETS.agents}
            region="content"
            fallback={<AgentsPage />}
          />
        ),
        renderSidebar: (options) => (
          <WorkbenchOwnedView
            target={WORKBENCH_REPLACEMENT_TARGETS.agents}
            region="sidebar"
            onItemSelect={options.onItemSelect}
            fallback={<AgentsSidebar onItemSelect={options.onItemSelect} />}
          />
        ),
      };
    case VARIN_BUILTIN_FLEET_EXTENSION.manifest.id:
      return { renderContent: () => <FleetPage /> };
    case VARIN_BUILTIN_MCP_EXTENSION.manifest.id:
      return {
        isAvailable: (context) => context.mcpInstalled,
        renderContent: () => (
          <WorkbenchOwnedView
            target={WORKBENCH_REPLACEMENT_TARGETS.mcp}
            region="content"
            fallback={<McpPage />}
          />
        ),
        renderSidebar: (options) => (
          <WorkbenchOwnedView
            target={WORKBENCH_REPLACEMENT_TARGETS.mcp}
            region="sidebar"
            onItemSelect={options.onItemSelect}
            fallback={<McpSidebar onItemSelect={options.onItemSelect} />}
          />
        ),
      };
    case VARIN_BUILTIN_PLUGIN_SETTINGS_EXTENSION.manifest.id:
      return {
        renderContent: () => <PluginSettingsPage />,
        renderSidebar: (options) => <PluginSettingsSidebar onItemSelect={options.onItemSelect} />,
      };
    case VARIN_BUILTIN_HARNESS_EXTENSION.manifest.id: {
      const contribution = definition.manifest.contributions?.find((item) => item.id === contributionId);
      const slug = typeof contribution?.data.slug === 'string' ? contribution.data.slug : '';
      const section = HARNESS_SECTION_BY_SLUG[slug];
      if (!section) throw new Error(`Unknown Agent Harness settings page: ${contributionId}`);
      return { renderContent: () => <HarnessSettingsPage section={section} /> };
    }
    default:
      throw new Error(`Built-in Pi integration does not own a settings page: ${definition.manifest.id}`);
  }
};

const McpPluginSettingsAdapter: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('mcp')}>
      {t('settings.varin.pluginSettings.mcp.open')}
    </Button>
  );
};

const adapterImplementation = (adapterId: string): PiPluginSettingsAdapterImplementation => ({
  render: (props: PiPluginSettingsAdapterRenderProps) => {
    switch (adapterId) {
      case 'mcp':
        return <McpPluginSettingsAdapter />;
      case 'subagents':
        return <SubagentsSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'magic-context':
        return (
          <MagicContextSettings
            initialPanel={props.navigationSection === 'agents' ? 'agents' : undefined}
            packageVersion={props.packageVersion}
            runtimeTarget={props.runtimeTarget}
            targetKey={props.targetKey}
          />
        );
      case 'web-access':
        return <WebAccessSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'openai-codex-compat':
        return <OpenAICodexCompatSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'observational-memory':
        return <ObservationalMemorySettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'context-mode':
        return <ContextModeSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'aft':
        return <AftSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'pi-lens':
        return <PiLensSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'hermes-memory':
        return <HermesMemorySettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      case 'rtk':
        return <RtkSettings runtimeTarget={props.runtimeTarget} targetKey={props.targetKey} />;
      default:
        throw new Error(`Unknown built-in Pi Plugin Settings adapter: ${adapterId}`);
    }
  },
});

const contributionImplementation = (
  definition: VarinBuiltinExtensionDefinition,
  contributionId: string,
): unknown => {
  if (definition.manifest.id === VARIN_BUILTIN_RECOVERY_EXTENSION.manifest.id) {
    return { render: () => <RecoverySettings /> } satisfies PiSettingsPanelImplementation;
  }
  const contribution = definition.manifest.contributions?.find((item) => item.id === contributionId);
  if (contribution?.kind === 'shell') {
    const Component = resolveWorkbenchShellComponent(definition.manifest.id);
    if (!Component) {
      throw new Error(`Built-in shell component not registered for extension: ${definition.manifest.id}`);
    }
    return { framework: 'react-19', Component };
  }
  if (contribution?.kind === 'transition-scene') {
    return { framework: 'react-19', Component: BuiltinWorkbenchTransitionScene };
  }
  if (contribution?.kind === 'settings-page') return pageImplementation(definition, contributionId);
  if (contribution?.kind === 'panel' && contribution.data.contract === 'pi-plugin-settings-adapter/v1') {
    return adapterImplementation(String(contribution.data.adapterId));
  }
  throw new Error(`Built-in Pi integration contribution has no linked implementation: ${contributionId}`);
};

export const activateBuiltinPiIntegration = (
  definition: VarinBuiltinExtensionDefinition,
  surface?: VarinApplicationSurface,
): SurfaceActivation => (context: SurfaceActivationContext) => {
  for (const contribution of definition.manifest.contributions ?? []) {
    if (surface && !contribution.supports.includes(surface)) continue;
    context.contribute(
      contribution,
      contributionImplementation(definition, contribution.id),
    );
  }
};

export const BUILTIN_PI_INTEGRATION_DEFINITIONS = VARIN_BUILTIN_EXTENSION_DEFINITIONS;
