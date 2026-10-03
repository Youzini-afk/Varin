import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import { DEFAULT_LOCAL_STT_MODEL } from '@varin/application-client';

export type VoiceProvider = 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say';
export type SttProvider = 'local' | 'openai-compatible';
export type TtsInputMode = 'sanitized' | 'raw' | 'summarized';

export interface PreferencesState {
  settingsAutoCreateWorktree: boolean;
  settingsAutoUpdateChecksEnabled: boolean;
  settingsDefaultFileViewerPreview: boolean;
  settingsGitmojiEnabled: boolean;
  settingsZenModel?: string;

  browserVoice: string;
  dictationEnabled: boolean;
  localTtsVoiceId: number;
  openaiApiKey: string;
  openaiCompatibleApiKey: string;
  openaiCompatibleTtsModel: string;
  openaiCompatibleUrl: string;
  openaiCompatibleVoice: string;
  openaiVoice: string;
  sayVoice: string;
  showMessageTTSButtons: boolean;
  speechPitch: number;
  speechRate: number;
  speechVolume: number;
  sttApiKey: string;
  sttLanguage: string;
  sttLocalModel: string;
  sttModel: string;
  sttProvider: SttProvider;
  sttServerUrl: string;
  sttSilenceHoldMs: number;
  sttSilenceThresholdDb: number;
  sttTranscribeOnStop: boolean;
  summarizeCharacterThreshold: number;
  summarizeMaxLength: number;
  summarizeMessageTTS: boolean;
  summarizeVoiceConversation: boolean;
  ttsInputMode: TtsInputMode;
  voiceProvider: VoiceProvider;

  setBrowserVoice(value: string): void;
  setDictationEnabled(value: boolean): void;
  setLocalTtsVoiceId(value: number): void;
  setOpenaiApiKey(value: string): void;
  setOpenaiCompatibleApiKey(value: string): void;
  setOpenaiCompatibleTtsModel(value: string): void;
  setOpenaiCompatibleUrl(value: string): void;
  setOpenaiCompatibleVoice(value: string): void;
  setOpenaiVoice(value: string): void;
  setSayVoice(value: string): void;
  setSettingsAutoCreateWorktree(value: boolean): void;
  setSettingsAutoUpdateChecksEnabled(value: boolean): void;
  setSettingsDefaultFileViewerPreview(value: boolean): void;
  setSettingsGitmojiEnabled(value: boolean): void;
  setSettingsZenModel(value: string | undefined): void;
  setShowMessageTTSButtons(value: boolean): void;
  setSpeechPitch(value: number): void;
  setSpeechRate(value: number): void;
  setSpeechVolume(value: number): void;
  setSttApiKey(value: string): void;
  setSttLanguage(value: string): void;
  setSttLocalModel(value: string): void;
  setSttModel(value: string): void;
  setSttProvider(value: SttProvider): void;
  setSttServerUrl(value: string): void;
  setSttSilenceHoldMs(value: number): void;
  setSttSilenceThresholdDb(value: number): void;
  setSttTranscribeOnStop(value: boolean): void;
  setSummarizeCharacterThreshold(value: number): void;
  setSummarizeMaxLength(value: number): void;
  setSummarizeMessageTTS(value: boolean): void;
  setSummarizeVoiceConversation(value: boolean): void;
  setTtsInputMode(value: TtsInputMode): void;
  setVoiceProvider(value: VoiceProvider): void;
}

const storageValue = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storeValue = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The Zustand persistence adapter still provides an in-memory fallback.
  }
};

const stringValue = (key: string, fallback: string): string => storageValue(key) || fallback;

