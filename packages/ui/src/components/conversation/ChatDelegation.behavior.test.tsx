import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { ToolDisclosureScope } from './ToolDisclosure';
import { ChatDelegation } from './ChatDelegation';
import type { ChatToolExecutionState } from './types';

let root: Root, container: HTMLElement;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = window.document.getElementById('root')!; root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens the exact delegated branch, cancels only its original operation, and retains disclosure choice', async () => {
  const cancelOperation = vi.fn(async () => {});
  const navigate = vi.spyOn(useUIStore.getState(), 'openContextPanelTab').mockImplementation(() => {});
  const execution = { toolCallId: 'dispatch', operationId: 'original-operation', status: 'running',
    operation: { id: 'original-operation', phase: 'running', executor: 'dispatch' },
    child: { task: { name: 'Later task', child_thread_id: 'child', child_branch_id: 'later-branch' },
      execution: { execution_id: 'original-operation', name: 'Source audit', child_thread_id: 'child', child_branch_id: 'original-branch',
        state: 'running', code_result: { kind: 'no_changes' } } } } as unknown as ChatToolExecutionState;
  const identity = { runtime: 'agent' as const, threadId: 'parent', branchId: 'parent-branch' };
  const presentation = { identity, api: { cancelOperation }, toolExecutions: {} } as unknown as ConversationPresentation;
  const render = async (visible = true) => act(async () => root.render(<I18nProvider><ConversationContext.Provider value={presentation}>
    <ToolDisclosureScope sessionId="delegation-actions">{visible && <ChatDelegation call={{ type: 'toolCall', id: 'dispatch', name: 'dispatch', arguments: { task: 'Read source' } }}
      execution={execution} cwd="/workspace" status="running" output={null} details={<p>Original receipt</p>} />}</ToolDisclosureScope>
  </ConversationContext.Provider></I18nProvider>));
  await render();
  expect(container.textContent).toContain('Source audit');
  expect(container.textContent).not.toContain('Later task');
  const disclosure = container.querySelector('details')!;
  await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new window.Event('toggle')); });
  const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;
  await act(async () => button('View conversation').click());
  expect(navigate).toHaveBeenCalledWith('/workspace', { mode: 'threads', thread: identity, member: { runtime: 'agent', threadId: 'child', branchId: 'original-branch' } });
  await act(async () => button('Stop task').click());
  expect(cancelOperation).toHaveBeenCalledExactlyOnceWith('original-operation');
  expect(container.textContent).toContain('Stopping');
  await render(false); await render();
  expect(container.querySelector('details')?.hasAttribute('open')).toBe(true);
  expect(container.textContent).toContain('Original receipt');
});
