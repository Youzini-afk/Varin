import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadRequestError, type ThreadIdentity, type ThreadModel, type ThreadModelInfo, type ThreadsAPI } from '@varin/application-client';
import type { McpInteractionItem, McpInteractionView, McpSamplingGeneration, OperationCancellationReceipt } from '@varin/protocol';
import { ThreadMcpSampling } from './ThreadMcpSampling';

vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props}
  ref={node => { if (node) node.value = String(props.value ?? ''); }} onInput={onChange as React.FormEventHandler<HTMLTextAreaElement>} /> }));
type API = Pick<ThreadsAPI, 'readMcpInteraction' | 'reviewMcpSamplingRequest' | 'reviewMcpSamplingOutput' | 'cancelOperation'>;
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread:original', branchId: 'branch:original' };
const models: ThreadModelInfo[] = [{ providerId: 'provider:a', modelId: 'model:one', name: 'First model' }, { providerId: 'provider:b', modelId: 'model:two' }];
const originalRequest = { messages: [{ role: 'user', content: { type: 'text', text: '<script>private prompt</script>' } }], maxTokens: 97,
  modelPreferences: { hints: [{ name: 'server-preferred-model' }], costPriority: 0 }, systemPrompt: 'Server instructions', temperature: 0,
  stopSequences: [], includeContext: 'none', metadata: { arbitrary: true }, _meta: { trace: 'original' }, unrecognizedParameter: [false, '', 0] };
const generation = (overrides: Partial<McpSamplingGeneration> = {}): McpSamplingGeneration => ({ operationId: 'generation:original', phase: 'running', outcome: null,
  cancelRequested: false, dispatch: 'started', model: { providerId: 'provider:b', providerFamily: 'family:b', model: 'model:two', maxTokens: 97 },
  usage: { measurement: 'missing', inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null }, problem: null, ...overrides });
const makeView = (): McpInteractionView => ({ record: { id: 'sampling:first', revision: 1,
  binding: { operationId: 'operation:original', executionOwner: { kind: 'external', identity: 'owner', epoch: 'epoch' },
    endpoint: { server: 'Original MCP server', resourceKey: 'server-key', configurationVersion: 'config', credentialVersion: 'grant' }, connectionId: 'connection:original',
    source: { kind: 'server_request', requestId: 0, relation: { kind: 'rpc_response_stream', outgoingRequestId: 'request:original' } } },
  runId: 'run:finished', threadId: identity.threadId, branchId: identity.branchId, mode: 'sampling', availability: 'live', choice: null,
  delivery: 'not_started', completionReported: false, deliveryReleased: true, problem: null, sampling: { review: 'request', generationOperationId: null } },
  presentation: { mode: 'sampling', message: '<b>Generate for this server</b>' }, response: null, request: structuredClone(originalRequest),
  sampling: { editedRequest: null, output: null, providerOutput: null, receipt: null, snapshot: null } });
const outputView = (): McpInteractionView => { const view = makeView(); return { ...view,
  record: { ...view.record, revision: 3, sampling: { review: 'output', generationOperationId: 'generation:original' } },
  generation: generation({ phase: 'terminal', outcome: 'succeeded', dispatch: 'completed', usage: { measurement: 'actual', inputTokens: 12, outputTokens: 7, cachedInputTokens: 0, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: 'price:1' } }),
  sampling: { editedRequest: structuredClone(originalRequest), output: { role: 'assistant', model: 'model:two', content: { type: 'text', text: '<img src="secret">generated text' }, stopReason: 'endTurn' },
    providerOutput: { unmodified: 'provider original' }, receipt: { providerCompleted: true }, snapshot: { source: 'sampling-only' } } }; };
