import { describe, expect, test } from 'vitest';

import {
  buildEmbeddedSessionChatURL,
  isEmbeddedSessionChatReady,
  readEmbeddedSessionChatConfigFromSearch,
  shouldConsumeSessionUrlParams,
} from './embeddedSessionChat';

describe('embedded session chat URL helpers', () => {
  test('builds embedded session chat URLs with namespaced params', () => {
    const url = buildEmbeddedSessionChatURL({
      sessionId: 'child-123',
      directory: '/tmp/project',
      readOnly: true,
      basePath: '/app',
      origin: 'https://varin.test',
    });

    expect(url).toBe('https://varin.test/app?surface=desktop&piPanel=session-chat&piSessionId=child-123&piReadOnly=1&piDirectory=%2Ftmp%2Fproject');
    expect(url).not.toContain('sessionId=');
    expect(url).not.toContain('directory=');
    expect(url).not.toContain('readOnly=');
  });

  test('parses Varin-owned embedded session chat params', () => {
    const config = readEmbeddedSessionChatConfigFromSearch('?piPanel=session-chat&piSessionId=child-123&piDirectory=%2Ftmp%2Fproject&piReadOnly=1');

    expect(config).toEqual({
      sessionId: 'child-123',
      directory: '/tmp/project',
      readOnly: true,
    });
  });

  test('does not retain an OpenCode-shaped compatibility route', () => {
    const config = readEmbeddedSessionChatConfigFromSearch('?ocPanel=session-chat&sessionId=child-123&directory=%2Ftmp%2Fproject&readOnly=1');
    expect(config).toBeNull();
  });

  test('does not let generic session URL cleanup consume embedded session chat params', () => {
    const params = new URLSearchParams('?piPanel=session-chat&piSessionId=child-123&piDirectory=%2Ftmp%2Fproject&piReadOnly=1');

    expect(shouldConsumeSessionUrlParams(params)).toBe(false);
  });

  test('still consumes normal session deep-link params', () => {
    expect(shouldConsumeSessionUrlParams(new URLSearchParams('?sessionId=session-123&directory=%2Ftmp%2Fproject'))).toBe(true);
    expect(shouldConsumeSessionUrlParams(new URLSearchParams('?session=session-123'))).toBe(true);
  });

  test('does not allow embedded ChatView to render before target session is active', () => {
    const embeddedSessionChat = {
      sessionId: 'child-123',
      directory: '/tmp/project/',
      readOnly: true,
    };

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: null,
      currentDirectory: '/tmp/project',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'parent-123',
      currentDirectory: '/tmp/project',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'child-123',
      currentDirectory: '/tmp/other',
    })).toBe(false);

    expect(isEmbeddedSessionChatReady({
      embeddedSessionChat,
      currentSessionId: 'child-123',
      currentDirectory: '/tmp/project',
    })).toBe(true);
  });
});
