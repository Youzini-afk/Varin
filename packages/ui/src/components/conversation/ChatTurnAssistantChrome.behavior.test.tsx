import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/zh-CN';
import { ChatTurnAssistantChrome } from './ChatTurnAssistantChrome';
import type { ChatAssistantWaitingPresentation } from './chatAssistantWaiting';
import type { ChatSessionMessageEntry } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));

it('changes the existing status in place through response, retry and stop, then retires it', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  const mount = document.createElement('div'); document.body.append(mount);
  const root = createRoot(mount);
  const entries: ChatSessionMessageEntry[] = [{ id: 'reply', parentId: null, timestamp: '', type: 'message', runId: 'run',
    message: { id: 'reply', role: 'assistant', model: '', provider: '', api: '', stopReason: 'stop', timestamp: 0,
      content: [{ type: 'text', text: 'Reply' }] } }];
  const render = (waiting?: ChatAssistantWaitingPresentation) => act(async () => root.render(<ChatTurnAssistantChrome entries={entries} waiting={waiting} />));
  try {
    await render({ stage: 'preparingRequest' });
    const header = mount.querySelector('header');
    const label = mount.querySelector('.swap-text');
    expect(label?.textContent).toBe('准备请求');
    for (const [stage, text] of [['waitingModel', '等待模型响应'], ['thinking', '思考中'], ['responding', '正在回复'], ['preparingTool', '准备工具调用']] as const) {
      await render({ stage });
      expect(mount.querySelector('header')).toBe(header);
      expect(mount.querySelector('.swap-text')).toBe(label);
      expect(label?.textContent).toBe(text);
      expect(mount.querySelectorAll('[role="status"]')).toHaveLength(1);
    }
    await render({ retry: { attempt: 2, retryAt: Date.now() + 5000 } });
    expect(label?.textContent).toContain('重试');
    await render({ stage: 'stopping' });
    expect(label?.textContent).toBe('正在停止');
    await render();
    expect(mount.querySelector('header')).toBe(header);
    expect(mount.querySelector('[role="status"]')).toBeNull();
    expect(mount.querySelector('.swap-text')).toBeNull();
  } finally { await act(async () => root.unmount()); mount.remove(); vi.unstubAllGlobals(); }
});
