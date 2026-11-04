import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expect, test, vi } from 'vitest';
import type { BrowserClipboardRequest, BrowserFrame } from '@varin/protocol';
import type { Page } from 'puppeteer-core';
import { NativeBrowserPresentation, type PresentationPage } from './native-presentation.js';
import { captureBrowserSelection, deleteBrowserSelection } from './native-clipboard.js';

/** DOM identity is real; only Chromium's native editing command and CDP transport
 * are test ports. These checks do not claim installed-platform edit/IME coverage. */
function documentFixture(editable = false) {
  const { document } = parseHTML('<html><body><input value="same selected text"><div contenteditable="true">same selected text</div></body></html>');
  const element = document.querySelector(editable ? 'div' : 'input')!;
  Object.defineProperty(document, 'activeElement', { configurable: true, value: element });
  Object.assign(document, { hasFocus: () => true });
  if (editable) Object.defineProperty(element, 'isContentEditable', { configurable: true, value: true });
  else Object.assign(element, { selectionStart: 5, selectionEnd: 13, selectionDirection: 'forward' });
  const selection = { anchorNode: element.firstChild!, anchorOffset: 5, focusNode: element.firstChild!, focusOffset: 13, rangeCount: 1, isCollapsed: false, toString: () => 'selected' };
  Object.assign(document, { getSelection: () => selection });
  const edit = vi.fn(() => {
    if (editable) { element.textContent = 'same  text'; selection.isCollapsed = true; }
    else { const input = element as HTMLInputElement; input.value = 'same  text'; input.selectionStart = input.selectionEnd = 5; }
    return true;
  });
  Object.assign(document, { execCommand: edit });
  const context = vm.createContext({ document });
  const run = <T>(fn: (...args: never[]) => T, value?: unknown): T => vm.runInContext(`(${fn.toString()})`, context)(value);
  const handles: { dispose: ReturnType<typeof vi.fn>; evaluate: (fn: (...args: never[]) => unknown) => Promise<unknown> }[] = [];
  const frame = { isolatedRealm: () => ({ evaluateHandle: async (fn: (...args: never[]) => unknown) => {
    const value = run(fn); const handle = { dispose: vi.fn().mockResolvedValue(undefined), evaluate: async (next: (...args: never[]) => unknown) => run(next, value) };
    handles.push(handle); return handle;
  } }) };
  return { document, element, selection, edit, frame, handles, run };
}
async function setup(editable = false) {
  const dom = documentFixture(editable), session = Object.assign(new EventEmitter(), { send: vi.fn().mockResolvedValue({}) });
  const page = { frames: () => [dom.frame], mainFrame: () => ({ client: session }) } as unknown as Page;
  const ownerPage: PresentationPage = { id: 'page', page, generation: 'generation', controlEpoch: 'epoch', viewerId: 'viewer', agentPaused: true, presentationStreams: new Set(), uploadDirectories: new Set() };
  let queued = Promise.resolve();
  const owner = new NativeBrowserPresentation({ browserId: 'browser', ownerGeneration: 'owner', scratchDirectory: '/tmp', require: () => ownerPage,
    changed: () => {}, acquireActivity: async () => async () => {},
    queued: (_page, work) => { const operation = queued.then(work); queued = operation.then(() => {}, () => {}); return operation; },
  });
  let frame!: BrowserFrame;
  const stop = await owner.subscribe('page', 'viewer', value => { frame = value; });
  session.emit('Page.screencastFrame', { data: '', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 } });
  const identity = { pageId: 'page', pageGeneration: 'generation', streamId: 'viewer', controlEpoch: 'epoch', frameSequence: frame.sequence };
  const capture = () => owner.clipboard({ ...identity, action: 'capture' });
  const cut = (selectionId: string, changes: Partial<BrowserClipboardRequest> = {}) => owner.clipboard({ ...identity, action: 'cut', selectionId, ...changes } as BrowserClipboardRequest);
  const blockQueue = () => { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); queued = queued.then(() => pending); return release; };
  return { ...dom, owner, ownerPage, session, identity, capture, cut, stop, blockQueue };
}

test.each([false, true])('single-use cut targets the captured %s editor through its native editing command', async editable => {
  const f = await setup(editable), selected = await f.capture();
  expect(selected?.text).toBe('selected'); expect(f.edit).not.toHaveBeenCalled();
  await f.cut(selected!.selectionId); expect(f.edit).toHaveBeenCalledExactlyOnceWith('delete');
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('no longer available'); expect(f.edit).toHaveBeenCalledTimes(1);
  expect(f.handles[0]!.dispose).toHaveBeenCalledOnce(); await f.stop();
});

