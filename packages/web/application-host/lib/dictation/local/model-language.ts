import { LOCAL_STT_MODEL_CATALOG, type LocalSttModelId } from './model-catalog.js';

// Qwen's native stream option uses model prompt names, not ISO/BCP-47 codes.
const QWEN_LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', yue: 'Cantonese', ar: 'Arabic', de: 'German', fr: 'French',
  es: 'Spanish', pt: 'Portuguese', id: 'Indonesian', it: 'Italian', ko: 'Korean', ru: 'Russian',
  th: 'Thai', vi: 'Vietnamese', ja: 'Japanese', tr: 'Turkish', hi: 'Hindi', ms: 'Malay',
  nl: 'Dutch', sv: 'Swedish', da: 'Danish', fi: 'Finnish', pl: 'Polish', cs: 'Czech',
  fil: 'Filipino', fa: 'Persian', el: 'Greek', hu: 'Hungarian', mk: 'Macedonian', ro: 'Romanian',
};

export function resolveLocalSttLanguage(modelId: LocalSttModelId, requested?: string): string {
  const input = requested?.trim().toLowerCase() ?? '';
  if (!input || input === 'auto') return '';
  const spec = LOCAL_STT_MODEL_CATALOG[modelId];
  if (!spec.info.supportsLanguageSelection) return '';
  let code = input.split('-')[0]!;
  if (spec.type === 'whisper') {
    if (code === 'fil') code = 'tl';
    if (code === 'jv') code = 'jw';
  } else if (spec.type === 'qwen3_asr' && code === 'tl') code = 'fil';
  if (!(spec.info.languages as readonly string[]).includes(code)) {
    throw new Error(`${spec.info.name} does not support the selected language: ${requested}`);
  }
  return spec.type === 'qwen3_asr' ? QWEN_LANGUAGE_NAMES[code]! : code;
}
