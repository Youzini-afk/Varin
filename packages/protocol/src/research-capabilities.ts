import type { HarnessModelRole, ModelSelection } from './harness-settings.js';

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
    systemPromptFragment: 'Investigate competing explanations using source material and focused follow-up routes. Preserve conflicts and unknowns for the principal researcher.',
    defaultResources: { network: true },
  },
  'experimental-design': {
    capability: 'experimental-design',
    slot: 'researchExperimentalDesign',
    tools: ['read', 'grep', 'find', 'ls', 'explore', 'related', 'recall', 'dispatch', 'threads', 'wait', 'send', 'read_thread', 'resources', 'research_source'],
    worktree: 'none',
    systemPromptFragment: 'Design low-cost checks that distinguish the leading explanations. State inputs, expected observations, and what each result would change.',
    defaultResources: { cpu: true },
  },
  'fast-exploration': {
    capability: 'fast-exploration',
    slot: 'researchFastExploration',
    tools: ['read', 'grep', 'find', 'ls', 'explore', 'related', 'recall', 'threads', 'wait', 'send', 'read_thread', 'resources', 'research_source'],
    worktree: 'none',
    systemPromptFragment: 'Explore a bounded route quickly. Return concrete observations, useful negative results, and the next discriminating question.',
    defaultResources: { cpu: true },
  },
  'high-throughput-execution': {
    capability: 'high-throughput-execution',
    slot: 'researchHighThroughputExecution',
    tools: ['read', 'edit', 'write', 'apply_patch', 'bash', 'grep', 'find', 'ls', 'get_output', 'write_to_process', 'kill_shell', 'threads', 'wait', 'send', 'read_thread', 'experiment', 'resources', 'research_source'],
    worktree: 'isolated',
    systemPromptFragment: 'Run the requested implementation or batch check efficiently in the isolated working state. Separate code or environment failure from a scientific result.',
    defaultResources: { cpu: true, longRunning: true },
  },
};

export const isResearchCapability = (value: unknown): value is ResearchCapability => (
  typeof value === 'string' && RESEARCH_CAPABILITIES.includes(value as ResearchCapability)
);

export const resolveResearchCapabilities = (
  slots: Partial<Record<HarnessModelRole, ModelSelection | null>>,
): ResolvedResearchCapability[] => RESEARCH_CAPABILITIES.flatMap((capability) => {
  const definition = RESEARCH_CAPABILITY_DEFINITIONS[capability];
  const model = slots[definition.slot];
  return model ? [{ capability, model, definition }] : [];
});
