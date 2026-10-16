import { describe, expect, it } from 'vitest';
import { resolveModelBrand } from './modelBrand';

describe('model brand identity', () => {
  it.each([
    [{ requestModelId: 'anthropic/claude-sonnet-4-5', modelId: 'writing', displayName: 'Writing model' }, 'anthropic'],
    [{ modelId: 'deepseek-v3.2', displayName: 'OpenAI' }, 'deepseek'],
    [{ requestModelId: 'openai/deepseek-v3', modelId: 'alias' }, 'deepseek'],
    [{ modelId: 'Qwen/Qwen3-Embedding-8B' }, 'qwen'],
    [{ modelId: 'qwen2.5-72b' }, 'qwen'],
    [{ modelId: 'gateway/alias', displayName: 'Claude Sonnet 4.5' }, 'anthropic'],
    [{ modelId: 'deepseek-r1-distill-qwen-32b' }, 'deepseek'],
    [{ modelId: 'gpt-4.1' }, 'openai'],
    [{ modelId: 'text-embedding-3-large' }, 'openai'],
    [{ modelId: 'o3-mini' }, 'openai'],
    [{ modelId: 'team-reranker', displayName: 'Custom ranker' }, 'unknown'],
    [{ modelId: 'myclaude-copy' }, 'unknown'],
    [{}, 'unknown'],
  ] as const)('resolves %j to %s', (identity, brand) => expect(resolveModelBrand(identity)).toBe(brand));
});
