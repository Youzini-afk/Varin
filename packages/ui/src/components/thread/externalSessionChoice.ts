import type { ExternalAgentCapabilities, ExternalInput } from '@varin/application-client';

export type ExternalSessionChoice = Pick<ExternalInput, 'model' | 'thinking' | 'mode' | 'config'>;

/** Session effort options describe the current model, not an unconfigured future model. */
export function externalThinkingOptions(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities) {
  const modelOption = capabilities?.configOptions?.find(option => option.category === 'model');
  const currentModel = capabilities?.current?.model || (typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined);
  const selectedModel = choice.model || (modelOption ? choice.config?.[modelOption.id] : undefined) || currentModel;
  const levels = capabilities?.models.find(model => model.id === selectedModel)?.thinkingLevels;
  return { levels, hideSessionConfig: Boolean(selectedModel && selectedModel !== currentModel && !levels?.length) };
}

/** A model change must not carry an invisible effort override to a different model. */
export function externalModelChoice(choice: ExternalSessionChoice, model: string, capabilities?: ExternalAgentCapabilities): ExternalSessionChoice {
  const thinkingIds = new Set(capabilities?.configOptions?.filter(option => option.category === 'thought_level' || option.category === 'model').map(option => option.id));
  return { ...choice, model, thinking: undefined,
    config: Object.fromEntries(Object.entries(choice.config ?? {}).filter(([id]) => !thinkingIds.has(id))) };
}

/** Never send an effort override hidden by the current session/model's controls. */
export function externalSessionInput(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities): ExternalSessionChoice {
  const { levels, hideSessionConfig } = externalThinkingOptions(choice, capabilities);
  const hiddenConfig = new Set(capabilities?.configOptions?.filter(option =>
    option.category === 'model' && capabilities.models.length || option.category === 'thought_level' && (levels?.length || hideSessionConfig) || option.category === 'mode' && capabilities.modes?.length).map(option => option.id));
  const config = Object.fromEntries(Object.entries(choice.config ?? {}).filter(([id]) => !hiddenConfig.has(id)));
  return { ...(choice.model ? { model: choice.model } : {}),
    ...(choice.thinking && levels?.includes(choice.thinking) ? { thinking: choice.thinking } : {}),
    ...(choice.mode ? { mode: choice.mode } : {}),
    ...(Object.keys(config).length ? { config } : {}) };
}
