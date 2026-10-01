import {
  PROVIDER_INFERENCE_CAPABILITIES,
  PROVIDER_INFERENCE_PROTOCOLS,
  type ProviderInferenceCapability,
  type ThinkingLevel,
  type DiscoverableProviderApi,
  type ProviderConfigInput,
  type ProviderConfigScope,
  type ProviderModelConfigInput,
} from '@varin/protocol';

type ApiKeyInputLike = { value?: string | null } | null | undefined;

export interface CustomProviderModelRowInput extends ProviderModelConfigInput {
  context?: string | number;
  output?: string | number;
}

export interface CustomProviderEditableModel {
  api?: string;
  attachment: boolean;
  baseUrl?: string;
  context: string;
  cost?: ProviderModelConfigInput['cost'];
  id: string;
  name: string;
  output: string;
  reasoning: boolean;
  thinkingLevelMap?: ProviderModelConfigInput['thinkingLevelMap'];
}

export interface CustomProviderEditableFormState {
  api: string;
  apiKey: string;
  authHeader?: boolean;
  baseURL: string;
  id: string;
  models: CustomProviderEditableModel[];
  modelsDefined: boolean;
  name: string;
  scope: ProviderConfigScope;
  chatEnabled: boolean;
  chatDefined: boolean;
  inference: Record<ProviderInferenceCapability, CustomProviderInferenceForm>;
}

export interface CustomProviderInferenceForm {
  enabled: boolean;
  disabled: boolean;
  baseURL: string;
  endpoint: string;
  credentialRef: string;
  models: CustomProviderEditableModel[];
}

export const createEmptyInferenceForm = (): CustomProviderInferenceForm => ({
  enabled: false, disabled: false, baseURL: '', endpoint: '', credentialRef: '', models: [],
});

const inferenceFormsFromConfig = (config?: ProviderConfigInput['capabilities']): CustomProviderEditableFormState['inference'] =>
  Object.fromEntries(PROVIDER_INFERENCE_CAPABILITIES.map(kind => {
    const capability = config?.[kind];
    return [kind, { ...createEmptyInferenceForm(), enabled: Boolean(capability) && capability?.enabled !== false, disabled: capability?.enabled === false,
      baseURL: capability?.baseUrl ?? '', endpoint: capability?.endpoint ?? '', credentialRef: capability?.credentialRef ?? '',
      models: (capability?.models ?? []).map(toEditableModel) }];
  })) as CustomProviderEditableFormState['inference'];

export type CustomProviderConfigInput = ProviderConfigInput & {
  scope?: ProviderConfigScope;
};

export const COMMON_PROVIDER_APIS: DiscoverableProviderApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
];

const requiresExplicitThinkingLevelMapping = (level: ThinkingLevel): boolean => (
  level === 'xhigh' || level === 'max'
);

const compactThinkingLevelMap = (
  map: ProviderModelConfigInput['thinkingLevelMap'],
): ProviderModelConfigInput['thinkingLevelMap'] => (
  map && Object.keys(map).length > 0 ? map : undefined
);

/**
 * Pi exposes the five common levels by default, but only exposes xhigh/max when a model maps them.
 * A custom provider marked as reasoning-capable should therefore make the full Pi control surface
 * available unless the user has explicitly disabled a level with `null`.
 */
export const ensureExtendedThinkingLevels = (
  map: ProviderModelConfigInput['thinkingLevelMap'],
): ProviderModelConfigInput['thinkingLevelMap'] => {
  const next = { ...(map ?? {}) };
  if (next.xhigh === undefined) next.xhigh = 'xhigh';
  if (next.max === undefined) next.max = 'max';
  return next;
};

export const isCustomProviderThinkingLevelEnabled = (
  map: ProviderModelConfigInput['thinkingLevelMap'],
  level: ThinkingLevel,
): boolean => map?.[level] !== null;

export const setCustomProviderThinkingLevelEnabled = (
  map: ProviderModelConfigInput['thinkingLevelMap'],
  level: ThinkingLevel,
  enabled: boolean,
): ProviderModelConfigInput['thinkingLevelMap'] => {
  const next = { ...(map ?? {}) };
  if (!enabled) {
    next[level] = null;
    return next;
  }

  if (next[level] === null) {
    if (requiresExplicitThinkingLevelMapping(level)) {
      next[level] = level;
    } else {
      delete next[level];
    }
  } else if (next[level] === undefined && requiresExplicitThinkingLevelMapping(level)) {
    next[level] = level;
  }
  return compactThinkingLevelMap(next);
};

/** Maps a fixed Pi level to an arbitrary provider-native effort string. */
export const setCustomProviderThinkingLevelMapping = (
  map: ProviderModelConfigInput['thinkingLevelMap'],
  level: ThinkingLevel,
  providerValue: string,
): ProviderModelConfigInput['thinkingLevelMap'] => {
  const value = providerValue.trim();
  const next = { ...(map ?? {}) };
  if (value) {
    next[level] = value;
  } else if (requiresExplicitThinkingLevelMapping(level)) {
    next[level] = level;
  } else {
    delete next[level];
  }
  return compactThinkingLevelMap(next);
};

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  const text = trimString(value).replace(/,/g, '');
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const inputNumber = (value: unknown): string => {
  const number = positiveInteger(value);
  return number === undefined ? '' : String(number);
};

export const createEmptyCustomProviderModel = (): CustomProviderEditableModel => ({
  attachment: false,
  context: '',
  id: '',
  name: '',
  output: '',
  reasoning: false,
});

