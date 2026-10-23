/* eslint-disable react-refresh/only-export-components */
import {
  VARIN_BUILTIN_AGENTS_EXTENSION,
  VARIN_BUILTIN_EXTENSION_DEFINITIONS,
  VARIN_BUILTIN_HARNESS_EXTENSION,
  type VarinBuiltinExtensionDefinition,
} from '@varin/extension-builtins';
import {
  type VarinApplicationSurface,
} from '@varin/extension-contract';
import type { SurfaceActivation, SurfaceActivationContext } from '@varin/extension-surface';
import { AgentsPage } from '@/components/sections/agents/AgentsPage';
import { AgentsSidebar } from '@/components/sections/agents/AgentsSidebar';
import {
  HarnessSettingsPage,
  type HarnessSettingsSection,
} from '@/components/sections/harness/HarnessSettingsPage';
import { BuiltinWorkbenchTransitionScene } from '@/components/ui/BuiltinWorkbenchTransitionScene';
import type { SettingsPageImplementation } from '@/lib/settings/page-types';
import { resolveWorkbenchShellComponent } from './shell-component-registry';
import {
  WorkbenchOwnedView,
  WORKBENCH_REPLACEMENT_TARGETS,
} from './workbench-registry';

const HARNESS_SECTION_BY_SLUG: Record<string, HarnessSettingsSection> = {
  'harness-tools': 'tools',
  'harness-permissions': 'permissions',
  'harness-context': 'context',
  'harness-retrieval': 'retrieval',
  'harness-embeddings': 'embeddings',
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
        renderSidebar: options => <WorkbenchOwnedView target={WORKBENCH_REPLACEMENT_TARGETS.agents} region="sidebar"
          onItemSelect={options.onItemSelect} fallback={<AgentsSidebar onItemSelect={options.onItemSelect} />} />,
      };
    case VARIN_BUILTIN_HARNESS_EXTENSION.manifest.id: {
      const contribution = definition.manifest.contributions?.find((item) => item.id === contributionId);
      const slug = typeof contribution?.data.slug === 'string' ? contribution.data.slug : '';
      const section = HARNESS_SECTION_BY_SLUG[slug];
      if (!section) throw new Error(`Unknown Agent Harness settings page: ${contributionId}`);
      return { renderContent: () => <HarnessSettingsPage section={section} /> };
    }
    default:
      throw new Error(`Built-in extension does not own a settings page: ${definition.manifest.id}`);
  }
};

const contributionImplementation = (
  definition: VarinBuiltinExtensionDefinition,
  contributionId: string,
): unknown => {
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
  throw new Error(`Built-in extension contribution has no linked implementation: ${contributionId}`);
};

export const activateBuiltinSurfaceExtension = (
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

export const BUILTIN_SURFACE_EXTENSION_DEFINITIONS = VARIN_BUILTIN_EXTENSION_DEFINITIONS;
