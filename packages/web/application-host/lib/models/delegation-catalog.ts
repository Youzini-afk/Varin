import type { ChannelModel, ModelChannel, ModelPricing, ModelThinkingConfiguration, ThreadThinkingLevel } from '@varin/application-client';
import { resolveHarnessDelegationModelSelectionSettings, type HarnessDelegationModelSelectionSettings } from '@varin/protocol';
import { modelOptions, thinkingLevels } from '../kernel/model-options.js';
import type { SelectedModel } from '../kernel/model-authority.js';
import type { ModelsService } from './service.js';
import { frozenModelPricing } from './pricing.js';
import { ModelConfigurationError, revisionOf } from './configuration.js';

/** Safe selection facts. Never contains endpoint, headers, credential references or raw parameters. */
export interface DelegationModelCandidate {
  id: string;
  configurationFingerprint: string;
  providerId: string;
  modelId: string;
  name: string;
  channelName: string;
  description?: string;
  input: ('text' | 'image')[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  billing: 'metered' | 'subscription' | 'local';
  thinking?: ModelThinkingConfiguration;
  thinkingLevels: ThreadThinkingLevel[];
  defaultThinkingLevel: ThreadThinkingLevel;
}
export interface DelegationSelectorSnapshot {
  providerId: string;
  modelId: string;
  operation: 'chat' | 'decision';
  thinkingLevel?: ThreadThinkingLevel;
  configurationFingerprint: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}
export interface DelegationModelCatalog {
  candidates: DelegationModelCandidate[];
  selector: DelegationSelectorSnapshot | null;
}

/** Stable public reference to exactly one configured model/account, never a display-name match. */
export const delegationModelIdentity = (providerId: string, modelId: string): string => `model:${revisionOf([providerId, modelId])}`;

const outputCapacity = (model: SelectedModel) => model.api === 'openai-codex-responses' ? null
  : Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null;

/** Include effective native options: opaque Bedrock IDs can use the configured name as a protocol hint. */
function chatOptions(model: SelectedModel) {
  const levels = thinkingLevels(model), max = outputCapacity(model);
  const choices = levels.map(level => modelOptions(model, level, max));
  const defaultThinkingLevel = modelOptions(model, undefined, max).thinkingLevel as ThreadThinkingLevel;
  return { levels, choices, defaultThinkingLevel, max };
}

/** Only the hash escapes this trusted helper; presentation edits do not invalidate execution identity. */
export function delegationModelConfigurationFingerprint(models: ModelsService, channel: ModelChannel, model: ChannelModel, operation: 'chat' | 'decision'): string {
  const { name: _channelName, models: _models, ...connection } = channel;
  const { name: _modelName, description: _description, catalog: _catalog, ...configuration } = model;
  const type = models.types.get(channel.type);
  if (!type) throw new ModelConfigurationError('channel-type-unavailable', 'The configured channel type is unavailable');
  if (operation === 'decision') return revisionOf({ channel: connection, model: configuration,
    operation, api: model.decision?.api ?? channel.parameters.decisionApi ?? type.defaultParameters?.decisionApi ?? type.protocol });
  const selected = models.describeConfiguredModel(channel, model);
  const { name: _name, pricing: _pricing, ...effective } = selected;
  return revisionOf({ channel: connection, model: configuration, effective, operation, choices: chatOptions(selected).choices });
}

/** One local catalog/settings snapshot. It does not capture models, acquire credentials, fetch or prepare execution. */
export async function readDelegationModelCatalog(models: ModelsService, configured?: HarnessDelegationModelSelectionSettings, fixedModel?: string): Promise<DelegationModelCatalog> {
  const selection = resolveHarnessDelegationModelSelectionSettings(configured ?? (await models.settings.harness()).delegationModelSelection);
  const snapshot = await models.read();
  const candidates: DelegationModelCandidate[] = [];
  for (const channel of snapshot.channels) {
    if (!channel.enabled) continue;
    for (const model of channel.models) {
      if (!model.enabled || !model.operations.includes('chat')) continue;
      const id = delegationModelIdentity(channel.id, model.id);
      // Fixed identity is a hard eligibility constraint, applied before inspecting unrelated options.
      if (fixedModel !== undefined && fixedModel !== id) continue;
      const selected = models.describeConfiguredModel(channel, model);
      const options = chatOptions(selected);
      candidates.push({ id,
        configurationFingerprint: delegationModelConfigurationFingerprint(models, channel, model, 'chat'),
        providerId: channel.id, modelId: model.id, name: model.name, channelName: channel.name,
        ...(model.description === undefined ? {} : { description: model.description }), input: [...(model.input ?? ['text'])],
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(options.max === null ? {} : { maxOutputTokens: options.max }),
        ...(model.pricing === undefined ? {} : { pricing: structuredClone(model.pricing) }),
        ...(model.thinking === undefined ? {} : { thinking: structuredClone(model.thinking) }),
        billing: frozenModelPricing(channel, model).billing, thinkingLevels: options.levels, defaultThinkingLevel: options.defaultThinkingLevel });
    }
  }
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!selection.enabled) return { candidates, selector: null };
  const { providerId, modelId } = selection.model!;
  const channel = snapshot.channels.find(value => value.id === providerId);
  if (!channel?.enabled) throw new ModelConfigurationError('delegation-selector-channel-unavailable', 'The configured delegation selector channel is unavailable or disabled');
  const model = channel.models.find(value => value.id === modelId);
  if (!model?.enabled || !model.operations.some(operation => operation === 'chat' || operation === 'decision')) {
    throw new ModelConfigurationError('delegation-selector-model-unavailable', 'The configured delegation selector model is unavailable or does not support chat or decision requests');
  }
  const operation = model.operations.includes('decision') ? 'decision' : 'chat';
  if (operation === 'decision' && selection.thinkingLevel !== undefined) {
    throw new ModelConfigurationError('delegation-selector-thinking-unavailable', 'The configured decision selector does not expose chat thinking controls');
  }
  const selected = operation === 'chat' ? models.describeConfiguredModel(channel, model) : undefined;
  const max = selected ? outputCapacity(selected) : model.maxOutputTokens;
  const thinkingLevel = selected ? modelOptions(selected, selection.thinkingLevel, max ?? null).thinkingLevel as ThreadThinkingLevel : undefined;
  return { candidates, selector: { providerId, modelId, operation,
    configurationFingerprint: delegationModelConfigurationFingerprint(models, channel, model, operation),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(max == null ? {} : { maxOutputTokens: max }),
  } };
}
