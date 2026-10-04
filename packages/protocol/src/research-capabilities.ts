import type { HarnessModelRole, ModelSelection } from './harness-settings.js';
import { resolveHarnessModelSlot, type HarnessModelBinding } from './harness-model-slots.js';
import { customizeHarnessAgent, type HarnessAgentModelSettings } from './harness-agents.js';

/** Research capabilities are routing identities, not permanent agent personas. */
export type ResearchCapability =
  | 'investigation'
  | 'experimental-design'
  | 'fast-exploration'
  | 'high-throughput-execution';

export const RESEARCH_CAPABILITIES: readonly ResearchCapability[] = [
  'investigation',
  'experimental-design',
  'fast-exploration',
  'high-throughput-execution',
];

export interface ResearchResourceManifest {
  cpu?: boolean;
  gpu?: boolean;
  network?: boolean;
  longRunning?: boolean;
}

export interface ThreadResearchManifest {
  capability: ResearchCapability;
  resources: ResearchResourceManifest;
}

export interface ResearchCapabilityDefinition {
  capability: ResearchCapability;
  slot: HarnessModelRole;
  tools: string[];
  worktree: 'none' | 'isolated';
  systemPromptFragment: string;
  defaultResources: ResearchResourceManifest;
  name?: string;
  description?: string;
  modelSettings?: HarnessAgentModelSettings;
}

export interface ResolvedResearchCapability {
  capability: ResearchCapability;
  model: ModelSelection;
  definition: ResearchCapabilityDefinition;
}

export const RESEARCH_CAPABILITY_DEFINITIONS: Readonly<Record<ResearchCapability, ResearchCapabilityDefinition>> = {
  investigation: {
    capability: 'investigation',
    slot: 'researchInvestigation',
    tools: ['read', 'grep', 'find', 'ls', 'explore', 'related', 'recall', 'webfetch', 'document_read', 'websearch', 'research_search', 'dispatch', 'threads', 'wait', 'send', 'read_thread', 'resources', 'research_source'],
    worktree: 'none',
    systemPromptFragment: 'Research capability: investigation.',
    defaultResources: { network: true },
  },
  'experimental-design': {
    capability: 'experimental-design',
    slot: 'researchExperimentalDesign',
    tools: ['read', 'grep', 'find', 'ls', 'explore', 'related', 'recall', 'dispatch', 'threads', 'wait', 'send', 'read_thread', 'resources', 'research_source'],
    worktree: 'none',
    systemPromptFragment: 'Research capability: experimental design.',
    defaultResources: { cpu: true },
  },
  'fast-exploration': {
    capability: 'fast-exploration',
    slot: 'researchFastExploration',
    tools: ['read', 'grep', 'find', 'ls', 'explore', 'related', 'recall', 'threads', 'wait', 'send', 'read_thread', 'resources', 'research_source'],
    worktree: 'none',
    systemPromptFragment: 'Research capability: exploration.',
    defaultResources: { cpu: true },
  },
  'high-throughput-execution': {
    capability: 'high-throughput-execution',
    slot: 'researchHighThroughputExecution',
    tools: ['read', 'edit', 'write', 'apply_patch', 'bash', 'grep', 'find', 'ls', 'get_output', 'write_to_process', 'kill_shell', 'threads', 'wait', 'send', 'read_thread', 'experiment', 'resources', 'research_source'],
    worktree: 'isolated',
    systemPromptFragment: 'Research capability: batch execution.',
    defaultResources: { cpu: true, longRunning: true },
  },
};

export const isResearchCapability = (value: unknown): value is ResearchCapability => (
  typeof value === 'string' && RESEARCH_CAPABILITIES.includes(value as ResearchCapability)
);

export const resolveResearchCapabilities = (
  slots: Partial<Record<HarnessModelRole, HarnessModelBinding | null>>,
): ResolvedResearchCapability[] => RESEARCH_CAPABILITIES.flatMap((capability) => {
  const base = RESEARCH_CAPABILITY_DEFINITIONS[capability];
  const definition = customizeHarnessAgent(base, slots[base.slot]?.agent);
  const model = resolveHarnessModelSlot(definition.slot, slots, null);
  return model ? [{ capability, model, definition }] : [];
});
