/** Catalog metadata resolves UI thinking levels into frozen provider-native request options. */
import type { ThreadThinkingLevel } from '@varin/application-client';
import { modelThinkingLevels } from '@varin/application-client';
import type { SelectedModel } from './model-authority.js';
import type { ModelSessionConfiguration } from './protocol.generated.js';

const failed = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export function thinkingLevels(model: SelectedModel): ThreadThinkingLevel[] {
  return modelThinkingLevels(model);
}
const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };
export function modelOptions(model: SelectedModel, requested: ThreadThinkingLevel | undefined, max: number | null, temperature?: number)
  : Pick<ModelSessionConfiguration, 'thinkingLevel' | 'reasoningEffort' | 'modelOptions'> {
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0)) return failed('model-temperature-invalid');
  const available = thinkingLevels(model);
  const level = requested ?? available[0];
  if (!level || !available.includes(level)) return failed('model-thinking-level-unavailable');
  const effort = ['off', 'on', 'budget'].includes(level) ? model.thinkingLevelMap?.[level] ?? null : model.thinkingLevelMap?.[level] ?? level;
  // Catalog IDs are user-owned aliases; protocol behavior follows the frozen upstream model.
  const requestModelId = (model.requestModelId ?? model.modelId).toLowerCase();
  const protocol: Record<string, unknown> = {};
  const parameters: Record<string, unknown> = {};
  let reasoningEffort = effort;
  const answerBudget = (minimum = 1024) => {
    if (level === 'budget' && model.thinking?.mode === 'budget') {
      if (model.thinking.tokens < minimum || max !== null && model.thinking.tokens >= max) return failed('model-thinking-output-capacity-insufficient');
      return model.thinking.tokens;
    }
    const budget = Math.min(budgets[level === 'on' ? 'high' : level as keyof typeof budgets], (max ?? model.maxTokens) - 1024);
    if (budget < 1024) return failed('model-thinking-output-capacity-insufficient');
    return budget;
  };
  switch (model.api) {
    case 'openai-responses': case 'azure-openai-responses': case 'openai-codex-responses': {
      if (model.reasoning && level === 'off') reasoningEffort = model.thinkingLevelMap?.off ?? 'none';
      break;
    }
    case 'anthropic-messages': {
      if (model.compat?.thinkingFormat === 'implicit') { reasoningEffort = null; break; }
      if (level === 'budget' && (model.compat?.forceAdaptiveThinking === true || model.compat?.supportsMidConvoEffort === true)) return failed('model-thinking-budget-unavailable');
      if (model.reasoning && model.compat?.supportsMidConvoEffort === true) {
        protocol.thinking = level === 'off' ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
        if (level !== 'off' && effort) protocol.outputConfig = { effort };
      } else if (model.reasoning) {
        protocol.thinking = level === 'off' ? { type: 'disabled' }
          : model.compat?.forceAdaptiveThinking === true && level !== 'budget' ? { type: 'adaptive', display: 'summarized' }
            : { type: 'enabled', budget_tokens: answerBudget(), display: 'summarized' };
        if (level !== 'off' && model.compat?.forceAdaptiveThinking === true) {
          if (effort) protocol.outputConfig = { effort: level === 'minimal' ? 'low' : effort };
        }
      }
      break;
    }
    case 'google-generative-ai': case 'google-vertex': {
      if (!model.reasoning) break;
      const usesLevel = model.compat?.thinkingFormat === 'google-level' || /gemini-[34](?:\.\d+)?-(?:pro|flash|argon)|gemma-?4/.test(requestModelId)
        || ['gemini-flash-latest', 'gemini-flash-lite-latest'].includes(requestModelId.split('/').at(-1)!);
      if (level === 'off') protocol.thinkingConfig = { thinkingBudget: 0 };
      else if (level === 'on') protocol.thinkingConfig = { includeThoughts: true };
      else if (level === 'budget' && model.thinking?.mode === 'budget') protocol.thinkingConfig = { includeThoughts: true, thinkingBudget: model.thinking.tokens };
      else if (usesLevel) {
        const mapped = String(effort).toUpperCase();
        if (!['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(mapped)) return failed('model-thinking-mapping-invalid');
        protocol.thinkingConfig = { includeThoughts: true, thinkingLevel: mapped };
      } else {
        const mapped = String(effort).toLowerCase();
        const googleBudgets: Record<string, number> = { minimal: requestModelId.includes('flash-lite') ? 512 : 128,
          low: 2048, medium: 8192, high: requestModelId.includes('2.5-pro') ? 32768 : 24576 };
        if (!(mapped in googleBudgets)) return failed('model-thinking-mapping-invalid');
        protocol.thinkingConfig = { includeThoughts: true, thinkingBudget: requestModelId.includes('2.5-') ? googleBudgets[mapped] : -1 };
      }
      break;
    }
    case 'bedrock-converse-stream': {
      if (level === 'off') break;
      // Bedrock supports model-specific fields; Claude's contract is distinct from other models.
      const resource = /^arn:[^:]+:bedrock:[^:]*:[^:]*:(.+)$/.exec(requestModelId)?.[1];
      const namedModel = resource === undefined ? requestModelId
        : /^(?:foundation-model|inference-profile)\/([^/]+)$/.exec(resource)?.[1];
      // Opaque resource/profile IDs need the configured name hint. A recognizable model
      // ID is authoritative, including non-Claude IDs; display edits cannot change its dialect.
      const candidate = (namedModel && (namedModel.includes('.') || /^claude[-_.]/.test(namedModel)) ? namedModel : model.name)
        .toLowerCase().replace(/[\s_.:]+/g, '-');
      if (!candidate.includes('claude')) return failed('model-thinking-protocol-unavailable');
      const adaptive = ['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-6', 'sonnet-5', 'haiku-5', 'fable-5'].some(name => candidate.includes(name));
      protocol.additionalModelRequestFields = adaptive && level !== 'budget' ? { thinking: { type: 'adaptive', display: 'summarized' },
        ...(effort ? { output_config: { effort: level === 'minimal' ? 'low' : effort } } : {}) }
        : { thinking: { type: 'enabled', budget_tokens: answerBudget(), display: 'summarized' }, anthropic_beta: ['interleaved-thinking-2025-05-14'] };
      break;
    }
    case 'openai-completions': {
      if (model.compat?.requiresReasoningContentOnAssistantMessages === true) protocol.requiresReasoningContent = true;
      if (model.reasoning) {
        switch (model.compat?.thinkingFormat) {
          case 'qwen': parameters.enable_thinking = level !== 'off'; break;
          case 'qwen-chat-template': parameters.chat_template_kwargs = { enable_thinking: level !== 'off', preserve_thinking: true }; reasoningEffort = null; break;
          case 'deepseek': parameters.thinking = { type: level === 'off' ? 'disabled' : 'enabled' }; break;
          case 'zai': parameters.thinking = level === 'off' ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false }; break;
          case 'openrouter': parameters.reasoning = level === 'off' ? { enabled: false } : level === 'budget' && model.thinking?.mode === 'budget' ? { max_tokens: model.thinking.tokens } : effort ? { effort } : { enabled: true }; reasoningEffort = null; break;
          case 'together': parameters.reasoning = { enabled: level !== 'off' }; break;
          case 'ant-ling': if (effort) parameters.reasoning = { effort }; reasoningEffort = null; break;
          case 'string-thinking': {
            if (level !== 'off' && !effort) return failed('model-thinking-mapping-invalid');
            parameters.thinking = effort ?? model.thinkingLevelMap?.off ?? 'none'; reasoningEffort = null; break;
          }
          default: if (level === 'off') reasoningEffort = model.thinkingLevelMap?.off ?? 'none';
        }
        if (model.compat?.supportsReasoningEffort === false) reasoningEffort = null;
        else if (level === 'off' && typeof model.thinkingLevelMap?.off === 'string') reasoningEffort = model.thinkingLevelMap.off;
        const budgetField = model.compat?.thinkingTokenBudgetField ?? (model.compat?.supportsThinkingTokenBudget ? 'thinking_token_budget' : undefined);
        if (typeof budgetField === 'string' && level !== 'off') parameters[budgetField] = answerBudget(1);
        if (level === 'budget' && typeof budgetField !== 'string' && model.compat?.thinkingFormat !== 'openrouter') return failed('model-thinking-budget-field-required');
      }
      break;
    }
  }
  if (level === 'budget' && !['anthropic-messages', 'google-generative-ai', 'google-vertex', 'bedrock-converse-stream', 'openai-completions'].includes(model.api)) return failed('model-thinking-budget-unavailable');
  const samplingParams = { ...parameters, ...model.samplingParams, ...model.samplingParamsByThinkingLevel?.[level] };
  // Explicit profile/user selection wins over catalog defaults, including zero.
  if (temperature !== undefined) delete samplingParams.temperature;
  return { thinkingLevel: level, reasoningEffort,
    modelOptions: { ...(model.compat?.copilot === true ? { copilot: true } : {}), ...(temperature === undefined ? {} : { temperature }), ...(Object.keys(samplingParams).length ? { samplingParams } : {}), ...(Object.keys(protocol).length ? { protocol } : {}) } };
}
