import { afterEach, describe, expect, it } from 'vitest';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { getDictationStartOptions } from './useDictation';

const initial = usePreferencesStore.getState();
afterEach(() => usePreferencesStore.setState(initial));

describe('dictation uses the settings page preferences', () => {
  it('uses the current local model and language immediately after editing settings', () => {
    const preferences = usePreferencesStore.getState();
    preferences.setSttProvider('local');
    preferences.setSttLocalModel('sense-voice-small-int8');
    preferences.setSttLanguage('ja-JP');
    expect(getDictationStartOptions()).toEqual({ provider: 'local', localModel: 'sense-voice-small-int8', language: 'ja-JP' });
    preferences.setSttLocalModel('qwen3-asr-0.6b-int8');
    preferences.setSttLanguage('');
    expect(getDictationStartOptions()).toEqual({ provider: 'local', localModel: 'qwen3-asr-0.6b-int8' });
  });

  it('uses the updated server endpoint, model, credential and language after switching providers', () => {
    const preferences = usePreferencesStore.getState();
    preferences.setSttProvider('openai-compatible');
    preferences.setSttServerUrl('https://speech.example/v1');
    preferences.setSttModel('multilingual');
    preferences.setSttApiKey('test-credential');
    preferences.setSttLanguage('de');
    expect(getDictationStartOptions()).toEqual({ provider: 'openai-compatible', language: 'de',
      openaiCompatible: { baseUrl: 'https://speech.example/v1', model: 'multilingual', apiKey: 'test-credential' } });
  });
});
