import type {
  AgentRuntime,
  AgentToolsView,
  ChildCapabilityDescriptor,
  ContextAgentDefinition,
  HarnessAgentModelSettings,
  HarnessAgentOverrides,
  HarnessCustomAgent,
  HarnessModelBinding,
  HarnessModelRole,
  ModelSelection,
  WorkFocusId,
} from '@varin/protocol';

export type { AgentRuntime, AgentToolsView } from '@varin/protocol';

export type AgentProfileBinding = Omit<HarnessModelBinding, 'agent'> & {
  agent?: Omit<HarnessAgentOverrides, 'tools'>;
};
export type AgentProfileConfig =
  | { kind: 'builtin'; slot: HarnessModelRole; binding: AgentProfileBinding }
  | { kind: 'custom'; key: string; agent: Omit<HarnessCustomAgent, 'tools'> };

export interface AgentProfileDefaults {
  name: string;
  description: string;
  instructions: string;
  worktree: 'none' | 'shared' | 'isolated';
  tools: string[];
}

export interface AgentProfileView {
  id: string;
  kind: 'builtin' | 'custom';
  config: AgentProfileConfig;
  effective: {
    avatar?: import('@varin/protocol').AgentAvatarId;
    name: string;
    description: string;
    instructions: string;
    enabled: boolean;
    model: ModelSelection | null;
    modelSource: 'inherit' | 'selected' | 'unconfigured';
    modelSettings?: HarnessAgentModelSettings;
    worktree: 'none' | 'shared' | 'isolated';
    workFocus: WorkFocusId[];
  };
  tools: AgentToolsView;
  defaults: AgentProfileDefaults | null;
  /** Automatic context work has its own prompt contract and runtime-owned tools. */
  automation?: ContextAgentDefinition;
}

export interface AgentProfilesSnapshot {
  runtime: AgentRuntime;
  revision: string;
  profiles: AgentProfileView[];
  /** Null means capability observation is unavailable, not an empty directory. */
  capabilities: ChildCapabilityDescriptor[] | null;
}

export interface AgentProfileSaveRequest {
  runtime: AgentRuntime;
  expectedRevision: string;
  /** Omitted only for creation, which requires custom config and explicit tools. */
  id?: string;
  config: AgentProfileConfig;
  /** Omitted keeps the selection; [] disables all tools; null resets only this runtime. */
  tools?: string[] | null;
}

export interface AgentProfilesAPI {
  read(input: { runtime: AgentRuntime }, signal?: AbortSignal): Promise<AgentProfilesSnapshot>;
  save(input: AgentProfileSaveRequest, signal?: AbortSignal): Promise<{ snapshot: AgentProfilesSnapshot; profileId: string }>;
  remove(input: { runtime: AgentRuntime; expectedRevision: string; id: string }, signal?: AbortSignal): Promise<AgentProfilesSnapshot>;
}

/** The authenticated Host supplies a short, safe message with the owning failure code. */
export class AgentProfilesError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AgentProfilesError';
  }
}
