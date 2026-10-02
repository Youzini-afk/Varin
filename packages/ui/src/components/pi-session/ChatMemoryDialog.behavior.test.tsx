import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMemoryDialog } from './ChatMemoryDialog';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), key: 'runtime-a', translate: (key: string) => key }));
vi.mock('@varin/application-client', async (original) => ({ ...(await original<object>()), runtimeFetch: mocks.fetch, getRuntimeKey: () => mocks.key }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));
const source = { entryId: 'entry-1', start: 0, text: 'Prefer brief updates.', revision: 'revision-1' };
const sources = [source];
const owner = { scope: 'bot', ownerId: 'bot-1' };
const draft = { content: 'Give brief updates.', trigger: 'Progress reporting', nature: 'preference', sources };
const response = (value: unknown, ok = true) => Promise.resolve({ ok, json: async () => value });

describe('selected memory dialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = () => act(async () => root.render(<ChatMemoryDialog sessionId="session-1" sources={sources} onClose={() => {}} />));
  const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!.click());
  beforeEach(() => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.key = 'runtime-a'; mocks.fetch.mockReset();
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  it('only previews until Save, then uses the frozen owner/source and a revision-checked undo', async () => {
    mocks.fetch.mockImplementationOnce(() => response({ owner, drafts: [draft] }));
    await render();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
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
    mocks.fetch.mockImplementationOnce(() => response({ owner, drafts: [draft] }));
    await render();
    mocks.fetch.mockImplementationOnce(() => response({ created: false, owner, item: { id: 4, content: draft.content, trigger: draft.trigger, status: 'accepted' } }));
    await click('chat.context.save');
    expect(container.textContent).not.toContain('chat.context.undo');
    await act(async () => root.render(null));
    mocks.fetch.mockImplementationOnce(() => response({ owner, drafts: [] }));
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
});
