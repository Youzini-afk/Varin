/**
 * Catalog of local sherpa-onnx STT models available for dictation.
 * Models are downloaded on demand from the k2-fsa GitHub releases and
 * extracted under the Varin speech-models directory.
 *
 * `type` selects the recognizer construction path in the worker:
 * - 'nemo_transducer': encoder/decoder/joiner transducer (Parakeet)
 * - 'whisper': encoder/decoder Whisper export
 * - 'sense_voice': multilingual single-model recognition
 * - 'qwen3_asr': convolution frontend + encoder/decoder + tokenizer directory
 * `files` maps logical roles to file names inside the extracted directory.
 */

import path from 'path';
import type { LocalSpeechModelCatalog, LocalSpeechModelSpec } from '../types.js';
import type { LocalSttModelInfo } from '@varin/application-client';
export { DEFAULT_LOCAL_STT_MODEL } from '@varin/application-client';

type LocalSttModelSpec = LocalSpeechModelSpec & { info: Omit<LocalSttModelInfo, 'id'> };
// OpenAI Whisper tokenizer language identities; Cantonese was added in large-v3.
const WHISPER_LANGUAGES = ('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su').split(' ');
const PARAKEET_V3_LANGUAGES = 'bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk'.split(' ');

export const LOCAL_STT_MODEL_CATALOG = {
  'whisper-turbo-int8': {
    type: 'whisper',
    featureDim: 128,
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-turbo',
    files: { encoder: 'turbo-encoder.int8.onnx', decoder: 'turbo-decoder.int8.onnx', tokens: 'turbo-tokens.txt' },
    description: 'Whisper large-v3 Turbo (multilingual)',
    info: { name: 'Whisper large-v3 Turbo', languages: [...WHISPER_LANGUAGES, 'yue'], supportsLanguageSelection: true,
      downloadBytes: 563790207, sourceUrl: 'https://huggingface.co/openai/whisper-large-v3-turbo' },
  },
  'qwen3-asr-0.6b-int8': {
    type: 'qwen3_asr',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2',
    extractedDir: 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
    files: { convFrontend: 'conv_frontend.onnx', encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokenizer: 'tokenizer' },
    description: 'Qwen3-ASR 0.6B (30 languages)',
    info: { name: 'Qwen3-ASR 0.6B', languages: 'zh en yue ar de fr es pt id it ko ru th vi ja tr hi ms nl sv da fi pl cs fil fa el hu mk ro'.split(' '),
      supportsLanguageSelection: true, downloadBytes: 878702423, sourceUrl: 'https://github.com/QwenLM/Qwen3-ASR' },
  },
  'sense-voice-small-int8': {
    type: 'sense_voice',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
    extractedDir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    files: { model: 'model.int8.onnx', tokens: 'tokens.txt' },
    description: 'SenseVoice Small (Chinese, English, Japanese, Korean, Cantonese)',
    info: { name: 'SenseVoice Small', languages: ['zh', 'en', 'ja', 'ko', 'yue'], supportsLanguageSelection: true,
      downloadBytes: 165783878, sourceUrl: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall' },
  },
  'parakeet-tdt-0.6b-v2-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v2 (English)',
    info: { name: 'Parakeet v2', languages: ['en'], supportsLanguageSelection: false,
      downloadBytes: 482468385, sourceUrl: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2' },
  },
  'parakeet-tdt-0.6b-v3-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v3 (25 European languages, auto-detected)',
    info: { name: 'Parakeet v3', languages: PARAKEET_V3_LANGUAGES, supportsLanguageSelection: false,
      downloadBytes: 487170055, sourceUrl: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3' },
  },
  'whisper-base-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-base',
    files: {
      encoder: 'base-encoder.int8.onnx',
      decoder: 'base-decoder.int8.onnx',
      tokens: 'base-tokens.txt',
    },
    description: 'OpenAI Whisper base (multilingual, smaller and lighter)',
    info: { name: 'Whisper base', languages: WHISPER_LANGUAGES, supportsLanguageSelection: true,
      downloadBytes: 207557382, sourceUrl: 'https://github.com/openai/whisper' },
  },
  'whisper-tiny-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-tiny',
    files: {
      encoder: 'tiny-encoder.int8.onnx',
      decoder: 'tiny-decoder.int8.onnx',
      tokens: 'tiny-tokens.txt',
    },
    description: 'OpenAI Whisper tiny (multilingual, fastest and lightest)',
    info: { name: 'Whisper tiny', languages: WHISPER_LANGUAGES, supportsLanguageSelection: true,
      downloadBytes: 116204861, sourceUrl: 'https://github.com/openai/whisper' },
  },
} as const satisfies Record<string, LocalSttModelSpec>;

/**
 * Local text-to-speech models (sherpa-onnx OfflineTts). Downloaded and
 * managed through the same pipeline as the STT models.
 */
export const LOCAL_TTS_MODEL_CATALOG = {
  'kokoro-en-v0_19': {
    type: 'kokoro',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    extractedDir: 'kokoro-en-v0_19',
    files: {
      model: 'model.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Kokoro TTS (English, natural voices)',
  },
} as const satisfies LocalSpeechModelCatalog;

export type LocalSttModelId = keyof typeof LOCAL_STT_MODEL_CATALOG;
export type LocalTtsModelId = keyof typeof LOCAL_TTS_MODEL_CATALOG;
export type LocalSpeechModelId = LocalSttModelId | LocalTtsModelId;

export const DEFAULT_LOCAL_TTS_MODEL: LocalTtsModelId = 'kokoro-en-v0_19';

export const LOCAL_STT_MODEL_IDS = Object.keys(LOCAL_STT_MODEL_CATALOG) as LocalSttModelId[];
export const LOCAL_TTS_MODEL_IDS = Object.keys(LOCAL_TTS_MODEL_CATALOG) as LocalTtsModelId[];

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalSttModelId(modelId: unknown): modelId is LocalSttModelId {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, modelId);
}

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalTtsModelId(modelId: unknown): modelId is LocalTtsModelId {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_TTS_MODEL_CATALOG, modelId);
}

/**
 * Any managed local model (STT or TTS).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalModelId(modelId: unknown): modelId is LocalSpeechModelId {
  return isLocalSttModelId(modelId) || isLocalTtsModelId(modelId);
}

/**
 * Spec lookup across both catalogs (STT and TTS).
 * @param {string} modelId
 */
export function getLocalSttModelSpec(modelId: string): LocalSpeechModelSpec & { id: string; requiredFiles: string[] } {
  const sttSpec = isLocalSttModelId(modelId) ? LOCAL_STT_MODEL_CATALOG[modelId] : undefined;
  const ttsSpec = isLocalTtsModelId(modelId) ? LOCAL_TTS_MODEL_CATALOG[modelId] : undefined;
  const spec: LocalSpeechModelSpec | undefined = sttSpec ?? ttsSpec;
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${modelId}`);
  }
  return {
    id: modelId,
    ...spec,
    requiredFiles: [...Object.values(spec.files), ...(spec.type === 'qwen3_asr'
      ? ['tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/tokenizer_config.json'] : [])],
  };
}

/**
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {string}
 */
export function getLocalSttModelDir(modelsDir: string, modelId: string): string {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
