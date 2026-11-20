import type { BotFigurePreset } from '@varin/application-client';
import type { BotFigureArtwork } from './botFigureArtwork';

export const botFigurePresets = {
  deepseek: { portrait: new URL('./figurePresets/deepseek.webp', import.meta.url).href, load: () => import('./figurePresets/deepseek') },
  claude: { portrait: new URL('./figurePresets/claude.webp', import.meta.url).href, load: () => import('./figurePresets/claude') },
  gpt: { portrait: new URL('./figurePresets/gpt.webp', import.meta.url).href, load: () => import('./figurePresets/gpt') },
  gemini: { portrait: new URL('./figurePresets/gemini.webp', import.meta.url).href, load: () => import('./figurePresets/gemini') },
  grok: { portrait: new URL('./figurePresets/grok.webp', import.meta.url).href, load: () => import('./figurePresets/grok') },
  kimi: { portrait: new URL('./figurePresets/kimi.webp', import.meta.url).href, load: () => import('./figurePresets/kimi') },
  glm: { portrait: new URL('./figurePresets/glm.webp', import.meta.url).href, load: () => import('./figurePresets/glm') },
  qwen: { portrait: new URL('./figurePresets/qwen.webp', import.meta.url).href, load: () => import('./figurePresets/qwen') },
  seed: { portrait: new URL('./figurePresets/seed.webp', import.meta.url).href, load: () => import('./figurePresets/seed') },
  minimax: { portrait: new URL('./figurePresets/minimax.webp', import.meta.url).href, load: () => import('./figurePresets/minimax') },
  llama: { portrait: new URL('./figurePresets/llama.webp', import.meta.url).href, load: () => import('./figurePresets/llama') },
  mistral: { portrait: new URL('./figurePresets/mistral.webp', import.meta.url).href, load: () => import('./figurePresets/mistral') },
  perplexity: { portrait: new URL('./figurePresets/perplexity.webp', import.meta.url).href, load: () => import('./figurePresets/perplexity') },
  wenxin: { portrait: new URL('./figurePresets/wenxin.webp', import.meta.url).href, load: () => import('./figurePresets/wenxin') },
  jev: { portrait: new URL('./figurePresets/jev.webp', import.meta.url).href, load: () => import('./figurePresets/jev') },
} satisfies Record<BotFigurePreset, { portrait: string; load(): Promise<{ default: BotFigureArtwork }> }>;