const item = ({ record, presentation, response, generation: generated }: McpInteractionItem): McpInteractionItem => structuredClone({ record, presentation, response, generation: generated });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
  let view = makeView();
  const api = {
    readMcpInteraction: vi.fn<API['readMcpInteraction']>(async () => structuredClone(view)),
    reviewMcpSamplingRequest: vi.fn<API['reviewMcpSamplingRequest']>(async input => {
      view = input.action === 'generate' ? { ...view, record: { ...view.record, revision: view.record.revision + 1, sampling: { review: 'request', generationOperationId: 'generation:original' } },
        generation: generation(), sampling: { ...view.sampling!, editedRequest: input.editedRequest } }
        : { ...view, record: { ...view.record, revision: view.record.revision + 1, choice: input.action, delivery: 'sending', sampling: { ...view.record.sampling!, review: 'closed' } } };
      return structuredClone(view);
    }),
    reviewMcpSamplingOutput: vi.fn<API['reviewMcpSamplingOutput']>(async input => {
      view = { ...view, record: { ...view.record, revision: view.record.revision + 1, choice: input.action, delivery: 'sending', sampling: { ...view.record.sampling!, review: 'closed' } } };
      return structuredClone(view);
    }),
    cancelOperation: vi.fn<API['cancelOperation']>(async operationId => ({ id: operationId, cancel_requested: true, phase: 'running' }) as OperationCancellationReceipt),
  };
  return { api, updates: vi.fn<(next: McpInteractionItem) => void>(), get: () => view, set: (next: McpInteractionView) => { view = next; } };
}
type Fixture = ReturnType<typeof fixture>;
type Options = { selectedModel?: ThreadModel; models?: ThreadModelInfo[]; identity?: ThreadIdentity; modelError?: string };
function Harness({ f, projected, options }: { f: Fixture; projected: McpInteractionItem; options: Options }) {
  const [current, setCurrent] = React.useState(projected);
  const [previous, setPrevious] = React.useState(projected);
  if (previous !== projected) { setPrevious(projected); setCurrent(projected); }
  return <ThreadMcpSampling api={f.api} identity={options.identity ?? identity} view={current} models={options.models ?? models}
    selectedModel={options.selectedModel} modelError={options.modelError} update={next => { f.updates(next); setCurrent(next); }} />;
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (f: Fixture, options: Options = {}) => { await act(async () => { root.render(<Harness f={f} projected={item(f.get())} options={options} />); }); };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
const click = async (label: string) => { await act(async () => { button(label).click(); }); };
const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
const edit = async (value: string) => { await act(async () => { const area = container.querySelector('textarea')!; Object.defineProperty(area, 'value', { configurable: true, writable: true, value }); area.dispatchEvent(new window.Event('input', { bubbles: true })); }); };
const choose = async (model?: ThreadModel) => { await act(async () => {
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Sampling model"]')!;
  Object.defineProperty(select, 'value', { configurable: true, writable: true, value: model ? JSON.stringify([model.providerId, model.modelId]) : '' });
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}); };

it('reads bodies only after expansion, retains every JSON parameter, and requires a real explicit model rather than server hints or the first catalog entry', async () => {
  const f = fixture(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await render(f);
  expect(f.api.readMcpInteraction).not.toHaveBeenCalled(); expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('private prompt'); expect(container.querySelector('b')).toBeNull();
  await click('Review sampling request');
  expect(f.api.readMcpInteraction).toHaveBeenCalledWith({ ...identity, operationId: 'operation:original', interactionId: 'sampling:first' }, expect.any(AbortSignal));
  expect(JSON.parse(container.querySelector('textarea')!.value)).toEqual(originalRequest);
  expect(container.querySelector('[aria-label="Original sampling request"]')!.textContent).toContain('unrecognizedParameter');
  expect(container.querySelector('script, img, iframe')).toBeNull();
  expect(button('Generate for review').disabled).toBe(true); await submit(); expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
  await choose(models[1]); await submit();
  expect(f.api.reviewMcpSamplingRequest).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original', interactionId: 'sampling:first', expectedRevision: 1,
    action: 'generate', model: { providerId: 'provider:b', modelId: 'model:two' }, editedRequest: originalRequest });
  expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Response not sent');
  expect(container.textContent).toContain('Actual model: provider:b / model:two · maxTokens: 97');
  expect(container.textContent).toContain('Usage: missing · Input: unavailable');
  expect(f.updates.mock.calls.every(([value]) => !('request' in value) && !('sampling' in value))).toBe(true);
});

