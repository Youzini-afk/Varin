import { flushUiSessions, uiSession } from '@/lib/interactive-ui/sessions';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { normalizeConversationUi, getRuntimeEndpointGeneration, InteractiveUiError, type UiViewState } from '@varin/application-client';
import { DeclarativeUiContent } from './DeclarativeUiContent';
import { ConversationContent } from './ConversationContent';
import { ChatTextSourceContext } from '@/components/conversation/chatTextSourceContext';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
const api = vi.hoisted(() => ({ registerFragment: vi.fn(), attach: vi.fn(), detach: vi.fn(), state: vi.fn(), observe: vi.fn(), reply: vi.fn(), select: vi.fn() }));
const clipboard = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: clipboard }));
const compose = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const quote = vi.hoisted(() => ({ add: vi.fn(), begin: vi.fn(), dispose: vi.fn() }));
vi.mock('@/lib/agent-editor/attachments', () => ({ beginContentReferenceInsertion: (identity: unknown) => { quote.begin(identity); return { add: quote.add, dispose: quote.dispose }; } }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createInteractiveUiHttpAPI: () => api }));
vi.mock('@/lib/interactive-ui/compose', () => ({ composeUiResult: compose, sendUiResult: send, beginUiComposeInsertion: () => ({ dispose: vi.fn() }) }));
vi.mock('@/lib/i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('./EmbeddedUiContent', () => ({ EmbeddedUiContent: () => null }));
vi.mock('./NativeObjectContent', () => ({ NativeObjectContent: () => null }));
vi.mock('@/lib/interactive-ui/native-object-actions', () => ({ useNativeObjectActions: () => ({ open: vi.fn(), reference: vi.fn() }) }));
let root: Root, container: HTMLDivElement, serial = 0;
const identity = { runtime: 'agent' as const, threadId: 'fragment-test', branchId: 'main' };
let presentation: ConversationPresentation;
let saved: UiViewState | null;
beforeEach(() => {
  vi.clearAllMocks(); saved = null;
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  Object.defineProperty(window.HTMLElement.prototype, 'reportValidity', { configurable: true, value: () => true });
  const storage = new Map<string, string>(); vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v) });
  presentation = { identity: { ...identity, threadId: `fragment-test-${serial++}` }, toolExecutions: {} } as unknown as ConversationPresentation;
  api.registerFragment.mockResolvedValue({ ref: 'ui:test@1' }); api.attach.mockImplementation(async () => ({ viewRef: 'ui-view:test', token: 'lease', state: saved }));
  api.observe.mockImplementation((_i, _v, _t, _l, signal: AbortSignal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined))));
  api.detach.mockImplementation(async (_i, _v, _t, state: UiViewState) => { saved = state; }); api.state.mockResolvedValue({ saved: true });
  api.select.mockImplementation(async (_i, observation, selection) => ({ ref: 'ui-selection:test', snapshotRef: 'ui-snapshot:test', viewRef: observation.viewRef, source: { ref: 'ui:test@1' }, text: selection.text, title: 'Hair' }));
  clipboard.mockResolvedValue({ ok: true }); compose.mockResolvedValue({ status: 'filled', updated: false }); send.mockResolvedValue({ status: 'sent' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const choice = { type: 'choice', key: 'hair', label: 'Hair', options: ['Short', 'Long'], action: 'Continue' };
async function render(value: unknown, branchId = 'main') {
  await act(async () => root.render(<ConversationContext.Provider value={{ ...presentation, identity: { ...presentation.identity, branchId } }}><DeclarativeUiContent node={normalizeConversationUi(value)} sourceKey="message:offset:0" fragment={{ messageId: 'message', fragmentKey: 'offset:0' }} /></ConversationContext.Provider>));
}
async function choose(index: number) {
  await act(async () => container.querySelectorAll<HTMLInputElement>('input')[index]!.click());
}
async function action() { await act(async () => container.querySelector<HTMLButtonElement>('[data-conversation-ui-action]')!.click()); }
it('chooses locally, interleaves prose controls, and composes the exact labelled result with a fixed source', async () => {
  await render(choice); await choose(1);
  expect(compose).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  await action();
  expect(compose).toHaveBeenCalledWith(expect.objectContaining({ text: 'Continue\n\nHair：Long', reference: expect.objectContaining({ ref: 'ui-selection:test' }) }));
  expect(container.textContent).toContain('ui.fragment.filled');
});
it('preserves keyed selections across option reordering, remount, and isolates branch state', async () => {
  await render(choice); await choose(1);
  await render({ ...choice, options: ['Long', 'Short', 'Medium'] }); await action();
  expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
  await act(async () => root.render(null));
  await render(choice); await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
  saved = null; await render(choice, 'fork'); await action(); expect(compose.mock.lastCall?.[0].text).not.toContain('Hair：Long');
});
it('retains inputs and shows failures without sending a replacement action on retry', async () => {
  send.mockRejectedValueOnce(new Error('Connection lost'));
  await render({ ...choice, action: { type: 'send', label: 'Continue' } }); await choose(0); await action();
  expect(container.textContent).toContain('Connection lost');
  await choose(1); await action();
  expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  expect(send.mock.calls[1]?.[0].text).toContain('Hair：Short');
});
it('supports multi-select, local-only tabs and disclosure without invoking the composer', async () => {
  await render({ ...choice, multiple: true, action: undefined }); await choose(0); await choose(1);
  expect(compose).not.toHaveBeenCalled();
  await render({ type: 'tabs', label: 'Plans', tabs: [{ key: 'a', label: 'A', content: 'First plan' }, { key: 'b', label: 'B', content: 'Second plan' }] });
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  expect(container.querySelector('[role="tabpanel"][aria-hidden="false"]')?.textContent).toBe('Second plan'); expect(send).not.toHaveBeenCalled();
  await act(async () => container.querySelector('[role="tab"][aria-selected="true"]')!.dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Home' })));
  expect(container.querySelector('[role="tabpanel"][aria-hidden="false"]')?.textContent).toBe('First plan');
});

it('renders only assistant top-level fragments between original prose, and hides unfinished stream JSON', async () => {
  const fence = '```varin-ui\n' + JSON.stringify(choice) + '\n```\n';
  const renderBody = async (content: string, role = 'assistant', isStreaming = true) => act(async () => root.render(
    <ConversationContext.Provider value={presentation}><ChatTextSourceContext.Provider value={{ role, entryId: 'native-message', text: content, offset: 12 }}>
      <ConversationContent content={content} messageId="display-id" isStreaming={isStreaming} renderMarkdown={text => <p>{text}</p>} />
    </ChatTextSourceContext.Provider></ConversationContext.Provider>));
  await renderBody('Before\n\n' + fence + 'After\n\n```varin-ui\n{"type":');
  expect([...container.children].map(el => el.tagName)).toEqual(['P', 'FORM', 'P']);
  expect(container.textContent).not.toContain('{"type":');
  await choose(0);
  const firstInput = container.querySelector('input');
  await renderBody('Before\n\n' + fence + 'After and more\n\n```varin-ui\n{"type":');
  expect(container.querySelector('input')).toBe(firstInput);
  expect(api.registerFragment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageId: 'native-message', fragmentKey: 'offset:8' }), expect.anything());
  await renderBody(fence, 'user'); expect(container.querySelector('input')).toBeNull(); expect(container.textContent).toContain('varin-ui');
  await renderBody('````markdown\n' + fence + '\n````'); expect(container.querySelector('input')).toBeNull();
  await renderBody('> ```varin-ui\n> {}\n> ```'); expect(container.querySelector('input')).toBeNull();
  await renderBody('```varin-ui\n{"type":"unknown"}\n```', 'assistant', false);
  expect(container.querySelector('[data-invalid-interaction]')?.textContent).toContain('unknown');
});

it('restores durable view values and keeps local edits visible when saving fails', async () => {
  saved = { data: { hair: 'label:Long' }, controls: {}, scroll: { x: 0, y: 0 } };
  await render(choice); await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
  api.state.mockRejectedValueOnce(new Error('Storage unavailable'));
  await choose(0); await act(async () => new Promise(resolve => setTimeout(resolve, 230)));
  expect(container.textContent).toContain('Storage unavailable');
  await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Short');
});
it('uses the work session for revision seeds, prefers saved destination state and flushes the same owner', async () => {
  const session = uiSession(`seed:${presentation.identity.threadId}`, presentation.identity, getRuntimeEndpointGeneration());
  session.initialState = { data: { hair: 'label:Long' }, controls: {}, scroll: { x: 0, y: 0 } };
  await act(async () => root.render(<ConversationContext.Provider value={presentation}><DeclarativeUiContent node={normalizeConversationUi(choice)} sourceKey="work" session={session} source={{ ref: 'ui:work@2' }} /></ConversationContext.Provider>));
  await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
  await choose(0); await act(async () => flushUiSessions(presentation.identity, getRuntimeEndpointGeneration()));
  expect(session.state?.data).toMatchObject({ hair: 'label:Short' });
  expect(api.state.mock.lastCall?.[3].data).toMatchObject({ hair: 'label:Short' });
  await act(async () => root.render(null));
  delete session.state;
  session.initialState = { data: { hair: 'label:Long' }, controls: {}, scroll: { x: 0, y: 0 } };
  saved = { data: { hair: 'label:Short' }, controls: {}, scroll: { x: 0, y: 0 } };
  await act(async () => root.render(<ConversationContext.Provider value={presentation}><DeclarativeUiContent node={normalizeConversationUi(choice)} sourceKey="work" session={session} source={{ ref: 'ui:work@2' }} /></ConversationContext.Provider>));
  await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Short');
});
it('shows required-field errors and resets a removed selected meaning without affecting other fields', async () => {
  const form = { type: 'form', label: 'Details', action: 'Continue', fields: [
    { ...choice, required: true, action: undefined }, { type: 'input', key: 'budget', label: 'Budget', inputType: 'range', min: 10, max: 100, unit: 'hours' }
  ] };
  await render(form); await action(); expect(compose).not.toHaveBeenCalled(); expect(container.textContent).toContain('ui.fragment.required');
  await choose(0); await action(); expect(compose.mock.lastCall?.[0].text).toContain('Budget：10');
  await act(async () => { const input = container.querySelector<HTMLInputElement>('input[type="range"]')!; input.value = '35'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  expect(container.querySelector('output')?.textContent).toBe('35 hours');
  await render({ ...form, fields: [{ ...form.fields[0], options: ['Long'] }, form.fields[1]] });
  expect(container.textContent).toContain('ui.fragment.reselect'); expect(container.querySelector('output')?.textContent).toBe('35 hours');
});

it('supports complete streamed previews then aligns the same values with the committed source', async () => {
  api.registerFragment.mockRejectedValueOnce(new InteractiveUiError(404, 'Not committed'));
  const node = normalizeConversationUi(choice);
  const show = (streaming: boolean) => act(async () => root.render(<ConversationContext.Provider value={presentation}><DeclarativeUiContent node={node} sourceKey="stream-message:0:offset:0" fragment={{ messageId: 'stream-message', fragmentKey: 'offset:0' }} isStreaming={streaming} /></ConversationContext.Provider>));
  await show(true); await choose(1); await action();
  expect(api.select.mock.lastCall?.[1]).toMatchObject({ preview: { content: node, messageFragment: { messageId: 'stream-message' } }, state: { data: { hair: 'label:Long' } } });
  await show(false); await action();
  expect(api.select.mock.lastCall?.[1]).toMatchObject({ ref: 'ui:test@1', state: { data: { hair: 'label:Long' } } });
});
it('defers a revised definition while a control is focused, then accepts the update without losing valid values', async () => {
  await render(choice); await choose(1);
  const input = container.querySelector('input')!;
  await act(async () => input.dispatchEvent(new window.Event('focusin', { bubbles: true })));
  await render({ ...choice, options: ['Short', 'Long', 'Medium'] });
  expect(container.querySelectorAll('input')).toHaveLength(2); expect(container.textContent).toContain('ui.fragment.updated');
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'ui.fragment.applyUpdate')!.click());
  expect(container.querySelectorAll('input')).toHaveLength(3);
  await action(); expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
});

it('keeps streaming choices when native content identity acquires its durable history entry', async () => {
  const content = '```varin-ui\n' + JSON.stringify(choice) + '\n```';
  const show = (entryId: string, streaming: boolean) => act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatTextSourceContext.Provider value={{ role: 'assistant', contentIdentity: 'model-item:request:item', entryId, text: content, offset: 0 }}>
      <ConversationContent content={content} messageId={entryId} isStreaming={streaming} renderMarkdown={text => <p>{text}</p>} />
    </ChatTextSourceContext.Provider></ConversationContext.Provider>));
  await show('progress:run', true); await choose(1); const input = container.querySelector('input')!;
  await act(async () => input.dispatchEvent(new window.Event('focusin', { bubbles: true })));
  await show('persisted-message', false); expect(container.querySelector('input')).toBe(input);
  expect(container.textContent).not.toContain('ui.fragment.updated'); await action();
  expect(compose.mock.lastCall?.[0].text).toContain('Hair：Long');
  expect(api.registerFragment.mock.lastCall?.[1].messageId).toBe('persisted-message');
});

