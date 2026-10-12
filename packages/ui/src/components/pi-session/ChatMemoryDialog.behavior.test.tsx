import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMemoryDialog } from './ChatMemoryDialog';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), key: 'runtime-a', translate: (key: string) => key, close: vi.fn(), subscribe: vi.fn() }));
vi.mock('@varin/application-client', async (original) => ({ ...(await original<object>()), runtimeFetch: mocks.fetch, getRuntimeKey: () => mocks.key, subscribeRuntimeEndpointChanged: mocks.subscribe }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange(open: boolean): void }>) => <div role="dialog">{children}<button onClick={() => onOpenChange(false)}>Close</button></div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
const source = { entryId: 'entry-1', start: 0, text: 'Prefer brief updates.', revision: 'revision-1' };
const sources = [source];
const owner = { scope: 'bot', ownerId: 'bot-1' };
const draft = { content: 'Give brief updates.', trigger: 'Progress reporting', nature: 'preference', sources };
const response = (value: unknown, ok = true) => Promise.resolve({ ok, json: async () => value });
const preview = (value: object, ok = true) => (_url: string, init: RequestInit) =>
  response({ ...value, requestKey: JSON.parse(String(init.body)).requestKey }, ok);
const sent = (index: number) => JSON.parse(mocks.fetch.mock.calls[index]![1].body);
const deferred = () => {
  let resolve!: (value: Awaited<ReturnType<typeof response>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof response>>>(done => { resolve = done; });
  return { promise, resolve };
};

describe('selected memory dialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = (selection = sources, sessionId = "session-1") => act(async () => root.render(<ChatMemoryDialog sessionId={sessionId} sources={selection} onClose={mocks.close} />));
  const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click());
  beforeEach(() => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.key = 'runtime-a'; mocks.fetch.mockReset(); mocks.close.mockReset();
    mocks.translate = (key: string) => key; mocks.subscribe.mockReset().mockReturnValue(() => {});
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  it('only previews until Save, then uses the frozen owner/source and a revision-checked undo', async () => {
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [draft] }));
    await render();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ sources, requestKey: expect.any(String) });
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('option')?.textContent).toBe('chat.context.owner.bot');
    const receipt = { created: true, owner, item: { id: 12, content: draft.content, trigger: draft.trigger, status: 'accepted' } };
    mocks.fetch.mockImplementationOnce(() => response(receipt));
    await click('chat.context.save');
    expect(JSON.parse(mocks.fetch.mock.calls[1]![1].body)).toEqual({ target: 'owner', expectedOwner: owner, draft });
    expect(container.textContent).toContain('chat.context.saved');
    mocks.fetch.mockImplementationOnce(() => response({ undone: true }));
    await click('chat.context.undo');
    expect(mocks.fetch.mock.calls[2]![0]).toContain('/12');
    expect(JSON.parse(mocks.fetch.mock.calls[2]![1].body).expected).toEqual({ content: draft.content, trigger: draft.trigger, status: 'accepted', invalidAt: null });
  });

  it('does not offer undo for an existing duplicate or silently save an empty extraction', async () => {
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [draft] }));
    await render();
    mocks.fetch.mockImplementationOnce(() => response({ created: false, owner, item: { id: 4, content: draft.content, trigger: draft.trigger, status: 'accepted' } }));
    await click('chat.context.save');
    expect(container.textContent).not.toContain('chat.context.undo');
    await act(async () => root.render(null));
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [] }));
    await render();
    expect(container.textContent).toContain('chat.context.empty');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'chat.context.save')).toBe(false);
  });

  it('cancels a pending extraction when the dialog is closed', async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    await render();
    const signal = mocks.fetch.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
  });

  it('retains the selection identity across new arrays, translations and lost-response retries', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('Connection lost'));
    await render();
    const original = sent(0);
    mocks.translate = (key: string) => key;
    await render(sources.map(item => ({ ...item })));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [draft] }));
    await click('chat.context.retry');
    expect(sent(1)).toEqual(original);
    expect(container.querySelector('textarea')?.defaultValue).toBe(draft.content);
  });

  it('observes the same request until the owner explicitly permits a user-triggered new attempt', async () => {
    mocks.fetch.mockImplementationOnce(preview({ error: 'Original request unresolved', retryDisposition: 'observe' }, false));
    await render();
    const original = sent(0);
    mocks.fetch.mockImplementationOnce(preview({ error: 'Original request stopped before sending', retryDisposition: 'new_attempt' }, false));
    await click('chat.context.retry');
    expect(sent(1)).toEqual(original);
    await render(sources.map(item => ({ ...item })));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [draft] }));
    await click('chat.context.retry');
    expect(sent(2)).toEqual({ sources, requestKey: expect.any(String), retryOf: original.requestKey });
    expect(sent(2).requestKey).not.toBe(original.requestKey);
  });

  it('does not offer retry when the matching owner response disallows it', async () => {
    mocks.fetch.mockImplementationOnce(preview({ error: 'Select the source again', retryDisposition: 'none' }, false));
    await render();
    expect(container.textContent).toContain('Select the source again');
    expect(container.textContent).not.toContain('chat.context.retry');
  });

  it('does not grant a new attempt or display drafts from a mismatched response identity', async () => {
    mocks.fetch.mockImplementationOnce(() => response({ requestKey: 'some-other-request', error: 'Retry now', retryDisposition: 'new_attempt' }, false));
    await render();
    const original = sent(0);
    mocks.fetch.mockImplementationOnce(() => response({ owner, drafts: [draft], requestKey: 'some-other-request' }));
    await click('chat.context.retry');
    expect(sent(1)).toEqual(original);
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('chat.context.failed');
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [draft] }));
    await click('chat.context.retry');
    expect(sent(2)).toEqual(original);
  });

  it('gives a changed selection a new identity and ignores the cancelled selection response', async () => {
    const pending = deferred();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    await render();
    const previous = sent(0);
    const signal = mocks.fetch.mock.calls[0]![1].signal as AbortSignal;
    const changed = [{ ...source, text: 'A different selection.' }];
    mocks.fetch.mockImplementationOnce(preview({ owner, drafts: [{ ...draft, content: 'Current selection.', sources: changed }] }));
    await render(changed);
    expect(signal.aborted).toBe(true);
    expect(sent(1).requestKey).not.toBe(previous.requestKey);
    expect(sent(1).retryOf).toBeUndefined();
    await act(async () => pending.resolve(await response({ owner, drafts: [draft], requestKey: previous.requestKey })));
    expect(container.querySelector('textarea')?.defaultValue).toBe('Current selection.');
  });

  it('closes the observation immediately even before its parent unmounts', async () => {
    const pending = deferred();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    await render();
    const original = sent(0);
    const signal = mocks.fetch.mock.calls[0]![1].signal as AbortSignal;
    await click('Close');
    expect(signal.aborted).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(await response({ owner, drafts: [draft], requestKey: original.requestKey })));
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('cancels observation and rejects late results from a replaced runtime', async () => {
    const pending = deferred();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    await render();
    const original = sent(0);
    const signal = mocks.fetch.mock.calls[0]![1].signal as AbortSignal;
    mocks.key = 'runtime-b';
    await act(async () => mocks.subscribe.mock.calls[0]![0]());
    expect(signal.aborted).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(await response({ owner, drafts: [draft], requestKey: original.requestKey })));
    expect(container.querySelector('textarea')).toBeNull();
  });

});
