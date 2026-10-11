import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { McpInteractionItem, McpInteractionView } from '@varin/protocol';
import { openExternalUrl } from '@/lib/url';
import { ThreadMcpInteractions } from './ThreadMcpInteraction';

vi.mock('@/lib/url', () => ({ openExternalUrl: vi.fn(async () => false) }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const makeView = (): McpInteractionView => ({ record: { id: 'elicitation:first', revision: 1,
  binding: { operationId: 'operation:original', executionOwner: { kind: 'external', identity: 'owner', epoch: 'epoch' },
    endpoint: { server: 'Original MCP server', resourceKey: 'server-key', configurationVersion: 'config', credentialVersion: 'grant' }, connectionId: 'connection', source: { kind: 'server_request', requestId: 0,
    relation: { kind: 'task', taskId: 'task:original' } } }, runId: 'run:finished', threadId: identity.threadId, branchId: identity.branchId,
  mode: 'form', availability: 'live', choice: null, delivery: 'not_started', completionReported: false, problem: null },
  request: {}, response: null, presentation: { mode: 'form', message: '<script>server text</script> **untrusted server words**', fields: [
    { name: 'enabled', title: 'Enabled', kind: 'boolean', required: true, default: false },
    { name: 'count', title: 'Count', kind: 'integer', required: true, default: 0, minimum: 0, maximum: 9 },
    { name: 'empty', title: 'Empty text', kind: 'string', required: false, default: '', maxLength: 8, pattern: '[a-z]*' },
    { name: 'unset', title: 'Optional flag', kind: 'boolean', required: false },
    { name: 'missing', title: 'Optional number', kind: 'number', required: false },
    { name: 'choice', title: 'Choice', kind: 'enum', required: true, default: '', options: [{ value: '', title: 'Empty choice' }, { value: 'b', title: 'Second choice' }] },
    { name: 'many', title: 'Several choices', kind: 'multi_enum', required: true, default: [], options: [{ value: 'a', title: 'A' }, { value: 'b', title: 'B' }], minItems: 0, maxItems: 2 },
  ] } });
type API = Pick<ThreadsAPI, 'listMcpInteractions' | 'readMcpInteraction' | 'respondMcpInteraction' | 'reviewMcpSamplingRequest' | 'reviewMcpSamplingOutput' | 'cancelOperation'>;
const item = ({ record, presentation, response }: McpInteractionItem): McpInteractionItem => structuredClone({ record, presentation, response });
const errorView = (): McpInteractionView => {
  const view = makeView();
  return { ...view, record: { ...view.record, mode: 'url', availability: 'owner_unavailable', delivery: null,
    binding: { ...view.record.binding, source: { kind: 'rpc_error', outgoingRequestId: 1.5, method: 'tools/call', elicitationId: 'external:original' } } },
    request: { code: -32042, message: 'Original RPC error detail', data: { elicitations: [{ mode: 'url', message: 'Complete this external step', url: 'https://accounts.example.test/finish', elicitationId: 'external:original' }] } },
    presentation: { mode: 'url', message: 'Complete this external step', url: 'https://accounts.example.test/finish', elicitationId: 'external:original' } };
};
function fixture() {
  let view = makeView();
  const api = {
    reviewMcpSamplingRequest: vi.fn<API['reviewMcpSamplingRequest']>(),
    reviewMcpSamplingOutput: vi.fn<API['reviewMcpSamplingOutput']>(),
    cancelOperation: vi.fn<API['cancelOperation']>(),
    listMcpInteractions: vi.fn<API['listMcpInteractions']>(async () => ({ items: [item(view)], nextCursor: null })),
    readMcpInteraction: vi.fn<API['readMcpInteraction']>(async () => structuredClone(view)),
    respondMcpInteraction: vi.fn<API['respondMcpInteraction']>(async input => {
      view = { ...view, record: { ...view.record, revision: view.record.revision + 1, choice: input.response.action, delivery: view.record.binding.source.kind === 'rpc_error' ? null : 'sending' }, response: input.response };
      return structuredClone(view);
    }),
  };
  return { api, get: () => view, set: (next: McpInteractionView) => { view = next; } };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(openExternalUrl).mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
const choose = async (value: string) => {
  const element = container.querySelector<HTMLSelectElement>('[aria-label="Choice"]')!;
  await act(async () => { Object.defineProperty(element, 'value', { configurable: true, writable: true, value }); element.dispatchEvent(new window.Event('change', { bubbles: true })); });
};
const render = async (api: API, cursor = 0) => { await act(async () => { root.render(<ThreadMcpInteractions api={api} identity={identity} eventCursor={cursor} />); }); };

it('renders owner fields as plain server text and sends false, zero, empty strings and arrays only after an explicit choice', async () => {
  const f = fixture(); await render(f.api);
  expect(f.api.respondMcpInteraction).not.toHaveBeenCalled();
  expect(container.querySelector('script')).toBeNull();
  expect([...container.querySelector('form')!.attributes].some(attribute => attribute.name.toLowerCase() === 'novalidate')).toBe(true);
  expect(container.textContent).toContain('<script>server text</script> **untrusted server words**');
  expect(container.textContent).toContain('Operation operation:original · Remote task task:original');
  expect(container.querySelector('[aria-label="Empty text"]')?.getAttribute('pattern')).toBe('[a-z]*');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Count"]')?.value).toBe('0');
  await submit();
  expect(f.api.respondMcpInteraction).toHaveBeenCalledWith({ ...identity, operationId: 'operation:original', interactionId: 'elicitation:first', expectedRevision: 1,
    response: { action: 'accept', content: { enabled: false, count: 0, empty: '', choice: '', many: [] } } });
  expect(container.textContent).toContain('Your choice: accept · Response delivery started');
  expect(container.textContent).not.toContain('Allow once');
});

it('retains a same-request draft during bounded event refresh and gives a new request its own draft', async () => {
  const f = fixture(); await render(f.api); await choose('1');
  f.set({ ...f.get(), record: { ...f.get().record, revision: 2 } });
  await render(f.api, 5); await submit();
  expect(f.api.respondMcpInteraction.mock.calls[0]![0]).toMatchObject({ expectedRevision: 2, response: { content: { choice: 'b' } } });
  f.set({ ...makeView(), record: { ...makeView().record, id: 'elicitation:next' } });
  await render(f.api, 6); await submit();
  expect(f.api.respondMcpInteraction.mock.calls[1]![0]).toMatchObject({ interactionId: 'elicitation:next', response: { content: { choice: '' } } });
  expect(f.api.listMcpInteractions.mock.calls.every(([input]) => input.limit === 20)).toBe(true);
});

it('gates repeated clicks synchronously and retries an uncertain result with the exact original response and revision', async () => {
  const f = fixture(); let reject!: (reason: unknown) => void;
  f.api.respondMcpInteraction.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render(f.api); await submit(); await submit();
  expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
  await act(async () => { reject(new Error('connection reset with private body')); });
  expect(container.textContent).not.toContain('private body');
  expect(button('Accept').disabled).toBe(true);
  await click('Retry same response');
  expect(f.api.respondMcpInteraction.mock.calls[1]![0]).toEqual(f.api.respondMcpInteraction.mock.calls[0]![0]);
  expect(container.textContent).toContain('Your choice: accept');
});

it.each(['decline', 'cancel'] as const)('keeps %s distinct from acceptance and shows unavailable historical requests without enabling answers', async action => {
  const f = fixture(); await render(f.api); await click(action === 'decline' ? 'Decline' : 'Cancel request');
  expect(f.api.respondMcpInteraction.mock.calls[0]![0].response).toEqual({ action });
  f.set({ ...makeView(), record: { ...makeView().record, availability: 'connection_lost', revision: 3 } });
  await render(f.api, 10);
  expect(container.textContent).toContain('Answered or closed requests');
  expect(button('Accept').disabled).toBe(true);
  await submit(); expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
});

it('opens only the exact displayed URL on a click and keeps opening, acceptance, transport and external completion separate', async () => {
  const f = fixture(); const url = 'https://accounts.example.test/login?request=original%2Ftoken#finish';
  f.set({ ...makeView(), record: { ...makeView().record, mode: 'url' }, presentation: { mode: 'url', message: 'Open the original service', url, elicitationId: 'remote-elicitation' } });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await render(f.api);
  expect(container.textContent).toContain(url); expect(container.textContent).toContain('Website host: accounts.example.test');
  expect(openExternalUrl).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(container.querySelector('iframe, img, a')).toBeNull();
  await click('Open website');
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(url);
  expect(container.textContent).toContain('Opening this URL could not be confirmed');
  expect(f.api.respondMcpInteraction).not.toHaveBeenCalled();
  await submit(); expect(f.api.respondMcpInteraction.mock.calls[0]![0].response).toEqual({ action: 'accept' });
  expect(container.textContent).toContain('The server has not reported external completion');
  f.set({ ...f.get(), record: { ...f.get().record, revision: 3, delivery: 'sent', availability: 'rpc_closed' } });
  await render(f.api, 12);
  expect(button('Open website').disabled).toBe(false);
  await click('Open website');
  expect(openExternalUrl).toHaveBeenCalledTimes(2);
  expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
  const beforeCompletion = structuredClone(f.get());
  let finishRefresh!: (view: McpInteractionView) => void;
  f.api.readMcpInteraction.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  await click('Refresh request');
  f.set({ ...f.get(), record: { ...f.get().record, revision: 4, completionReported: true } });
  await render(f.api, 13);
  expect(container.textContent).toContain('Response transport confirmed');
  expect(container.textContent).toContain('The server reported this external interaction complete');
  await act(async () => finishRefresh(beforeCompletion));
  expect(container.textContent).toContain('The server reported this external interaction complete');
});

it('replaces pages instead of loading all history and never sends cancellation when the view closes', async () => {
  const f = fixture(); const closed = { ...makeView(), record: { ...makeView().record, id: 'historical', availability: 'rpc_closed' as const } };
  f.api.listMcpInteractions.mockImplementation(async input => input.cursor ? { items: [item(closed)], nextCursor: null } : { items: [item(f.get())], nextCursor: 'opaque:next' });
  await render(f.api); await click('More requests');
  expect(f.api.listMcpInteractions.mock.calls[1]![0]).toEqual({ ...identity, cursor: 'opaque:next', limit: 20 });
  expect(container.querySelector('[aria-label="MCP request elicitation:first"]')).toBeNull();
  expect(container.querySelector('[aria-label="MCP request historical"]')).not.toBeNull();
  expect(button('Accept').disabled).toBe(true);
  await click('Latest requests');
  expect(f.api.listMcpInteractions).toHaveBeenCalledTimes(3);
  await act(async () => { root.render(null); });
  expect(f.api.respondMcpInteraction).not.toHaveBeenCalled();
});

it('allows correcting owner-rejected fields, without rendering raw remote error text', async () => {
  const f = fixture(); f.api.respondMcpInteraction.mockRejectedValueOnce(new ThreadRequestError(400, 'mcp_interaction_response_invalid'));
  await render(f.api); await submit();
  expect(container.textContent).toContain('Check the requested fields');
  expect(button('Accept').disabled).toBe(false);
  await choose('1'); await submit();
  expect(f.api.respondMcpInteraction.mock.calls[1]![0]).toMatchObject({ response: { content: { choice: 'b' } } });
});


it('uses the original external URL helper acknowledgement without treating a null popup handle as confirmed opening', async () => {
  const actual = await vi.importActual<typeof import('@/lib/url')>('@/lib/url');
  const open = vi.fn(() => null);
  Object.defineProperty(window, 'open', { configurable: true, value: open });
  expect(await actual.openExternalUrl('https://accounts.example.test/finish?value=0')).toBe(false);
  expect(open).toHaveBeenCalledWith('https://accounts.example.test/finish?value=0', '_blank', 'noopener,noreferrer');
  const desktopOpen = vi.fn(async () => undefined);
  Object.defineProperty(window, '__VARIN_DESKTOP__', { configurable: true, value: { openExternal: desktopOpen } });
  expect(await actual.openExternalUrl('https://accounts.example.test/finish?value=0')).toBe(true);
  expect(desktopOpen).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce();
});


it.each(['accept', 'decline', 'cancel'] as const)('records %s locally on a closed error-source card without implying a response or retry', async action => {
  const f = fixture(); f.set(errorView());
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await render(f.api);
  expect(f.api.readMcpInteraction).not.toHaveBeenCalled();
  expect(f.api.respondMcpInteraction).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled(); expect(openExternalUrl).not.toHaveBeenCalled();
  expect(container.textContent).toContain('tools/call (request 1.5) ended with error -32042');
  expect(container.textContent).toContain('No MCP response is sent');
  expect(container.textContent).toContain('does not retry the call, restart its Run, or grant the Agent permission');
  expect(container.textContent).not.toContain('Original RPC error detail');
  expect(button('Accept locally').disabled).toBe(false);
  expect(button('Open website').disabled).toBe(false);
  if (action === 'accept') await submit(); else await click(action === 'decline' ? 'Decline locally' : 'Cancel locally');
  expect(f.api.respondMcpInteraction).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original', interactionId: 'elicitation:first', expectedRevision: 1, response: { action } });
  expect(container.textContent).toContain(`Local choice: ${action} · No MCP response applies`);
  expect(container.textContent).not.toContain('Response delivery started');
  await click('Open website');
  expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith('https://accounts.example.test/finish');
  expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
  await click('Show original RPC error');
  expect(f.api.readMcpInteraction).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original', interactionId: 'elicitation:first' });
  expect(container.querySelector('[aria-label="Original MCP evidence"]')?.textContent).toContain('Original RPC error detail');
  f.set({ ...f.get(), record: { ...f.get().record, revision: 3, completionReported: true } });
  await render(f.api, 1);
  expect(container.textContent).toContain('The server reported this external interaction complete');
  expect(container.textContent).toContain('Its result remains that error');
  expect(f.api.respondMcpInteraction).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});
