import { randomUUID } from 'node:crypto';
import type { Frame, JSHandle, Page } from 'puppeteer-core';
import { BrowserExecutionError, type BrowserClipboardRequest, type BrowserClipboardSelection, type BrowserInputIdentity } from '@varin/protocol';

type SelectionSnapshot = {
  document: Document; element: Element; text: string;
} & ({ kind: 'input'; value: string; start: number; end: number; direction: string | null; inputType: string }
  | { kind: 'editable'; anchor: Node; anchorOffset: number; focus: Node; focusOffset: number });

/** Runs in the original focused frame. Nodes stay in an owner-held JSHandle,
 * never in a page global or a caller-provided selector. */
export function captureBrowserSelection(): SelectionSnapshot | null {
  let doc = document, element = doc.activeElement;
  if (!doc.hasFocus()) return null;
  while (element) {
    if (element.shadowRoot?.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if (element.tagName === 'IFRAME') {
      const child = (element as HTMLIFrameElement).contentDocument;
      if (!child) return null; // The owner will inspect the focused cross-origin frame itself.
      doc = child; element = doc.activeElement; continue;
    }
    break;
  }
  if (!element) return null;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    if (input.type === 'password' || input.disabled || input.readOnly || input.selectionStart === null || input.selectionEnd === null || input.selectionStart === input.selectionEnd) return null;
    return { kind: 'input', document: doc, element, text: input.value.slice(input.selectionStart, input.selectionEnd), value: input.value,
      start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, inputType: input.type };
  }
  const selection = doc.getSelection();
  if (!(element as HTMLElement).isContentEditable && doc.designMode !== 'on' || !selection || selection.rangeCount !== 1 || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  return { kind: 'editable', document: doc, element, text: selection.toString(), anchor: selection.anchorNode,
    anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset };
}

/** Validation and the browser editing command are one synchronous page task.
 * execCommand uses Chromium's edit/undo/input-event machinery, not DOM assignment. */
export function deleteBrowserSelection(saved: SelectionSnapshot | null): 'deleted' | 'stale' | 'unavailable' {
  let doc = document, element = doc.activeElement;
  if (!saved || !doc.hasFocus()) return 'stale';
  while (element) {
    if (element.shadowRoot?.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if (element.tagName === 'IFRAME') {
      const child = (element as HTMLIFrameElement).contentDocument;
      if (!child) return 'stale';
      doc = child; element = doc.activeElement; continue;
    }
    break;
  }
  if (doc !== saved.document || element !== saved.element || !element?.isConnected) return 'stale';
  if (saved.kind === 'input') {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    if (input.disabled || input.readOnly || input.type !== saved.inputType || input.type === 'password' || input.value !== saved.value
      || input.selectionStart !== saved.start || input.selectionEnd !== saved.end || input.selectionDirection !== saved.direction) return 'stale';
  } else {
    const selection = doc.getSelection();
    if (!(element as HTMLElement).isContentEditable && doc.designMode !== 'on' || !selection || selection.rangeCount !== 1
      || selection.anchorNode !== saved.anchor || selection.anchorOffset !== saved.anchorOffset || selection.focusNode !== saved.focus
      || selection.focusOffset !== saved.focusOffset || selection.toString() !== saved.text) return 'stale';
  }
  if (!doc.execCommand('delete')) return 'unavailable';
  // A cancelled/no-op editor command must not be reported as a successful cut.
  if (saved.kind === 'input') return (element as HTMLInputElement).value !== saved.value ? 'deleted' : 'unavailable';
  return doc.getSelection()?.isCollapsed ? 'deleted' : 'unavailable';
}

type Ticket = { id: string; identity: BrowserInputIdentity; handle: JSHandle<SelectionSnapshot | null> };
const sameLease = (first: BrowserInputIdentity, second: BrowserInputIdentity) => first.pageId === second.pageId && first.pageGeneration === second.pageGeneration
  && first.streamId === second.streamId && first.controlEpoch === second.controlEpoch;

/** At most one pending original selection per live viewer. A failed/unknown cut
 * consumes its ticket; retrying never deletes a later selection. */
export class NativeBrowserClipboard {
  private readonly tickets = new Map<string, Ticket>();
  async release(streamId?: string): Promise<void> {
    const tickets = [...this.tickets.values()].filter(ticket => !streamId || ticket.identity.streamId === streamId);
    for (const ticket of tickets) if (this.tickets.get(ticket.identity.streamId) === ticket) this.tickets.delete(ticket.identity.streamId);
    await Promise.all(tickets.map(ticket => ticket.handle.dispose().catch(() => {})));
  }
  async execute(request: BrowserClipboardRequest, page: Page, valid: () => boolean): Promise<BrowserClipboardSelection | null> {
    if (request.action === 'capture') {
      await this.release(request.streamId);
      for (const frame of page.frames()) {
        if (!valid()) throw new BrowserExecutionError('Browser clipboard control lease is stale', 'none');
        // Puppeteer's original isolated realm shares the DOM, but not page scripts'
        // replacements for selection accessors or Document.execCommand.
        const realm = (frame as Frame & { isolatedRealm(): { evaluateHandle: Frame['evaluateHandle'] } }).isolatedRealm();
        const handle = await realm.evaluateHandle(captureBrowserSelection) as JSHandle<SelectionSnapshot | null>;
        let retained = false;
        try {
          const text = await handle.evaluate(value => value?.text ?? null);
          if (!valid()) throw new BrowserExecutionError('Browser clipboard control lease is stale', 'none');
          if (typeof text !== 'string' || !text) continue;
          const id = randomUUID(); this.tickets.set(request.streamId, { id, identity: { ...request }, handle }); retained = true;
          return { selectionId: id, text };
        } finally { if (!retained) await handle.dispose().catch(() => {}); }
      }
      return null;
    }
    const ticket = this.tickets.get(request.streamId);
    if (!ticket || ticket.id !== request.selectionId || !sameLease(ticket.identity, request)) {
      if (request.action === 'release') return null;
      throw new BrowserExecutionError('The original browser selection is no longer available', 'none');
    }
    this.tickets.delete(request.streamId);
    try {
      if (request.action === 'release') return null;
      if (!valid()) throw new BrowserExecutionError('Browser clipboard control lease is stale', 'none');
      let result: ReturnType<typeof deleteBrowserSelection>;
      try { result = await ticket.handle.evaluate(deleteBrowserSelection); }
      catch (error) { throw new BrowserExecutionError(error, 'unknown'); }
      if (result !== 'deleted') throw new BrowserExecutionError(result === 'stale' ? 'The browser selection changed; nothing was cut' : 'The browser could not delete this selection', 'none');
      return null;
    } finally { await ticket.handle.dispose().catch(() => {}); }
  }
}
