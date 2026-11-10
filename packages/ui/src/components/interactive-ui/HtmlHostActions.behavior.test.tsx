import { getRuntimeEndpointGeneration } from '@varin/application-client';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { UiHostAction, UiObservation, ContentReference } from '@varin/application-client';
import { HtmlHostActions } from './HtmlHostActions';
import { uiSession, type UiSession } from '@/lib/interactive-ui/sessions';
const mocks = vi.hoisted(() => ({ host: 1, select: vi.fn(), compose: vi.fn(), send: vi.fn(), copy: vi.fn(), open: vi.fn(), reference: vi.fn(), add: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => mocks.host, createInteractiveUiHttpAPI: () => ({ select: mocks.select }) }));
vi.mock('@/lib/interactive-ui/compose', () => ({ composeUiResult: mocks.compose, sendUiResult: mocks.send, beginUiComposeInsertion: () => ({ dispose: vi.fn() }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/lib/interactive-ui/native-object-actions', () => ({ useNativeObjectActions: () => ({ open: mocks.open, reference: mocks.reference }) }));
vi.mock('@/lib/agent-editor/attachments', () => ({ addContentReference: mocks.add, beginContentReferenceInsertion: (identity: unknown) => ({ add: (reference: unknown) => mocks.add(identity, reference), dispose: vi.fn() }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let root: Root, container: HTMLElement, session: UiSession;
const capture = vi.fn<() => Promise<UiObservation>>();
beforeEach(() => {
  vi.clearAllMocks(); mocks.host = 1;
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  container = document.querySelector('main')!; root = createRoot(container);
  session = uiSession(`html-actions:${crypto.randomUUID()}`, { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, getRuntimeEndpointGeneration());
  capture.mockResolvedValue({ ref: 'ui:report@2', viewRef: 'ui-view:report', capturedAt: 'now', viewport: { width: 800, height: 600 }, state: { data: { total: 21 }, controls: {}, scroll: { x: 0, y: 0 } }, context: { total: 21 } });
  mocks.select.mockImplementation(async (_identity, observation, selected) => ({ ref: 'ui-selection:fixed', snapshotRef: 'ui-snapshot:fixed', viewRef: observation.viewRef, source: { ref: observation.ref }, title: 'Report', text: selected.text }));
  mocks.compose.mockResolvedValue({ status: 'filled', updated: false }); mocks.send.mockResolvedValue({ status: 'sent' }); mocks.copy.mockResolvedValue({ ok: true });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const render = async (action: UiHostAction) => { await act(async () => root.render(<HtmlHostActions actions={[action]} session={session} capture={capture} />)); };
const actionButton = () => container.querySelector<HTMLButtonElement>('button:not([aria-expanded])');
const click = async () => { await act(async () => actionButton()!.click()); };
it('does not act before a trusted button click, then composes readable text with a fixed source', async () => {
  await render({ key: 'fill', type: 'compose', label: 'Use result', text: 'Budget: 21' });
  expect(mocks.compose).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  await click();
  expect(mocks.compose).toHaveBeenCalledWith(expect.objectContaining({ text: 'Budget: 21', identity: session.identity, reference: expect.objectContaining({ source: expect.objectContaining({ revisionRef: 'ui:report@2', snapshotRef: 'ui-snapshot:fixed' }) }) }));
  expect(mocks.select.mock.calls[0]![1].context).toBeUndefined();
});
it('labels sending explicitly and retries the frozen failed submission even after the HTML changes its proposed result', async () => {
  mocks.send.mockRejectedValueOnce(new Error('Unknown outcome'));
  await render({ key: 'continue', type: 'send', label: 'Continue', text: 'Original result' });
  expect(actionButton()?.textContent).toContain('ui.fragment.send');
  await click(); const frozen = mocks.send.mock.calls[0]![0];
  await render({ key: 'continue', type: 'send', label: 'Continue', text: 'New result' });
  expect(container.querySelector('.conversation-ui-disclosure')?.textContent).toContain('Original result');
  await click(); expect(mocks.send.mock.calls[1]![0]).toBe(frozen); expect(capture).toHaveBeenCalledTimes(1);
  await click(); expect(mocks.send.mock.calls[2]![0].text).toBe('New result');
  await click(); expect(mocks.send).toHaveBeenCalledTimes(3);
});
it('references a verified native object without pretending the enclosing HTML is its owner', async () => {
  const reference = { ref: 'object-selection:fixed', title: 'Task', source: { kind: 'object', objectRef: 'thread:child' } } as ContentReference;
  mocks.reference.mockResolvedValue(reference);
  await render({ key: 'cite', type: 'reference', label: 'Cite task', ref: 'thread:child' }); await click();
  expect(mocks.reference).toHaveBeenCalledWith('thread:child'); expect(mocks.add).toHaveBeenCalledWith(session.identity, reference);
  expect(capture).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('shows failed clipboard writes rather than claiming success', async () => {
  mocks.copy.mockResolvedValue({ ok: false, error: 'Clipboard unavailable' });
  await render({ key: 'copy', type: 'copy', label: 'Copy', text: 'Result' }); await click();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Clipboard unavailable'); expect(container.querySelector('[role="status"]')).toBeNull();
});

it('retains an unresolved send when the page removes or changes the action, across view remounts', async () => {
  mocks.send.mockRejectedValueOnce(new Error('Unknown outcome'));
  await render({ key: 'same', type: 'send', label: 'Original send', text: 'Frozen result' }); await click();
  const frozen = mocks.send.mock.calls[0]![0];
  await render({ key: 'same', type: 'open', label: 'New navigation', ref: 'thread:other' });
  expect(actionButton()?.textContent).toContain('Original send');
  expect(mocks.open).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await act(async () => root.render(<HtmlHostActions actions={[]} session={session} capture={capture} />));
  expect(actionButton()?.textContent).toContain('Original send');
  await click(); expect(mocks.send.mock.calls[1]![0]).toBe(frozen); expect(mocks.open).not.toHaveBeenCalled();
  expect(container.querySelector('button')).toBeNull();
});

it('does not attach a prepared result to a replacement Host', async () => {
  mocks.reference.mockImplementationOnce(async () => { mocks.host++; return { ref: 'object-selection:old', title: 'Old' }; });
  await render({ key: 'cite', type: 'reference', label: 'Cite task', ref: 'thread:child' }); await click();
  expect(mocks.add).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toBe('ui.content.actionsUnavailable');
});
