/**
 * Sherpa-onnx offline TTS (Kokoro). Runs inside the dictation worker process
 * only — never load the native addon in the main server process.
 */

import { existsSync } from 'fs';
import path from 'path';

import { loadSherpaOnnxNode } from './sherpa-loader.js';
import type { SherpaOfflineTts } from '../types.js';

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function float32ToPcm16le(samples: Float32Array): Buffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export class SherpaTtsEngine {
  readonly tts: SherpaOfflineTts;

  /**
   * @param {{ modelDir: string, files: { model: string, voices: string, tokens: string, espeakData: string }, numThreads?: number }} config
   */
  constructor(config: {
    files: { espeakData: string; model: string; tokens: string; voices: string };
    modelDir: string;
    numThreads?: number;
  }) {
    const modelPath = path.join(config.modelDir, config.files.model);
    const voicesPath = path.join(config.modelDir, config.files.voices);
    const tokensPath = path.join(config.modelDir, config.files.tokens);
    const dataDir = path.join(config.modelDir, config.files.espeakData);

    assertFileExists(modelPath, 'TTS model');
    assertFileExists(voicesPath, 'TTS voices');
    assertFileExists(tokensPath, 'TTS tokens');
    assertFileExists(dataDir, 'TTS espeak-ng dataDir');

    const sherpa = loadSherpaOnnxNode();
    const OfflineTts = sherpa.OfflineTts;
    if (typeof OfflineTts !== 'function') {
      throw new Error('sherpa-onnx-node OfflineTts is unavailable');
    }

    this.tts = new OfflineTts({
      model: {
        kokoro: {
          model: modelPath,
          voices: voicesPath,
          tokens: tokensPath,
          dataDir,
          lengthScale: 1.0,
        },
        numThreads: config.numThreads ?? 2,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    });
  }

  /**
   * Synthesize text to PCM16LE.
   * @param {string} text
   * @param {{ speakerId?: number, speed?: number }} [options]
   * @returns {{ pcm16: Buffer, sampleRate: number }}
   */
  synthesize(text: string, options: { speakerId?: number; speed?: number } = {}): {
    pcm16: Buffer;
    sampleRate: number;
  } {
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      throw new Error('Cannot synthesize empty text');
    }

    const audio = this.tts.generate({
      text: trimmed,
      generationConfig: {
        sid: Number.isInteger(options.speakerId) ? options.speakerId : 0,
        speed: typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1.0,
      },
      // Request a copied buffer from sherpa itself: native external-backed
      // typed arrays are rejected by Electron.
      enableExternalBuffer: false,
    });

    const value = audio && typeof audio === 'object' ? audio as Record<string, unknown> : {};
    let samples: Float32Array | null = null;
    if (value.samples instanceof Float32Array) {
      samples = Float32Array.from(value.samples);
    } else if (Array.isArray(value.samples)) {
      samples = Float32Array.from(value.samples.filter((sample): sample is number => typeof sample === 'number'));
    }
    if (!samples) {
      throw new Error('Unexpected sherpa TTS output: missing Float32 samples');
    }

    const sampleRate =
      typeof value.sampleRate === 'number' && value.sampleRate > 0
        ? value.sampleRate
        : typeof this.tts.sampleRate === 'number' && this.tts.sampleRate > 0
          ? this.tts.sampleRate
          : 24000;

    return { pcm16: float32ToPcm16le(samples), sampleRate };
  }

  free(): void {
    try {
      this.tts?.free?.();
    } catch {
      // ignore
    }
  }
}
