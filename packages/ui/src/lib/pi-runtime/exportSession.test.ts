import { describe, expect, test } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import { formatPiSessionAsMarkdown } from './exportSession';

const base = {
  parentId: null,
  timestamp: '2026-08-02T01:02:03.000Z',
};

describe('formatPiSessionAsMarkdown', () => {
  test('exports Pi messages, images, tools, bash metadata, and session metadata', () => {
    const entries: PiSessionEntry[] = [
      {
        ...base,
        id: 'user-1',
        message: {
          content: [
            { text: 'Inspect this', type: 'text' },
            { data: 'base64', mimeType: 'image/png', type: 'image' },
          ],
          role: 'user',
          timestamp: 1,
        },
        type: 'message',
      },
      {
        ...base,
        id: 'assistant-1',
        message: {
          api: 'messages',
          content: [
            { text: 'I will inspect it.', type: 'text' },
            { thinking: 'private', type: 'thinking' },
            { arguments: { path: 'README.md' }, id: 'tool-1', name: 'read', type: 'toolCall' },
          ],
          model: 'pi-model',
          provider: 'pi-provider',
          role: 'assistant',
          stopReason: 'toolUse',
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
          },
        },
        type: 'message',
      },
      {
        ...base,
        id: 'tool-result-1',
        message: {
          content: [{ text: 'contents', type: 'text' }],
          isError: false,
          role: 'toolResult',
          timestamp: 3,
          toolCallId: 'tool-1',
          toolName: 'read',
        },
        type: 'message',
      },
      {
        ...base,
        id: 'bash-1',
        message: {
          cancelled: false,
          command: 'git status',
          exitCode: 0,
          fullOutputPath: 'D:/tmp/full.log',
          output: 'short output',
          role: 'bashExecution',
          timestamp: 4,
          truncated: true,
        },
        type: 'message',
      },
    ];

    const markdown = formatPiSessionAsMarkdown(entries, {
      cwd: 'D:/work',
      sessionId: 'session-a',
      title: 'Pi session',
    }, new Date('2026-08-02T12:00:00.000Z'));

    expect(markdown).toContain('# Pi session');
    expect(markdown).toContain('Session ID: `session-a`');
    expect(markdown).toContain('Working directory: `D:/work`');
    expect(markdown).toContain('*[Image attachment: image/png]*');
    expect(markdown).toContain('pi-provider/pi-model');
    expect(markdown).toContain('**Tool call: read** `tool-1`');
    expect(markdown).toContain('"path": "README.md"');
    expect(markdown).toContain('**Tool result: read** `tool-1`');
    expect(markdown).toContain('*Output was truncated.*');
    expect(markdown).toContain('Full output: `D:/tmp/full.log`');
  });

  test('does not expose redacted thinking or hidden extension messages and preserves unknown and meta entries', () => {
    const entries: PiSessionEntry[] = [
      {
        ...base,
        id: 'assistant-redacted',
        message: {
          api: 'messages',
          content: [{ redacted: true, thinking: 'do not export', type: 'thinking' }],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
          },
        },
        type: 'message',
      },
      {
        ...base,
        content: 'internal state',
        customType: 'state',
        display: false,
        id: 'custom-1',
        type: 'custom_message',
      },
      {
        ...base,
        data: { future: true },
        id: 'unknown-1',
        originalType: 'future_entry',
        type: 'unknown',
      },
      {
        ...base,
        id: 'model-1',
        modelId: 'model',
        provider: 'provider',
        type: 'model_change',
      },
    ];

    const markdown = formatPiSessionAsMarkdown(entries, {}, new Date('2026-08-02T12:00:00.000Z'));
    expect(markdown).toContain('Redacted thinking omitted');
    expect(markdown).not.toContain('do not export');
    expect(markdown).not.toContain('Custom message: state');
    expect(markdown).not.toContain('internal state');
    expect(markdown).toContain('Unknown entry: future_entry');
    expect(markdown).toContain('provider/model');
  });

  test('uses a longer Markdown fence when content already contains backticks', () => {
    const entries: PiSessionEntry[] = [{
      ...base,
      id: 'bash-fence',
      message: {
        cancelled: false,
        command: 'printf "```"',
        output: 'done',
        role: 'bashExecution',
        timestamp: 4,
        truncated: false,
      },
      type: 'message',
    }];
    const markdown = formatPiSessionAsMarkdown(entries, {}, new Date('2026-08-02T12:00:00.000Z'));
    expect(markdown).toContain('````shell\nprintf "```"\n````');
  });
});
