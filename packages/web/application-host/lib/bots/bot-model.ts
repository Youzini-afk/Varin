import type { BotModelSelection, ThreadModelInfo } from '@varin/application-client';

/** Resolve the profile once for foreground, background and existing Bot conversations. */
export function resolveBotModelSelection(profile: BotModelSelection | null, defaults: Record<string, unknown>, models: ThreadModelInfo[]): BotModelSelection | null {
  const selection = profile ?? (typeof defaults.defaultProvider === 'string' && typeof defaults.defaultModel === 'string'
    ? { providerId: defaults.defaultProvider, modelId: defaults.defaultModel } : null);
  if (!selection) return null;
  const model = models.find(candidate => candidate.providerId === selection.providerId && candidate.modelId === selection.modelId);
  if (!model) throw new Error('Bot model is no longer registered. Select an available Agent model in Bot settings.');
  const levels = model.thinkingLevels ?? ['off'];
  const requested = profile ? profile.thinkingLevel : defaults.defaultThinkingLevel;
  const thinkingLevel = requested ?? levels[0];
  if (!levels.some(level => level === thinkingLevel)) throw new Error('Bot thinking level is unavailable for the selected model. Update its thinking setting.');
  return { ...selection, thinkingLevel: thinkingLevel as NonNullable<BotModelSelection['thinkingLevel']> };
}

export function botModelMatches(configuration: { providerId?: string; model?: string; catalogModelId?: string; thinkingLevel?: string }, model: BotModelSelection): boolean {
  return configuration.providerId === model.providerId && (configuration.catalogModelId ?? configuration.model) === model.modelId
    && configuration.thinkingLevel === model.thinkingLevel;
}
