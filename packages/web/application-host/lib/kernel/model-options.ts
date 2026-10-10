/** Catalog metadata resolves UI thinking levels into frozen provider-native request options. */
import type { ThreadThinkingLevel } from '@varin/application-client';
import type { SelectedModel } from './model-authority.js';
import type { ModelSessionConfiguration } from './protocol.generated.js';

const levels: ThreadThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const failed = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export function thinkingLevels(model: SelectedModel): ThreadThinkingLevel[] {
  return model.reasoning ? levels.filter(level => model.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined)) : ['off'];
}
const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };
export function modelOptions(model: SelectedModel, requested: ThreadThinkingLevel | undefined, max: number | null, temperature?: number)
  : Pick<ModelSessionConfiguration, 'thinkingLevel' | 'reasoningEffort' | 'modelOptions'> {
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0)) return failed('model-temperature-invalid');
  const available = thinkingLevels(model);
  const level = requested ?? available[0];
  if (!level || !available.includes(level)) return failed('model-thinking-level-unavailable');
  const effort = level === 'off' ? null : model.thinkingLevelMap?.[level] ?? level;
  const protocol: Record<string, unknown> = {};
  const parameters: Record<string, unknown> = {};
  let reasoningEffort = effort;
  const answerBudget = () => {
    const budget = Math.min(budgets[level as keyof typeof budgets], (max ?? model.maxTokens) - 1024);
    if (budget < 1024) return failed('model-thinking-output-capacity-insufficient');
    return budget;
  };
  switch (model.api) {
    case 'anthropic-messages': {
      if (model.compat?.supportsMidConvoEffort === true) {
        protocol.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
        protocol.outputConfig = { effort: 'high' };
      } else if (model.reasoning) {
        protocol.thinking = level === 'off' ? { type: 'disabled' }
          : model.compat?.forceAdaptiveThinking === true ? { type: 'adaptive', display: 'summarized' }
            : { type: 'enabled', budget_tokens: answerBudget(), display: 'summarized' };
        if (level !== 'off' && model.compat?.forceAdaptiveThinking === true) {
          protocol.outputConfig = { effort: model.thinkingLevelMap?.[level] ?? (level === 'minimal' ? 'low' : level) };
        }
      }
      break;
    }
    case 'google-generative-ai': case 'google-vertex': {
      if (!model.reasoning) break;
      const usesLevel = /gemini-3(?:\.\d+)?-(?:pro|flash)|gemma-?4/.test(model.modelId.toLowerCase())
        || ['gemini-flash-latest', 'gemini-flash-lite-latest'].includes(model.modelId.toLowerCase());
      if (level === 'off') protocol.thinkingConfig = { thinkingBudget: 0 };
      else if (usesLevel) {
        const mapped = String(effort).toUpperCase();
        if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(mapped)) return failed('model-thinking-mapping-invalid');
        protocol.thinkingConfig = { includeThoughts: true, thinkingLevel: mapped };
      } else {
        const mapped = String(effort).toLowerCase();
        const googleBudgets: Record<string, number> = { minimal: model.modelId.includes('flash-lite') ? 512 : 128,
          low: 2048, medium: 8192, high: model.modelId.includes('2.5-pro') ? 32768 : 24576 };
        if (!(mapped in googleBudgets)) return failed('model-thinking-mapping-invalid');
        protocol.thinkingConfig = { includeThoughts: true, thinkingBudget: model.modelId.includes('2.5-') ? googleBudgets[mapped] : -1 };
      }
      break;
    }
    case 'bedrock-converse-stream': {
      if (level === 'off') break;
      // Bedrock supports model-specific fields; Claude's contract is distinct from other models.
      const candidates = [model.modelId, model.name].map(value => value.toLowerCase().replace(/[\s_.:]+/g, '-'));
      if (!candidates.some(value => value.includes('claude'))) return failed('model-thinking-protocol-unavailable');
      const adaptive = candidates.some(value => ['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-6', 'sonnet-5', 'fable-5'].some(name => value.includes(name)));
      protocol.additionalModelRequestFields = adaptive ? { thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: model.thinkingLevelMap?.[level] ?? (level === 'minimal' ? 'low' : level) } }
        : { thinking: { type: 'enabled', budget_tokens: answerBudget(), display: 'summarized' }, anthropic_beta: ['interleaved-thinking-2025-05-14'] };
      break;
    }
    case 'openai-completions': {
      if (model.reasoning) {
        switch (model.compat?.thinkingFormat) {
          case 'qwen': parameters.enable_thinking = level !== 'off'; break;
          case 'qwen-chat-template': parameters.chat_template_kwargs = { enable_thinking: level !== 'off', preserve_thinking: true }; reasoningEffort = null; break;
          case 'deepseek': parameters.thinking = { type: level === 'off' ? 'disabled' : 'enabled' }; break;
          case 'zai': parameters.thinking = level === 'off' ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false }; break;
          case 'openrouter': parameters.reasoning = level === 'off' ? { enabled: false } : { effort }; reasoningEffort = null; break;
          case 'together': parameters.reasoning = { enabled: level !== 'off' }; break;
          case 'ant-ling': if (effort) parameters.reasoning = { effort }; reasoningEffort = null; break;
          case 'string-thinking': parameters.thinking = effort ?? model.thinkingLevelMap?.off ?? 'none'; reasoningEffort = null; break;
        }
        if (model.compat?.supportsReasoningEffort === false) reasoningEffort = null;
        else if (level === 'off' && typeof model.thinkingLevelMap?.off === 'string') reasoningEffort = model.thinkingLevelMap.off;
        const budgetField = model.compat?.thinkingTokenBudgetField ?? (model.compat?.supportsThinkingTokenBudget ? 'thinking_token_budget' : undefined);
        if (typeof budgetField === 'string' && level !== 'off') parameters[budgetField] = answerBudget();
      }
      break;
    }
  }
  const samplingParams = { ...parameters, ...model.samplingParams, ...model.samplingParamsByThinkingLevel?.[level] };
  // Explicit profile/user selection wins over catalog defaults, including zero.
  if (temperature !== undefined) delete samplingParams.temperature;
  return { thinkingLevel: level, reasoningEffort,
    modelOptions: { ...(temperature === undefined ? {} : { temperature }), ...(Object.keys(samplingParams).length ? { samplingParams } : {}), ...(Object.keys(protocol).length ? { protocol } : {}) } };
}
