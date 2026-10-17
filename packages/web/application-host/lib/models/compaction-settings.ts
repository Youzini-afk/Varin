import { ModelConfigurationError, object } from './configuration.js';
import type { CompactionBudgetSettings, CompactionSettings } from '@varin/protocol';
const invalid = (field: string): never => { throw new ModelConfigurationError('invalid_settings', `${field} must be a non-negative safe integer`); };
function budgetSettings(value: Record<string, unknown>, label: string): CompactionBudgetSettings {
  const result: CompactionBudgetSettings = {};
  if ('reserveTokens' in value) {
    throw new ModelConfigurationError('invalid_settings', `${label}.reserveTokens is no longer supported; use reserveRatio (0 to less than 1)`);
  }
  const ratio = value.reserveRatio;
  if (ratio !== undefined) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio >= 1)
      throw new ModelConfigurationError('invalid_settings', `${label}.reserveRatio must be a number from 0 to less than 1`);
    result.reserveRatio = ratio;
  }
  const tokens = value.keepRecentTokens;
  if (tokens !== undefined) {
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) invalid(`${label}.keepRecentTokens`);
    result.keepRecentTokens = tokens as number;
  }
  return result;
}
export function parseCompactionSettings(value: unknown): CompactionSettings {
  if (value === undefined) return {};
  if (!object(value)) throw new ModelConfigurationError('invalid_settings', 'compaction must be an object');
  const result: CompactionSettings = budgetSettings(value, 'compaction');
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new ModelConfigurationError('invalid_settings', 'compaction.enabled must be boolean');
    result.enabled = value.enabled;
  }
  if (value.modelOverrides !== undefined) {
    if (!object(value.modelOverrides)) throw new ModelConfigurationError('invalid_settings', 'compaction.modelOverrides must be an object');
    result.modelOverrides = {};
    for (const [key, settings] of Object.entries(value.modelOverrides)) {
      if (!key || !object(settings)) throw new ModelConfigurationError('invalid_settings', 'compaction model override must be an object');
      result.modelOverrides[key] = budgetSettings(settings, `compaction.modelOverrides.${key}`);
    }
  }
  return result;
}
