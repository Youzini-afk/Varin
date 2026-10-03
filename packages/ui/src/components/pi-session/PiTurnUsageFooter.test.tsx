import React from 'react';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  PiAssistantMessage,
  PiSessionMessageEntry,
  PiUsage,
} from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import { PiTurnUsageFooter } from './PiTurnUsageFooter';

const usage = (values: Partial<PiUsage>): PiUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
  ...values,
});

const assistantMessage = (
  timestamp: number,
  stopReason: PiAssistantMessage['stopReason'],
  messageUsage: PiUsage,
): PiAssistantMessage => ({
  api: 'messages',
  content: [],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason,
  timestamp,
  usage: messageUsage,
});

const assistant = (
  id: string,
  stopReason: PiAssistantMessage['stopReason'],
  messageUsage: PiUsage,
): PiSessionMessageEntry => ({
  id,
  message: assistantMessage(Number(id), stopReason, messageUsage),
  parentId: null,
  timestamp: id,
  type: 'message',
});

const renderUsage = (entries: PiSessionMessageEntry[], liveAssistant?: PiAssistantMessage): string => (
  renderToStaticMarkup(
    <I18nProvider>
      <PiTurnUsageFooter entries={entries} liveAssistant={liveAssistant} />
    </I18nProvider>,
  )
);

describe('Pi turn usage footer', () => {
  test('renders one aggregate after the terminal answer', () => {
    const markup = renderUsage([
      assistant('1', 'toolUse', usage({ input: 9_808, output: 454, totalTokens: 10_262 })),
      assistant('2', 'stop', usage({ cacheRead: 9_000, input: 10_278, output: 64, totalTokens: 19_342 })),
    ]);

    expect(markup.match(/data-pi-assistant-usage="true"/g)).toHaveLength(1);
    expect(markup).toContain('title="Input: 20,086"');
    expect(markup).toContain('title="Output: 518"');
    expect(markup).toContain('title="Cache Read: 9,000"');
    expect(markup).not.toContain('Cache Write');
    expect(markup).toContain('title="Total: 29,604"');
  });

  test('waits through tool use and live streaming instead of rendering intermediate totals', () => {
    const toolUse = assistant('1', 'toolUse', usage({ input: 100, totalTokens: 100 }));
    const pending = assistantMessage(2, 'pending', usage({ input: 200, totalTokens: 200 }));

    expect(renderUsage([toolUse])).toBe('');
    expect(renderUsage([toolUse], pending)).toBe('');
  });
});
