import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useDeviceInfo } from '@/lib/device';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { LocalSttModelPicker } from './LocalSttModelPicker';
import { speechLanguageLabel } from '@/lib/voice/speech-language';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { RiCloseLine, RiPlayLine, RiStopLine } from '@remixicon/react';
import {
    SettingsSection,
    SettingsCheckboxRow,
    SettingsFieldRow,
    SettingsControlGroup,
    SettingsChipGroup,
    SETTINGS_SELECT_SIZE,
    SETTINGS_SELECT_ROW_TRIGGER_CLASS,
    SETTINGS_CONTROL_CLUSTER_CLASS,
    SETTINGS_FIELD_LABEL_CLASS,
    SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { Icon } from '@/components/icon/Icon';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { runtimeFetch, type LocalSttModelStatus } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { useLocalTTS } from '@/hooks/useLocalTTS';
import { disposePreviewAudio } from './voicePreviewAudio';

interface DictationModelState {
    id: string;
    installed: boolean;
    downloading: boolean;
    downloadProgress: number | null;
    downloadError: string | null;
}

/** Kokoro en_v0_19 speaker ids in sherpa-onnx order. */
const KOKORO_VOICE_OPTIONS = [
    { id: 0, label: 'Alloy (af)' },
    { id: 1, label: 'Bella (af)' },
    { id: 2, label: 'Nicole (af)' },
    { id: 3, label: 'Sarah (af)' },
    { id: 4, label: 'Sky (af)' },
    { id: 5, label: 'Adam (am)' },
    { id: 6, label: 'Michael (am)' },
    { id: 7, label: 'Emma (bf)' },
    { id: 8, label: 'Isabella (bf)' },
    { id: 9, label: 'George (bm)' },
    { id: 10, label: 'Lewis (bm)' },
];

const LOCAL_TTS_MODEL_ID = 'kokoro-en-v0_19';

const LocalTtsModelStatus = () => {
    const { t } = useI18n();
    const [model, setModel] = useState<DictationModelState | null>(null);
    const [requesting, setRequesting] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const response = await runtimeFetch('/api/dictation/status', { query: { provider: 'local' } });
            if (!response.ok) {
                return;
            }
            const data = await response.json();
            const entry = Array.isArray(data?.ttsModels)
                ? data.ttsModels.find((m: DictationModelState) => m.id === LOCAL_TTS_MODEL_ID)
                : null;
            if (entry) {
                setModel(entry);
            }
        } catch {
            // Display-only status; keep the previous state on fetch failure.
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!model?.downloading) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, 2000);
        return () => clearInterval(interval);
    }, [model?.downloading, refresh]);

    const request = async (method: 'POST' | 'DELETE') => {
        setRequesting(true);
        try {
            const path = method === 'POST'
                ? `/api/dictation/models/${LOCAL_TTS_MODEL_ID}/download`
                : `/api/dictation/models/${LOCAL_TTS_MODEL_ID}`;
            await runtimeFetch(path, { method });
            await refresh();
        } catch {
            // Status refresh reports errors.
        } finally {
            setRequesting(false);
        }
    };

    if (!model) {
        return null;
    }

    return (
        <div className="flex items-center gap-2 py-1.5">
            <span className="typography-ui-label text-foreground">Kokoro</span>
            <span className="typography-ui-compact tabular-nums text-muted-foreground">305 MB</span>
            {model.installed ? (
                <>
                    <Icon
                        name="checkbox-circle"
                        className="h-4 w-4 text-[var(--status-success)]"
                        aria-label={t('settings.voice.page.stt.modelInstalled')}
                    />
                    <Button
                        variant="ghost"
                        size="xs"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                        disabled={requesting}
                        onClick={() => { void request('DELETE'); }}
                        title={t('settings.voice.page.stt.modelDelete')}
                        aria-label={t('settings.voice.page.stt.modelDelete')}
                    >
                        <Icon name="delete-bin" className="h-4 w-4" />
                    </Button>
                </>
            ) : model.downloading ? (
                <span className="flex items-center gap-1.5">
                    <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    <span className="typography-ui-compact tabular-nums text-muted-foreground">
                        {typeof model.downloadProgress === 'number' ? `${model.downloadProgress}%` : ''}
                    </span>
                </span>
            ) : (
                <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 w-6 p-0"
                    disabled={requesting}
                    onClick={() => { void request('POST'); }}
                    title={t('settings.voice.page.stt.modelDownload')}
                    aria-label={t('settings.voice.page.stt.modelDownload')}
                >
                    <Icon name="download" className="h-4 w-4" />
                </Button>
            )}
            {model.downloadError ? (
                <span className="typography-meta text-[var(--status-error)]">{model.downloadError}</span>
            ) : null}
        </div>
    );
};

