/**
 * Dictation service: resolves STT providers, tracks local model download
 * state, and exposes a readiness snapshot for the status route.
 *
 * Providers:
 * - 'local' (default): catalog-selected sherpa-onnx models in a worker process.
 *   Models auto-download in the background on first use.
 * - 'openai-compatible': any OpenAI-compatible /v1/audio/transcriptions
 *   endpoint (faster-whisper, whisper.cpp, OpenAI).
 */

import { rm } from 'fs/promises';

import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './local/worker-client.js';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LOCAL_STT_MODEL_CATALOG,
  LOCAL_STT_MODEL_IDS,
  LOCAL_TTS_MODEL_CATALOG,
  LOCAL_TTS_MODEL_IDS,
  getLocalSttModelDir,
  isLocalModelId,
  isLocalSttModelId,
  isLocalTtsModelId,
} from './local/model-catalog.js';
import { ensureLocalSttModel, isLocalSttModelInstalled } from './local/model-downloader.js';
import { resolveLocalSttLanguage } from './local/model-language.js';
import type { LocalSttModelId } from './local/model-catalog.js';
import type {
  DictationStartOptions,
  LocalSpeechModelCatalog,
  SttSessionResolution,
} from './types.js';

interface LocalModelStatus {
  description: string;
  downloadError: string | null;
  downloadProgress: number | null;
  downloading: boolean;
  id: string;
  installed: boolean;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createDictationService({ modelsDir }: { modelsDir: string }) {
  const workerClient = new DictationWorkerClient();
  /** modelId -> 'downloading' | 'error' */
  const downloadStates = new Map<string, 'downloading' | 'error'>();
  /** modelId -> last download error message */
  const downloadErrors = new Map<string, string>();
  /** modelId -> in-flight ensure promise */
  const downloadPromises = new Map<string, Promise<void>>();
  /** modelId -> 0..100 download percent (null while size unknown) */
  const downloadProgress = new Map<string, number | null>();

  const startModelDownload = (modelId: string): Promise<void> => {
    const existing = downloadPromises.get(modelId);
    if (existing) {
      return existing;
    }
    downloadStates.set(modelId, 'downloading');
    downloadErrors.delete(modelId);
    downloadProgress.set(modelId, 0);
    const promise = ensureLocalSttModel({
      modelsDir,
      modelId,
      onProgress: (downloadedBytes: number, totalBytes: number | null) => {
        downloadProgress.set(
          modelId,
          totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : null,
        );
      },
    })
      .then(() => {
        downloadStates.delete(modelId);
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      })
      .catch((error) => {
        downloadStates.set(modelId, 'error');
        downloadErrors.set(modelId, errorMessage(error));
        downloadPromises.delete(modelId);
        downloadProgress.delete(modelId);
      });
    downloadPromises.set(modelId, promise);
    return promise;
  };

  const resolveLocalModelId = (requested: unknown): LocalSttModelId => {
    return isLocalSttModelId(requested) ? requested : DEFAULT_LOCAL_STT_MODEL;
  };

  /**
   * Create a connected StreamingTranscriptionSession for one dictation.
   * Returns { session } on success or { error, retryable, reasonCode } when
   * the provider is not ready.
   *
   * @param {{ provider?: string, language?: string, localModel?: string,
   *           openaiCompatible?: { baseUrl?: string, model?: string, apiKey?: string } }} options
   */
  const createSttSession = async (options: DictationStartOptions = {}): Promise<SttSessionResolution> => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';

    if (provider === 'openai-compatible') {
      const config = options.openaiCompatible || {};
      const session = new OpenAICompatibleTranscriptionSession({
        baseURL: config.baseUrl ?? '',
        model: config.model ?? '',
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(options.language ? { language: options.language } : {}),
      });
      try {
        await session.connect();
      } catch (error) {
        return {
          error: errorMessage(error),
          retryable: false,
          reasonCode: 'stt_not_configured',
        };
      }
      return { session };
    }

    const modelId = resolveLocalModelId(options.localModel);
    let language: string;
    try { language = resolveLocalSttLanguage(modelId, options.language); }
    catch (error) { return { error: errorMessage(error), retryable: false, reasonCode: 'stt_language_unsupported' }; }
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        // Allow a retry on the next attempt.
        downloadStates.delete(modelId);
        return {
          error: `Failed to download dictation model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const session = new WorkerBackedTranscriptionSession(workerClient, { modelsDir, modelId, language });
    try {
      await session.connect();
    } catch (error) {
      const message = errorMessage(error);
      // A model that passes the file-presence check but fails to load is
      // corrupt on disk (e.g. truncated by an interrupted extraction). Remove
      // it so the next attempt re-downloads instead of crashing forever.
      if (/Load model|Protobuf parsing failed/i.test(message)) {
        await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true })
          .catch(() => undefined);
        return {
          error: 'Dictation model files were corrupt and have been removed; retry to re-download',
          retryable: true,
          reasonCode: 'model_corrupt',
        };
      }
      return {
        error: message,
        retryable: true,
        reasonCode: 'stt_unavailable',
      };
    }
    return { session };
  };

  /**
   * Readiness snapshot for the status route and UI gating.
   * @param {{ provider?: string, localModel?: string }} [options]
   */
  const getStatus = async (options: { localModel?: string; provider?: string } = {}) => {
    const provider = options.provider === 'openai-compatible' ? 'openai-compatible' : 'local';
    const modelId = resolveLocalModelId(options.localModel);

    const describeModel = async (id: string, catalog: LocalSpeechModelCatalog): Promise<LocalModelStatus> => ({
      id,
      description: catalog[id]?.description ?? id,
      installed: await isLocalSttModelInstalled(modelsDir, id),
      downloading: downloadStates.get(id) === 'downloading',
      downloadProgress: downloadProgress.get(id) ?? null,
      downloadError: downloadErrors.get(id) || null,
    });

    const models = await Promise.all(
      LOCAL_STT_MODEL_IDS.map(async (id) => ({ ...await describeModel(id, LOCAL_STT_MODEL_CATALOG),
        ...LOCAL_STT_MODEL_CATALOG[id].info })),
    );
    const ttsModels = await Promise.all(
      LOCAL_TTS_MODEL_IDS.map((id) => describeModel(id, LOCAL_TTS_MODEL_CATALOG)),
    );

    if (provider === 'openai-compatible') {
      return { provider, available: true, models, ttsModels };
    }

    const model = models.find((entry) => entry.id === modelId) || null;
    if (model?.installed) {
      return { provider, available: true, activeModel: modelId, models, ttsModels };
    }
    if (model?.downloading) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_in_progress',
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    if (model?.downloadError) {
      return {
        provider,
        available: false,
        reasonCode: 'model_download_failed',
        error: model.downloadError,
        activeModel: modelId,
        models,
        ttsModels,
      };
    }
    return {
      provider,
      available: false,
      reasonCode: 'models_missing',
      activeModel: modelId,
      models,
      ttsModels,
    };
  };

  /**
   * Synthesize speech with the local TTS model. Returns WAV bytes, or a
   * readiness error while the model is missing/downloading.
   * @param {{ text: string, model?: string, speakerId?: number, speed?: number }} options
   */
  const synthesizeSpeech = async ({ text, model, speakerId, speed }: {
    model?: string;
    speakerId?: number;
    speed?: number;
    text: string;
  }): Promise<
    | { error: string; reasonCode: string; retryable: boolean }
    | { audio: Buffer; format: string }
  > => {
    const modelId = isLocalTtsModelId(model) ? model : DEFAULT_LOCAL_TTS_MODEL;
    const installed = await isLocalSttModelInstalled(modelsDir, modelId);
    if (!installed) {
      const state = downloadStates.get(modelId);
      if (state === 'error') {
        const message = downloadErrors.get(modelId) || 'Model download failed';
        downloadStates.delete(modelId);
        return {
          error: `Failed to download TTS model: ${message}`,
          retryable: true,
          reasonCode: 'model_download_failed',
        };
      }
      void startModelDownload(modelId);
      return {
        error: 'TTS model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      };
    }

    const result = await workerClient.synthesizeSpeech({
      modelsDir,
      modelId,
      text,
      ...(typeof speakerId === 'number' ? { speakerId } : {}),
      ...(typeof speed === 'number' ? { speed } : {}),
    });
    return { audio: result.audio, format: result.format };
  };

  /**
   * Kick off a background download for a model (used by the status route's
   * download action so Settings can pre-download models).
   */
  const requestModelDownload = async (modelId: string) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (await isLocalSttModelInstalled(modelsDir, modelId)) {
      return { ok: true, installed: true };
    }
    void startModelDownload(modelId);
    return { ok: true, installed: false };
  };

  /**
   * Delete an installed model from disk. A model that is mid-download cannot
   * be deleted. An engine already loaded in the worker keeps its in-memory
   * copy until the worker's idle shutdown; the files are simply re-downloaded
   * on the next use if the model is selected again.
   */
  const deleteModel = async (modelId: string) => {
    if (!isLocalModelId(modelId)) {
      return { ok: false, error: 'Unknown model id' };
    }
    if (downloadStates.get(modelId) === 'downloading') {
      return { ok: false, error: 'Model is downloading' };
    }
    await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    downloadErrors.delete(modelId);
    return { ok: true };
  };

  const shutdown = (): void => {
    workerClient.shutdown();
  };

  return {
    createSttSession,
    synthesizeSpeech,
    getStatus,
    requestModelDownload,
    deleteModel,
    shutdown,
  };
}