it('collects basic input and exact free-form additions into a single editable form result', async () => {
  await render({ type: 'form', label: 'Preferences', action: 'Continue', fields: [
    { ...choice, action: undefined, allowOther: true, multiple: true },
    { type: 'input', key: 'notes', label: 'Notes', inputType: 'textarea' },
    { type: 'input', key: 'count', label: 'Count', inputType: 'number', min: 0 },
  ] });
  await choose(0); await choose(1);
  const supplement = [...container.querySelectorAll('button')].find(button => button.textContent === 'ui.question.supplement')!;
  expect(supplement.getAttribute('aria-expanded')).toBe('false');
  await act(async () => supplement.click());
  const other = container.querySelector<HTMLTextAreaElement>('[aria-label="ui.question.supplement"]')!, notes = container.querySelector<HTMLTextAreaElement>('textarea:not([aria-label])')!, count = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { for (const [element, value] of [[other, '自己补充'], [notes, '  Keep my wording\nexactly.'], [count, '0']] as const) { element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); } });
  await act(async () => supplement.click());
  expect(supplement.getAttribute('aria-expanded')).toBe('false');
  expect(supplement.textContent).toContain('自己补充');
  await act(async () => supplement.click());
  expect(other.value).toBe('自己补充');
  await action(); const text = compose.mock.lastCall?.[0].text;
  expect(text).toContain('Hair：Short、Long、自己补充'); expect(text).toContain('Notes：  Keep my wording\nexactly.'); expect(text).toContain('Count：0');
});

