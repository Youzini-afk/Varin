import type { AgentProfileConfig, AgentProfileView, AgentRuntime, AgentProfileSaveRequest } from '@varin/application-client';
import type { AgentAvatarId, ThinkingLevel, WorkFocusId } from '@varin/protocol';

export interface AgentProfileDraft {
  externalAgent: string;
  externalModel: string;
  avatar: AgentAvatarId | '';
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  providerId: string;
  modelId: string;
  temperature: string;
  thinkingLevel: ThinkingLevel | 'inherit';
  tools: string;
  toolsChange: 'unchanged' | 'explicit' | 'reset';
  workFocus: WorkFocusId[];
}
export interface RetainedAgentProfileDraft { values: AgentProfileDraft; revision: string }
export const agentProfileDrafts = new Map<string, RetainedAgentProfileDraft>();

export function makeAgentProfileDraft(profile?: AgentProfileView, newTools: readonly string[] = []): AgentProfileDraft {
  const effective = profile?.effective;
  const external = profile?.config.kind === 'builtin' ? profile.config.binding.agent?.external : profile?.config.agent.external;
  return {
    externalAgent: external?.configurationId ?? '', externalModel: external?.model ?? '',
    avatar: effective?.avatar ?? '',
    name: effective?.name ?? '', description: effective?.description ?? '', instructions: effective?.instructions ?? '',
    enabled: effective?.enabled ?? true,
    providerId: effective?.model?.providerId ?? '', modelId: effective?.model?.modelId ?? '',
    temperature: effective?.modelSettings?.temperature === undefined ? '' : String(effective.modelSettings.temperature),
    thinkingLevel: effective?.modelSettings?.thinkingLevel ?? 'inherit',
    tools: (profile?.tools.names ?? newTools).join(', '), toolsChange: profile ? 'unchanged' : 'explicit',
    workFocus: effective?.workFocus ?? [],
  };
}

/** Serialize only the selected runtime's tool change; the Host owns persisted tool selection. */
export function agentProfileSaveRequest(runtime: AgentRuntime, revision: string, draft: AgentProfileDraft, profile?: AgentProfileView, defaultLabels?: { name: string; description: string }): AgentProfileSaveRequest {
  const model = draft.providerId && draft.modelId ? { providerId: draft.providerId, modelId: draft.modelId } : undefined;
  const modelSettings = {
    ...(draft.temperature.trim() ? { temperature: Number(draft.temperature) } : {}),
    ...(draft.thinkingLevel === 'inherit' ? {} : { thinkingLevel: draft.thinkingLevel }),
  };
  let config: AgentProfileConfig;
  const external = draft.externalAgent ? { configurationId: draft.externalAgent, ...(draft.externalModel.trim() ? { model: draft.externalModel.trim() } : {}) } : undefined;
  if (profile?.config.kind === 'builtin') {
    const defaults = profile.defaults ? { ...profile.defaults, ...defaultLabels } : null;
    const overrides = {
      ...(external ? { external } : {}),
      ...(draft.avatar ? { avatar: draft.avatar } : {}),
      ...(draft.name.trim() === defaults?.name ? {} : { name: draft.name.trim() }),
      ...(draft.description === defaults?.description ? {} : { description: draft.description }),
      ...(draft.instructions === defaults?.instructions ? {} : { instructions: draft.instructions }),
      ...(Object.keys(modelSettings).length ? { modelSettings } : {}),
    };
    config = { kind: 'builtin', slot: profile.config.slot, binding: {
      enabled: draft.enabled, ...model, ...(Object.keys(overrides).length ? { agent: overrides } : {}),
    } };
  } else {
    config = { kind: 'custom', key: profile?.config.kind === 'custom' ? profile.config.key : '', agent: {
      ...(external ? { external } : {}),
      name: draft.name.trim(), description: draft.description, instructions: draft.instructions, enabled: draft.enabled,
      ...(draft.avatar ? { avatar: draft.avatar } : {}),
      ...(model ? { model } : {}), ...(Object.keys(modelSettings).length ? { modelSettings } : {}),
      workFocus: draft.workFocus,
    } };
  }
  return { runtime, expectedRevision: revision, ...(profile ? { id: profile.id } : {}), config,
    ...(profile?.automation || draft.toolsChange === 'unchanged' ? {} : { tools: draft.toolsChange === 'reset' ? null
      : [...new Set(draft.tools.split(/[\n,]/u).map(tool => tool.trim()).filter(Boolean))] }),
  };
}
