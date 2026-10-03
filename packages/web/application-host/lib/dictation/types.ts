import type { EventEmitter } from 'node:events';
import type { Pcm16MonoResampler } from './audio.js';

export interface DictationStartOptions {
  language?: string;
  localModel?: string;
  openaiCompatible?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  provider?: string;
}

export interface DictationEvent {
  payload: Record<string, unknown>;
  type: string;
}

export interface StreamingTranscriptionSession extends EventEmitter {
  appendPcm16(chunk: Buffer): void;
  clear(): void;
  close(): void;
  commit(): void;
  requiredSampleRate: number;
}

export type SttSessionResolution =
  | { session: StreamingTranscriptionSession }
  | { error: string; reasonCode?: string; retryable: boolean };

export interface DictationStreamState {
  ackSeq: number;
  autoCommitBytes: number;
  awaitingFinalCommit: boolean;
  bytesSinceCommit: number;
  committedSegmentIds: string[];
  dictationId: string;
  finalSeq: number | null;
  finalTimeout: ReturnType<typeof setTimeout> | null;
  finalTranscriptSegmentIds: Set<string>;
  finishRequested: boolean;
  finishSealed: boolean;
  inputFormat: string;
  inputRate: number;
  nextSeqToForward: number;
  outputRate: number;
  peakSinceCommit: number;
  receivedChunks: Map<number, Buffer>;
  resampler: Pcm16MonoResampler | null;
  stt: StreamingTranscriptionSession;
  transcriptsBySegmentId: Map<string, string>;
}

export interface LocalSpeechModelFiles {
  convFrontend?: string;
  decoder?: string;
  encoder?: string;
  espeakData?: string;
  joiner?: string;
  model?: string;
  tokenizer?: string;
  tokens?: string;
  voices?: string;
}

export interface LocalSpeechModelSpec {
  archiveUrl: string;
  featureDim?: number;
  description: string;
  extractedDir: string;
  files: LocalSpeechModelFiles;
  type: 'nemo_transducer' | 'whisper' | 'sense_voice' | 'qwen3_asr' | 'kokoro';
}

export type LocalSpeechModelCatalog = Record<string, LocalSpeechModelSpec>;

export interface SherpaOfflineStream {
  acceptWaveform(...args: unknown[]): void;
  setOption?(key: string, value: string): void;
  free?(): void;
}

export interface SherpaOfflineRecognizer {
  config?: { featConfig?: { sampleRate?: number } };
  createStream(): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  free?(): void;
  getResult(stream: SherpaOfflineStream): unknown;
}

export interface SherpaOfflineTts {
  free?(): void;
  generate(input: Record<string, unknown>): unknown;
  sampleRate?: number;
}

export interface SherpaModule {
  OfflineRecognizer: new (config: Record<string, unknown>) => SherpaOfflineRecognizer;
  OfflineTts?: (new (config: Record<string, unknown>) => SherpaOfflineTts) | undefined;
}

export type WorkerRequest = Record<string, unknown> & { requestId?: string; type: string };
