/**
 * Sherpa-onnx offline recognizer engine for the managed STT catalog, plus a
 * realtime streaming transcription session that re-decodes the accumulated
 * segment audio on a throttle to produce live partial transcripts.
 *
 * Runs inside the dictation worker process only — never load the native
 * addon in the main server process.
 */

import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import { pcm16lePeakAbs, pcm16leToFloat32 } from '../audio.js';
import type { SherpaOfflineRecognizer, SherpaOfflineStream } from '../types.js';

export type RecognizerConfig = { numThreads?: number; language?: string; featureDim?: number } & (
  | { encoder: string; decoder: string; tokens: string; joiner: string; type: 'nemo_transducer' }
  | { encoder: string; decoder: string; tokens: string; type: 'whisper' }
  | { model: string; tokens: string; type: 'sense_voice' }
  | { convFrontend: string; encoder: string; decoder: string; tokenizer: string; type: 'qwen3_asr' }
);

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export class SherpaOfflineRecognizerEngine {
  readonly recognizer: SherpaOfflineRecognizer;
  readonly sampleRate: number;
  private readonly streamLanguage: string;

  constructor(config: RecognizerConfig) {
    const modelConfig: Record<string, unknown> = { numThreads: config.numThreads ?? 2, provider: 'cpu', debug: 0 };
    const paths: Record<string, string> = {};
    this.streamLanguage = '';
    switch (config.type) {
      case 'whisper':
        Object.assign(paths, { encoder: config.encoder, decoder: config.decoder, tokens: config.tokens });
        Object.assign(modelConfig, { whisper: { encoder: config.encoder, decoder: config.decoder,
          language: config.language ?? '', task: 'transcribe', tailPaddings: -1 }, tokens: config.tokens, modelType: 'whisper' });
        break;
      case 'nemo_transducer':
        Object.assign(paths, { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner, tokens: config.tokens });
        Object.assign(modelConfig, { transducer: { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner },
          tokens: config.tokens, modelType: 'nemo_transducer' });
        break;
      case 'sense_voice':
        Object.assign(paths, { model: config.model, tokens: config.tokens });
        Object.assign(modelConfig, { senseVoice: { model: config.model, language: config.language || 'auto',
          useInverseTextNormalization: 1 }, tokens: config.tokens });
        break;
      case 'qwen3_asr':
        Object.assign(paths, { convFrontend: config.convFrontend, encoder: config.encoder, decoder: config.decoder, tokenizer: config.tokenizer });
        Object.assign(modelConfig, { qwen3Asr: { convFrontend: config.convFrontend, encoder: config.encoder,
          decoder: config.decoder, tokenizer: config.tokenizer }, tokens: '' });
        this.streamLanguage = config.language ?? '';
        break;
    }
    for (const [role, filename] of Object.entries(paths)) assertFileExists(filename, role);
    const sherpa = loadSherpaOnnxNode();
    const featConfig = { sampleRate: 16000, featureDim: config.featureDim ?? 80 };
    const recognizerConfig: Record<string, unknown> = {
      featConfig,
      modelConfig,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    };

    this.recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
    const sr = this.recognizer?.config?.featConfig?.sampleRate;
    this.sampleRate =
      typeof sr === 'number' && Number.isFinite(sr) && sr > 0
        ? sr
        : featConfig.sampleRate;
  }

  createStream(): SherpaOfflineStream {
    const stream = this.recognizer.createStream();
    if (this.streamLanguage) {
      if (!stream.setOption) throw new Error('The speech runtime cannot apply the selected language');
      stream.setOption('language', this.streamLanguage);
    }
    return stream;
  }

  acceptWaveform(stream: SherpaOfflineStream, sampleRate: number, samples: Float32Array): void {
    if (!stream || typeof stream.acceptWaveform !== 'function') {
      throw new Error('Unexpected sherpa offline stream: missing acceptWaveform()');
    }
    // sherpa-onnx-node expects acceptWaveform({ samples, sampleRate });
    // the WASM build expects acceptWaveform(sampleRate, samples).
    if (stream.acceptWaveform.length <= 1) {
      stream.acceptWaveform({ samples, sampleRate });
    } else {
      stream.acceptWaveform(sampleRate, samples);
    }
  }

  /**
   * Decode a full PCM16 segment and return its text.
   * Applies auto-gain when the peak is low so quiet microphones still decode.
   * @param {Buffer} pcm16
   * @returns {string}
   */
  decodePcm16(pcm16: Buffer): string {
    if (pcm16.length === 0) {
      return '';
    }

    const peak = pcm16lePeakAbs(pcm16);
    const peakFloat = peak / 32768.0;
    const targetPeak = 0.6;
    const maxGain = 50;
    const gain =
      peakFloat > 0 && peakFloat < targetPeak ? Math.min(maxGain, targetPeak / peakFloat) : 1;

    const stream = this.createStream();
    try {
      const floatSamples = pcm16leToFloat32(pcm16, gain);
      this.acceptWaveform(stream, this.sampleRate, floatSamples);
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      const text =
        typeof result === 'object' && result && 'text' in result ? result.text : result;
      return String(text ?? '').trim();
    } finally {
      try {
        stream.free?.();
      } catch {
        // ignore
      }
    }
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Streaming transcription session backed by the offline recognizer.
 * Accumulates the current segment's PCM and re-decodes it at most every
 * `minDecodeIntervalMs` to emit non-final partial transcripts; `commit()`
 * finalizes the segment and starts a new one.
 *
 * Implements the StreamingTranscriptionSession contract used by
 * DictationStreamManager.
 */
export class SherpaRealtimeTranscriptionSession extends EventEmitter {
  readonly engine: SherpaOfflineRecognizerEngine;
  readonly requiredSampleRate: number;
  minDecodeIntervalMs: number;
  private connected: boolean;
  private currentSegmentId: string | null;
  private previousSegmentId: string | null;
  private lastPartialText: string;
  private pcm16: Buffer;
  private lastDecodeAt: number;
  private lastDecodedBytes: number;
  private decoding: boolean;
  private pendingDecode: boolean;

  /**
   * @param {{ engine: SherpaOfflineRecognizerEngine, minDecodeIntervalMs?: number }} params
   */
  constructor({ engine, minDecodeIntervalMs }: {
    engine: SherpaOfflineRecognizerEngine;
    minDecodeIntervalMs?: number;
  }) {
    super();
    this.engine = engine;
    this.requiredSampleRate = engine.sampleRate;
    this.minDecodeIntervalMs = minDecodeIntervalMs ?? 350;
    this.connected = false;
    this.currentSegmentId = null;
    this.previousSegmentId = null;
    this.lastPartialText = '';
    this.pcm16 = Buffer.alloc(0);
    this.lastDecodeAt = 0;
    this.lastDecodedBytes = 0;
    this.decoding = false;
    this.pendingDecode = false;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.currentSegmentId = randomUUID();
    this.connected = true;
  }

  appendPcm16(chunk: Buffer): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa realtime session not connected'));
      return;
    }
    this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
    this.maybeDecode(false).catch((err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  commit(): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit('error', new Error('Sherpa realtime session not connected'));
      return;
    }

    void (async () => {
      try {
        await this.maybeDecode(true);
        const finalText = this.lastPartialText;
        const segmentId = this.currentSegmentId;
        const previousSegmentId = this.previousSegmentId;

        this.emit('committed', { segmentId, previousSegmentId });
        this.emit('transcript', { segmentId, transcript: finalText, isFinal: true });

        this.previousSegmentId = segmentId;
        this.currentSegmentId = randomUUID();
        this.lastPartialText = '';
        this.pcm16 = Buffer.alloc(0);
        this.lastDecodedBytes = 0;
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  clear(): void {
    if (!this.connected) {
      return;
    }
    this.pcm16 = Buffer.alloc(0);
    this.lastDecodedBytes = 0;
    this.currentSegmentId = randomUUID();
    this.lastPartialText = '';
  }

  close(): void {
    this.connected = false;
    this.currentSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
    this.lastDecodedBytes = 0;
  }

  async maybeDecode(force: boolean): Promise<void> {
    if (!this.connected || !this.currentSegmentId) {
      return;
    }
    // Finalizing the same audio only changes transcript finality. Reuse the
    // decoded text instead of repeating the native inference.
    if (this.pcm16.length === this.lastDecodedBytes) return;

    const now = Date.now();
    if (!force && now - this.lastDecodeAt < this.minDecodeIntervalMs) {
      return;
    }

    if (this.decoding) {
      this.pendingDecode = true;
      return;
    }

    this.decoding = true;
    try {
      const decodeStartedAt = Date.now();
      const text = this.engine.decodePcm16(this.pcm16);
      this.lastDecodedBytes = this.pcm16.length;
      this.lastDecodeAt = Date.now();
      // Adaptive throttle: on slow hardware (or heavy models) re-decoding the
      // growing segment every 350ms would monopolize the worker. Space partial
      // decodes to ~1.5x the observed decode time.
      this.minDecodeIntervalMs = Math.max(350, (this.lastDecodeAt - decodeStartedAt) * 1.5);
      if (text !== this.lastPartialText) {
        this.lastPartialText = text;
        this.emit('transcript', {
          segmentId: this.currentSegmentId,
          transcript: text,
          isFinal: false,
        });
      }
    } finally {
      this.decoding = false;
      if (this.pendingDecode) {
        this.pendingDecode = false;
        await this.maybeDecode(true);
      }
    }
  }
}
