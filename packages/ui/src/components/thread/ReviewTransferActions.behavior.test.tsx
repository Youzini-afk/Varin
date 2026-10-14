import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity } from '@varin/application-client';
import type { HistoryItem } from '@varin/protocol';
const transfer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/reviewFlow', () => ({
  getReviewTransferDirection: () => 'review-to-original', reviewableAssistantText: () => 'Finding',
  transferReviewMessage: transfer,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button> }));
import { ReviewTransferActions } from './ReviewTransferActions';
let root: Root; let container: HTMLElement;
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:review', branchId: 'branch:review' };
const item = { id: 'history:review', run_id: 'run:review', thread_id: identity.threadId, source: 'assistant' } as HistoryItem;
beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = window.document.getElementById('root')! as unknown as HTMLElement; root = createRoot(container); transfer.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('sends the displayed native history item and exposes original-delivery retry after an uncertain response', async () => {
  transfer.mockRejectedValueOnce(new Error('Delivery outcome unknown')).mockResolvedValueOnce(undefined);
  await act(async () => root.render(<ReviewTransferActions identity={identity} item={item} />));
  const click = async () => act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Send feedback to implementation');
  await click(); expect(transfer).toHaveBeenLastCalledWith(identity, item);
  expect(container.textContent).toContain('Retry original delivery'); expect(container.textContent).toContain('Delivery outcome unknown');
  await click(); expect(transfer.mock.calls[1]).toEqual(transfer.mock.calls[0]);
  expect(container.textContent).toContain('Review message sent'); expect(container.querySelector('button')!.disabled).toBe(true);
});
it('disables forwarding while the original send is pending', async () => {
  let resolve!: () => void; transfer.mockReturnValue(new Promise<void>(done => { resolve = done; }));
  await act(async () => root.render(<ReviewTransferActions identity={identity} item={item} />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.disabled).toBe(true); expect(container.textContent).toContain('Sending review message');
  await act(async () => resolve()); expect(container.textContent).toContain('Review message sent');
});