it('uses only a catalog-backed passed model selection and never substitutes a missing selection', async () => {
  const f = fixture(); await render(f, { selectedModel: { providerId: 'unknown', modelId: 'unknown' } }); await click('Review sampling request');
  expect(button('Generate for review').disabled).toBe(true);
  const selectedModel: ThreadModel = { ...models[1]!, thinkingLevel: 'high', temperature: 0 };
  await render(f, { selectedModel }); await submit();
  expect(f.api.reviewMcpSamplingRequest.mock.calls[0]![0]).toMatchObject({ action: 'generate', model: selectedModel });
});

it('checks only JSON object shape and sends arbitrary edits intact to the owner', async () => {
  const f = fixture(); await render(f, { selectedModel: models[0] }); await click('Review sampling request');
  for (const value of ['{broken', 'null', '[]', 'false', '3', '"text"']) { await edit(value); await submit(); }
  expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
  const edited = { vendorField: { nested: ['untouched', false] }, maxTokens: 'owner checks this', __unmapped: 0 };
  await edit(JSON.stringify(edited)); await submit();
  expect(f.api.reviewMcpSamplingRequest.mock.calls[0]![0]).toMatchObject({ action: 'generate', editedRequest: edited });
  expect(f.get().request).toEqual(originalRequest);
});

it('requires a second explicit output review and acceptance, with provider completion separate from original server delivery', async () => {
  const f = fixture(); f.set(outputView()); await render(f);
  expect(f.api.readMcpInteraction).not.toHaveBeenCalled(); expect(button('Accept and send to server')).toBeUndefined();
  expect(container.textContent).toContain('terminal · succeeded'); expect(container.textContent).toContain('Response not sent');
  expect(container.textContent).not.toContain('generated text');
  await click('Review generated output');
  expect(container.querySelector('[aria-label="Generated sampling output"]')!.textContent).toContain('<img src=');
  expect(container.querySelector('img')).toBeNull(); expect(container.textContent).toContain('Usage: actual · Input: 12 · Output: 7 · Cached input: 0');
  expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled(); await click('Accept and send to server');
  expect(f.api.reviewMcpSamplingOutput).toHaveBeenCalledExactlyOnceWith({ ...identity, operationId: 'operation:original', interactionId: 'sampling:first', expectedRevision: 3, action: 'accept' });
  expect(container.textContent).toContain('Your choice: accept · Response delivery started'); expect(container.textContent).not.toContain('Response transport confirmed');
  expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
});

it.each(['decline', 'cancel'] as const)('keeps %s distinct at either review without loading bodies or generating', async action => {
  const f = fixture(); await render(f); await click(action === 'decline' ? 'Decline request' : 'Cancel sampling request');
  expect(f.api.reviewMcpSamplingRequest.mock.calls[0]![0]).toMatchObject({ action, expectedRevision: 1 });
  f.set(outputView()); await render(f); await click(action === 'decline' ? 'Decline output' : 'Cancel sampling request');
  expect(f.api.reviewMcpSamplingOutput.mock.calls[0]![0]).toMatchObject({ action, expectedRevision: 3 });
  expect(f.api.readMcpInteraction).not.toHaveBeenCalled(); expect(f.api.cancelOperation).not.toHaveBeenCalled();
});

it('stops the original generation operation, never the original server operation, and gates repeated stop clicks', async () => {
  const f = fixture(); const active = outputView(); f.set({ ...active, record: { ...active.record, sampling: { review: 'request', generationOperationId: 'generation:original' } }, generation: generation() });
  const pending = deferred<OperationCancellationReceipt>(); f.api.cancelOperation.mockReturnValueOnce(pending.promise);
  await render(f); await click('Stop generation'); await click('Stop generation');
  expect(f.api.cancelOperation).toHaveBeenCalledExactlyOnceWith('generation:original');
  await act(async () => pending.resolve({ id: 'generation:original', phase: 'running', cancel_requested: true } as OperationCancellationReceipt));
  expect(button('Stop generation').disabled).toBe(true); expect(container.textContent).toContain('Generation stop control acknowledged');
  expect(container.textContent).toContain('Response not sent'); expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled();
});

