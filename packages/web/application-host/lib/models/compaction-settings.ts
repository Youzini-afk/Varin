import { ModelConfigurationError, object } from './configuration.js';
export interface CompactionTokenSettings { reserveTokens?: number; keepRecentTokens?: number }
export interface CompactionSettings extends CompactionTokenSettings { enabled?: boolean; modelOverrides?: Record<string, CompactionTokenSettings> }
const invalid = (field: string): never => { throw new ModelConfigurationError('invalid_settings', `${field} must be a non-negative safe integer`); };
function tokenSettings(value: Record<string, unknown>, label: string): CompactionTokenSettings {
  const result: CompactionTokenSettings = {};
  for (const key of ['reserveTokens', 'keepRecentTokens'] as const) {
    const tokens = value[key];
    if (tokens === undefined) continue;
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) invalid(`${label}.${key}`);
    result[key] = tokens as number;
  }
  return result;
}
export function parseCompactionSettings(value: unknown): CompactionSettings {
  if (value === undefined) return {};
  if (!object(value)) throw new ModelConfigurationError('invalid_settings', 'compaction must be an object');
  const result: CompactionSettings = tokenSettings(value, 'compaction');
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new ModelConfigurationError('invalid_settings', 'compaction.enabled must be boolean');
    result.enabled = value.enabled;
  }
  if (value.modelOverrides !== undefined) {
    if (!object(value.modelOverrides)) throw new ModelConfigurationError('invalid_settings', 'compaction.modelOverrides must be an object');
    result.modelOverrides = {};
    for (const [key, settings] of Object.entries(value.modelOverrides)) {
      if (!key || !object(settings)) throw new ModelConfigurationError('invalid_settings', 'compaction model override must be an object');
      result.modelOverrides[key] = tokenSettings(settings, `compaction.modelOverrides.${key}`);
    }
  }
  return result;
}