test.each(['selection', 'value', 'node', 'readonly', 'password'])('a changed input %s preserves the page text', async change => {
  const f = await setup(), selected = await f.capture(), input = f.element as HTMLInputElement;
  if (change === 'selection') input.selectionStart = 0;
  if (change === 'value') input.value = 'replacement selected text';
  if (change === 'readonly') input.readOnly = true;
  if (change === 'password') input.type = 'password';
  if (change === 'node') { const replacement = input.cloneNode(true); input.replaceWith(replacement); Object.defineProperty(f.document, 'activeElement', { value: replacement }); }
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('selection changed'); expect(f.edit).not.toHaveBeenCalled(); await f.stop();
});

test('another contenteditable node with identical selected text is not the original selection', async () => {
  const f = await setup(true), selected = await f.capture();
  f.selection.anchorNode = f.document.createTextNode('same selected text'); f.selection.focusNode = f.selection.anchorNode;
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('selection changed'); expect(f.edit).not.toHaveBeenCalled(); await f.stop();
});

test.each(['epoch', 'generation', 'viewer', 'paused'])('revoking the original %s rejects cut before native input', async field => {
  const f = await setup(), selected = await f.capture();
  if (field === 'epoch') f.ownerPage.controlEpoch = 'new';
  if (field === 'generation') f.ownerPage.generation = 'new-page';
  if (field === 'viewer') f.ownerPage.viewerId = 'other';
  if (field === 'paused') f.ownerPage.agentPaused = false;
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('lease is stale'); expect(f.edit).not.toHaveBeenCalled(); await f.stop();
});

test('navigation invalidates the original node handle even when the visible text is identical', async () => {
  const f = await setup(), selected = await f.capture();
  await f.owner.invalidateClipboard('page');
  expect(f.handles[0]!.dispose).toHaveBeenCalledOnce();
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('no longer available'); expect(f.edit).not.toHaveBeenCalled(); await f.stop();
});

test('a second viewer cannot redeem another viewer’s selection ticket', async () => {
  const f = await setup(), selected = await f.capture();
  const stopOther = await f.owner.subscribe('page', 'other', () => {});
  f.session.emit('Page.screencastFrame', { data: '', sessionId: 2, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  f.ownerPage.viewerId = 'other';
  await expect(f.cut(selected!.selectionId, { streamId: 'other' })).rejects.toThrow('no longer available');
  expect(f.edit).not.toHaveBeenCalled(); await stopOther(); await f.stop();
});

test.each([false, true])('a cancelled or unchanged native edit (%s) is not reported as a successful cut', async result => {
  const f = await setup(), selected = await f.capture(); f.edit.mockImplementation(() => result);
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('could not delete');
  expect((f.element as HTMLInputElement).value).toBe('same selected text');
  await expect(f.cut(selected!.selectionId)).rejects.toThrow('no longer available'); await f.stop();
});

test('capture excludes password inputs and inaccessible iframe documents', () => {
  const f = documentFixture(); (f.element as HTMLInputElement).type = 'password';
  expect(f.run(captureBrowserSelection)).toBeNull();
  const iframe = f.document.createElement('iframe'); Object.defineProperty(iframe, 'contentDocument', { value: null });
  f.document.body.appendChild(iframe); Object.defineProperty(f.document, 'activeElement', { value: iframe });
  expect(f.run(captureBrowserSelection)).toBeNull(); expect(f.edit).not.toHaveBeenCalled();
});

test('lost focus between clipboard write and deletion preserves input contents', () => {
  const f = documentFixture(), selected = f.run(captureBrowserSelection);
  Object.assign(f.document, { hasFocus: () => false });
  expect(f.run(deleteBrowserSelection, selected)).toBe('stale'); expect(f.edit).not.toHaveBeenCalled();
});


test('revocation while cut waits in the original input lane prevents deletion', async () => {
  const f = await setup(), selected = await f.capture(), unblock = f.blockQueue();
  const pending = f.cut(selected!.selectionId); await Promise.resolve();
  f.ownerPage.controlEpoch = 'revoked'; unblock();
  await expect(pending).rejects.toThrow('control changed'); expect(f.edit).not.toHaveBeenCalled(); await f.stop();
});

test('a late release of an older ticket cannot remove a newer selection ticket', async () => {
  const f = await setup(), first = await f.capture(), second = await f.capture();
  expect(f.handles[0]!.dispose).toHaveBeenCalledOnce(); expect(f.handles[1]!.dispose).not.toHaveBeenCalled();
  await f.owner.clipboard({ ...f.identity, action: 'release', selectionId: first!.selectionId });
  expect(f.handles[1]!.dispose).not.toHaveBeenCalled(); await f.cut(second!.selectionId);
  expect(f.edit).toHaveBeenCalledExactlyOnceWith('delete'); await f.stop();
});

test('detaching the original viewer releases an unused selection handle', async () => {
  const f = await setup(); await f.capture(); await f.stop();
  expect(f.handles[0]!.dispose).toHaveBeenCalledOnce(); expect(f.edit).not.toHaveBeenCalled();
});