it('registers a later native output part using its part-local offset, not the joined selection offset', async () => {
  const content = 'Second part introduction\n\n```varin-ui\n' + JSON.stringify(choice) + '\n```';
  await act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatTextSourceContext.Provider value={{ role: 'assistant', contentIdentity: 'model-item:request:second', entryId: 'persisted-message', contentIndex: 3, text: content, offset: 250 }}>
      <ConversationContent content={content} messageId="display-second" renderMarkdown={text => <p>{text}</p>} />
    </ChatTextSourceContext.Provider></ConversationContext.Provider>));
  expect(api.registerFragment).toHaveBeenCalledWith(expect.anything(), { messageId: 'persisted-message', contentIndex: 3, fragmentKey: `offset:${content.indexOf('```')}` }, expect.anything());
  await choose(1); await action(); expect(compose.mock.lastCall?.[0].sourceKey).toBe(`model-item:request:second:offset:${content.indexOf('```')}`);
});

it('copies observed selections and reports clipboard failure instead of a false success', async () => {
  await render({ ...choice, action: { type: 'copy', label: 'Continue' } }); await choose(1); await action();
  expect(clipboard).toHaveBeenCalledWith('Continue\n\nHair：Long'); expect(compose).not.toHaveBeenCalled();
  clipboard.mockResolvedValueOnce({ ok: false, error: 'Clipboard denied' }); await action();
  expect(container.textContent).toContain('Clipboard denied'); expect(container.textContent).not.toContain('ui.fragment.copied');
});

it('flushes the latest mounted durable selection before the debounce and propagates save failure', async () => {
  await render(choice); await choose(1); expect(api.state).not.toHaveBeenCalled();
  await act(async () => { await flushUiSessions(presentation.identity, getRuntimeEndpointGeneration()); });
  expect(api.state.mock.lastCall?.[3].data).toMatchObject({ hair: 'label:Long' });
  await choose(0); api.state.mockRejectedValueOnce(new Error('Storage blocked'));
  await act(async () => { await expect(flushUiSessions(presentation.identity, getRuntimeEndpointGeneration())).rejects.toThrow('Storage blocked'); });
  expect(container.textContent).toContain('Storage blocked');
  await act(async () => { await flushUiSessions(presentation.identity, getRuntimeEndpointGeneration()); });
  expect(api.state.mock.lastCall?.[3].data).toMatchObject({ hair: 'label:Short' });
  await act(async () => root.render(null)); api.state.mockClear();
  await flushUiSessions(presentation.identity, getRuntimeEndpointGeneration()); expect(api.state).not.toHaveBeenCalled();
});
it('blocks dirty durable views without a lease but does not block untouched or pure streaming previews', async () => {
  api.attach.mockImplementation(() => new Promise(() => {}));
  await render(choice);
  await expect(flushUiSessions(presentation.identity, getRuntimeEndpointGeneration())).resolves.toBeUndefined();
  await choose(0);
  await expect(flushUiSessions(presentation.identity, getRuntimeEndpointGeneration())).rejects.toThrow('ui.content.notReady');
  await act(async () => root.render(null));
  api.registerFragment.mockRejectedValueOnce(new InteractiveUiError(404, 'Preview only'));
  await act(async () => root.render(<ConversationContext.Provider value={presentation}><DeclarativeUiContent node={normalizeConversationUi(choice)} sourceKey="preview-for-fork" fragment={{ messageId: 'preview-message', fragmentKey: 'offset:0' }} isStreaming /></ConversationContext.Provider>));
  await choose(0);
  await expect(flushUiSessions(presentation.identity, getRuntimeEndpointGeneration())).resolves.toBeUndefined();
  expect(api.state).not.toHaveBeenCalled();
});

it('quotes the current choice and selected tab without invoking a compose/send action', async () => {
  await render(choice); await choose(1);
  const quoteButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('chat.context.quoteContent'))!;
  await act(async () => quoteButton().click());
  expect(quote.begin).toHaveBeenCalledWith(presentation.identity);
  expect(quote.add).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Hair：Long'), source: expect.objectContaining({ kind: 'ui', snapshotRef: 'ui-snapshot:test' }) }));
  expect(compose).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  await render({ type: 'tabs', label: 'Plans', tabs: [{ key: 'a', label: 'A', content: 'First plan' }, { key: 'b', label: 'B', content: 'Second plan' }] });
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  await act(async () => quoteButton().click());
  expect(quote.add.mock.lastCall?.[0].text).toContain('Second plan');
  expect(quote.add.mock.lastCall?.[0].text).not.toContain('First plan');
  expect(quote.dispose).toHaveBeenCalledTimes(2);
});
