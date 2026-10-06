# TTS Module Documentation

## Purpose
This module provides server-side Text-to-Speech services using OpenAI's TTS API. The historical shared text summarization endpoint now lives in `packages/web/application-host/lib/text/` as an API-compatible stub because the previous Zen model provider is unavailable.

## Entrypoints and structure
- `packages/web/application-host/lib/tts/index.ts`: Public entrypoint imported by `packages/web/application-host/index.ts`.
- `packages/web/application-host/lib/tts/routes.ts`: Express route registration for `/api/voice/*`, `/api/tts/*`, and `/api/stt/*` endpoints.
- `packages/web/application-host/lib/tts/capability-runtime.ts`: runtime helper for probing local macOS `say` TTS voice capability.
- `packages/web/application-host/lib/tts/service.ts`: TTS service implementation with OpenAI integration.
- `packages/web/application-host/lib/text/summarization.ts`: Shared text summarization stub and sanitization utilities. It performs no external Zen calls.
- `packages/web/application-host/lib/tts/stt.ts`: STT proxy for OpenAI-compatible transcription endpoints.
- `packages/web/application-host/lib/tts/base-url.ts`: shared base URL validation and normalization for custom OpenAI-compatible endpoints.

## Public exports

### TTS Service (from service.js)
- `ttsService`: Singleton instance of TTSService class.
- `TTSService`: TTS service class for OpenAI audio generation.
- `TTS_VOICES`: Array of supported OpenAI voice identifiers.

### Shared text summarization (re-exported from ../text/summarization.js)
- `summarizeText({ text, threshold, maxLength, zenModel, mode })`: Retired shared text summarizer retained as a stub. TTS uses `mode: 'tts'`; `zenModel` is ignored.
- `sanitizeForTTS(text)`: Sanitizes text by removing markdown, URLs, file paths, and other non-speakable content.
- `sanitizeForNote(text)`: Re-exported for note-mode callers that still import through the TTS surface.

### Capability runtime (capability-runtime.js)
- `detectSayTtsCapability(processLike)`: probes local `say -v "?"` support and returns `{ available, voices, reason }`.

## Constants

### Voice identifiers
- `TTS_VOICES`: Array of supported OpenAI voices: `['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']`.

### Summarization defaults
- No model request timeout is used; the summarization provider is disabled.

### Default values
- `summarizeText` defaults: `threshold` = 200, `maxLength` = 500, `mode` = 'tts'. `zenModel` is ignored.
- `generateSpeechStream` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.
- `generateSpeechBuffer` defaults: `voice` = 'coral', `model` = 'gpt-4o-mini-tts', `speed` = 1.0.

## TTSService methods

### `isAvailable()`
Returns whether an OpenAI API key is configured through `OPENAI_API_KEY` or Pi's canonical auth file.

### `generateSpeechStream(options)`
Generates speech and returns as a web stream for direct streaming to clients.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`, `apiKey`.
- Returns: `{ stream: ReadableStream, contentType: 'audio/mpeg' }`.
- Throws: Error if API key not configured or text is empty.

### `generateSpeechBuffer(options)`
Generates speech and returns as Buffer for caching purposes.
- Options: `text` (required), `voice`, `model`, `speed`, `instructions`.
- Returns: Buffer containing MP3 audio data.
- Throws: Error if API key not configured or text is empty.

## Response contracts

### `summarizeText`
Returns object with:
- `summary`: Sanitized or locally distilled fallback text.
- `summarized`: Always `false` while the model provider is unavailable.
- `reason`: String explaining why summarization was skipped.
- `originalLength`: Optional number for original text length.
- `summaryLength`: Optional number for summarized text length.

The route-level text summarize API is now `/api/text/summarize`.

### `sanitizeForTTS`
Returns sanitized string with markdown, URLs, file paths, and special characters removed.

### `generateSpeechStream`
Returns object with:
- `stream`: ReadableStream of MP3 audio data.
- `contentType`: Always 'audio/mpeg'.

### `generateSpeechBuffer`
Returns Buffer containing MP3 audio data.

## API key resolution
OpenAI API keys are resolved in order:
1. Environment variable `OPENAI_API_KEY`.
2. Pi auth file (`auth.openai`, `auth.codex`, or `auth.chatgpt`).
3. Supports both string format (just token) and object format (with `access` or `token` fields).

## Usage in web server
The TTS module is used by `packages/web/application-host/index.ts` for:
- Generating speech streams for client playback.
- Generating speech buffers for caching.
- Sanitizing text before TTS synthesis. Historical summarization calls now return local fallback text.
- Sanitizing text to remove non-speakable content.

The historical summarization API is shared with notifications and notes, but currently acts as a no-model fallback/stub.

The server-side TTS approach bypasses mobile Safari's audio context restrictions by generating audio on the server and streaming to clients.

## Notes for contributors

### Adding new TTS features
1. Add new methods to `packages/web/application-host/lib/tts/service.ts` TTSService class.
2. Export public functions from `packages/web/application-host/lib/tts/index.ts`.
3. Follow existing patterns for API key resolution and error handling.
4. Ensure all text is sanitized before TTS synthesis.
5. Consider adding new voice options to `TTS_VOICES` constant.

### Text sanitization
- Always call `sanitizeForTTS` on text before passing to TTS generation.
- The sanitization removes markdown, code blocks, URLs, file paths, shell commands, and special characters.
- This prevents the TTS from reading out technical formatting that sounds unnatural.

### Error handling
- `generateSpeechStream` and `generateSpeechBuffer` throw descriptive errors for missing API keys or empty text.
- `summarizeText` does not call Zen and returns mode-specific fallback text with `summarized: false`.
- All errors are logged to console with `[TTSService]` or `[Summarize]` prefix.

### API key management
- TTSService caches OpenAI client instance and recreates when API key changes.
- API key changes are detected by comparing with `_lastApiKey` property.
- This allows dynamic API key updates without server restart.

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Test API key resolution with environment variable and auth file.
- Test speech generation with various text lengths and voice options.
- Test summarization stub behavior above and below threshold.
- Test sanitization with markdown, URLs, and code blocks.
- Verify streaming and buffer generation produce valid MP3 audio.

## Verification notes

### Manual verification
1. Configure an OpenAI API key via the environment or Varin settings.
2. Test `ttsService.isAvailable()` returns true.
3. Call `ttsService.generateSpeechStream({ text: 'Hello world' })` and verify stream is returned.
4. Call `ttsService.generateSpeechBuffer({ text: 'Hello world' })` and verify Buffer is returned.
5. Test `summarizeText` with text above and below threshold.
6. Test `sanitizeForTTS` with markdown, URLs, and code blocks.

### API endpoint verification
1. Start web server and access TTS endpoint via client.
2. Verify audio plays correctly in browser.
3. Test on mobile Safari to verify bypass of audio context restrictions.
4. Test with long messages to verify summarization is triggered.
