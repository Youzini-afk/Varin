import { describe, expect, test } from 'vitest';

import { escapeRawMarkdownHtml } from './markdownSecurity';

describe('escapeRawMarkdownHtml', () => {
  test('escapes raw HTML text before rendering', () => {
    const payload = '<style>@import url("https://example.test/theme.css");</style>';

    expect(escapeRawMarkdownHtml(payload)).toBe(
      '&lt;style&gt;@import url(&quot;https://example.test/theme.css&quot;);&lt;/style&gt;',
    );
  });
});
