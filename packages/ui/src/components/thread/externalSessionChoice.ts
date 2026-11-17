import { CODEX_PERMISSION_PROFILE_OPTION, type ExternalAgentCapabilities, type ExternalInput } from '@varin/application-client';

export type ExternalSessionChoice = Pick<ExternalInput, 'model' | 'thinking' | 'mode' | 'config'>;

function externalPrimaryConfig(capabilities: ExternalAgentCapabilities | undefined, category: string) {
  return capabilities?.configOptions?.find(option => option.category === category && option.type !== 'boolean');
}

/** Session effort options describe the current model, not an unconfigured future model. */
export function externalThinkingOptions(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities) {
  const modelOption = externalPrimaryConfig(capabilities, 'model');
  const currentModel = capabilities?.current?.model || (typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined);
  const selectedModel = choice.model || (modelOption ? choice.config?.[modelOption.id] : undefined) || currentModel;
  const sessionOption = selectedModel === currentModel ? externalPrimaryConfig(capabilities, 'thought_level') : undefined;
  const levels = capabilities?.models.find(model => model.id === selectedModel)?.thinkingLevels ?? sessionOption?.options.map(option => option.value);
  const modelChanged = Boolean(selectedModel && selectedModel !== currentModel);
  return { levels, sessionOption, selectedModel, modelChanged, hideSessionConfig: Boolean(!capabilities?.modelsError && modelChanged && !levels?.length) };
}

function projectedConfigIds(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities) {
  const { levels, modelChanged, hideSessionConfig } = externalThinkingOptions(choice, capabilities);
  return new Set([
    capabilities?.models.length ? externalPrimaryConfig(capabilities, 'model')?.id : undefined,
    levels?.length || hideSessionConfig ? externalPrimaryConfig(capabilities, 'thought_level')?.id : undefined,
    capabilities?.modes?.length ? externalPrimaryConfig(capabilities, 'mode')?.id : undefined,
    ...(modelChanged ? (capabilities?.configOptions ?? []).filter(option => option.category === 'model_config').map(option => option.id) : []),
  ]);
}

export function externalGenericOptions(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities) {
  const projected = projectedConfigIds(choice, capabilities);
  const options = capabilities?.configOptions?.filter(option => !projected.has(option.id)) ?? [];
  // Keep an unavailable permission choice visible so it can be cleared explicitly.
  if (choice.config?.[CODEX_PERMISSION_PROFILE_OPTION] && !options.some(option => option.id === CODEX_PERMISSION_PROFILE_OPTION))
    options.push({ id: CODEX_PERMISSION_PROFILE_OPTION, name: 'Codex permissions', type: 'select', options: [] });
  return options;
}

/** A model change must not carry an invisible effort override to a different model. */
export function externalModelChoice(choice: ExternalSessionChoice, model: string, capabilities?: ExternalAgentCapabilities): ExternalSessionChoice {
  const modelId = externalPrimaryConfig(capabilities, 'model')?.id;
  const config = { ...choice.config };
  if (modelId) delete config[modelId];
  const next = { ...choice, model, config };
  const { levels, selectedModel } = externalThinkingOptions(next, capabilities);
  if (selectedModel === externalThinkingOptions(choice, capabilities).selectedModel) return next;
  for (const option of capabilities?.configOptions ?? [])
    if (option.category === 'model_config' || option.category === 'thought_level') delete config[option.id];
  return { ...next, thinking: next.thinking && levels?.includes(next.thinking) ? next.thinking : undefined };
}

/** Never send an effort override hidden by the current session/model's controls. */
export function externalSessionInput(choice: ExternalSessionChoice, capabilities?: ExternalAgentCapabilities): ExternalSessionChoice & Pick<ExternalInput, 'permissionProfile'> {
  const { levels } = externalThinkingOptions(choice, capabilities);
  const hiddenConfig = projectedConfigIds(choice, capabilities);
  const { [CODEX_PERMISSION_PROFILE_OPTION]: permissionProfile, ...remaining } = choice.config ?? {};
  const config = Object.fromEntries(Object.entries(remaining).filter(([id]) => !hiddenConfig.has(id)));
  return { ...(choice.model ? { model: choice.model } : {}),
    ...(choice.thinking && (levels?.includes(choice.thinking) || capabilities?.modelsError) ? { thinking: choice.thinking } : {}),
    ...(choice.mode ? { mode: choice.mode } : {}),
    ...(permissionProfile ? { permissionProfile } : {}),
    ...(Object.keys(config).length ? { config } : {}) };
}

/** Validate live negotiated values without discarding choices on a failed/unknown catalog. */
export function normalizeExternalSessionChoice(choice: ExternalSessionChoice, capabilities: ExternalAgentCapabilities): ExternalSessionChoice {
  let next = { ...choice };
  if (next.model && !capabilities.modelsError && !capabilities.models.some(model => model.id === next.model)) next = externalModelChoice(next, '', capabilities);
  if (next.mode && !capabilities.modes?.some(mode => mode.id === next.mode)) next.mode = undefined;
  const { levels, sessionOption, modelChanged, hideSessionConfig } = externalThinkingOptions(next, capabilities);
  const previousEffort = sessionOption && next.config?.[sessionOption.id];
  if (sessionOption && previousEffort && levels?.includes(previousEffort)) {
    next.thinking ??= previousEffort;
    next.config = { ...next.config };
    delete next.config[sessionOption.id];
  }
  if (next.thinking && !capabilities.modelsError && !levels?.includes(next.thinking)) next.thinking = undefined;
  if (next.config) {
    next.config = Object.fromEntries(Object.entries(next.config).filter(([id, value]) => {
      // An obsolete permission selection must not fall through to a broader current profile.
      if (id === CODEX_PERMISSION_PROFILE_OPTION) return true;
      const option = capabilities.configOptions?.find(item => item.id === id);
      return option && !(option.category === 'thought_level' && hideSessionConfig)
        && !(option.category === 'model_config' && modelChanged)
        && (option.type === 'boolean' ? value === 'true' || value === 'false' : option.options.some(item => item.value === value));
    }));
  }
  return next;
}
