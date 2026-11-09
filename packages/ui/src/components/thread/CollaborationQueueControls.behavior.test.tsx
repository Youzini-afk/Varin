import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadsAPI, ThreadQueuedExchange } from '@varin/application-client';
import type { MessageFeedEntry } from '@varin/protocol';
import { CollaborationQueueControls } from './CollaborationQueueControls';
import { CollaborationExchangeQueue } from './CollaborationExchangeQueue';
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const click = async (label: string) => act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click(); });

it('edits an unhandled User message without dropping its attachments, then offers immediate delivery and withdrawal', async () => {
  const control = vi.fn().mockResolvedValue({}), changed = vi.fn();
  const api = { messages: { control } } as unknown as ThreadsAPI;
  const message = { messageId: 'original', senderThreadId: 'sender', senderBranchId: 'original-branch', revision: 7,
    afterCurrent: true, text: 'Selected file attached', attachments: [{ ref: 'original-file' }], actor: { kind: 'user' } } as MessageFeedEntry;
  await act(async () => root.render(<CollaborationQueueControls api={api} message={message} onChanged={changed} />));
  await click('collaboration.queue.edit');
  const editor = container.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(editor.value).toBe(message.text);
  await click('collaboration.queue.save');
  expect(control).toHaveBeenLastCalledWith({ runtime: 'agent', threadId: 'sender', branchId: 'original-branch' }, {
    messageId: 'original', expectedRevision: 7, action: 'edit', text: message.text,
  });
  await click('collaboration.queue.sendNow');
  expect(control.mock.calls.at(-1)![1]).toEqual({ messageId: 'original', expectedRevision: 7, action: 'send_now' });
  await click('collaboration.queue.withdraw');
  expect(control.mock.calls.at(-1)![1].action).toBe('cancel');
  expect(changed).toHaveBeenCalledTimes(3);
});

it('keeps a failed withdrawal visible and refreshes the authoritative queue revision', async () => {
  const control = vi.fn().mockRejectedValue(new Error('Already being handled')), changed = vi.fn();
  const message = { messageId: 'original', senderThreadId: 'sender', senderBranchId: 'branch', revision: 3,
    targetThreadId: 'receiver', targetBranchId: 'receiver-branch', kind: 'request', replyTo: null, acceptedCursor: 1, acceptedAtMs: 1,
    state: 'queued', activation: { state: 'pending', executionId: null, holdReason: null }, replyWait: null, deliveredRunId: null, deliveredCursor: null,
    afterCurrent: true, text: 'Agent message', attachments: [], actor: { kind: 'agent', runId: 'run', operationId: 'send', origin: { kind: 'model_step', request_id: 'request' } } } satisfies MessageFeedEntry;
  await act(async () => root.render(<CollaborationQueueControls api={{ messages: { control } } as unknown as ThreadsAPI} message={message} onChanged={changed} />));
  expect(container.textContent).not.toContain('collaboration.queue.edit');
  await click('collaboration.queue.withdraw');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Already being handled');
  expect(changed).toHaveBeenCalledOnce();
});

it('offers file queue controls only until the immutable delivery is being merged', async () => {
  const controlExchange = vi.fn().mockResolvedValue(undefined), changed = vi.fn();
  const api = { collaboration: { controlExchange } } as unknown as ThreadsAPI;
  const value: ThreadQueuedExchange = { operationId: 'original-exchange', revision: 5, senderThreadId: 'sender', senderBranchId: 'source-branch',
    source: { threadId: 'sender', name: 'Sender' }, target: { threadId: 'receiver', name: 'Receiver' }, files: ['a.ts', 'long/subdirectory/b.ts'], state: 'queued', afterCurrent: true };
  await act(async () => root.render(<CollaborationExchangeQueue api={api} values={[value]} onChanged={changed} />));
  await click('collaboration.queue.sendNow');
  expect(controlExchange).toHaveBeenCalledWith({ runtime: 'agent', threadId: 'sender', branchId: 'source-branch' }, {
    operationId: 'original-exchange', expectedRevision: 5, action: 'send_now',
  });
  await act(async () => root.render(<CollaborationExchangeQueue api={api} values={[{ ...value, revision: 6, state: 'applying' }]} onChanged={changed} />));
  expect(container.textContent).toContain('collaboration.queue.applying');
  expect(container.textContent).not.toContain('collaboration.queue.withdraw');
});
