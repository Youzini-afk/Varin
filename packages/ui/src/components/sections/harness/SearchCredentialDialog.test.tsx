import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SearchCredentialDialog } from './SearchCredentialDialog';
import { openSearchCredentialRequest, searchCredentialChanged, useSearchCredentialRequests } from '@/stores/useSearchCredentialRequests';

const fixture = vi.hoisted(() => ({ call: vi.fn(), generation: 1, changed: undefined as (() => void) | undefined }));
vi.mock('@varin/application-client', () => ({ searchCredentialRequest: fixture.call,
  getRuntimeEndpointGeneration: () => fixture.generation, subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.changed = listener; return () => {}; } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open, onOpenChangeComplete }: React.PropsWithChildren<{ open: boolean; onOpenChangeComplete(open: boolean): void }>) => {
    React.useEffect(() => { if (!open) onOpenChangeComplete(false); }, [open, onOpenChangeComplete]);
    return open ? <>{children}</> : null;
  }, DialogContent: ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>, DialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
let root: Root, container: HTMLElement;
const pending = { id: 'request', connectionId: 'search', name: 'Research', provider: 'exa', status: 'pending' as const };
beforeEach(async () => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.generation = 1; fixture.call.mockReset(); fixture.call.mockResolvedValue(pending);
  useSearchCredentialRequests.setState({ requests: [], credentialRevision: 0 });
  container = document.getElementById('app')!; root = createRoot(container);
  await act(async () => root.render(<SearchCredentialDialog />));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

test('keeps secret input out of shared state and sends it only to its original credential request on explicit save', async () => {
  await act(async () => { await openSearchCredentialRequest('request'); await openSearchCredentialRequest('request'); });
  expect(useSearchCredentialRequests.getState().requests).toHaveLength(1);
  const input = container.querySelector<HTMLInputElement>('input[type=password]')!;
  await act(async () => { input.value = 'private-key'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  expect(JSON.stringify(useSearchCredentialRequests.getState())).not.toContain('private-key');
  expect(fixture.call.mock.calls.every(call => call[1] !== 'POST')).toBe(true);
  fixture.call.mockResolvedValueOnce({ ...pending, status: 'completed' });
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(fixture.call).toHaveBeenLastCalledWith('request', 'POST', 'private-key');
  expect(container.querySelector('input')).toBeNull();
});

test('cancels without sending draft text and removes an old Host prompt on endpoint changes', async () => {
  await act(async () => openSearchCredentialRequest('request'));
  const cancel = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'settings.common.actions.cancel')!;
  fixture.call.mockResolvedValueOnce({ ...pending, status: 'cancelled' });
  await act(async () => cancel.click());
  expect(fixture.call).toHaveBeenLastCalledWith('request', 'DELETE', undefined);
  await act(async () => openSearchCredentialRequest('request'));
  await act(async () => { fixture.generation++; fixture.changed?.(); });
  expect(container.querySelector('input')).toBeNull();
});

test('reflects owner cancellation and credential changes, and keeps an owner failure visible', async () => {
  await act(async () => openSearchCredentialRequest('request'));
  await act(async () => searchCredentialChanged({ requestId: 'request', status: 'failed' }));
  expect(container.querySelector('[role=alert]')?.textContent).toContain('credentialEntry.failed');
  expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
  await act(async () => searchCredentialChanged({ requestId: 'request', status: 'cancelled' }));
  expect(container.querySelector('[role=dialog]')).toBeNull();
  searchCredentialChanged({ connectionId: 'search' });
  expect(useSearchCredentialRequests.getState().credentialRevision).toBe(1);
});
