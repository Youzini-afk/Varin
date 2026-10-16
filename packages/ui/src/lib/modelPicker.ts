import type { ChannelModel, ModelChannel } from '@varin/application-client';
import type { ModelPickerEntry, ModelPickerProvider } from '@/components/model-picker/ModelPickerList';

export const toModelPickerModel = (model: ChannelModel): ModelPickerEntry['model'] => ({
  capabilities: { attachment: model.input?.includes('image') ?? false, reasoning: model.reasoning === true, toolcall: true },
  id: model.id, input: model.input ?? ['text'], limit: { context: model.contextWindow, output: model.maxOutputTokens },
  name: model.name, requestModelId: model.requestModelId,
  variants: Object.fromEntries(Object.keys(model.thinkingLevelMap ?? {}).map(level => [level, {}])),
});
export const toModelPickerProvider = (channel: ModelChannel): ModelPickerProvider => ({
  id: channel.id, name: channel.name, logoId: channel.type,
  models: channel.enabled ? channel.models.filter(model => model.enabled && model.operations.includes('chat')).map(toModelPickerModel) : [],
});