export const createEmptyCustomProviderState = (): CustomProviderEditableFormState => ({
  api: 'openai-completions',
  apiKey: '',
  authHeader: true,
  baseURL: '',
  id: '',
  models: [createEmptyCustomProviderModel()],
  modelsDefined: true,
  name: '',
  scope: 'user',
  chatEnabled: true,
  chatDefined: false,
  inference: inferenceFormsFromConfig(),
});

export const resolveCustomProviderApiKey = (
  controlledValue: string,
  inputElement?: ApiKeyInputLike,
): string => trimString(controlledValue) || trimString(inputElement?.value);

const toEditableModel = (model: CustomProviderModelRowInput): CustomProviderEditableModel => ({
  ...(model.api ? { api: model.api } : {}),
  attachment: model.input?.includes('image') === true,
  ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
  context: inputNumber(model.contextWindow ?? model.context),
  ...(model.cost ? { cost: model.cost } : {}),
  id: trimString(model.id),
  name: trimString(model.name),
  output: inputNumber(model.maxTokens ?? model.output),
  reasoning: model.reasoning === true,
  ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
});

export const normalizeCustomProviderModelRows = (
  rows: CustomProviderEditableModel[],
): ProviderModelConfigInput[] => rows.flatMap((row) => {
  const id = trimString(row.id);
  if (!id) return [];
  const name = trimString(row.name);
  const api = trimString(row.api);
  const baseUrl = trimString(row.baseUrl);
  const contextWindow = positiveInteger(row.context);
  const maxTokens = positiveInteger(row.output);
  const thinkingLevelMap = row.reasoning
    ? ensureExtendedThinkingLevels(row.thinkingLevelMap)
    : row.thinkingLevelMap;
  return [{
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(row.cost === undefined ? {} : { cost: row.cost }),
    id,
    input: row.attachment ? ['text', 'image'] : ['text'],
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(name ? { name } : {}),
    reasoning: row.reasoning,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
  }];
});

export const mergeCustomProviderModelRows = (
  existingRows: CustomProviderEditableModel[],
  importedRows: CustomProviderModelRowInput[],
): CustomProviderEditableModel[] => {
  const rows = existingRows
    .filter((row) => row.id.trim() || row.name.trim() || row.context.trim() || row.output.trim())
    .map((row) => ({ ...row }));
  const indexes = new Map(rows.map((row, index) => [row.id.trim(), index] as const));

  for (const imported of importedRows) {
    const normalized = toEditableModel(imported);
    if (!normalized.id) continue;
    const index = indexes.get(normalized.id);
    if (index === undefined) {
      indexes.set(normalized.id, rows.length);
      rows.push(normalized);
      continue;
    }
    const existing = rows[index];
    if (!existing) continue;
    rows[index] = {
      ...existing,
      ...normalized,
      name: normalized.name || existing.name,
      context: normalized.context || existing.context,
      output: normalized.output || existing.output,
    };
  }

  return rows.length > 0 ? rows : [createEmptyCustomProviderModel()];
};

export const createCustomProviderFormStateFromConfig = (
  config: CustomProviderConfigInput,
): CustomProviderEditableFormState => {
  const models = (config.models ?? []).map(toEditableModel).filter((model) => model.id);
  return {
    api: trimString(config.api),
    apiKey: '',
    ...(config.authHeader === undefined ? {} : { authHeader: config.authHeader }),
    baseURL: trimString(config.baseUrl),
    id: trimString(config.id),
    models: models.length > 0 ? models : [createEmptyCustomProviderModel()],
    modelsDefined: config.models !== undefined,
    name: trimString(config.name),
    scope: config.scope ?? 'user',
    chatEnabled: config.capabilities?.chat !== false,
    chatDefined: config.capabilities?.chat !== undefined,
    inference: inferenceFormsFromConfig(config.capabilities),
  };
};

export const createPiProviderConfigFromForm = (
  state: CustomProviderEditableFormState,
): ProviderConfigInput => {
  const api = state.api.trim();
  const baseUrl = state.baseURL.trim();
  const name = state.name.trim();
  const chatModels = normalizeCustomProviderModelRows(state.models);
  const capabilities: NonNullable<ProviderConfigInput['capabilities']> = {
    ...(state.chatDefined || !state.chatEnabled ? { chat: state.chatEnabled } : {}),
  };
  for (const kind of PROVIDER_INFERENCE_CAPABILITIES) {
    const capability = state.inference[kind];
    if (capability.enabled || capability.disabled) capabilities[kind] = {
      protocol: PROVIDER_INFERENCE_PROTOCOLS[kind],
      ...(!capability.enabled ? { enabled: false } : {}),
      ...(capability.baseURL.trim() ? { baseUrl: capability.baseURL.trim() } : {}),
      ...(capability.endpoint.trim() ? { endpoint: capability.endpoint.trim() } : {}),
      ...(capability.credentialRef.trim() ? { credentialRef: capability.credentialRef.trim() } : {}),
      models: normalizeCustomProviderModelRows(capability.models),
    };
  }
  return {
    ...((state.chatEnabled || chatModels.length > 0) && api ? { api } : {}),
    ...(state.authHeader === undefined ? {} : { authHeader: state.authHeader }),
    ...(baseUrl ? { baseUrl } : {}),
    id: state.id.trim(),
    ...(state.modelsDefined || !state.chatEnabled ? { models: chatModels } : {}),
    ...(name ? { name } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
};