const OPENAI_VOICE_OPTIONS = [
    { value: 'alloy', label: 'Alloy' },
    { value: 'ash', label: 'Ash' },
    { value: 'ballad', label: 'Ballad' },
    { value: 'coral', label: 'Coral' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
    { value: 'nova', label: 'Nova' },
    { value: 'onyx', label: 'Onyx' },
    { value: 'sage', label: 'Sage' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'verse', label: 'Verse' },
    { value: 'marin', label: 'Marin' },
    { value: 'cedar', label: 'Cedar' },
];

export const VoiceSettings: React.FC = () => {
    const { t, locale } = useI18n();
    const { isMobile } = useDeviceInfo();
    const voiceProvider = usePreferencesStore((state) => state.voiceProvider);
    const setVoiceProvider = usePreferencesStore((state) => state.setVoiceProvider);
    const speechRate = usePreferencesStore((state) => state.speechRate);
    const setSpeechRate = usePreferencesStore((state) => state.setSpeechRate);
    const speechPitch = usePreferencesStore((state) => state.speechPitch);
    const setSpeechPitch = usePreferencesStore((state) => state.setSpeechPitch);
    const speechVolume = usePreferencesStore((state) => state.speechVolume);
    const setSpeechVolume = usePreferencesStore((state) => state.setSpeechVolume);
    const sayVoice = usePreferencesStore((state) => state.sayVoice);
    const setSayVoice = usePreferencesStore((state) => state.setSayVoice);
    const localTtsVoiceId = usePreferencesStore((state) => state.localTtsVoiceId);
    const setLocalTtsVoiceId = usePreferencesStore((state) => state.setLocalTtsVoiceId);
    const { speak: speakLocalTts, stop: stopLocalTts, isPlaying: isLocalTtsPlaying, error: localTtsError } = useLocalTTS();

    const previewLocalVoice = useCallback(() => {
        if (isLocalTtsPlaying) {
            stopLocalTts();
            return;
        }
        const voiceLabel = KOKORO_VOICE_OPTIONS.find((v) => v.id === localTtsVoiceId)?.label
            ?? String(localTtsVoiceId);
        void speakLocalTts(t('settings.voice.page.preview.voiceLine', { voiceName: voiceLabel }), {
            speakerId: localTtsVoiceId,
        speed: usePreferencesStore.getState().speechRate,
        });
    }, [isLocalTtsPlaying, localTtsVoiceId, speakLocalTts, stopLocalTts, t]);
    const browserVoice = usePreferencesStore((state) => state.browserVoice);
    const setBrowserVoice = usePreferencesStore((state) => state.setBrowserVoice);
    const openaiVoice = usePreferencesStore((state) => state.openaiVoice);
    const setOpenaiVoice = usePreferencesStore((state) => state.setOpenaiVoice);
    const openaiApiKey = usePreferencesStore((state) => state.openaiApiKey);
    const setOpenaiApiKey = usePreferencesStore((state) => state.setOpenaiApiKey);
    const openaiCompatibleUrl = usePreferencesStore((state) => state.openaiCompatibleUrl);
    const setOpenaiCompatibleUrl = usePreferencesStore((state) => state.setOpenaiCompatibleUrl);
    const openaiCompatibleApiKey = usePreferencesStore((state) => state.openaiCompatibleApiKey);
    const setOpenaiCompatibleApiKey = usePreferencesStore((state) => state.setOpenaiCompatibleApiKey);
    const openaiCompatibleVoice = usePreferencesStore((state) => state.openaiCompatibleVoice);
    const setOpenaiCompatibleVoice = usePreferencesStore((state) => state.setOpenaiCompatibleVoice);
    const openaiCompatibleTtsModel = usePreferencesStore((state) => state.openaiCompatibleTtsModel);
    const setOpenaiCompatibleTtsModel = usePreferencesStore((state) => state.setOpenaiCompatibleTtsModel);
    const showMessageTTSButtons = usePreferencesStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = usePreferencesStore((state) => state.ttsInputMode);
    const setTtsInputMode = usePreferencesStore((state) => state.setTtsInputMode);
    // STT settings
    const sttProvider = usePreferencesStore((state) => state.sttProvider);
    const setSttProvider = usePreferencesStore((state) => state.setSttProvider);
    const sttServerUrl = usePreferencesStore((state) => state.sttServerUrl);
    const setSttServerUrl = usePreferencesStore((state) => state.setSttServerUrl);
    const sttApiKey = usePreferencesStore((state) => state.sttApiKey);
    const setSttApiKey = usePreferencesStore((state) => state.setSttApiKey);
    const sttModel = usePreferencesStore((state) => state.sttModel);
    const setSttModel = usePreferencesStore((state) => state.setSttModel);
    const sttLocalModel = usePreferencesStore((state) => state.sttLocalModel);
    const setSttLocalModel = usePreferencesStore((state) => state.setSttLocalModel);
    const sttLanguage = usePreferencesStore((state) => state.sttLanguage);
    const [localModelInfo, setLocalModelInfo] = useState<LocalSttModelStatus>();
    const languageNames = useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
    const localLanguages = useMemo(() => [...(localModelInfo?.languages ?? [])].sort((left, right) =>
        speechLanguageLabel(languageNames, left).localeCompare(speechLanguageLabel(languageNames, right), locale)),
    [localModelInfo, languageNames, locale]);
    let selectedLanguage = sttLanguage.trim().toLowerCase().split('-')[0] || 'auto';
    if (selectedLanguage === 'fil' && localLanguages.includes('tl')) selectedLanguage = 'tl';
    if (selectedLanguage === 'tl' && localLanguages.includes('fil')) selectedLanguage = 'fil';
    if (selectedLanguage === 'jv' && localLanguages.includes('jw')) selectedLanguage = 'jw';
    const setSttLanguage = usePreferencesStore((state) => state.setSttLanguage);
    const sttSilenceThresholdDb = usePreferencesStore((state) => state.sttSilenceThresholdDb);
    const setSttSilenceThresholdDb = usePreferencesStore((state) => state.setSttSilenceThresholdDb);
    const sttSilenceHoldMs = usePreferencesStore((state) => state.sttSilenceHoldMs);
    const setSttSilenceHoldMs = usePreferencesStore((state) => state.setSttSilenceHoldMs);
    const setShowMessageTTSButtons = usePreferencesStore((state) => state.setShowMessageTTSButtons);
    const dictationEnabled = usePreferencesStore((state) => state.dictationEnabled);
    const setDictationEnabled = usePreferencesStore((state) => state.setDictationEnabled);

    const [isSayAvailable, setIsSayAvailable] = useState(false);
    const [sayVoices, setSayVoices] = useState<Array<{ name: string; locale: string }>>([]);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewAudio, setPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isOpenAIAvailable, setIsOpenAIAvailable] = useState(false);
    const [isOpenAIPreviewPlaying, setIsOpenAIPreviewPlaying] = useState(false);
    const [openaiPreviewAudio, setOpenaiPreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [isCompatiblePreviewPlaying, setIsCompatiblePreviewPlaying] = useState(false);
    const [compatiblePreviewAudio, setCompatiblePreviewAudio] = useState<HTMLAudioElement | null>(null);

    const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [isBrowserPreviewPlaying, setIsBrowserPreviewPlaying] = useState(false);

    const persistSttProvider = useCallback((provider: 'local' | 'openai-compatible') => {
        setSttProvider(provider);
        void updateDesktopSettings({ sttProvider: provider });
    }, [setSttProvider]);

    const persistSttServerUrl = useCallback((url: string) => {
        setSttServerUrl(url);
        void updateDesktopSettings({ sttServerUrl: url });
    }, [setSttServerUrl]);

    const persistSttModel = useCallback((model: string) => {
        setSttModel(model);
        void updateDesktopSettings({ sttModel: model });
    }, [setSttModel]);

    const persistSttLocalModel = useCallback((model: string) => {
        setSttLocalModel(model);
        void updateDesktopSettings({ sttLocalModel: model });
    }, [setSttLocalModel]);

    const persistSttLanguage = useCallback((lang: string) => {
        setSttLanguage(lang);
        void updateDesktopSettings({ sttLanguage: lang });
    }, [setSttLanguage]);

    const persistSttSilenceThresholdDb = useCallback((db: number) => {
        setSttSilenceThresholdDb(db);
        void updateDesktopSettings({ sttSilenceThresholdDb: db });
    }, [setSttSilenceThresholdDb]);

    const persistSttSilenceHoldMs = useCallback((ms: number) => {
        setSttSilenceHoldMs(ms);
        void updateDesktopSettings({ sttSilenceHoldMs: ms });
    }, [setSttSilenceHoldMs]);

    useEffect(() => {
        const loadVoices = async () => {
            const voices = await browserVoiceService.waitForVoices();
            setBrowserVoices(voices);
        };
        loadVoices();

        if ('speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                setBrowserVoices(window.speechSynthesis.getVoices());
            };
        }

        return () => {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.onvoiceschanged = null;
            }
        };
    }, []);

    const filteredBrowserVoices = useMemo(() => {
        return browserVoices
            .filter(v => v.lang)
            .sort((a, b) => {
                const aIsEnglish = a.lang.startsWith('en');
                const bIsEnglish = b.lang.startsWith('en');
                if (aIsEnglish && !bIsEnglish) return -1;
                if (!aIsEnglish && bIsEnglish) return 1;
                const langCompare = a.lang.localeCompare(b.lang);
                if (langCompare !== 0) return langCompare;
                return a.name.localeCompare(b.name);
            });
    }, [browserVoices]);

    const previewBrowserVoice = useCallback(() => {
        if (isBrowserPreviewPlaying) {
            browserVoiceService.cancelSpeech();
            setIsBrowserPreviewPlaying(false);
            return;
        }

        const selectedVoice = browserVoices.find(v => v.name === browserVoice);
        const voiceName = selectedVoice?.name ?? t('settings.voice.page.preview.browserVoiceFallback');
        const previewText = t('settings.voice.page.preview.voiceLine', { voiceName });

        setIsBrowserPreviewPlaying(true);

        const utterance = new SpeechSynthesisUtterance(previewText);
        utterance.rate = speechRate;
        utterance.pitch = speechPitch;
        utterance.volume = speechVolume;

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang;
        }

        utterance.onend = () => setIsBrowserPreviewPlaying(false);
        utterance.onerror = () => setIsBrowserPreviewPlaying(false);

        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
    }, [browserVoice, browserVoices, speechRate, speechPitch, speechVolume, isBrowserPreviewPlaying, t]);

    useEffect(() => {
        return () => {
            if (isBrowserPreviewPlaying) {
                browserVoiceService.cancelSpeech();
            }
        };
    }, [isBrowserPreviewPlaying]);

    useEffect(() => {
        if (!showMessageTTSButtons || (voiceProvider !== 'openai' && voiceProvider !== 'openai-compatible')) {
            setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            return;
        }

        const checkOpenAIAvailability = async () => {
            try {
                const response = await runtimeFetch('/api/tts/status');
                const data = await response.json();
                const hasServerKey = data.available;
                const hasSettingsKey = openaiApiKey.trim().length > 0;
                setIsOpenAIAvailable(hasServerKey || hasSettingsKey);
            } catch {
                setIsOpenAIAvailable(openaiApiKey.trim().length > 0);
            }
        };

        checkOpenAIAvailability();
    }, [openaiApiKey, showMessageTTSButtons, voiceProvider]);

    useEffect(() => {
        if (!showMessageTTSButtons) {
            setIsSayAvailable(false);
            setSayVoices([]);
            return;
        }

        runtimeFetch('/api/tts/say/status')
            .then(res => res.json())
            .then(data => {
                setIsSayAvailable(data.available);
                if (data.voices) {
                    const uniqueVoices = data.voices
                        .filter((v: { name: string; locale: string }, i: number, arr: Array<{ name: string; locale: string }>) =>
                            arr.findIndex((x: { name: string }) => x.name === v.name) === i
                        )
                        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
                    setSayVoices(uniqueVoices);
                }
            })
            .catch(() => {
                setIsSayAvailable(false);
            });
    }, [showMessageTTSButtons]);

    const previewVoice = useCallback(async () => {
        if (previewAudio) {
            disposePreviewAudio(previewAudio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
            return;
        }

        setIsPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/say/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: sayVoice }),
                    voice: sayVoice,
                    rate: Math.round(100 + (speechRate - 0.5) * 200),
                }),
            });

            if (!response.ok) throw new Error('Preview failed');

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setPreviewAudio(null);
                setIsPreviewPlaying(false);
            };

            setPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setPreviewAudio(null);
            setIsPreviewPlaying(false);
        }
    }, [sayVoice, speechRate, previewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(previewAudio);
        };
    }, [previewAudio]);

    const previewOpenAIVoice = useCallback(async () => {
        if (openaiPreviewAudio) {
            disposePreviewAudio(openaiPreviewAudio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
            return;
        }

        setIsOpenAIPreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.voiceLine', { voiceName: openaiVoice }),
                    voice: openaiVoice,
                    speed: speechRate,
                    apiKey: openaiApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setOpenaiPreviewAudio(null);
                setIsOpenAIPreviewPlaying(false);
            };

            setOpenaiPreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setOpenaiPreviewAudio(null);
            setIsOpenAIPreviewPlaying(false);
        }
    }, [openaiVoice, speechRate, openaiPreviewAudio, openaiApiKey, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(openaiPreviewAudio);
        };
    }, [openaiPreviewAudio]);

    const previewCompatibleVoice = useCallback(async () => {
        if (compatiblePreviewAudio) {
            disposePreviewAudio(compatiblePreviewAudio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
            return;
        }

        if (!openaiCompatibleUrl.trim()) return;

        setIsCompatiblePreviewPlaying(true);
        let audio: HTMLAudioElement | null = null;
        try {
            const response = await runtimeFetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: t('settings.voice.page.preview.customServerLine'),
                    voice: openaiCompatibleVoice,
                    model: openaiCompatibleTtsModel || undefined,
                    speed: speechRate,
                    baseURL: openaiCompatibleUrl,
                    apiKey: openaiCompatibleApiKey || undefined,
                }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            audio = new Audio(url);

            audio.onended = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            audio.onerror = () => {
                disposePreviewAudio(audio);
                setCompatiblePreviewAudio(null);
                setIsCompatiblePreviewPlaying(false);
            };

            setCompatiblePreviewAudio(audio);
            await audio.play();
        } catch {
            disposePreviewAudio(audio);
            setCompatiblePreviewAudio(null);
            setIsCompatiblePreviewPlaying(false);
        }
    }, [openaiCompatibleUrl, openaiCompatibleVoice, openaiCompatibleTtsModel, openaiCompatibleApiKey, speechRate, compatiblePreviewAudio, t]);

    useEffect(() => {
        return () => {
            disposePreviewAudio(compatiblePreviewAudio);
        };
    }, [compatiblePreviewAudio]);

    const sliderClass = "flex-1 min-w-0 h-1.5 bg-[var(--interactive-border)] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--primary-base)] [&::-moz-range-thumb]:border-0 disabled:opacity-50";

    return (
        <>
            <SettingsSection
                settingsItem="voice.playback"
                title={t('settings.voice.page.section.playbackAndSummary')}
                divider={false}
                contentClassName="space-y-4"
            >
                <SettingsCheckboxRow
                    checked={showMessageTTSButtons}
                    onChange={setShowMessageTTSButtons}
                    label={t('settings.voice.page.field.messageReadAloudButton')}
                    ariaLabel={t('settings.voice.page.field.messageReadAloudButtonAria')}
                />

                {showMessageTTSButtons && (
                    <>
                        <SettingsControlGroup
                            title={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.browser')}</strong> {t('settings.voice.page.tooltip.browser')}</li>
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.localTts')}</li>
                                    <li><strong>{t('settings.voice.page.provider.openai')}</strong> {t('settings.voice.page.tooltip.openai')}</li>
                                    <li><strong>{t('settings.voice.page.provider.custom')}</strong> {t('settings.voice.page.tooltip.custom')}</li>
                                    <li><strong>{t('settings.voice.page.provider.say')}</strong> {t('settings.voice.page.tooltip.say')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={voiceProvider}
                                onChange={setVoiceProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                className="w-full gap-1.5 sm:gap-2"
                                options={[
                                    { value: 'browser', label: t('settings.voice.page.provider.browser') },
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai', label: t('settings.voice.page.provider.openai') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.custom') },
                                    ...(isSayAvailable
                                        ? [{
                                            value: 'say' as const,
                                            label: (
                                                <>
                                                    <Icon name="apple" className="mr-0.5 h-3.5 w-3.5" />
                                                    {t('settings.voice.page.provider.say')}
                                                </>
                                            ),
                                        }]
                                        : []),
                                ]}
                            />
                        </SettingsControlGroup>

                            {/* OpenAI API Key */}
                            {voiceProvider === 'openai' && (
                                <div className="space-y-1.5">
                                    <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !isOpenAIAvailable && "text-[var(--status-error)]")}>
                                        {t('settings.voice.page.field.apiKey')}
                                    </span>
                                    <span className={cn(SETTINGS_HELPER_CLASS, !isOpenAIAvailable && "text-[var(--status-error)]/80")}>
                                        {isOpenAIAvailable && !openaiApiKey
                                          ? t('settings.voice.page.field.apiKeyHintUsingConfig')
                                          : !isOpenAIAvailable
                                            ? t('settings.voice.page.field.apiKeyHintRequired')
                                            : t('settings.voice.page.field.apiKeyHintProvide')}
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="password"
                                            value={openaiApiKey}
                                            onChange={(e) => setOpenaiApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {openaiApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenaiApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <RiCloseLine className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* OpenAI-compatible custom server */}
                            {voiceProvider === 'openai-compatible' && (
                                <div className="space-y-3">
                                    <div className="space-y-1.5">
                                        <span className="flex items-center gap-1.5">
                                            <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !openaiCompatibleUrl.trim() && "text-[var(--status-error)]")}>
                                                {t('settings.voice.page.field.serverUrl')}
                                            </span>
                                            <SettingsInfoHint>{t('settings.voice.page.field.serverUrlHint')}</SettingsInfoHint>
                                        </span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="text"
                                                value={openaiCompatibleUrl}
                                                onChange={(e) => setOpenaiCompatibleUrl(e.target.value)}
                                                placeholder="http://localhost:8880/v1"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleUrl && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleUrl('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <RiCloseLine className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className={SETTINGS_FIELD_LABEL_CLASS}>API Key</span>
                                        <span className={SETTINGS_HELPER_CLASS}>
                                            Optional
                                        </span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="password"
                                                value={openaiCompatibleApiKey}
                                                onChange={(e) => setOpenaiCompatibleApiKey(e.target.value)}
                                                placeholder="sk-..."
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                            {openaiCompatibleApiKey && (
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenaiCompatibleApiKey('')}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                >
                                                    <Icon name="close" className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                        <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <input
                                                type="text"
                                                value={openaiCompatibleTtsModel}
                                                onChange={(e) => setOpenaiCompatibleTtsModel(e.target.value)}
                                                placeholder="speaches-ai/Kokoro-82M-v1.0-ONNX"
                                                className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <span className="flex items-center gap-1.5">
                                            <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.voice')}</span>
                                            <SettingsInfoHint>{t('settings.voice.page.field.voiceIdentifierHint')}</SettingsInfoHint>
                                        </span>
                                        <div className={cn('flex items-center gap-2', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                            <div className="relative min-w-0 flex-1">
                                                <input
                                                    type="text"
                                                    value={openaiCompatibleVoice}
                                                    onChange={(e) => setOpenaiCompatibleVoice(e.target.value)}
                                                    placeholder="af_sky"
                                                    className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                                />
                                            </div>
                                            <Button size="xs" variant="ghost" onClick={previewCompatibleVoice} title={t('settings.voice.page.actions.preview')} disabled={!openaiCompatibleUrl.trim()}>
                                                {isCompatiblePreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Local (Kokoro) TTS model status */}
                            {voiceProvider === 'local' && <LocalTtsModelStatus />}

                            {/* Voice Selection */}
                            <SettingsFieldRow label={t('settings.voice.page.field.voice')}>
                                    {voiceProvider === 'local' && (
                                        <>
                                            <Select
                                                value={String(localTtsVoiceId)}
                                                onValueChange={(value) => setLocalTtsVoiceId(Number.parseInt(value, 10) || 0)}
                                            >
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')}>
                                                        {(value) => KOKORO_VOICE_OPTIONS.find((v) => String(v.id) === value)?.label ?? value}
                                                    </SelectValue>
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {KOKORO_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.id} value={String(v.id)}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewLocalVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isLocalTtsPlaying ? <Icon name="stop" className="w-3.5 h-3.5" /> : <Icon name="play" className="w-3.5 h-3.5" />}
                                            </Button>
                                            {localTtsError ? (
                                                <span className="typography-meta text-[var(--status-error)]">{localTtsError}</span>
                                            ) : null}
                                        </>
                                    )}

                                    {voiceProvider === 'openai' && isOpenAIAvailable && (
                                        <>
                                            <Select value={openaiVoice} onValueChange={setOpenaiVoice}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {OPENAI_VOICE_OPTIONS.map((v) => (
                                                        <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewOpenAIVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isOpenAIPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'openai-compatible' && (
                                        <span className={SETTINGS_HELPER_CLASS}>{t('settings.voice.page.field.configuredAbove')}</span>
                                    )}

                                    {voiceProvider === 'say' && isSayAvailable && sayVoices.length > 0 && (
                                        <>
                                            <Select value={sayVoice} onValueChange={setSayVoice}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.selectVoicePlaceholder')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {sayVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}

                                    {voiceProvider === 'browser' && filteredBrowserVoices.length > 0 && (
                                        <>
                                            <Select value={browserVoice || '$auto'} onValueChange={(value) => setBrowserVoice(value === '$auto' ? '' : value)}>
                                                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                                                    <SelectValue placeholder={t('settings.voice.page.field.auto')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="__auto__">{t('settings.voice.page.field.auto')}</SelectItem>
                                                    {filteredBrowserVoices.map((v) => (
                                                        <SelectItem key={v.name} value={v.name}>{v.name} ({v.lang})</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button size="xs" variant="ghost" onClick={previewBrowserVoice} title={t('settings.voice.page.actions.preview')}>
                                                {isBrowserPreviewPlaying ? <RiStopLine className="w-3.5 h-3.5" /> : <RiPlayLine className="w-3.5 h-3.5" />}
                                            </Button>
                                        </>
                                    )}
                            </SettingsFieldRow>

                            {/* Speech Rate */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechRate')}>
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechRate} onChange={(e) => setSpeechRate(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechRate} onValueChange={setSpeechRate} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                            </SettingsFieldRow>

                            {/* Speech Pitch */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechPitch')}>
                                    {!isMobile && <input type="range" min={0.5} max={2} step={0.1} value={speechPitch} onChange={(e) => setSpeechPitch(Number(e.target.value))} className={sliderClass} />}
                                    <NumberInput value={speechPitch} onValueChange={setSpeechPitch} min={0.5} max={2} step={0.1} className="w-16 tabular-nums" />
                            </SettingsFieldRow>

                            {/* Speech Volume */}
                            <SettingsFieldRow label={t('settings.voice.page.field.speechVolume')}>
                                    {!isMobile && <input type="range" min={0} max={1} step={0.1} value={speechVolume} onChange={(e) => setSpeechVolume(Number(e.target.value))} className={sliderClass} />}
                                    {isMobile ? (
                                        <NumberInput value={Math.round(speechVolume * 100)} onValueChange={(v) => setSpeechVolume(v / 100)} min={0} max={100} step={10} className="w-16 tabular-nums" />
                                    ) : (
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3rem] text-right">
                                            {Math.round(speechVolume * 100)}%
                                        </span>
                                    )}
                            </SettingsFieldRow>

                            <SettingsControlGroup title={t('settings.voice.page.field.ttsInputMode')}>
                                <SettingsChipGroup
                                    value={ttsInputMode}
                                    onChange={setTtsInputMode}
                                    aria-label={t('settings.voice.page.field.ttsInputMode')}
                                    className="w-full gap-1.5 sm:gap-2"
                                    options={[
                                        { value: 'sanitized', label: t('settings.voice.page.field.ttsInputModeSanitized') },
                                        { value: 'raw', label: t('settings.voice.page.field.ttsInputModeRaw') },
                                        { value: 'summarized', label: t('settings.voice.page.field.ttsInputModeSummarized') },
                                    ]}
                                />
                            </SettingsControlGroup>
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                settingsItem="voice.speech-recognition"
                title={t('settings.voice.page.section.speechRecognition')}
                contentClassName="space-y-4"
            >
                <SettingsCheckboxRow
                    checked={dictationEnabled}
                    onChange={setDictationEnabled}
                    label={t('settings.voice.page.field.enableVoiceInput')}
                    ariaLabel={t('settings.voice.page.field.enableVoiceInputAria')}
                />

                {dictationEnabled && (
                    <>
                        <SettingsControlGroup
                            title={t('settings.voice.page.field.provider')}
                            info={(
                                <ul className="space-y-1">
                                    <li><strong>{t('settings.voice.page.provider.local')}</strong> {t('settings.voice.page.tooltip.sttLocal')}</li>
                                    <li><strong>{t('settings.voice.page.provider.server')}</strong> {t('settings.voice.page.tooltip.sttServer')}</li>
                                </ul>
                            )}
                        >
                            <SettingsChipGroup
                                value={sttProvider}
                                onChange={persistSttProvider}
                                aria-label={t('settings.voice.page.field.provider')}
                                className="w-full gap-1.5 sm:gap-2"
                                options={[
                                    { value: 'local', label: t('settings.voice.page.provider.local') },
                                    { value: 'openai-compatible', label: t('settings.voice.page.provider.server') },
                                ]}
                            />
                        </SettingsControlGroup>

                        {sttProvider === 'local' && (
                            <div className="space-y-1.5">
                                <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                <LocalSttModelPicker selectedModelId={sttLocalModel} onSelect={persistSttLocalModel} onSelectionInfo={setLocalModelInfo} />
                            </div>
                        )}

                        {sttProvider === 'openai-compatible' && (
                            <div className="space-y-3">
                                <div className="space-y-1.5">
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn(SETTINGS_FIELD_LABEL_CLASS, !sttServerUrl.trim() && "text-[var(--status-error)]")}>
                                            {t('settings.voice.page.field.serverUrl')}
                                        </span>
                                        <SettingsInfoHint>{t('settings.voice.page.field.sttServerUrlHint')}</SettingsInfoHint>
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="text"
                                            value={sttServerUrl}
                                            onChange={(e) => persistSttServerUrl(e.target.value)}
                                            placeholder="http://localhost:8001/v1"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttServerUrl && (
                                            <button
                                                type="button"
                                                onClick={() => persistSttServerUrl('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <RiCloseLine className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <span className={SETTINGS_FIELD_LABEL_CLASS}>API Key</span>
                                    <span className={SETTINGS_HELPER_CLASS}>
                                        Optional
                                    </span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="password"
                                            value={sttApiKey}
                                            onChange={(e) => setSttApiKey(e.target.value)}
                                            placeholder="sk-..."
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                        {sttApiKey && (
                                            <button
                                                type="button"
                                                onClick={() => setSttApiKey('')}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                            >
                                                <Icon name="close" className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.voice.page.field.model')}</span>
                                    <div className={cn('relative', SETTINGS_CONTROL_CLUSTER_CLASS)}>
                                        <input
                                            type="text"
                                            value={sttModel}
                                            onChange={(e) => persistSttModel(e.target.value)}
                                            placeholder="deepdml/faster-whisper-large-v3-turbo-ct2"
                                            className="w-full h-7 rounded-lg border border-input bg-transparent px-2 typography-ui-label text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/70"
                                        />
                                    </div>
                                </div>
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceThreshold')}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={-60} max={-20} step={1} value={sttSilenceThresholdDb} onChange={(e) => persistSttSilenceThresholdDb(Number(e.target.value))} className={sliderClass} />}
                                        <span className="typography-ui-label text-foreground tabular-nums min-w-[3.5rem] text-right">
                                            {sttSilenceThresholdDb} dB
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-8 py-0.5">
                                    <span className="typography-ui-label text-foreground sm:w-56 shrink-0">{t('settings.voice.page.field.silenceHold')}</span>
                                    <div className="flex items-center gap-2 w-fit">
                                        {!isMobile && <input type="range" min={500} max={3000} step={100} value={sttSilenceHoldMs} onChange={(e) => persistSttSilenceHoldMs(Number(e.target.value))} className={sliderClass} />}
                                        <NumberInput value={sttSilenceHoldMs} onValueChange={persistSttSilenceHoldMs} min={500} max={3000} step={100} className="w-20 tabular-nums" />
                                        <span className="typography-meta text-muted-foreground">{t('settings.voice.page.field.millisecondsUnit')}</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <SettingsFieldRow label={t('settings.voice.page.field.language')}>
                            {sttProvider === 'local' && localModelInfo?.supportsLanguageSelection === false
                                ? <span className="typography-ui-label text-muted-foreground">{t('settings.voice.page.stt.autoLanguage')}</span>
                                : sttProvider === 'local' ? <Select value={selectedLanguage} onValueChange={(value) => persistSttLanguage(value === 'auto' ? '' : value)}>
                                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.voice.page.field.language')}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="auto">{t('settings.voice.page.stt.autoLanguage')}</SelectItem>
                                        {selectedLanguage !== 'auto' && !localLanguages.includes(selectedLanguage) ? <SelectItem value={selectedLanguage} disabled>
                                            {speechLanguageLabel(languageNames, selectedLanguage)}
                                        </SelectItem> : null}
                                        {localLanguages.map(code => <SelectItem key={code} value={code}>{speechLanguageLabel(languageNames, code)}</SelectItem>)}
                                    </SelectContent>
                                </Select> : <div className="flex items-center gap-2">
                                    <input type="text" value={sttLanguage} onChange={(event) => persistSttLanguage(event.target.value)} placeholder="auto"
                                        aria-label={t('settings.voice.page.field.language')}
                                        className="h-7 w-28 rounded-lg border border-input bg-transparent px-2 typography-ui-label focus:outline-none focus:ring-1 focus:ring-primary/50" />
                                    <SettingsInfoHint>{t('settings.voice.page.field.sttLanguageHint')}</SettingsInfoHint>
                                </div>}
                        </SettingsFieldRow>
                    </>
                )}
            </SettingsSection>
        </>
    );
};