it('blocks repeated generation and unknown failures, and an unchanged refresh cannot trigger or enable a duplicate generation', async () => {
  const f = fixture(); const pending = deferred<McpInteractionView>(); f.api.reviewMcpSamplingRequest.mockReturnValueOnce(pending.promise);
  await render(f, { selectedModel: models[0] }); await click('Review sampling request'); await submit(); await submit();
  expect(f.api.reviewMcpSamplingRequest).toHaveBeenCalledOnce();
  await act(async () => pending.reject(new Error('private upstream prompt and credential')));
  expect(container.textContent).not.toContain('private upstream'); expect(button('Generate for review').disabled).toBe(true);
  await click('Refresh sampling review'); await submit(); expect(button('Generate for review').disabled).toBe(true); expect(f.api.reviewMcpSamplingRequest).toHaveBeenCalledOnce();
  f.set(outputView()); await click('Refresh sampling review');
  expect(button('Accept and send to server').disabled).toBe(false); expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled();
});

it('keeps a definitively unadmitted model request editable without discarding its draft', async () => {
  const f = fixture(); f.api.reviewMcpSamplingRequest.mockRejectedValueOnce(new ThreadRequestError(400, 'registered-model-not-found', 'not_started'));
  await render(f, { selectedModel: models[0] }); await click('Review sampling request'); await submit();
  expect(button('Generate for review').disabled).toBe(false); expect(container.textContent).toContain('Choose another model');
  const edited = { ...originalRequest, metadata: undefined, unrecognizedParameter: ['preserved'] }; await edit(JSON.stringify(edited)); await submit();
  expect(f.api.reviewMcpSamplingRequest.mock.calls[1]![0]).toMatchObject({ editedRequest: { unrecognizedParameter: ['preserved'] } });
});

it('does not confuse an already-completed generation with confirmation of an uncertain output acceptance', async () => {
  const f = fixture(); f.set(outputView()); const pending = deferred<McpInteractionView>(); f.api.reviewMcpSamplingOutput.mockReturnValueOnce(pending.promise);
  await render(f); await click('Review generated output'); await click('Accept and send to server'); await click('Accept and send to server');
  expect(f.api.reviewMcpSamplingOutput).toHaveBeenCalledOnce(); await act(async () => pending.reject(new Error('lost delivery response')));
  await click('Refresh sampling review'); expect(button('Accept and send to server').disabled).toBe(true);
  await click('Accept and send to server'); expect(f.api.reviewMcpSamplingOutput).toHaveBeenCalledOnce();
  f.set({ ...f.get(), record: { ...f.get().record, revision: 4, choice: 'accept', delivery: 'unknown', sampling: { ...f.get().record.sampling!, review: 'closed' } } });
  await click('Refresh sampling review'); expect(container.textContent).toContain('Response delivery unconfirmed');
  expect(button('Accept and send to server')).toBeUndefined();
});

it('keeps undispatched failed-generation details and enables only an explicit reviewed retry', async () => {
  const f = fixture(); const failed = makeView(); f.set({ ...failed, record: { ...failed.record, revision: 2, problem: 'mcp_sampling_token_limit_unsupported',
    sampling: { review: 'request', generationOperationId: 'generation:original' } }, generation: generation({ phase: 'terminal', outcome: 'failed', dispatch: 'not_started', problem: 'mcp_sampling_token_limit_unsupported' }) });
  await render(f, { selectedModel: models[1] }); expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
  expect(container.textContent).toContain('cannot enforce maxTokens'); await click('Review sampling request'); await submit();
  expect(f.api.reviewMcpSamplingRequest.mock.calls[0]![0]).toMatchObject({ action: 'generate', expectedRevision: 2 });
});

