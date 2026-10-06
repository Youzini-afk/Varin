# Dictation module

Server-authoritative streaming speech-to-text for the chat composer, plus
local text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64)
over a WebSocket; the server runs the transcription and streams live partial
transcripts back.

Local TTS (Kokoro via sherpa-onnx OfflineTts) runs in the same worker process
and is exposed as `POST /api/dictation/tts/speak` (JSON `{text, speakerId?,
speed?, model?}` → WAV bytes; 503 with `reasonCode` while the model is
downloading). TTS models live in the same catalog/downloader as STT models
(`local/model-catalog.ts` `LOCAL_TTS_MODEL_CATALOG`) and are managed by the
same status/download/delete routes.

## Ownership

- `runtime.ts` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: authenticated client or scoped `varin_url_token`, plus origin check).
  Created by `../platform/startup-pipeline-runtime.ts` and stopped with the Host.
- `stream-manager.ts` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate,
  auto-commit every ~15 s of audio, silence suppression by PCM peak,
  partial-transcript concatenation, adaptive finalization timeout.
- `service.ts` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx recognition in a forked worker process.
    The shared default is multilingual Whisper large-v3 Turbo. The Host catalog
    also offers Qwen3-ASR 0.6B, SenseVoice Small, Parakeet v2/v3 and Whisper base/tiny.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.ts`, reuses `../tts/stt.ts`).
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and realtime session (throttled re-decode for partials),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
  The model catalog owns native assets, supported languages, archive download
  sizes and source links; status returns those capabilities alongside live
  installation state. The UI consumes that catalog instead of maintaining a
  second list or fabricated accuracy/speed ratings. Whisper Turbo uses 128-bin
  features, SenseVoice a single ONNX model, and Qwen its frontend/encoder/decoder
  plus verified tokenizer assets. Native runtime 1.13.8 supplies the Qwen stream
  language option and the current Kokoro generationConfig API.
- `audio.ts` — PCM16 helpers: format parsing, peak, WAV wrapping, streaming
  linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible', language?, localModel?,
openaiCompatible?: { baseUrl, model, apiKey } }`.

The composer and settings page share `usePreferencesStore`. Local model changes
also use the existing settings persistence path. Language selection accepts a
BCP-47 primary language (for example `zh-CN` becomes `zh`): Whisper/SenseVoice
receive their code, Qwen receives its protocol name (for example `Chinese`).
Empty/`auto` means automatic detection; Parakeet always detects automatically.
Unsupported forced languages fail before download/inference. Language-specific
engines keep active sessions and the most recently used configuration, releasing
other idle configurations instead of accumulating a model copy for each language.
Finalization reuses the last decoded text when no audio was added; new audio and
new segments still decode normally.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under the Varin data directory (`~/.config/varin/speech-models` on Linux).
