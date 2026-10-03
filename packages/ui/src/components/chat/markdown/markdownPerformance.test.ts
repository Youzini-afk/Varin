import { describe, expect, test } from 'vitest';

import {
  CONSTRAINED_FILE_REFERENCE_ANNOTATION_MAX_CHARS,
  CONSTRAINED_RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS,
  FILE_REFERENCE_ANNOTATION_MAX_CHARS,
  RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS,
  shouldEnableFileReferenceAnnotations,
  shouldUseRichMarkdownFirstPaint,
} from './markdownPerformance';

describe('markdown performance gates', () => {
  test('disables file reference annotation for streaming or oversized markdown', () => {
    expect(shouldEnableFileReferenceAnnotations({
      enabled: true,
      isStreaming: true,
      contentLength: 100,
      isConstrainedRuntime: false,
    })).toBe(false);

    expect(shouldEnableFileReferenceAnnotations({
      enabled: true,
      isStreaming: false,
      contentLength: FILE_REFERENCE_ANNOTATION_MAX_CHARS + 1,
      isConstrainedRuntime: false,
    })).toBe(false);

    expect(shouldEnableFileReferenceAnnotations({
      enabled: true,
      isStreaming: false,
      contentLength: FILE_REFERENCE_ANNOTATION_MAX_CHARS,
      isConstrainedRuntime: false,
    })).toBe(true);
  });

  test('uses lower annotation and rich first-paint limits in constrained runtimes', () => {
    expect(shouldEnableFileReferenceAnnotations({
      enabled: true,
      isStreaming: false,
      contentLength: CONSTRAINED_FILE_REFERENCE_ANNOTATION_MAX_CHARS + 1,
      isConstrainedRuntime: true,
    })).toBe(false);

    expect(shouldUseRichMarkdownFirstPaint({
      contentLength: CONSTRAINED_RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS + 1,
      isConstrainedRuntime: true,
    })).toBe(false);

    expect(shouldUseRichMarkdownFirstPaint({
      contentLength: RICH_MARKDOWN_FIRST_PAINT_MAX_CHARS,
      isConstrainedRuntime: false,
    })).toBe(true);
  });
});