it('retains edits through projection refresh, and rejects late old details after a newer output revision', async () => {
  const f = fixture(); await render(f, { selectedModel: models[0] }); await click('Review sampling request'); await edit('{"myPendingEdit":true}');
  f.set({ ...f.get(), record: { ...f.get().record, revision: 2 } }); await render(f, { selectedModel: models[0] });
  await click('Refresh sampling review'); expect(container.querySelector('textarea')!.value).toBe('{"myPendingEdit":true}');
  const old = structuredClone(f.get()); const pending = deferred<McpInteractionView>(); f.api.readMcpInteraction.mockReturnValueOnce(pending.promise);
  await click('Refresh sampling review'); f.set(outputView()); await render(f);
  await act(async () => pending.resolve(old)); expect(container.textContent).toContain('A newer sampling state');
  expect(container.querySelector('textarea')).toBeNull(); expect(button('Accept and send to server')).toBeUndefined();
  expect(f.updates.mock.calls.at(-1)![0].record.revision).toBe(2);
  await click('Refresh sampling review'); expect(button('Accept and send to server').disabled).toBe(false);
});

it.each(['branch', 'owner'] as const)('discards a stale %s reader and draft without cancelling server work', async replacement => {
  const f = fixture(); await render(f, { selectedModel: models[0] }); await click('Review sampling request'); await edit('{"oldDraft":true}');
  const old = structuredClone(f.get()); const pending = deferred<McpInteractionView>(); f.api.readMcpInteraction.mockReturnValueOnce(pending.promise); await click('Refresh sampling review');
  const signal = f.api.readMcpInteraction.mock.calls.at(-1)![1]!;
  const next = replacement === 'owner' ? fixture() : f;
  const selectedIdentity = replacement === 'branch' ? { ...identity, branchId: 'branch:next' } : identity;
  next.set({ ...makeView(), record: { ...makeView().record, branchId: selectedIdentity.branchId }, request: { newOwnerRequest: true } });
  await render(next, { identity: selectedIdentity, selectedModel: models[0] });
  expect(signal.aborted).toBe(true); expect(container.querySelector('textarea')).toBeNull();
  const updates = next.updates.mock.calls.length; await act(async () => pending.resolve(old)); expect(next.updates).toHaveBeenCalledTimes(updates);
  await click('Review sampling request'); expect(container.querySelector('textarea')!.value).toContain('newOwnerRequest'); expect(container.querySelector('textarea')!.value).not.toContain('oldDraft');
  expect(f.api.cancelOperation).not.toHaveBeenCalled(); expect(f.api.reviewMcpSamplingRequest).not.toHaveBeenCalled();
});

it('closing details and unmounting aborts only readers, and ignores a late mutation result', async () => {
  const f = fixture(); const reading = deferred<McpInteractionView>(); f.api.readMcpInteraction.mockReturnValueOnce(reading.promise);
  await render(f, { selectedModel: models[0] }); await click('Review sampling request'); const signal = f.api.readMcpInteraction.mock.calls[0]![1]!;
  await click('Hide sampling details'); expect(signal.aborted).toBe(true); await act(async () => reading.resolve(makeView())); expect(f.updates).not.toHaveBeenCalled();
  await click('Review sampling request'); const sending = deferred<McpInteractionView>(); f.api.reviewMcpSamplingRequest.mockReturnValueOnce(sending.promise); await submit();
  const updates = f.updates.mock.calls.length; await act(async () => root.render(null)); await act(async () => sending.resolve(outputView()));
  expect(f.updates).toHaveBeenCalledTimes(updates); expect(f.api.cancelOperation).not.toHaveBeenCalled(); expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled();
});

it('keeps historical output readable without enabling sending and never displays unsafe diagnostic text', async () => {
  const f = fixture(); const closed = outputView(); f.set({ ...closed, record: { ...closed.record, availability: 'connection_lost', problem: 'PRIVATE upstream error' },
    generation: { ...closed.generation!, problem: 'SECRET provider prompt' } });
  await render(f); await click('Review generated output');
  expect(container.textContent).toContain('Original connection was lost'); expect(container.textContent).not.toContain('PRIVATE'); expect(container.textContent).not.toContain('SECRET');
  expect(button('Accept and send to server').disabled).toBe(true); await click('Accept and send to server'); expect(f.api.reviewMcpSamplingOutput).not.toHaveBeenCalled();
  f.set({ ...f.get(), record: { ...f.get().record, revision: 4, problem: '__proto__' }, generation: { ...f.get().generation!, problem: 'constructor' } });
  await render(f); expect(container.textContent).toContain('Generation needs attention');
});
