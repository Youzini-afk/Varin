import type { ThreadModel, ThreadModelInfo } from './threads.js';

/** `models` is the Host's enabled chat-model catalog, in its configured order. */
export function defaultConversationModel(defaults: Record<string, unknown>, models: readonly ThreadModelInfo[]): ThreadModel | null {
  const configured = models.find(model => model.providerId === defaults.defaultProvider && model.modelId === defaults.defaultModel);
  const model = configured ?? models.find(model => model.providerId === defaults.defaultProvider) ?? models[0];
  if (!model) return null;
  const levels = model.thinkingLevels?.length ? model.thinkingLevels : ['off'] as const;
  const thinkingLevel = levels.find(level => level === defaults.defaultThinkingLevel) ?? levels[0];
  return { providerId: model.providerId, modelId: model.modelId, thinkingLevel };
}
