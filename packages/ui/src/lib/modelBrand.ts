/** Model identity is independent of its transport/channel. Keep this resolver
 * presentation-only: it never infers capabilities or changes a model request. */
export type ModelBrand = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'qwen' | 'kimi' | 'zhipu' | 'minimax' | 'unknown';
export interface ModelBrandIdentity {
  requestModelId?: string | null;
  modelId?: string | null;
  displayName?: string | null;
}

const familyRules: readonly [ModelBrand, RegExp][] = [
  ['deepseek', /^deepseek(?:$|[-_.])/],
  ['anthropic', /^(?:claude|anthropic)(?:$|[-_.])/],
  ['qwen', /^(?:qwen\d*(?:\.\d+)?|qwq|qvq)(?:$|[-_.])/],
  ['google', /^(?:gemini|gemma|imagen|veo)(?:$|[-_.])/],
  ['kimi', /^(?:kimi|moonshot)(?:$|[-_.])/],
  ['zhipu', /^(?:glm|chatglm|zhipu|zai-org)(?:$|[-_.])/],
  ['minimax', /^minimax(?:$|[-_.])/],
  ['openai', /^(?:gpt|chatgpt|codex|o1|o3|o4|dall-e|whisper|sora|text-embedding-(?:3|ada))(?:$|[-_.])/],
];

function matchFamily(value: string | null | undefined): ModelBrand | undefined {
  const tokens = value?.trim().toLowerCase().split(/[^\p{L}\p{N}._-]+/u).filter(Boolean) ?? [];
  const namespaces = new Set<string>();
  // Generic provider namespaces must not override a concrete model family,
  // e.g. openai/deepseek-v3 behind an OpenAI-compatible gateway.
  for (const token of tokens) {
    // Try the complete family first (deepseek-r1-distill-qwen stays DeepSeek),
    // then starts after real separators in deployment/channel decorations.
    // An embedded word such as myclaude is not a model-family boundary.
    const starts = [0, ...[...token.matchAll(/[-_.]+/g)].map(match => match.index + match[0].length)];
    for (const start of starts) {
      const candidate = token.slice(start);
      if (['openai', 'anthropic', 'google'].includes(candidate)) { namespaces.add(candidate); continue; }
      const family = familyRules.find(([, pattern]) => pattern.test(candidate));
      if (family) return family[0];
    }
  }
  return namespaces.has('anthropic') ? 'anthropic'
    : namespaces.has('google') ? 'google'
      : namespaces.has('openai') ? 'openai' : undefined;
}

export function resolveModelBrand(identity: ModelBrandIdentity): ModelBrand {
  return matchFamily(identity.requestModelId) ?? matchFamily(identity.modelId) ?? matchFamily(identity.displayName) ?? 'unknown';
}

export const modelBrandLogo: Record<Exclude<ModelBrand, 'unknown'>, string> = {
  openai: 'openai', anthropic: 'claude', google: 'google', deepseek: 'deepseek', qwen: 'qwen',
  kimi: 'kimi-for-coding', zhipu: 'zai-coding-plan', minimax: 'minimax-coding-plan',
};
