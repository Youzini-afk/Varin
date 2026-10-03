import React from 'react';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiUsage } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { PiAssistantUsageFooter } from './PiAssistantUsageFooter';

const renderUsage = (usage: PiUsage): string => renderToStaticMarkup(
  <I18nProvider><PiAssistantUsageFooter usage={usage} /></I18nProvider>,
);

describe('Pi assistant usage footer', () => {
  test('renders compact metric icons and omits empty cache fields', () => {
    const markup = renderUsage({
      cacheRead: 8_000,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 2_000,
      output: 500,
      totalTokens: 10_500,
    });
    expect(markup).toContain('Token');
    expect(markup).toContain('title="Input: 2,000"');
    expect(markup).toContain('title="Output: 500"');
    expect(markup).toContain('title="Cache Read: 8,000"');
    expect(markup).not.toContain('Cache Write');
    expect(markup).not.toContain('Reasoning');
    expect(markup).toContain('title="Total: 10,500"');
  });

  test('renders nothing when the provider reports no usage', () => {
    expect(renderUsage({
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    })).toBe('');
  });

  test('renders output token rate when a measured duration is available', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><PiAssistantUsageFooter tokensPerSecond={42.5} usage={{
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 1,
        output: 42,
        totalTokens: 43,
      }} /></I18nProvider>,
    );
    expect(markup).toContain('42.5 Tok/s');
  });
});
