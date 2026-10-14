/**
 * Server-side Text-to-Speech Service
 *
 * Uses OpenAI's TTS API to generate audio on the server and stream it to clients.
 * This bypasses mobile Safari's audio context restrictions.
 */

import OpenAI from 'openai';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

// Voice options from OpenAI
export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
] as const;
export type TTSVoice = typeof TTS_VOICES[number];

function getOpenAIApiKey(): string | null {
  // Speech uses its explicitly supplied credential or the Host environment.
  // Conversation accounts are separate and are never discovered or imported.
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export interface GenerateSpeechOptions {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  instructions?: string | undefined;
  model?: string | undefined;
  speed?: number | undefined;
  text: string;
  voice?: string | undefined;
}

export class TTSService {
  private _client: OpenAI | null;
  private _lastApiKey: string | null;
  constructor() {
    this._client = null;
    this._lastApiKey = null;
  }

  private _getClient(): OpenAI | null {
    const apiKey = getOpenAIApiKey();

    if (!apiKey) {
      this._client = null;
      this._lastApiKey = null;
      return null;
    }

    // If API key changed or client doesn't exist, create new client
    if (apiKey && (!this._client || this._lastApiKey !== apiKey)) {
      this._client = new OpenAI({ apiKey });
      this._lastApiKey = apiKey;
    }

    return this._client;
  }

  isAvailable(): boolean {
    return this._getClient() !== null;
  }

  /**
   * Generate speech and return as a stream
   */
  async generateSpeechStream(options: GenerateSpeechOptions): Promise<{ buffer: Buffer; contentType: string }> {
    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions,
      apiKey,
      baseURL,
    } = options;

    const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
    if (normalizedBaseURLResult.error) {
      throw new Error(normalizedBaseURLResult.error);
    }
    const normalizedBaseURL = normalizedBaseURLResult.value;

    // Use provided API key / baseURL or fall back to configured key
    let client;
    if (normalizedBaseURL || apiKey) {
      const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: 'not-required' };
      if (apiKey) clientOpts.apiKey = apiKey;
      if (!apiKey) clientOpts.apiKey = 'not-required';
      if (normalizedBaseURL) clientOpts.baseURL = normalizedBaseURL;
      client = new OpenAI(clientOpts);
    } else {
      client = this._getClient();
    }

    if (!client) {
      throw new Error('TTS service not available. Set OPENAI_API_KEY on the Host, provide a speech API key, or set a custom server URL in settings.');
    }

    if (!text.trim()) {
      throw new Error('Text is required for TTS');
    }

    try {
      // OpenAI-compatible servers (custom baseURL) may not support `instructions`
      // or `response_format`, but do support `speed`. Send the safe subset.
      const speechParams = normalizedBaseURL
        ? { model, voice, input: text, speed }
        : {
            model,
            voice,
            input: text,
            speed,
            ...(instructions && { instructions }),
            response_format: 'mp3',
          };

      console.log('[TTSService] Generating speech — model:', model, 'voice:', voice, 'baseURL:', normalizedBaseURL ?? '(openai)');
      const response = await client.audio.speech.create(speechParams as Parameters<typeof client.audio.speech.create>[0]);

      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: 'audio/mpeg',
      };
    } catch (error) {
      console.error('[TTSService] Error generating speech:', error);
      throw new Error(`Failed to generate speech: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate speech and return as a buffer (for caching)
   */
  async generateSpeechBuffer(options: GenerateSpeechOptions): Promise<Buffer> {
    return (await this.generateSpeechStream(options)).buffer;
  }
}

// Export singleton instance
export const ttsService = new TTSService();
