import React from 'react';
import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PiAssistantMessage } from '@varin/protocol';
import { I18nProvider } from '@/lib/i18n';
import type { PiTimelineTurn } from './piTimelineProjection';
import { PiTurnAssistantChrome } from './PiTurnAssistantChrome';

const assistant = (stopReason: PiAssistantMessage['stopReason'], provider = 'runtime-provider'): PiAssistantMessage => ({
  api: 'messages',
  content: [],
  model: 'runtime-model',
  provider,
  role: 'assistant',
  stopReason,
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 16_024,
  },
});

const turn = (liveAssistant?: PiAssistantMessage, userContent = 'hello'): PiTimelineTurn => ({
  entries: [],
  id: 'turn:user',
  ...(liveAssistant ? { liveAssistant } : {}),
  liveUser: true,
  metadata: {},
  resultByCallId: new Map(),
  user: { content: userContent, role: 'user', timestamp: 1 },
});

const renderChrome = (node: React.ReactNode): string => renderToStaticMarkup(
  <I18nProvider>{node}</I18nProvider>,
);

describe('Pi turn assistant chrome', () => {
  test('renders one accessible waiting header with the snapshot model and busy dots', () => {
    const markup = renderChrome(
      <PiTurnAssistantChrome
        turn={turn()}
        waiting={{ model: { id: 'snapshot-model', provider: 'snapshot-provider' } }}
      />,
    );
    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Varin');
    expect(markup).not.toContain('>Pi</span>');
    expect(markup).toContain('snapshot-provider/snapshot-model');
  });

  test('lets the real live assistant model take over without adding a second header', () => {
    const markup = renderChrome(
      <PiTurnAssistantChrome
        turn={turn(assistant('pending'))}
        waiting={{ model: { id: 'snapshot-model', provider: 'snapshot-provider' } }}
      />,
    );
    expect(markup.match(/<header/g)).toHaveLength(1);
    expect(markup).toContain('runtime-provider/runtime-model');
    expect(markup).not.toContain('snapshot-provider/snapshot-model');
    expect(markup).not.toContain('16,024');
  });

  test('removes the working animation from a completed assistant header', () => {
    const markup = renderChrome(<PiTurnAssistantChrome turn={turn(assistant('stop'))} />);
    expect(markup).not.toContain('role="status"');
  });

  test('uses the provider agent label for non-Varin agent providers', () => {
    const markup = renderChrome(<PiTurnAssistantChrome turn={turn(assistant('stop', 'pi-subagents'))} />);
    expect(markup).toContain('Subagents');
    expect(markup).not.toContain('>Varin</span>');
  });

  test('prefers the invoked agent name when the subagent command carries it', () => {
    const markup = renderChrome(
      <PiTurnAssistantChrome
        turn={turn(assistant('stop', 'pi-subagents'), '/run reviewer inspect the repository')}
      />,
    );
    expect(markup).toContain('reviewer');
    expect(markup).not.toContain('Subagents');
  });
});