const booleanValue = (key: string, fallback: boolean): boolean => {
  const value = storageValue(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
};

const numberValue = (key: string, fallback: number, minimum?: number, maximum?: number): number => {
  const value = Number(storageValue(key));
  if (!Number.isFinite(value)) return fallback;
  if (minimum !== undefined && value < minimum) return fallback;
  if (maximum !== undefined && value > maximum) return fallback;
  return value;
};

const initialVoiceProvider = (): VoiceProvider => {
  const value = storageValue('voiceProvider');
  return value === 'browser'
    || value === 'local'
    || value === 'openai'
    || value === 'openai-compatible'
    || value === 'say'
    ? value
    : 'browser';
};

const initialSttProvider = (): SttProvider => {
  const value = storageValue('sttProvider');
  if (value === 'openai-compatible' || value === 'server') return 'openai-compatible';
  return 'local';
};

const initialTtsInputMode = (): TtsInputMode => {
  const value = storageValue('ttsInputMode');
  return value === 'raw' || value === 'summarized' ? value : 'sanitized';
};

const persistString = (
  set: (partial: Partial<PreferencesState>) => void,
  update: Partial<PreferencesState>,
  key: string,
  value: string,
): void => {
  set(update);
  storeValue(key, value);
};

export const usePreferencesStore = create<PreferencesState>()(
  devtools(
    persist(
      (set) => ({
        settingsAutoCreateWorktree: false,
        settingsAutoUpdateChecksEnabled: true,
        settingsDefaultFileViewerPreview: false,
        settingsGitmojiEnabled: booleanValue('gitmojiEnabled', false),
        settingsZenModel: undefined,

        browserVoice: stringValue('browserVoice', ''),
        dictationEnabled: booleanValue('dictationEnabled', true),
        localTtsVoiceId: numberValue('localTtsVoiceId', 0, 0),
        openaiApiKey: stringValue('openaiApiKey', ''),
        openaiCompatibleApiKey: stringValue('openaiCompatibleApiKey', ''),
        openaiCompatibleTtsModel: stringValue('openaiCompatibleTtsModel', 'kokoro'),
        openaiCompatibleUrl: stringValue('openaiCompatibleUrl', ''),
        openaiCompatibleVoice: stringValue('openaiCompatibleVoice', 'af_sky'),
        openaiVoice: stringValue('openaiVoice', 'nova'),
        sayVoice: stringValue('sayVoice', 'Samantha'),
        showMessageTTSButtons: booleanValue('showMessageTTSButtons', false),
        speechPitch: numberValue('speechPitch', 1, 0.5, 2),
        speechRate: numberValue('speechRate', 1, 0.5, 2),
        speechVolume: numberValue('speechVolume', 1, 0, 1),
        sttApiKey: stringValue('sttApiKey', ''),
        sttLanguage: stringValue('sttLanguage', ''),
        sttLocalModel: stringValue('sttLocalModel', DEFAULT_LOCAL_STT_MODEL),
        sttModel: stringValue('sttModel', 'deepdml/faster-whisper-large-v3-turbo-ct2'),
        sttProvider: initialSttProvider(),
        sttServerUrl: stringValue('sttServerUrl', 'http://localhost:8001/v1'),
        sttSilenceHoldMs: numberValue('sttSilenceHoldMs', 1500),
        sttSilenceThresholdDb: numberValue('sttSilenceThresholdDb', -45),
        sttTranscribeOnStop: booleanValue('sttTranscribeOnStop', true),
        summarizeCharacterThreshold: numberValue('summarizeCharacterThreshold', 200, 50, 2000),
        summarizeMaxLength: numberValue('summarizeMaxLength', 500, 50, 2000),
        summarizeMessageTTS: booleanValue('summarizeMessageTTS', false),
        summarizeVoiceConversation: booleanValue('summarizeVoiceConversation', false),
        ttsInputMode: initialTtsInputMode(),
        voiceProvider: initialVoiceProvider(),

        setBrowserVoice: (value) => persistString(set, { browserVoice: value }, 'browserVoice', value),
        setDictationEnabled: (value) => {
          set({ dictationEnabled: value });
          storeValue('dictationEnabled', String(value));
        },
        setLocalTtsVoiceId: (value) => {
          const normalized = Math.max(0, Math.trunc(value));
          set({ localTtsVoiceId: normalized });
          storeValue('localTtsVoiceId', String(normalized));
        },
        setOpenaiApiKey: (value) => persistString(set, { openaiApiKey: value }, 'openaiApiKey', value),
        setOpenaiCompatibleApiKey: (value) => persistString(set, { openaiCompatibleApiKey: value }, 'openaiCompatibleApiKey', value),
        setOpenaiCompatibleTtsModel: (value) => persistString(set, { openaiCompatibleTtsModel: value }, 'openaiCompatibleTtsModel', value),
        setOpenaiCompatibleUrl: (value) => persistString(set, { openaiCompatibleUrl: value }, 'openaiCompatibleUrl', value),
        setOpenaiCompatibleVoice: (value) => persistString(set, { openaiCompatibleVoice: value }, 'openaiCompatibleVoice', value),
        setOpenaiVoice: (value) => persistString(set, { openaiVoice: value }, 'openaiVoice', value),
        setSayVoice: (value) => persistString(set, { sayVoice: value }, 'sayVoice', value),
        setSettingsAutoCreateWorktree: (settingsAutoCreateWorktree) => set({ settingsAutoCreateWorktree }),
        setSettingsAutoUpdateChecksEnabled: (settingsAutoUpdateChecksEnabled) => set({ settingsAutoUpdateChecksEnabled }),
        setSettingsDefaultFileViewerPreview: (settingsDefaultFileViewerPreview) => set({ settingsDefaultFileViewerPreview }),
        setSettingsGitmojiEnabled: (settingsGitmojiEnabled) => set({ settingsGitmojiEnabled }),
        setSettingsZenModel: (settingsZenModel) => set({ settingsZenModel }),
        setShowMessageTTSButtons: (value) => {
          set({ showMessageTTSButtons: value });
          storeValue('showMessageTTSButtons', String(value));
        },
        setSpeechPitch: (value) => {
          const normalized = Math.max(0.5, Math.min(2, value));
          set({ speechPitch: normalized });
          storeValue('speechPitch', String(normalized));
        },
        setSpeechRate: (value) => {
          const normalized = Math.max(0.5, Math.min(2, value));
          set({ speechRate: normalized });
          storeValue('speechRate', String(normalized));
        },
        setSpeechVolume: (value) => {
          const normalized = Math.max(0, Math.min(1, value));
          set({ speechVolume: normalized });
          storeValue('speechVolume', String(normalized));
        },
        setSttApiKey: (value) => persistString(set, { sttApiKey: value }, 'sttApiKey', value),
        setSttLanguage: (value) => persistString(set, { sttLanguage: value }, 'sttLanguage', value),
        setSttLocalModel: (value) => persistString(set, { sttLocalModel: value }, 'sttLocalModel', value),
        setSttModel: (value) => persistString(set, { sttModel: value }, 'sttModel', value),
        setSttProvider: (value) => persistString(set, { sttProvider: value }, 'sttProvider', value),
        setSttServerUrl: (value) => persistString(set, { sttServerUrl: value }, 'sttServerUrl', value),
        setSttSilenceHoldMs: (value) => {
          set({ sttSilenceHoldMs: value });
          storeValue('sttSilenceHoldMs', String(value));
        },
        setSttSilenceThresholdDb: (value) => {
          set({ sttSilenceThresholdDb: value });
          storeValue('sttSilenceThresholdDb', String(value));
        },
        setSttTranscribeOnStop: (value) => {
          set({ sttTranscribeOnStop: value });
          storeValue('sttTranscribeOnStop', String(value));
        },
        setSummarizeCharacterThreshold: (value) => {
          const normalized = Math.max(50, Math.min(2000, value));
          set({ summarizeCharacterThreshold: normalized });
          storeValue('summarizeCharacterThreshold', String(normalized));
        },
        setSummarizeMaxLength: (value) => {
          const normalized = Math.max(50, Math.min(2000, value));
          set({ summarizeMaxLength: normalized });
          storeValue('summarizeMaxLength', String(normalized));
        },
        setSummarizeMessageTTS: (value) => {
          set({ summarizeMessageTTS: value });
          storeValue('summarizeMessageTTS', String(value));
        },
        setSummarizeVoiceConversation: (value) => {
          set({ summarizeVoiceConversation: value });
          storeValue('summarizeVoiceConversation', String(value));
        },
        setTtsInputMode: (value) => persistString(set, { ttsInputMode: value }, 'ttsInputMode', value),
        setVoiceProvider: (value) => persistString(set, { voiceProvider: value }, 'voiceProvider', value),
      }),
      {
        // Reuse the existing storage key so upgrades retain fork preferences while
        // silently dropping the former OpenCode provider/session cache fields.
        name: 'config-store',
        storage: createDeferredSafeJSONStorage(),
        version: 1,
        migrate: (persistedState, version) => {
          const state = persistedState && typeof persistedState === 'object'
            ? persistedState as Partial<PreferencesState>
            : {};
          // The old false value was an internal default with no setting exposed
          // to users. Enable the newly surfaced updater for existing installs;
          // an explicit settings.json value is still applied afterwards.
          if (version < 1) {
            return { ...state, settingsAutoUpdateChecksEnabled: true };
          }
          return state;
        },
        partialize: (state) => ({
          settingsAutoCreateWorktree: state.settingsAutoCreateWorktree,
          settingsAutoUpdateChecksEnabled: state.settingsAutoUpdateChecksEnabled,
          settingsDefaultFileViewerPreview: state.settingsDefaultFileViewerPreview,
          settingsGitmojiEnabled: state.settingsGitmojiEnabled,
          settingsZenModel: state.settingsZenModel,
          browserVoice: state.browserVoice,
          dictationEnabled: state.dictationEnabled,
          localTtsVoiceId: state.localTtsVoiceId,
          openaiApiKey: state.openaiApiKey,
          openaiCompatibleApiKey: state.openaiCompatibleApiKey,
          openaiCompatibleTtsModel: state.openaiCompatibleTtsModel,
          openaiCompatibleUrl: state.openaiCompatibleUrl,
          openaiCompatibleVoice: state.openaiCompatibleVoice,
          openaiVoice: state.openaiVoice,
          sayVoice: state.sayVoice,
          showMessageTTSButtons: state.showMessageTTSButtons,
          speechPitch: state.speechPitch,
          speechRate: state.speechRate,
          speechVolume: state.speechVolume,
          sttApiKey: state.sttApiKey,
          sttLanguage: state.sttLanguage,
          sttLocalModel: state.sttLocalModel,
          sttModel: state.sttModel,
          sttProvider: state.sttProvider,
          sttServerUrl: state.sttServerUrl,
          sttSilenceHoldMs: state.sttSilenceHoldMs,
          sttSilenceThresholdDb: state.sttSilenceThresholdDb,
          sttTranscribeOnStop: state.sttTranscribeOnStop,
          summarizeCharacterThreshold: state.summarizeCharacterThreshold,
          summarizeMaxLength: state.summarizeMaxLength,
          summarizeMessageTTS: state.summarizeMessageTTS,
          summarizeVoiceConversation: state.summarizeVoiceConversation,
          ttsInputMode: state.ttsInputMode,
          voiceProvider: state.voiceProvider,
        }),
      },
    ),
    { name: 'VarinPreferences' },
  ),
);
