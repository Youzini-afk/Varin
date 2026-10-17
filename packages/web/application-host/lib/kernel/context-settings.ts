/** Context policy derives from the same native settings snapshot used by model and resource configuration. */
import { createHash } from 'node:crypto';
import { DEFAULT_COMPACTION_RESERVE_RATIO, mergeHarnessSettings, type HarnessSettingsInput } from '@varin/protocol';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import { parseCompactionSettings } from '../models/compaction-settings.js';

export interface ContextPolicySnapshot {
  configurationIdentity: string;
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  explicitKeepRecentTokens: number | null;
  backgroundPreparation: boolean;
  preparationWaterline: number;
}
export function readContextPolicy(input: { settings: AgentSettingsSnapshot; projectRoot?: string; providerId?: string; modelId: string; contextWindowTokens: number | null }): ContextPolicySnapshot {
  const { settings } = input;
  const global = settings.global;
  const project = settings.projectTrusted ? settings.project : {};
  const user = parseCompactionSettings(global.compaction);
  const local = parseCompactionSettings(project.compaction);
  const modelKey = input.providerId ? `${input.providerId}/${input.modelId}` : undefined;
  const ordinary = { ...user, ...local };
  const override = modelKey ? { ...user.modelOverrides?.[modelKey], ...local.modelOverrides?.[modelKey] } : {};
  const harness = mergeHarnessSettings((global.harness ?? {}) as HarnessSettingsInput, (project.harness ?? {}) as HarnessSettingsInput);
  const explicitKeep = override.keepRecentTokens ?? ordinary.keepRecentTokens;
  const reserveRatio = override.reserveRatio ?? ordinary.reserveRatio ?? DEFAULT_COMPACTION_RESERVE_RATIO;
  const policy = {
    enabled: ordinary.enabled ?? true,
    reserveTokens: Math.ceil((input.contextWindowTokens ?? 0) * reserveRatio),
    keepRecentTokens: explicitKeep ?? 20000,
    explicitKeepRecentTokens: explicitKeep ?? null,
    backgroundPreparation: harness.context.backgroundPreparation,
    preparationWaterline: harness.context.preparationWaterline,
  };
  return { ...policy, configurationIdentity: createHash('sha256').update(JSON.stringify([
    settings.globalRevision, settings.projectTrusted ? settings.projectRevision : 'unselected',
    settings.projectTrusted ? input.projectRoot ?? null : null, modelKey ?? null, input.contextWindowTokens, reserveRatio, policy,
  ])).digest('hex') };
}
