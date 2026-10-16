/**
 * useMessageTTS Hook
 *
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useCallback, useState } from 'react';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useThreadStore, selectedComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { sanitizeForTTS } from '@/lib/voice/summarize';
import { generateModelText } from '@/lib/modelText';

// Below this length the reply is comfortable to listen to as-is; summarizing
// would only add latency.
const TTS_SUMMARIZE_MIN_CHARS = 600;

const SUMMARIZE_SYSTEM_PROMPT = 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.';

async function summarizeForSpeech(
    text: string,
    preferred: { providerID?: string; modelID?: string },
): Promise<string | null> {
    try {
        const result = await generateModelText({ key: crypto.randomUUID(), purpose: 'text', prompt: text, system: SUMMARIZE_SYSTEM_PROMPT, ...(preferred.providerID && preferred.modelID ? { model: { providerId: preferred.providerID, modelId: preferred.modelID } } : {}) });
        return result.text.trim() || null;
    } catch {
        return null;
    }
}

export interface UseMessageTTSReturn {
    /** Whether TTS is currently playing for this message */
    isPlaying: boolean;
    /** Play the message text */
    play: (text: string) => Promise<void>;
    /** Stop playback */
    stop: () => void;
}

export function useMessageTTS(): UseMessageTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);

    const voiceProvider = usePreferencesStore((state) => state.voiceProvider);
    const speechRate = usePreferencesStore((state) => state.speechRate);
    const speechPitch = usePreferencesStore((state) => state.speechPitch);
    const speechVolume = usePreferencesStore((state) => state.speechVolume);
    const sayVoice = usePreferencesStore((state) => state.sayVoice);
    const localTtsVoiceId = usePreferencesStore((state) => state.localTtsVoiceId);
    const browserVoice = usePreferencesStore((state) => state.browserVoice);
    const openaiVoice = usePreferencesStore((state) => state.openaiVoice);
    const openaiCompatibleVoice = usePreferencesStore((state) => state.openaiCompatibleVoice);
    const openaiCompatibleUrl = usePreferencesStore((state) => state.openaiCompatibleUrl);
    const openaiCompatibleTtsModel = usePreferencesStore((state) => state.openaiCompatibleTtsModel);
    const showMessageTTSButtons = usePreferencesStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = usePreferencesStore((state) => state.ttsInputMode);
    const composerKey = useThreadStore(selectedComposerKey);
    const currentModel = useThreadDraftStore(state => composerKey ? state.drafts[composerKey]?.model : undefined);

    const isServerProvider = voiceProvider === 'openai' || voiceProvider === 'openai-compatible';
    const shouldCheckOpenAIAvailability = showMessageTTSButtons && isServerProvider;
    const shouldCheckSayAvailability = showMessageTTSButtons && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, isAvailable: isServerTTSAvailable } = useServerTTS({
        enabled: shouldCheckOpenAIAvailability,
        availabilityMode: voiceProvider === 'openai-compatible' ? 'openai-compatible' : 'openai',
    });
    const { speak: speakSayTTS, stop: stopSayTTS, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS } = useLocalTTS();

    const stop = useCallback(() => {
        setIsPlaying(false);
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        browserVoiceService.cancelSpeech();
    }, [stopServerTTS, stopSayTTS, stopLocalTTS]);

    const play = useCallback(async (text: string) => {
        if (!text.trim()) return;

        // Stop any existing playback
        stop();

        setIsPlaying(true);

        try {
            // Summarized mode: replace long replies with a short spoken-prose
            // summary from the small model; fall back to the sanitized
            // original when summarization is unavailable.
            let sourceText = text;
            if (ttsInputMode === 'summarized' && text.length >= TTS_SUMMARIZE_MIN_CHARS) {
                const summary = await summarizeForSpeech(text, {
                    providerID: currentModel?.providerId,
                    modelID: currentModel?.modelId,
                });
                if (summary) {
                    sourceText = summary;
                }
            }

            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(sourceText);
            const textToSpeak = shouldUseRaw ? sourceText : sanitizedText;

            if (isServerProvider && isServerTTSAvailable) {
                const voice = voiceProvider === 'openai-compatible' ? openaiCompatibleVoice : openaiVoice;
                const baseURL = voiceProvider === 'openai-compatible' ? openaiCompatibleUrl : undefined;
                const model = voiceProvider === 'openai-compatible' ? openaiCompatibleTtsModel : undefined;
                await speakServerTTS(textToSpeak, {
                    voice,
                    model,
                    speed: speechRate,
                    pitch: speechPitch,
                    volume: speechVolume,
                    summarize: false,
                    baseURL,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else if (voiceProvider === 'local') {
                await speakLocalTTS(sanitizedText, {
                    speakerId: localTtsVoiceId,
                    speed: speechRate,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                const wordsPerMinute = Math.round(100 + (speechRate - 0.5) * 200);
                await speakSayTTS(sanitizedText, {
                    voice: sayVoice,
                    rate: wordsPerMinute,
                    onEnd: () => setIsPlaying(false),
                    onError: () => setIsPlaying(false),
                });
            } else {
                // Browser TTS
                await browserVoiceService.waitForVoices();
                await browserVoiceService.resumeAudioContext();
                await browserVoiceService.speakText(
                    sanitizedText,
                    navigator.language || 'en-US',
                    () => setIsPlaying(false),
                    {
                        rate: speechRate,
                        pitch: speechPitch,
                        volume: speechVolume,
                        voiceName: browserVoice || undefined,
                    }
                );
            }
        } catch (err) {
            console.error('[useMessageTTS] Playback error:', err);
            setIsPlaying(false);
        }
    }, [
        voiceProvider,
        isServerProvider,
        speechRate,
        speechPitch,
        speechVolume,
        sayVoice,
        browserVoice,
        openaiVoice,
        openaiCompatibleVoice,
        openaiCompatibleUrl,
        openaiCompatibleTtsModel,
        isServerTTSAvailable,
        isSayTTSAvailable,
        ttsInputMode,
        currentModel,
        speakServerTTS,
        speakSayTTS,
        speakLocalTTS,
        localTtsVoiceId,
        stop,
    ]);

    return {
        isPlaying,
        play,
        stop,
    };
}
