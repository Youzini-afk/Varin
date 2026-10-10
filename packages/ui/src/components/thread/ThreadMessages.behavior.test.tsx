import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError } from '@varin/application-client';
import type { ThreadIdentity, ThreadFamilyAPI, ThreadMessagesAPI } from '@varin/application-client';
import type { FamilyList, MessageReceipt, MessageSummary, MessageView } from '@varin/protocol';
import { ThreadMessages } from './ThreadMessages';
const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/components/ui/textarea', () => ({ Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} /> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:child', branchId: 'branch:child' };
const family: FamilyList = { rootThreadId: 'thread:root', members: [{ threadId: 'thread:peer', parentThreadId: 'thread:root', task: 'Peer task', state: 'waiting', branches: [{ branchId: 'branch:peer', headId: null, activeRunId: 'run:peer', latestRun: { runId: 'run:peer', state: 'waiting' } }] }] };
const receipt: MessageReceipt = { messageId: 'message:original', senderThreadId: 'thread:peer', senderBranchId: 'branch:peer', targetThreadId: identity.threadId, targetBranchId: identity.branchId, actor: { kind: 'agent', runId: 'run:peer', operationId: 'original-send', origin: { kind: 'model_step', request_id: 'original-request' } }, kind: 'inform', replyTo: null, acceptedCursor: 19 };
const summary: MessageSummary = { ...receipt, state: 'queued', deliveredRunId: null, deliveredCursor: null };
function fixture() {
  return {
    api: {
      list: vi.fn<ThreadMessagesAPI['list']>(async (_identity, request) => ({ messages: request.direction === 'incoming' ? [summary] : [], nextCursor: null })),
      get: vi.fn<ThreadMessagesAPI['get']>(async () => ({ ...summary, text: 'Original message body' })),
      send: vi.fn<ThreadMessagesAPI['send']>(async (_identity, request) => ({ ...receipt, messageId: 'message:sent', senderThreadId: identity.threadId, senderBranchId: identity.branchId, targetThreadId: 'thread:peer', targetBranchId: 'branch:peer', actor: { kind: 'user' }, replyTo: request.replyTo ?? null, acceptedCursor: 22 })),
    },
    family: { list: vi.fn(async () => family) } as unknown as ThreadFamilyAPI,
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  endpoint.generation = 1;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (f: ReturnType<typeof fixture>, selected = identity, eventCursor = 1) => { await act(async () => root.render(<ThreadMessages api={f.api} family={f.family} identity={selected} eventCursor={eventCursor} />)); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const enter = async (value: string) => { await act(async () => { const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Task message text"]')!; input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); }); };
const target = async () => { await act(async () => { const input = container.querySelector<HTMLSelectElement>('[aria-label="Message recipient"]')!; Object.defineProperty(input, 'value', { configurable: true, writable: true, value: JSON.stringify(['thread:peer', 'branch:peer']) }); input.dispatchEvent(new window.Event('change', { bubbles: true })); }); };

it('reads accepted information on demand and replies with the original received ID as the user, without guessing a branch', async () => {
  const f = fixture(); await render(f); expect(f.api.list).not.toHaveBeenCalled();
  await click('Open task messages'); expect(container.textContent).toContain('Accepted · awaiting a normal boundary');
  expect(f.api.get).not.toHaveBeenCalled(); await click('Read message message:original');
  expect(container.textContent).toContain('Original message body');
  await click('Reply to message:original'); await enter('Thanks, original reply'); await click('Send notification');
  expect(f.api.send.mock.calls[0]![0]).toEqual(identity);
  expect(f.api.send.mock.calls[0]![1]).toEqual({ key: expect.any(String), kind: 'inform', text: 'Thanks, original reply', replyTo: 'message:original' });
  expect(container.textContent).toContain('Accepted message message:sent');
  expect(container.textContent).toContain('does not confirm that work started');
  expect(f.api.list.mock.calls.at(-1)![1]).toMatchObject({ direction: 'outgoing' });
});

it('retries an uncertain Host response with exactly the same body, peer and key, including across collapse', async () => {
  const f = fixture(); f.api.send.mockRejectedValueOnce(new ThreadRequestError(400, 'kernel-response-discarded'));
  await render(f); await click('Open task messages'); await target(); await enter('路径 C:\\work\\原文'); await click('Send notification');
  expect(container.textContent).toContain('Could not confirm acceptance');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Task message text"]')!.disabled).toBe(true);
  const original = f.api.send.mock.calls[0]![1];
  await click('Hide task messages'); await click('Open task messages'); await click('Retry same notification');
  expect(f.api.send.mock.calls[1]![1]).toEqual(original);
  expect(original).toMatchObject({ kind: 'inform', targetThreadId: 'thread:peer', targetBranchId: 'branch:peer', text: '路径 C:\\work\\原文' });
  expect(container.textContent).toContain('Accepted message message:sent');
});

it('refreshes real delivery metadata and drops old message bodies on close, identity and Host changes', async () => {
  const f = fixture(); const delayed = deferred<MessageView>(); f.api.get.mockReturnValueOnce(delayed.promise);
  await render(f); await click('Open task messages'); await click('Read message message:original');
  const signal = f.api.get.mock.calls[0]![2]!; await click('Hide task messages'); expect(signal.aborted).toBe(true);
  await act(async () => delayed.resolve({ ...summary, text: 'stale private body' }));
  expect(container.textContent).not.toContain('stale private body');
  f.api.list.mockResolvedValue({ messages: [{ ...summary, state: 'delivered', deliveredRunId: 'actual-receiver-run', deliveredCursor: 24 }], nextCursor: null });
  await click('Open task messages'); await render(f, identity, 24);
  expect(container.textContent).toContain('Delivered to history in actual-receiver-run');
  await act(async () => { endpoint.generation++; for (const listener of endpoint.listeners) listener(); });
  expect(container.querySelector('[aria-label="Original task message"]')).toBeNull();
  await click('Open task messages'); await render(f, { ...identity, branchId: 'other-branch' });
  expect(container.textContent).not.toContain('actual-receiver-run'); expect(f.api.send).not.toHaveBeenCalled();
});
