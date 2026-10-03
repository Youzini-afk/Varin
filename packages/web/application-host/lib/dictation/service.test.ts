import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDictationService } from './service.js';
import { resolveLocalSttLanguage } from './local/model-language.js';

const state = vi.hoisted(() => ({ installed: vi.fn(), connect: vi.fn(), configurations: [] as unknown[] }));
vi.mock('./local/model-downloader.js', () => ({
  isLocalSttModelInstalled: state.installed,
  ensureLocalSttModel: vi.fn(),
}));
vi.mock('./local/worker-client.js', () => ({
  DictationWorkerClient: class { shutdown() {} },
  WorkerBackedTranscriptionSession: class extends EventEmitter {
    constructor(_client: unknown, configuration: unknown) { super(); state.configurations.push(configuration); }
    connect = state.connect;
  },
}));
afterEach(() => { vi.clearAllMocks(); state.configurations.length = 0; });

describe('multilingual dictation', () => {
  it('passes the selected regional language through to the native session in the model protocol', async () => {
    state.installed.mockResolvedValue(true);
    state.connect.mockResolvedValue(undefined);
    const service = createDictationService({ modelsDir: '/models' });
    for (const [model, language] of [['whisper-turbo-int8', 'zh'], ['sense-voice-small-int8', 'zh'], ['qwen3-asr-0.6b-int8', 'Chinese']] as const) {
      expect(await service.createSttSession({ localModel: model, language: 'zh-CN' })).toHaveProperty('session');
      expect(state.configurations.at(-1)).toMatchObject({ modelId: model, language });
    }
  });

  it('rejects unsupported forced languages before starting inference or downloading a model', async () => {
    const service = createDictationService({ modelsDir: '/models' });
    expect(await service.createSttSession({ localModel: 'sense-voice-small-int8', language: 'de-DE' }))
      .toMatchObject({ retryable: false, reasonCode: 'stt_language_unsupported' });
    expect(state.installed).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });

  it('keeps automatic detection automatic and maps protocol-specific language aliases', () => {
    expect(resolveLocalSttLanguage('qwen3-asr-0.6b-int8', 'auto')).toBe('');
    expect(resolveLocalSttLanguage('qwen3-asr-0.6b-int8', 'tl-PH')).toBe('Filipino');
    expect(resolveLocalSttLanguage('whisper-turbo-int8', 'fil-PH')).toBe('tl');
    expect(resolveLocalSttLanguage('whisper-base-int8', 'jv-ID')).toBe('jw');
    expect(resolveLocalSttLanguage('parakeet-tdt-0.6b-v3-int8', 'zh-CN')).toBe('');
  });

  it('returns model capability metadata with the live installation state', async () => {
    state.installed.mockImplementation(async (_directory, id) => id === 'sense-voice-small-int8');
    const service = createDictationService({ modelsDir: '/models' });
    const status = await service.getStatus();
    expect(status.activeModel).toBe('whisper-turbo-int8');
    const senseVoice = status.models.find(model => model.id === 'sense-voice-small-int8');
    expect(senseVoice?.languages).toContain('zh');
    expect(senseVoice?.installed).toBe(true);
    expect(senseVoice?.downloadBytes).toBeGreaterThan(0);
    expect(status.models.find(model => model.id === 'whisper-turbo-int8')?.languages).toContain('yue');
    expect(status.models.find(model => model.id === 'parakeet-tdt-0.6b-v3-int8')?.languages).not.toContain('zh');
  });
});
