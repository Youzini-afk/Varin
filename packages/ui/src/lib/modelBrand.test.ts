import { describe, expect, it } from 'vitest';
import { resolveModelBrand } from './modelBrand';

describe('model brand identity', () => {
  it.each([
    [{ requestModelId: 'anthropic/claude-sonnet-4-5', modelId: 'writing', displayName: 'Writing model' }, 'anthropic'],
    [{ modelId: 'deepseek-v3.2', displayName: 'OpenAI' }, 'deepseek'],
    [{ modelId: '[CM]deepseek-v4.1-flash', displayName: '[CM]deepseek-v4.1-flash' }, 'deepseek'],
    [{ requestModelId: ' 【CM】DeepSeek-V4.1-Flash ', modelId: 'alias' }, 'deepseek'],
    [{ requestModelId: 'relay/[CM]DEEPSEEK-v4.1-flash:fast' }, 'deepseek'],
    [{ modelId: 'team_deepseek-v4.1-flash_fast' }, 'deepseek'],
    [{ modelId: 'CM-deepseek-v4.1-flash' }, 'deepseek'],
    [{ modelId: 'cm.deepseek.v4.1.flash' }, 'deepseek'],
    [{ requestModelId: 'openai/deepseek-v3', modelId: 'alias' }, 'deepseek'],
    [{ requestModelId: '[openai]deepseek-v4.1-flash' }, 'deepseek'],
    [{ requestModelId: 'gateway-anthropic/deepseek-v4.1-flash' }, 'deepseek'],
    [{ modelId: 'Qwen/Qwen3-Embedding-8B' }, 'qwen'],
    [{ modelId: 'qwen2.5-72b' }, 'qwen'],
    [{ modelId: 'gateway/alias', displayName: 'Claude Sonnet 4.5' }, 'anthropic'],
    [{ modelId: 'deepseek-r1-distill-qwen-32b' }, 'deepseek'],
    [{ modelId: 'gpt-4.1' }, 'openai'],
    [{ modelId: '[CM]GPT-4.1-mini' }, 'openai'],
    [{ modelId: '[CM]Claude-Sonnet-4.5' }, 'anthropic'],
    [{ modelId: 'relay_gemini-2.5-pro' }, 'google'],
    [{ modelId: '[CM]Qwen3-32B' }, 'qwen'],
    [{ modelId: 'text-embedding-3-large' }, 'openai'],
    [{ modelId: 'o3-mini' }, 'openai'],
    [{ modelId: 'team-reranker', displayName: 'Custom ranker' }, 'unknown'],
    [{ modelId: 'myclaude-copy' }, 'unknown'],
    [{ modelId: '[CM]mydeepseek-v4.1-flash' }, 'unknown'],
    [{ modelId: '[CM]custom-model', displayName: '[CM]DeepSeek V4.1 Flash' }, 'deepseek'],
    [{}, 'unknown'],
  ] as const)('resolves %j to %s', (identity, brand) => expect(resolveModelBrand(identity)).toBe(brand));
});
