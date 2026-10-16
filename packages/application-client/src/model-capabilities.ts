import { MODEL_THINKING_EFFORTS, type ThinkingLevel } from '@varin/protocol';
import type { ChannelModel, ModelThinkingConfiguration } from './model-connections.js';
export { MODEL_THINKING_EFFORTS } from '@varin/protocol';

export function modelThinkingConfiguration(model: Pick<ChannelModel, 'thinking' | 'thinkingLevelMap'>): ModelThinkingConfiguration {
  if (model.thinking) return model.thinking;
  const levels = MODEL_THINKING_EFFORTS.filter(level => typeof model.thinkingLevelMap?.[level] === 'string');
  return levels.length ? { mode: 'levels', levels, allowOff: typeof model.thinkingLevelMap?.off === 'string' } : { mode: 'fixed' };
}

/** The settings preview and execution picker expose the same declared choices. */
export function modelThinkingLevels(model: Pick<ChannelModel, 'reasoning' | 'thinking' | 'thinkingLevelMap'>): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  const control = modelThinkingConfiguration(model);
  if (control?.mode === 'fixed') return ['on'];
  if (control?.mode === 'switch') return ['off', 'on'];
  if (control?.mode === 'budget') return [...(control.allowOff ? ['off' as const] : []), 'budget'];
  if (control?.mode === 'levels') return [...(control.allowOff ? ['off' as const] : []), ...control.levels];
  return ['on'];
}
